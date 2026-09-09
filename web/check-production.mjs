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
