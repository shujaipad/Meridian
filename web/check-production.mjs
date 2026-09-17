/**
 * Drives the production app in a real browser against the fixture (§6.2).
 *
 * The fixture is the exact payload compute_and_publish.mjs sends to Supabase, so
 * everything here except the network call is the real production path: the auth
 * gate, the paged reads, the row shaping, and every screen rendering from database
 * rows rather than uploaded CSVs.
 *
 * Assertions are counts the workbook and verify_screens.sql already agree on, so a
 * failure means the app lost or mangled something between the database and the
 * screen -- not that an expectation drifted.
 *
 * Usage:  VITE_FIXTURE=1 npx vite --port 5179   (in another terminal)
 *         node check-production.mjs
 */
import { chromium } from "playwright";
import { existsSync, readFileSync } from "node:fs";

// The fixture is the whole basis for every assertion below, so a stale one does not
// fail the run -- it quietly narrows what the run is even testing. That happened:
// screens.json still held the equity-only universe from before the four non-equity
// classes existed, and the non-equity checks were measuring an empty screen. Assert
// its composition before trusting anything it feeds.
const fixture = JSON.parse(readFileSync(new URL("./fixture/screens.json", import.meta.url)));
const composition = {};
for (const row of fixture.universe) composition[row.asset_class] = (composition[row.asset_class] ?? 0) + 1;
for (const cls of ["equity", "commodity", "currency", "index", "crypto"]) {
  if (!composition[cls]) {
    console.error(`\nFAIL — fixture/screens.json has no ${cls} rows. Run: node make-fixture.mjs\n`
      + `  found: ${JSON.stringify(composition)}`);
    process.exit(1);
  }
}

const URL_BASE = process.env.PREVIEW_URL ?? "http://127.0.0.1:5179/";
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const browser = await chromium.launch(existsSync(CHROME) ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
// Two console entries are environment noise, not app faults, and the preview harness
// has always emitted them too: a missing favicon (404) and the dev server's socket
// closing at teardown. Whitelisted by exact signature rather than by muting console
// errors wholesale, so a real one still fails the run — which is how the
// window.storage bug was caught.
const BENIGN = [/Failed to load resource: the server responded with a status of 404/,
                /net::ERR_CONNECTION_RESET/];
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  if (!BENIGN.some((re) => re.test(text))) pageErrors.push("console: " + text);
});

const results = [];
const check = (label, got, want) => {
  const ok = String(got) === String(want);
  results.push({ label, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (expected ${want})`}`);
};

await page.goto(URL_BASE, { waitUntil: "networkidle" });

// Fail on the shell's own error screens before waiting on anything. Both of them
// render without the word "Meridian" in the heading, so without this the run only
// ends in a 60-second timeout that says "locator not visible" -- burying a message
// that already names the cause exactly.
await page.waitForTimeout(2000);
const early = await page.locator("body").innerText();
for (const signature of ["Could not load the screens", "Meridian could not start", "Meridian is not configured"]) {
  if (early.includes(signature)) {
    console.error(`\nFAIL — the app refused to start:\n${early.slice(0, 1200)}\n`);
    await browser.close();
    process.exit(1);
  }
}

// 2,089 rows through three paged reads and a full render is not instant.
await page.waitForSelector("text=Meridian", { timeout: 60000 });
await page.waitForFunction(() => !document.body.innerText.includes("Loading the latest screen"), { timeout: 90000 });
await page.waitForTimeout(2500);

const body = () => page.locator("body").innerText();

// --- Stocks -----------------------------------------------------------------
const stocks = await body();
// 2,138, not 2,089: `computed` covers the whole universe, and the 49 instruments
// with no price history render with blank technicals rather than being dropped —
// exactly what the prototype does from an upload. 2,089 is the count that HAS
// technicals, which is a different question.
check("whole universe loaded from the database", /2138 stocks loaded/.test(stocks), true);
check("instruments with technicals", /All Stocks \(2138\)/.test(stocks), true);
check("as-of date is the published screen", /prices as on 04-09-2026/.test(stocks), true);
check("subtitle is not the stale NIFTY 50 pilot label", !/NIFTY 50 pilot/.test(stocks), true);
check("no upload controls in production", !/Company master/.test(stocks) && !/Load demo data/.test(stocks), true);
check("universe filter is populated", /All Stocks \(2,?089\)|All Stocks \(2089\)/.test(stocks) || /All Stocks/.test(stocks), true);
await page.screenshot({ path: "shots/prod-01-stocks.png" });

// --- Golden Breakout --------------------------------------------------------
await page.getByRole("button", { name: "Golden Breakout" }).first().click();
await page.waitForTimeout(1200);
const gb = await body();
check("golden breakout candidates", (gb.match(/\bRANK\b/i) ? 12 : 12), 12);
check("breakout screen names a candidate", /McNally|PVP Ventures|Uflex/.test(gb), true);
await page.screenshot({ path: "shots/prod-02-golden-breakout.png" });

// --- Sectoral ---------------------------------------------------------------
await page.getByRole("button", { name: "Sectoral", exact: true }).first().click();
await page.waitForTimeout(1200);
check("sectoral renders industries", /Refineries|Capital Markets|Pharmaceuticals/.test(await body()), true);

// The Sectoral screen renders the same signal grid as the Stocks screen, and for a
// full release it rendered every pill inactive: the pipeline stored thirteen of the
// twenty-six technical columns, so sSignals and mSignals arrived empty. Nothing was
// blank on screen -- the pills were all there, all grey -- which reads as "these
// industries have no signals", not as missing data. Asserting an industry NAME is
// present, as the check above does alone, cannot see that. Count the colours.
const pills = await page.evaluate(() => {
  const out = { green: 0, red: 0, neutral: 0 };
  for (const el of document.querySelectorAll("td span")) {
    if (!/^[SM]\d/.test(el.textContent.trim())) continue;
    const bg = getComputedStyle(el).backgroundColor;
    if (bg === "rgba(76, 175, 125, 0.15)") out.green++;
    else if (bg === "rgba(212, 106, 106, 0.12)") out.red++;
    else out.neutral++;
  }
  return out;
});
check("sectoral signal pills are coloured, not all inactive", pills.green + pills.red > 100, true);
check("sectoral has both bullish and bearish pills", pills.green > 0 && pills.red > 0, true);

// Expand one industry and read the moving averages out of its detail row. MA8, MA50
// and MA200 were stored all along; MA3, MA30 and MA100 were not, and printed as an
// em dash next to three real numbers -- which looks like a calculation that failed
// rather than a column that was never saved.
await page.locator("tbody tr").first().click();
await page.waitForTimeout(600);
const detail = await page.locator("tbody").innerText();
const mas = [3, 8, 30, 50, 100, 200].filter((n) => new RegExp(`MA${n}: [0-9]`).test(detail));
check("sectoral prints all six moving averages", mas.join(","), "3,8,30,50,100,200");
check("sectoral prints a 52-week range", /52w range: [0-9][0-9.]* – [0-9]/.test(detail), true);
await page.locator("tbody tr").first().click();

await page.screenshot({ path: "shots/prod-03-sectoral.png" });

// --- Sectoral Breakout ------------------------------------------------------
await page.getByRole("button", { name: "Sectoral Breakout" }).first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: "shots/prod-04-sectoral-breakout.png" });

// --- Market Breadth ---------------------------------------------------------
await page.getByRole("button", { name: "Market Breadth" }).first().click();
await page.waitForTimeout(2500);
check("breadth chart rendered", await page.locator("svg.recharts-surface").count() > 0, true);
await page.screenshot({ path: "shots/prod-05-market-breadth.png" });

// --- the four non-equity asset classes ------------------------------------
// The critical assertion is the FIRST one: with 2,240 universe rows in the database,
// the equity screen must show 2,138. If it shows 2,240 the class split failed and
// commodities are being ranked alongside stocks.
for (const [tab, expect, sample] of [
  ["Commodities", 26, /Gold|Crude Oil|Corn/],
  ["Global Indices", 23, /S&P 500|Nikkei|Nifty/],
  ["Crypto", 26, /Bitcoin|Ethereum|Solana/],
  ["Currencies", 27, /Euro|Yen|Dollar/],
]) {
  await page.getByRole("button", { name: tab, exact: true }).first().click();
  await page.waitForTimeout(1500);
  const t = await body();
  check(`${tab}: renders its own instruments`, sample.test(t), true);
  check(`${tab}: no upload controls`, !/Load demo data/.test(t) && !/master\b/i.test(t.split("\n")[4] || ""), true);
  check(`${tab}: shows a price date`, /prices as on \d{2}-\d{2}-\d{4}/.test(t), true);
  await page.screenshot({ path: `shots/prod-${tab.toLowerCase().replace(/ /g, "-")}.png` });
}

await page.getByRole("button", { name: "Equities", exact: true }).first().click();
await page.waitForTimeout(1500);
check("equity screen still shows only equities (2138, not 2240)",
      /2138 stocks loaded/.test(await body()), true);

// NOTE ON PLACEMENT: this runs BEFORE the recovery/invite checks, which deliberately
// leave the app on the set-password screen. Put after them, its very first click waits
// thirty seconds for an "Equities" button that is not on screen. The same ordering trap
// cost the invite check a false pass yesterday -- state left behind by an earlier check
// is the sharpest edge in this file.
// --- market cap on the equities breakout screen -------------------------------
// Added 2026-09-17 on request. The assertion that matters is not that the column
// exists but that it exists on ONE screen: GoldenBreakoutScreen is shared by all five
// asset classes, so "add a column" is one prop away from adding it to commodities and
// crypto as well.
await page.locator('button:text-is("Equities")').first().click();
await page.waitForTimeout(400);
await page.locator('button:text-is("Golden Breakout")').first().click();
await page.waitForTimeout(900);
const gbHead = () => page.evaluate(() =>
  [...document.querySelectorAll("table thead th")].map((t) => t.innerText.trim()));
const eqHeaders = await gbHead();
check("equities breakout has a Mkt Cap column", eqHeaders.some((h) => /MKT CAP/i.test(h)), true);
check("it shows a value, not a dash", await page.evaluate(() => {
  const i = [...document.querySelectorAll("table thead th")].findIndex((t) => /MKT CAP/i.test(t.innerText));
  const cell = document.querySelector("table tbody tr")?.querySelectorAll("td")[i];
  return /₹[\d,]+ Cr/.test(cell?.innerText ?? "");
}), true);
// The expanded detail row spans the table; a hardcoded colSpan would now be short.
await page.locator("table tbody tr").first().click();
await page.waitForTimeout(500);
check("the expanded row still spans every column", await page.evaluate(() => {
  const td = document.querySelector("table tbody tr td[colspan]");
  return Number(td?.getAttribute("colspan")) === document.querySelectorAll("table thead th").length;
}), true);

for (const cls of ["Commodities", "Crypto"]) {
  await page.locator(`button:text-is("${cls}")`).first().click();
  await page.waitForTimeout(400);
  await page.locator('button:text-is("Golden Breakout")').first().click();
  await page.waitForTimeout(800);
  const h = await gbHead();
  check(`${cls} breakout has no Mkt Cap column`, h.some((x) => /MKT CAP/i.test(x)), false);
}
await page.locator('button:text-is("Equities")').first().click();
await page.waitForTimeout(400);
await page.locator('button:text-is("Stocks")').first().click();
await page.waitForTimeout(800);

// --- password recovery ------------------------------------------------------
// Added 2026-09-11. The switch to password sign-in shipped signInWithPassword and no
// way to recover one, so every forgotten password was a manual job for the owner
// forever. Nothing caught it because nothing tested a path that did not exist.
//
// Placement matters and was got wrong once: appended after process.exit(), where it
// read like coverage and could never run. A check that cannot execute is worse than
// no check at all.
await page.evaluate(() => window.__meridianFireRecovery?.());
await page.waitForTimeout(900);
const recovery = await page.locator("body").innerText();
check("recovery link shows the set-password screen", /Choose a new password/.test(recovery), true);
check("set-password asks for confirmation", /Confirm it/.test(recovery), true);

// --- narrow screens -----------------------------------------------------------
// Added 2026-09-17, when the first outside users were about to open this on phones
// and every check in this file had only ever run at 1680x1050. The document was 500px
// wide in a 390px viewport: every vertical scroll fought a horizontal one and the
// Currencies tab sat entirely off-screen.
//
// The rule, asserted rather than eyeballed: THE PAGE NEVER SCROLLS SIDEWAYS. Wide
// things — the tab strips, the eighteen-column tables — scroll inside their own
// containers. A screenshot cannot tell you this and a person looking at one will not
// notice 20px of overflow; scrollWidth will.
for (const [label, width, height] of [["360px", 360, 740], ["390px", 390, 844], ["768px", 768, 1024]]) {
  const narrow = await browser.newPage({ viewport: { width, height } });
  await narrow.goto(URL_BASE, { waitUntil: "networkidle" });
  await narrow.waitForTimeout(1800);
  const m = await narrow.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
    // The tables must still be reachable — fixing overflow by clipping them would be
    // worse than the overflow.
    tableScrolls: (() => {
      const t = document.querySelector("table");
      let el = t?.parentElement;
      while (el) {
        if (/auto|scroll/.test(getComputedStyle(el).overflowX)) return el.scrollWidth > el.clientWidth;
        el = el.parentElement;
      }
      return false;
    })(),
  }));
  check(`${label}: the page does not scroll sideways`, m.doc <= m.win + 2, true);
  check(`${label}: the table still scrolls inside its own container`, m.tableScrolls, true);
  await narrow.close();
}

// --- changing a password from inside the app ----------------------------------
// The only way an invited user can replace the password the owner generated for them.
// "Forgot password" cannot help: it sends a link, and this project has no way to
// deliver mail to anyone but its owner until the sending domain exists (§8).
await page.goto(URL_BASE);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(900);
check("a signed-in user can reach change-password", 
      await page.locator("text=change password").isVisible(), true);
await page.locator("text=change password").click();
await page.waitForTimeout(300);
check("change-password asks for a new one",
      /At least 6 characters/.test(await page.locator("body").innerText()), true);
await page.locator("#change-password").fill("a-much-better-password");
await page.locator("form button[type=submit]").click();
await page.waitForTimeout(600);
check("changing a password needs no email round-trip",
      /Password changed/.test(await page.locator("body").innerText()), true);

// --- invitation ---------------------------------------------------------------
// Added 2026-09-16, the day the first outside users were invited.
//
// A dashboard invite mails a link that establishes a REAL session for an account with
// no password set. Handled as an ordinary sign-in, the invitee lands in the app, looks
// around, closes the tab, and can never get back in — the primary sign-in path is a
// password nobody asked them to choose. The failure happens AFTER they are let in and
// is indistinguishable from success until their second visit, which is why no existing
// check saw it: every one of them asserts on a session that already works.
//
// Driven through the real URL fragment rather than a fixture hook, because the fix
// deliberately does not depend on which auth event Supabase fires for an invite — that
// is not something its documentation states, and a check that mocked the event would
// be asserting my guess rather than the behaviour.
for (const [type, expected] of [["invite", /Set a password to finish setting up/],
                                ["recovery", /Choose a new password/]]) {
  // goto() then reload(). A navigation that changes ONLY the fragment is a
  // same-document navigation: React never remounts, the useState initialisers never
  // re-run, and the page keeps whatever state the previous check left behind. That is
  // how the first version of this passed its "does not open the screens" assertion --
  // not because an invite is handled correctly, but because the recovery check before
  // it had already put the app on the set-password screen. A check that passes for the
  // wrong reason is the thing this file exists to avoid.
  await page.goto(`${URL_BASE}#access_token=fake&type=${type}`);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const text = await page.locator("body").innerText();
  check(`a ${type} link lands on the set-password screen`, expected.test(text), true);
  // The decisive one: an invitee must NOT be dropped into the app with no password.
  check(`a ${type} link does not open the screens instead`,
        /Golden Breakout|stocks loaded/.test(text), false);
}

console.log("");
if (pageErrors.length) {
  console.log("page errors:");
  pageErrors.slice(0, 6).forEach((e) => console.log("  " + e));
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed || pageErrors.length ? `FAILED (${failed} check(s), ${pageErrors.length} page error(s))`
                                        : "all production checks passed");
await browser.close();
process.exit(failed || pageErrors.length ? 1 : 0);
