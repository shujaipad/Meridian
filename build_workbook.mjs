/**
 * Stage 1 of the workbook build — compute every screen via the real engine.
 *
 * Emits workbook-data.json for build_workbook.py to format. The split is
 * deliberate: the model must come from meridian-engine.js and nowhere else.
 *
 * The old workbook was formula-driven end to end ("no hardcoded results"), and
 * that is precisely what broke it — its financial-sector exemption enumerated 11
 * industries in an OR() formula while the engine had 12, so it silently
 * mis-scored Bajaj Finserv, Aditya Birla Capital and Cholamandalam Financial
 * Holdings. A workbook that re-derives the model in Excel is a THIRD
 * implementation alongside the JS engine and the Python backtest, and §7.2
 * rejected exactly that. So every model output here is a value produced by the
 * same code the app runs; build_workbook.py adds formulas only where they
 * recalculate something meaningful and cannot disagree with the model.
 *
 * Usage: node build_workbook.mjs [--out workbook-data.json]
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { num, r2 } from "./meridian-io.js";

import {
  computeAll,
  computeRSUniverse,
  closesByKeyFromPrices,
  computeFundamentalScores,
  computeSectoralSeries,
  computeTechnicalBlock,
  computeBreadthSeries,
  runGoldenBreakoutScreener,
  GOLDEN_BREAKOUT_PARAMS,
} from "./meridian-engine.js";

const BASE = dirname(fileURLToPath(import.meta.url));
const OUT = join(BASE, "workbook-data.json");

// 75 master rows carry quoted fields with embedded commas ("Food, Beverages &
// Tobacco"), so a split(",") would corrupt them.
function parseCSV(text) {
  const rows = [];
  let field = "", row = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length && r.some((v) => v !== ""))
             .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}


console.error("reading inputs...");
const master = parseCSV(readFileSync(join(BASE, "meridian-company-master-2138.csv"), "utf8"))
  .map((m) => ({ ...m, MarketCap: num(m.MarketCap) }));

const fundamentals = parseCSV(readFileSync(join(BASE, "meridian-fundamentals-742.csv"), "utf8"))
  .map((f) => ({
    ISIN: f.ISIN, FY: f.FY,
    ROE_Pct: num(f.ROE_Pct), ROCE_Pct: num(f.ROCE_Pct), DebtEquity: num(f.DebtEquity),
    EPS: num(f.EPS), Sales: num(f.Sales), FixedAssets: num(f.FixedAssets), CWIP: num(f.CWIP),
  }));

const prices = [];
for (const f of readdirSync(BASE).filter((f) => /^meridian-price-history-2090-part\d+of3\.csv$/.test(f)).sort()) {
  for (const r of parseCSV(readFileSync(join(BASE, f), "utf8"))) {
    prices.push({ ISIN: r.ISIN, Date: r.Date, High: num(r.High), Low: num(r.Low),
                  Close: num(r.Close), Volume: num(r.Volume) });
  }
}
const asOf = prices.reduce((m, r) => (r.Date > m ? r.Date : m), "");
console.error(`  ${master.length} instruments, ${prices.length} price rows, as of ${asOf}`);

console.error("computing (same engine the app runs)...");
const computed = computeAll(master, fundamentals, prices);
const closesById = closesByKeyFromPrices(prices, "ISIN");
const rs = computeRSUniverse(closesById);
const fundScores = computeFundamentalScores(computed);

const stocks = computed.map((s) => {
  const t = s.tech || {}, f = s.fund || {}, fs = fundScores[s.ISIN] || {};
  // computeRSUniverse returns an OBJECT per id ({rating, band, streakDays, capped}),
  // not a bare number. Destructure it — passing the object into bandOfRSRating compares
  // an object against numbers, which is silently false and bands everything "green".
  const r = rs[s.ISIN] || null;
  return {
    ISIN: s.ISIN, Symbol: s.Symbol, Name: s.Name,
    Industry: s.Sector, SectorGroup: s.IndustryGroup, MarketCap: s.MarketCap,
    CMP: r2(t.cmp), ChangePct: r2(t.changePct),
    RSRating: r?.rating ?? null, RSBand: r?.band ?? null, RSStreakDays: r?.streakDays ?? null,
    RSI: r2(t.rsi),
    MA8: r2(t.mas?.[8]), MA50: r2(t.mas?.[50]), MA200: r2(t.mas?.[200]),
    High52: r2(t.high52), Low52: r2(t.low52),
    VolBreakoutPct: r2(t.volBreakoutPct),
    MA200SlopePct: r2(t.ma200SlopePct), MA200Rising: t.ma200Rising ?? null,
    // The two price-vs-MA gates, emitted so the workbook can reproduce the whole
    // five-gate funnel in-sheet and cross-check it against the screener's own output.
    PriceAbove50DMA: t.sSignals?.[50] ?? null, PriceAbove8DMA: t.sSignals?.[8] ?? null,
    GoldenCrossState: t.goldenCrossState ?? null,
    GoldenCrossStreak: t.goldenCrossStreak?.streak ?? null,
    SeparationPct: r2(t.separationPct),
    FundScore: r2(fs.score), FundTier: fs.tier ?? null, FinExempt: fs.exempt ?? null,
    ROE3yr: r2(f.roe?.avg3), ROCE3yr: r2(f.roce?.avg3),
    EPSGrowth3yr: r2(f.epsGrowth?.avg3), SalesGrowth3yr: r2(f.salesGrowth?.avg3),
    DebtEquity: r2(f.debtEquity?.lastYr), AssetTurns: r2(f.assetTurns?.lastYr),
    CWIPPct: r2(f.cwipPct),
  };
});

const gbCols = (c) => ({
  ISIN: c.ISIN, Symbol: c.Symbol, Name: c.Name, Industry: c.Sector,
  CMP: r2(c.tech.cmp), ChangePct: r2(c.tech.changePct),
  SeparationPct: r2(c.tech.separationPct),
  FreshnessDays: c.tech.goldenCrossStreak?.streak ?? null,
  MA200SlopePct: r2(c.tech.ma200SlopePct),
  VolBreakoutPct: r2(c.tech.volBreakoutPct),
  FundScore: r2((fundScores[c.ISIN] || {}).score), FundTier: (fundScores[c.ISIN] || {}).tier ?? null,
});
const breakout = runGoldenBreakoutScreener(computed).map(gbCols);

console.error("computing sectoral...");
const seriesBySector = computeSectoralSeries(master, prices);
// computeSectoralSeries returns only the synthetic index series, not how many stocks
// built it. Recount the same way it grouped — master rows in the industry that actually
// carry price history — so the workbook can show the depth behind each index.
const constituentsBySector = {};
master.forEach((m) => {
  if (m.Sector && closesById[m.ISIN]?.length) constituentsBySector[m.Sector] = (constituentsBySector[m.Sector] || 0) + 1;
});
const sectorNames = Object.keys(seriesBySector);
const closesBySector = Object.fromEntries(sectorNames.map((n) => [n, seriesBySector[n].map((r) => r.Close)]));
const rsSector = computeRSUniverse(closesBySector);
const sectoralComputed = sectorNames.map((name) => {
  const tech = computeTechnicalBlock(seriesBySector[name]);
  return { ISIN: name, Name: name, Symbol: name, Sector: name,
           tech: tech ? { ...tech, rs: rsSector[name] || null } : tech, fund: null };
});
const sectoral = sectoralComputed.map((s) => ({
  Industry: s.Name, Constituents: constituentsBySector[s.Name] ?? 0,
  IndexLevel: r2(s.tech?.cmp), ChangePct: r2(s.tech?.changePct),
  RSRating: s.tech?.rs?.rating ?? null, RSBand: s.tech?.rs?.band ?? null,
  RSStreakDays: s.tech?.rs?.streakDays ?? null, RSI: r2(s.tech?.rsi),
  MA50: r2(s.tech?.mas?.[50]), MA200: r2(s.tech?.mas?.[200]),
  MA200SlopePct: r2(s.tech?.ma200SlopePct),
  GoldenCrossState: s.tech?.goldenCrossState ?? null,
  GoldenCrossStreak: s.tech?.goldenCrossStreak?.streak ?? null,
  SeparationPct: r2(s.tech?.separationPct),
}));
const sectoralBreakout = runGoldenBreakoutScreener(sectoralComputed).map((c) => ({
  Industry: c.Name, IndexLevel: r2(c.tech.cmp), ChangePct: r2(c.tech.changePct),
  SeparationPct: r2(c.tech.separationPct),
  FreshnessDays: c.tech.goldenCrossStreak?.streak ?? null,
  MA200SlopePct: r2(c.tech.ma200SlopePct),
}));

console.error("computing breadth...");
// The engine indexes breadth by position on a right-aligned grid (dayIndex), which is all
// the on-screen chart needs. A worksheet row needs a real date, so map the index back onto
// the trailing end of the universe's sorted trading calendar — the same right-alignment
// computeBreadthSeries itself assumes.
const allDates = Array.from(new Set(prices.map((r) => r.Date))).sort();
const maxLen = Math.max(0, ...Object.values(closesById).map((a) => a.length));
const dateOfIndex = (i) => allDates[allDates.length - maxLen + i] ?? null;
const breadth = (computeBreadthSeries(computed, closesById) || []).map((b) => ({
  Date: dateOfIndex(b.dayIndex),
  PctAbove200DMA: r2(b.pctAbove200),
  MA30: r2(b.pctAbove200MA30), MA100: r2(b.pctAbove200MA100), MA200: r2(b.pctAbove200MA200),
  NewHighs: b.newHighs, NewLows: b.newLows,
  HighLowRatio: b.hlRatio == null ? null : r2(b.hlRatio),
}));

const payload = {
  meta: {
    as_of: asOf,
    generated_at: new Date().toISOString(),
    universe_count: master.length,
    priced_count: Object.keys(closesById).length,
    gates: GOLDEN_BREAKOUT_PARAMS,
  },
  universe: master.map((m) => ({
    ISIN: m.ISIN, Symbol: m.Symbol, Name: m.Name, Industry: m.Sector,
    SectorGroup: m.IndustryGroup, MarketCap: m.MarketCap,
    NSECode: m.NSECode, BSECode: m.BSECode,
  })),
  stocks, breakout, sectoral, sectoralBreakout, breadth,
};

// JSON.stringify silently omits keys whose value is undefined, which would leave the 49
// instruments with no price history carrying fewer fields than the rest. Anything reading
// the file positionally would then be quietly misaligned.
for (const [name, rows] of Object.entries({ stocks, breakout, sectoral, sectoralBreakout, breadth })) {
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  for (const r of rows) for (const k of keys) if (r[k] === undefined) r[k] = null;
  const ragged = rows.filter((r) => Object.keys(r).length !== keys.size).length;
  if (ragged) throw new Error(`${name}: ${ragged} ragged rows`);
}

writeFileSync(process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : OUT,
              JSON.stringify(payload));
console.error(`wrote ${OUT}`);
console.error(`  stocks ${stocks.length} | breakout ${breakout.length} | sectoral ${sectoral.length} `
            + `| sectoral breakout ${sectoralBreakout.length} | breadth ${breadth.length}`);
