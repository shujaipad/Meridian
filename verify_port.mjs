/**
 * Port parity check — Node engine vs Python backtest.
 *
 * §6.2 commits the production compute job to reusing Meridian's JS functions
 * rather than reimplementing them in Python, precisely to avoid the
 * dual-codebase drift §7.2 caught in a third-party scorer. This proves the
 * commitment actually holds: it runs meridian-engine.js under Node over the
 * real price history and emits the Golden Breakout candidate set for the
 * latest date, which verify_port.py then compares against the independent
 * Python implementation in meridian_backtest.py over the same data.
 *
 * Two implementations, two languages, one expected answer. Any disagreement is
 * drift, and is meant to fail loudly here rather than quietly in production.
 *
 * Usage: node verify_port.mjs > port-node.json
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { computeAll, runGoldenBreakoutScreener } from "./meridian-engine.js";

const BASE = dirname(fileURLToPath(import.meta.url));

// Minimal RFC4180-ish parser: 75 rows of the master carry quoted fields with
// embedded commas ("Food, Beverages & Tobacco"), so splitting on "," is wrong.
function parseCSV(text) {
  const rows = [];
  let field = "", row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows
    .filter((r) => r.length === header.length && r.some((v) => v !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const num = (v) => (v === "" || v == null ? null : Number(v));

const master = parseCSV(readFileSync(join(BASE, "meridian-company-master-2138.csv"), "utf8"))
  .map((m) => ({ ...m, MarketCap: num(m.MarketCap) }));

const priceFiles = readdirSync(BASE)
  .filter((f) => /^meridian-price-history-2090-part\d+of3\.csv$/.test(f))
  .sort();

const prices = [];
for (const f of priceFiles) {
  for (const r of parseCSV(readFileSync(join(BASE, f), "utf8"))) {
    prices.push({
      ISIN: r.ISIN, Date: r.Date,
      High: num(r.High), Low: num(r.Low),
      Close: num(r.Close), Volume: num(r.Volume),
    });
  }
}

// Fundamentals are irrelevant to the Golden Breakout gates (§4.3 keeps the
// Composite Score display-only), so the comparison runs technicals-only —
// exactly the surface meridian_backtest.py implements.
const computed = computeAll(master, [], prices);
const candidates = runGoldenBreakoutScreener(computed);

const asOf = prices.reduce((m, r) => (r.Date > m ? r.Date : m), "");
process.stdout.write(JSON.stringify({
  as_of: asOf,
  instruments: new Set(prices.map((r) => r.ISIN)).size,
  candidates: candidates.map((c) => ({
    isin: c.ISIN,
    separation_pct: c.tech.separationPct,
    freshness_days: c.tech.goldenCrossStreak?.streak ?? null,
    ma200_slope_pct: c.tech.ma200SlopePct,
  })),
}, null, 1) + "\n");
