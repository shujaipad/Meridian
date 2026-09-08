/**
 * Compute every screen with the engine and publish it to Supabase (§6.3).
 *
 * This is the compute half of the nightly job, written to run by hand until the
 * VPS exists. §6.2 requires Meridian to display rather than compute, and the
 * frontend physically cannot compute: deriving the screens needs 2.1M price rows
 * (~110MB) and several seconds of CPU per pass. So the screens are computed here
 * and the app reads the results.
 *
 * Writes technicals_daily, sectoral_technicals_daily, fundamentals_scored,
 * golden_breakout_candidates and market_breadth_daily.
 *
 *   export SUPABASE_URL="https://<project>.supabase.co"
 *   export SUPABASE_SERVICE_ROLE_KEY="<service_role key>"
 *   node --max-old-space-size=6144 compute_and_publish.mjs
 *
 * Reads the committed CSVs rather than reading 2.1M rows back out of Supabase --
 * they are byte-identical to what was loaded (verify_load.sql agrees on all 12
 * counts) and it is far faster. The VPS version reads from prices_daily instead,
 * because by then the CSVs will be stale and the database will be the truth.
 *
 * SNAPSHOT SEMANTICS. Four of these five tables hold one row per instrument for
 * ONE date, not history (§6.4) -- so a re-run must replace, not accumulate. Each
 * is emptied inside the same run that refills it. That is a deliberate simplifying
 * choice for a manual job: the staging-table-and-atomic-swap of §6.3 exists so the
 * NIGHTLY job never shows a half-written screen to a live reader, and belongs with
 * the VPS work. Running this by hand against a live app would show empty screens
 * for a few seconds. market_breadth_daily is genuine history and is upserted by
 * date instead.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bandOfRSRating, closesByKeyFromPrices, computeAll, computeBreadthSeries,
  computeFundamentalScores, computeRSUniverse, computeSectoralSeries,
  computeTechnicalBlock, runGoldenBreakoutScreener,
} from "./meridian-engine.js";

const BASE = dirname(fileURLToPath(import.meta.url));
const BATCH = 500;

// --dry-run shapes every row as the real run would and writes TSV instead of
// sending, so the output can be COPYed into a Postgres holding the real schema.
// That is what proves the rows FIT -- a numeric overflow or a jsonb the column
// rejects is otherwise found only partway through writing to a live project.
const DRY = process.argv.includes("--dry-run");
const DRY_DIR = join(BASE, "dryrun-screens");

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!DRY && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  process.exit(1);
}
let db = null;
if (!DRY) {
  const { createClient } = await import("@supabase/supabase-js");
  db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

// Postgres text-format COPY: \N is NULL, and tab/newline/backslash must be escaped
// or a jsonb payload containing one would silently shift every later column.
function tsvCell(v) {
  if (v === null || v === undefined) return "\\N";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}
function dryWrite(table, rows) {
  if (!existsSync(DRY_DIR)) mkdirSync(DRY_DIR, { recursive: true });
  const cols = rows.length ? Object.keys(rows[0]) : [];
  writeFileSync(join(DRY_DIR, `${table}.cols`), cols.join(","));
  writeFileSync(join(DRY_DIR, `${table}.tsv`),
    rows.map((r) => cols.map((c) => tsvCell(r[c])).join("\t")).join("\n") + (rows.length ? "\n" : ""));
}

// ---------------------------------------------------------------- csv
function splitCSVLine(line) {
  const out = []; let f = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(f); f = ""; }
    else f += c;
  }
  out.push(f); return out;
}
function readCSV(path) {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
  const head = splitCSVLine(lines.shift().replace(/\r$/, ""));
  return lines.map((l) => Object.fromEntries(
    splitCSVLine(l.replace(/\r$/, "")).map((v, i) => [head[i], v])));
}
const num = (v) => (v === "" || v == null ? null : Number(v));
const r4 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 1e4) / 1e4);
const r2 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 100) / 100);

async function write(table, rows, { onConflict, label }) {
  if (DRY) { dryWrite(table, rows); console.log(`  ${table}: ${rows.length} rows (dry run)`); return; }
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const q = db.from(table);
    const { error } = onConflict
      ? await q.upsert(slice, { onConflict })
      : await q.insert(slice);
    if (error) {
      console.error(`\n  FAILED writing ${table} (${label} ${i}-${i + BATCH}): ${error.message}`);
      if (error.details) console.error(`  details: ${error.details}`);
      process.exit(1);
    }
    process.stdout.write(`\r  ${table}: ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  console.log("");
}

async function clear(table) {
  if (DRY) return;
  // Snapshot tables are replaced wholesale. A bare delete needs a predicate, and
  // one that is true for every row is the honest way to say "all of them".
  const { error } = await db.from(table).delete().gte("as_of_date", "1900-01-01");
  if (error) { console.error(`clearing ${table}: ${error.message}`); process.exit(1); }
}

// ---------------------------------------------------------------- inputs
console.log("reading inputs...");
const master = readCSV(join(BASE, "meridian-company-master-2138.csv"))
  .map((m) => ({ ...m, MarketCap: num(m.MarketCap) }));
const fundamentals = readCSV(join(BASE, "meridian-fundamentals-742.csv")).map((f) => ({
  ISIN: f.ISIN, FY: f.FY, ROE_Pct: num(f.ROE_Pct), ROCE_Pct: num(f.ROCE_Pct),
  DebtEquity: num(f.DebtEquity), EPS: num(f.EPS), Sales: num(f.Sales),
  FixedAssets: num(f.FixedAssets), CWIP: num(f.CWIP),
}));
const prices = [];
for (const f of readdirSync(BASE).filter((f) => /^meridian-price-history-2090-part\d+of3\.csv$/.test(f)).sort()) {
  for (const r of readCSV(join(BASE, f))) {
    prices.push({ ISIN: r.ISIN, Date: r.Date, High: num(r.High), Low: num(r.Low),
                  Close: num(r.Close), Volume: num(r.Volume) });
  }
}
const asOf = prices.reduce((m, r) => (r.Date > m ? r.Date : m), "");
console.log(`  ${master.length} instruments, ${prices.length.toLocaleString()} price rows, as of ${asOf}`);

// The universe_id map is the join key for four of the five tables. Paged, because
// PostgREST caps a response at 1,000 rows and would otherwise silently return only
// the first page — orphaning 1,138 instruments with no error anywhere.
const ids = {};
if (DRY) {
  master.forEach((m, i) => { ids[m.ISIN] = i + 1; });
} else
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("universe").select("id,identifier").range(from, from + 999);
  if (error) { console.error(`reading universe: ${error.message}`); process.exit(1); }
  data.forEach((r) => { ids[r.identifier] = r.id; });
  if (data.length < 1000) break;
}
console.log(`  universe id map: ${Object.keys(ids).length} instruments`);
if (!DRY && Object.keys(ids).length !== master.length) {
  console.error(`  universe in Supabase (${Object.keys(ids).length}) != master (${master.length}) — run load_supabase.mjs first`);
  process.exit(1);
}

// ---------------------------------------------------------------- compute
console.log("computing (the same engine the app used to run in-browser)...");
const computed = computeAll(master, fundamentals, prices);
const closesById = closesByKeyFromPrices(prices, "ISIN");
const rs = computeRSUniverse(closesById);
const scores = computeFundamentalScores(computed);

const technicals = computed.filter((s) => s.tech).map((s) => {
  const t = s.tech, r = rs[s.ISIN] || null;
  return {
    universe_id: ids[s.ISIN], as_of_date: asOf,
    cmp: r4(t.cmp), change_pct: r4(t.changePct),
    high52: r4(t.high52), low52: r4(t.low52),
    pct_from_high52: r4(t.pctFromHigh52), pct_from_low52: r4(t.pctFromLow52),
    ma3: r4(t.mas?.[3]), ma8: r4(t.mas?.[8]), ma30: r4(t.mas?.[30]),
    ma50: r4(t.mas?.[50]), ma100: r4(t.mas?.[100]), ma200: r4(t.mas?.[200]),
    rsi: r2(t.rsi),
    s_signals: t.sSignals ?? null, m_signals: t.mSignals ?? null,
    s_streaks: t.sStreaks ?? null, m_streaks: t.mStreaks ?? null,
    rs_rating: r?.rating ?? null, rs_band: r?.band ?? null,
    rs_streak_days: r?.streakDays ?? null, rs_capped: r?.capped ?? null,
    vol_breakout_pct: r2(t.volBreakoutPct),
    ma200_slope_pct: r4(t.ma200SlopePct), ma200_rising: t.ma200Rising ?? null,
    golden_cross_state: t.goldenCrossState ?? null,
    golden_cross_streak: t.goldenCrossStreak?.streak ?? null,
    separation_pct: r4(t.separationPct),
  };
});

const scored = computed.filter((s) => scores[s.ISIN]?.score != null).map((s) => ({
  universe_id: ids[s.ISIN], as_of_date: asOf,
  composite_score: r2(scores[s.ISIN].score),
  tier: scores[s.ISIN].tier,
  // The whole fundamental block as jsonb: the app renders per-metric avg3, lastYr,
  // variation and improvement/deterioration flags, and flattening that into columns
  // would be 28 of them for data nothing filters or sorts on.
  per_metric: { ...s.fund, exempt: scores[s.ISIN].exempt },
}));

const candidates = runGoldenBreakoutScreener(computed).map((c, i) => ({
  universe_id: ids[c.ISIN], as_of_date: asOf, rank: i + 1,
  separation_pct: r4(c.tech.separationPct),
  freshness_days: c.tech.goldenCrossStreak?.streak ?? null,
  vol_breakout_pct: r2(c.tech.volBreakoutPct),
}));

console.log("computing sectoral...");
const seriesBySector = computeSectoralSeries(master, prices);
const sectorNames = Object.keys(seriesBySector);
const constituents = {};
master.forEach((m) => {
  if (m.Sector && closesById[m.ISIN]?.length) constituents[m.Sector] = (constituents[m.Sector] || 0) + 1;
});
const rsSector = computeRSUniverse(Object.fromEntries(
  sectorNames.map((n) => [n, seriesBySector[n].map((r) => r.Close)])));
const sectoral = sectorNames.map((name) => {
  const t = computeTechnicalBlock(seriesBySector[name]);
  const r = rsSector[name] || null;
  return {
    industry_group: name, as_of_date: asOf,
    constituents: constituents[name] ?? 0,
    cmp: r4(t?.cmp), change_pct: r4(t?.changePct), rsi: r2(t?.rsi),
    ma8: r4(t?.mas?.[8]), ma50: r4(t?.mas?.[50]), ma200: r4(t?.mas?.[200]),
    ma200_slope_pct: r4(t?.ma200SlopePct), ma200_rising: t?.ma200Rising ?? null,
    golden_cross_state: t?.goldenCrossState ?? null,
    golden_cross_streak: t?.goldenCrossStreak?.streak ?? null,
    separation_pct: r4(t?.separationPct),
    rs_rating: r?.rating ?? null, rs_band: r?.band ?? null, rs_streak_days: r?.streakDays ?? null,
  };
});

console.log("computing breadth...");
const allDates = Array.from(new Set(prices.map((r) => r.Date))).sort();
const maxLen = Math.max(0, ...Object.values(closesById).map((a) => a.length));
const breadth = (computeBreadthSeries(computed, closesById) || []).map((b) => ({
  trade_date: allDates[allDates.length - maxLen + b.dayIndex] ?? null,
  pct_above_200dma: r2(b.pctAbove200),
  pct_above_200dma_ma30: r2(b.pctAbove200MA30),
  pct_above_200dma_ma100: r2(b.pctAbove200MA100),
  pct_above_200dma_ma200: r2(b.pctAbove200MA200),
  new_highs: b.newHighs, new_lows: b.newLows,
  high_low_ratio: b.hlRatio == null ? null : r4(b.hlRatio),
})).filter((b) => b.trade_date);

console.log(`  technicals ${technicals.length} | scored ${scored.length} | candidates ${candidates.length} `
          + `| sectoral ${sectoral.length} | breadth ${breadth.length}`);

// ---------------------------------------------------------------- publish
console.log("publishing...");
for (const t of ["golden_breakout_candidates", "fundamentals_scored", "technicals_daily", "sectoral_technicals_daily"]) {
  await clear(t);
}
await write("technicals_daily", technicals, { onConflict: "universe_id", label: "rows" });
await write("fundamentals_scored", scored, { onConflict: "universe_id", label: "rows" });
await write("golden_breakout_candidates", candidates, { onConflict: "universe_id", label: "rows" });
await write("sectoral_technicals_daily", sectoral, { onConflict: "industry_group", label: "rows" });
await write("market_breadth_daily", breadth, { onConflict: "trade_date", label: "rows" });

console.log(`\npublished screens as of ${asOf}. Verify with verify_screens.sql.`);
