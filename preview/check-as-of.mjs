// Verifies the "prices as on DD-MM-YYYY" header (§5).
//
// Four things that are each easy to break silently and invisible in a screenshot:
//   1. the date is the newest bar in the DATA, never the clock;
//   2. it follows the active asset-class tab rather than always showing equities —
//      the header sits above the tabs, so the non-equity screens have to report
//      their freshness upward and a broken lift shows the wrong class's date;
//   3. switching tabs does not leak the previous class's date;
//   4. the "· N lagging" warning actually fires. A warning that cannot fire is
//      worthless, so this builds a deliberately ragged price file to make it fire.
//
// Requires `npm run dev` running. Usage: node check-as-of.mjs

import { chromium } from "playwright";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_BASE = process.env.PREVIEW_URL ?? "http://127.0.0.1:5178/";
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const R = "/home/user/Meridian";

const EQ_MASTER = `${R}/meridian-company-master-742.csv`;
const EQ_PRICES = `${R}/preview/prices-trim.csv`;
const CO_MASTER = `${R}/meridian-commodities-master.csv`;
const CO_PRICES = `${R}/meridian-commodities-prices-sample.csv`;

for (const f of [EQ_MASTER, EQ_PRICES, CO_MASTER, CO_PRICES]) {
  if (!existsSync(f)) { console.error(`missing ${f} — run \`npm run trim\` first`); process.exit(1); }
}

// Truncate three symbols so they end before the rest of the universe.
const LAG_SYMS = 3, LAG_BARS = 10;
const rows = readFileSync(CO_PRICES, "utf8").trim().split("\n");
const head = rows[0], body = rows.slice(1).map((l) => l.split(","));
const dates = [...new Set(body.map((r) => r[1]))].sort();
const cutoff = dates[dates.length - 1 - LAG_BARS];
const lagging = [...new Set(body.map((r) => r[0]))].sort().slice(0, LAG_SYMS);
const doctored = body.filter((r) => !(lagging.includes(r[0]) && r[1] > cutoff));
const lagFile = join(mkdtempSync(join(tmpdir(), "meridian-asof-")), "lagging-prices.csv");
writeFileSync(lagFile, [head, ...doctored.map((r) => r.join(","))].join("\n"));

const browser = await chromium.launch(existsSync(CHROME) ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1680, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(URL_BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const header = async () => {
  const t = await page.locator("body").innerText();
  const m = /prices as on\s+([0-9-]+)(\s*·\s*(\d+) lagging)?/.exec(t);
  return m ? { date: m[1], lagging: m[3] ? Number(m[3]) : 0 } : null;
};
const tab = async (name) => {
  await page.getByRole("button", { name }).first().click();
  await page.waitForTimeout(700);
};

const results = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ label, ok, got, want });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}` + (ok ? "" : ` — expected ${JSON.stringify(want)}`));
};

const inputs = page.locator('input[type="file"]');
await inputs.nth(0).setInputFiles(EQ_MASTER);
await page.waitForTimeout(1500);
await inputs.nth(2).setInputFiles(EQ_PRICES);
await page.waitForTimeout(12000);
check("equities shows its own newest bar", await header(), { date: "04-09-2026", lagging: 0 });

await tab("Commodities");
check("empty class shows nothing, not the equities date", await header(), null);

const ci = page.locator('input[type="file"]');
await ci.nth(0).setInputFiles(CO_MASTER);
await page.waitForTimeout(1500);
await ci.nth(1).setInputFiles(lagFile);
await page.waitForTimeout(4000);
check("commodities date lifts up, with the lag warning", await header(), { date: "26-06-2026", lagging: LAG_SYMS });

await tab("Equities");
check("switching back does not leak the commodities date", await header(), { date: "04-09-2026", lagging: 0 });
await tab("Commodities");
check("and switching forward restores it", await header(), { date: "26-06-2026", lagging: LAG_SYMS });

await browser.close();
const failed = results.filter((r) => !r.ok);
if (pageErrors.length) console.log("page errors:", pageErrors);
console.log(failed.length || pageErrors.length ? `\nFAILED (${failed.length})` : "\nall as-of checks passed");
process.exit(failed.length || pageErrors.length ? 1 : 0);
