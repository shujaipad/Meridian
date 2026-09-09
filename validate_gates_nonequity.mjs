/**
 * Are the Golden Breakout gates valid outside equities? (§9, open since the start.)
 *
 * The five gates — price > 50DMA > 200DMA, 200DMA rising, separation ≥ 3%, cross no
 * older than 15 trading days, price > 8DMA — were backtested on five years of Indian
 * equities and nothing else. Commodities, FX, global indices and crypto have quite
 * different volatility, and thresholds tuned on one population are not automatically
 * meaningful on another. Real history now exists for all four, so this measures it
 * rather than assuming either way.
 *
 * Method mirrors meridian_backtest.py: walk each instrument's history day by day,
 * take every date where all five gates fire, and measure the forward return over a
 * fixed horizon against that class's own baseline — the average forward return from
 * a random day in the same class over the same period. Comparing a commodity signal
 * against an equity baseline would say nothing.
 *
 * Read the output with the sample sizes in view. Twenty-six instruments over five
 * years is a fraction of the 2,089-stock equity sample, and a class producing a dozen
 * episodes cannot support a conclusion however good the hit rate looks.
 *
 * Usage: node --max-old-space-size=4096 validate_gates_nonequity.mjs [--horizon 60]
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rollingSMASeries, maAbove, GOLDEN_BREAKOUT_PARAMS } from "./meridian-engine.js";

const BASE = dirname(fileURLToPath(import.meta.url));
const HORIZON = process.argv.includes("--horizon")
  ? Number(process.argv[process.argv.indexOf("--horizon") + 1]) : 60;
const { minSeparationPct, freshnessMaxDays } = GOLDEN_BREAKOUT_PARAMS;

function readPrices(cls) {
  const lines = readFileSync(join(BASE, `meridian-${cls}-prices.csv`), "utf8").trim().split("\n");
  const head = lines.shift().replace(/\r$/, "").split(",");
  const bySym = {};
  for (const line of lines) {
    const c = line.replace(/\r$/, "").split(",");
    const r = Object.fromEntries(head.map((h, i) => [h, c[i]]));
    (bySym[r.Symbol] ||= []).push({ date: r.Date, close: Number(r.Close) });
  }
  for (const s of Object.keys(bySym)) bySym[s].sort((a, b) => a.date.localeCompare(b.date));
  return bySym;
}

// The five gates evaluated as of index i, using only data up to i — the whole point
// of a walk-forward test is that nothing after i is visible.
function gatesFireAt(closes, ma8, ma50, ma200, i) {
  const c = closes[i], m8 = ma8[i], m50 = ma50[i], m200 = ma200[i];
  if (c == null || m8 == null || m50 == null || m200 == null) return false;
  if (!maAbove(m50, m200)) return false;                       // gate 1a
  if (!(c > m50)) return false;                                // gate 1b
  if (!(c > m8)) return false;                                 // gate 5
  const prior = ma200[i - 20];
  if (prior == null || !(m200 > prior)) return false;          // gate 2: 200DMA rising
  const sep = ((m50 - m200) / Math.abs(m200)) * 100;
  if (!(sep >= minSeparationPct)) return false;                // gate 3
  // gate 4: freshness — how long has 50DMA been above 200DMA?
  let streak = 0;
  for (let j = i; j >= 0; j--) {
    if (ma50[j] == null || ma200[j] == null) break;
    if (!maAbove(ma50[j], ma200[j])) break;
    streak++;
  }
  return streak <= freshnessMaxDays;
}

const results = [];
for (const cls of ["commodities", "currencies", "indices", "crypto"]) {
  const bySym = readPrices(cls);
  let episodes = [], baseline = [], instrumentsWithSignal = new Set();

  for (const [sym, rows] of Object.entries(bySym)) {
    const closes = rows.map((r) => r.close);
    if (closes.length < 260 + HORIZON) continue;
    const ma8 = rollingSMASeries(closes, 8);
    const ma50 = rollingSMASeries(closes, 50);
    const ma200 = rollingSMASeries(closes, 200);

    for (let i = 220; i < closes.length - HORIZON; i++) {
      const fwd = (closes[i + HORIZON] / closes[i] - 1) * 100;
      // Every eligible day contributes to the baseline, signal or not. That is what
      // makes the comparison fair: the same instruments, the same period, the same
      // horizon — the only difference is whether the gates fired.
      baseline.push(fwd);
      if (gatesFireAt(closes, ma8, ma50, ma200, i)) {
        episodes.push(fwd);
        instrumentsWithSignal.add(sym);
      }
    }
  }

  // MEDIAN, not mean. A handful of instruments that went up 100x drag a mean into
  // meaninglessness: crypto's mean 60-day forward return reads +55%, which would
  // compound to something absurd over five years and is really one or two coins. The
  // median says what a typical 60-day window actually did, which is the question.
  const median = (a) => {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const hit = (a) => (a.length ? (a.filter((x) => x > 0).length / a.length) * 100 : null);
  results.push({
    cls, n: episodes.length, instruments: instrumentsWithSignal.size,
    signalHit: hit(episodes), baseHit: hit(baseline),
    signalRet: median(episodes), baseRet: median(baseline),
    signalMean: mean(episodes), baseMean: mean(baseline), baseN: baseline.length,
  });
}

console.log(`Golden Breakout gates outside equities — ${HORIZON}-day forward return`);
console.log(`gates: separation >= ${minSeparationPct}%, freshness <= ${freshnessMaxDays}d\n`);
console.log("class          episodes  instr   hit%   base%    edge  medRet% medBase%    edge");
console.log("-".repeat(82));
for (const r of results) {
  const f = (v, d = 1) => (v == null ? "  n/a" : v.toFixed(d).padStart(6));
  console.log(`${r.cls.padEnd(14)} ${String(r.n).padStart(8)} ${String(r.instruments).padStart(6)}`
    + ` ${f(r.signalHit)} ${f(r.baseHit)} ${f(r.signalHit - r.baseHit)}`
    + ` ${f(r.signalRet, 2)} ${f(r.baseRet, 2)} ${f(r.signalRet - r.baseRet, 2)}`);
}
console.log("\n(means, for comparison — heavily outlier-skewed:)");
for (const r of results) {
  const f = (v) => (v == null ? "n/a" : v.toFixed(2));
  console.log(`  ${r.cls.padEnd(14)} signal ${String(f(r.signalMean)).padStart(8)}%   baseline ${String(f(r.baseMean)).padStart(8)}%`);
}
console.log("\nEquity reference (§4.3, 2,089 stocks): 59.6% hit rate, +12.57% mean over 60 days.");
console.log("Sample sizes here are far smaller — read the episode count before the edge.");
