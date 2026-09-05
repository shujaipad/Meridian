// Loads the real equities data into a running preview and screenshots each
// screen into ./shots. Requires `npm run dev` in another terminal, and
// `npm run trim` to have produced prices-trim.csv.
//
// Usage: node capture.mjs [--full]
//   --full  use the untrimmed 67MB price history (slow; minutes, not seconds)

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const URL_BASE = process.env.PREVIEW_URL ?? "http://127.0.0.1:5178/";
const repo = (p) => fileURLToPath(new URL(p, import.meta.url));

// The sandbox ships Chromium at a fixed path and blocks `playwright install`;
// fall back to Playwright's own resolution when running elsewhere.
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const launchOpts = existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {};

const pricesFile = process.argv.includes("--full")
  ? repo("../meridian-price-history-742.csv")
  : repo("./prices-trim.csv");

if (!existsSync(pricesFile)) {
  console.error(`missing ${pricesFile} — run \`npm run trim\` first`);
  process.exit(1);
}

const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));

await page.goto(URL_BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);

const inputs = page.locator('input[type="file"]');
for (const [label, file] of [
  ["company master", repo("../meridian-company-master-742.csv")],
  ["fundamentals", repo("../meridian-fundamentals-742.csv")],
  ["prices", pricesFile],
]) {
  console.log(`uploading ${label}...`);
  await inputs.nth(["company master", "fundamentals", "prices"].indexOf(label)).setInputFiles(file);
  await page.waitForTimeout(label === "prices" ? 1000 : 3000);
}

// The price parse is the long pole; wait for the table to actually populate.
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000);
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 600));
  if (/stocks loaded/i.test(txt) && /RS RATING|CMP/i.test(txt)) break;
}
await page.waitForTimeout(4000);

const shot = async (name) => {
  await page.screenshot({ path: `shots/${name}.png` });
  console.log("captured", name);
};
const clickTab = async (label) => {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  await page.waitForTimeout(3500);
};

await shot("01-stocks");
for (const [tab, name] of [
  ["Golden Breakout", "02-golden-breakout"],
  ["Sectoral", "03-sectoral"],
  ["Sectoral Breakout", "04-sectoral-breakout"],
  ["Market Breadth", "05-market-breadth"],
  ["Currencies", "06-currencies"],
]) {
  await clickTab(tab);
  await shot(name);
}

console.log("\nerrors:", errors.length ? errors.slice(0, 8).join("\n") : "(none)");
await browser.close();
