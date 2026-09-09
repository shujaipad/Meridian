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
 * TWO INPUT MODES. By default it reads the committed CSVs, which is right for a
 * manual run: they are byte-identical to what was loaded and it is far faster.
 * `--from-db` reads prices_daily instead, which is what the DAILY job must use --
 * once daily_fetch.mjs starts appending bars, the CSVs are stale and the database is
 * the truth. Running the scheduled job against the CSVs would recompute yesterday's
 * screens forever while appearing to work perfectly.
 *
 * `--from-db` reads only the trailing window, not all 2.28M rows. Every live signal
 * has a bounded lookback: 200 bars for the 200DMA, 252 for RS Rating and the 52-week
 * range, 500 for the breadth series. 800 calendar days covers ~550 trading days,
 * comfortably past the longest of those, and cuts the read from ~2,280 paged requests
 * to ~1,200. The backtest needs the full five years, but the backtest does not run
 * here.
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
const FROM_DB = process.argv.includes("--from-db");
// See the header: 800 calendar days ≈ 550 trading days, past the 500-bar breadth
// window which is the longest lookback any live signal uses.
const DB_WINDOW_DAYS = 800;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transport failures are retried; deterministic ones are not. A home connection
// dropping mid-upload aborted the first real load, and every write here is an upsert
// on a natural key, so retrying one either lands or is a no-op.
const TRANSIENT = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|502|503|504|timeout/i;

async function withRetry(fn, label) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    let error;
    try { ({ error } = await fn()); }
    catch (e) { error = { message: String(e?.message || e) }; }
    if (!error) return;
    lastError = error;
    if (!TRANSIENT.test(error.message || "") || attempt === 4) break;
    const wait = 2 ** attempt * 1000 + Math.random() * 500;
    console.error(`\n  ${label}: ${error.message} — retrying in ${(wait / 1000).toFixed(1)}s`);
    await sleep(wait);
  }
  throw new Error(`${label}: ${lastError.message}`);
}

async function write(table, rows, { onConflict, label }) {
  if (DRY) { dryWrite(table, rows); console.log(`  ${table}: ${rows.length} rows (dry run)`); return; }
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    try {
      await withRetry(() => (onConflict
        ? db.from(table).upsert(slice, { onConflict })
        : db.from(table).insert(slice)), `${table} ${label} ${i}-${i + BATCH}`);
    } catch (e) {
      console.error(`\n  FAILED: ${e.message}`);
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
if (!FROM_DB) {
  for (const f of readdirSync(BASE).filter((f) => /^meridian-price-history-2090-part\d+of3\.csv$/.test(f)).sort()) {
    for (const r of readCSV(join(BASE, f))) {
      prices.push({ ISIN: r.ISIN, Date: r.Date, High: num(r.High), Low: num(r.Low),
                    Close: num(r.Close), Volume: num(r.Volume) });
    }
  }
}
console.log(`  ${master.length} instruments in the master`);

// The universe_id map is the join key for four of the five tables. Paged, because
// PostgREST caps a response at 1,000 rows and would otherwise silently return only
// the first page — orphaning 1,138 instruments with no error anywhere.
const ids = {};
if (DRY) {
  // Mirror the id order load_supabase.mjs assigns: equities first by ISIN, then each
  // non-equity class by Yahoo ticker. Only equities were seeded here at first, which
  // silently filtered every non-equity row out of the output — 0 technicals for all
  // four classes, with no error, because the filter that drops rows with no
  // universe_id cannot tell "not in the universe" from "not in the test's id map".
  let n = 0;
  master.forEach((m) => { ids[m.ISIN] = ++n; });
  for (const c of [{ dir: "commodities" }, { dir: "currencies" }, { dir: "indices" }, { dir: "crypto" }]) {
    const mp = join(BASE, `meridian-${c.dir}-master.csv`);
    if (existsSync(mp)) readCSV(mp).forEach((m) => { ids[m.YahooTicker] = ++n; });
  }
} else
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("universe").select("id,identifier").range(from, from + 999);
  if (error) { console.error(`reading universe: ${error.message}`); process.exit(1); }
  data.forEach((r) => { ids[r.identifier] = r.id; });
  if (data.length < 1000) break;
}
console.log(`  universe id map: ${Object.keys(ids).length} instruments`);

// --from-db: pull the trailing window for EQUITIES here. The non-equity classes read
// their own slice further down, because each has a separate calendar and its own
// as-of date, and pooling them into one array would lose that distinction.
if (FROM_DB) {
  const cutoff = new Date(Date.now() - DB_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);
  const isinById = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("universe")
      .select("id,identifier").eq("asset_class", "equity").range(from, from + 999);
    if (error) { console.error(`reading equity universe: ${error.message}`); process.exit(1); }
    data.forEach((r) => { isinById[r.id] = r.identifier; });
    if (data.length < 1000) break;
  }
  console.log(`  reading prices_daily since ${cutoff} ...`);
  let n = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("prices_daily")
      .select("universe_id,trade_date,high,low,close,volume")
      .gte("trade_date", cutoff).order("universe_id").order("trade_date")
      .range(from, from + 999);
    if (error) { console.error(`reading prices_daily: ${error.message}`); process.exit(1); }
    for (const r of data) {
      const isin = isinById[r.universe_id];
      if (!isin) continue;                       // a non-equity row; handled per class below
      prices.push({ ISIN: isin, Date: r.trade_date, High: num(r.high), Low: num(r.low),
                    Close: num(r.close), Volume: num(r.volume) });
    }
    n += data.length;
    if (n % 100000 === 0) process.stdout.write(`\r    ${n.toLocaleString()} rows`);
    if (data.length < 1000) break;
  }
  console.log(`\n  ${prices.length.toLocaleString()} equity price rows from the database`);
}
// Check that every EQUITY in the master is present, not that the row counts match.
// The counts stopped matching the moment the four non-equity classes were added —
// 2,240 in Supabase against a 2,138-row equity master is correct, and comparing
// totals turned that into a false "run load_supabase.mjs first".
if (!DRY) {
  const missing = master.filter((m) => !ids[m.ISIN]).map((m) => m.ISIN);
  if (missing.length) {
    console.error(`  ${missing.length} master instrument(s) missing from the Supabase universe `
                + `(e.g. ${missing.slice(0, 3).join(", ")}) — run load_supabase.mjs first`);
    process.exit(1);
  }
  console.log(`  all ${master.length} equity instruments present, `
            + `${Object.keys(ids).length - master.length} non-equity alongside them`);
}

// ---------------------------------------------------------------- compute
const asOf = prices.reduce((m, r) => (r.Date > m ? r.Date : m), "");
console.log(`computing ${prices.length.toLocaleString()} equity price rows, as of ${asOf} ...`);
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

// -------------------------------------------------- non-equity asset classes
// RS Rating is computed WITHIN each class, never across. It is a percentile rank
// against a population (§4.1), and the population has to be comparable — ranking
// Bitcoin's momentum against the Japanese Yen's produces a number with no meaning.
// The prototype already did this by giving each class its own screen; the pipeline
// has to reproduce it deliberately.
//
// These classes get technicals and Golden Breakout only. No fundamentals (there are
// none), no sectoral (no industries), no breadth (a 26-instrument universe has no
// meaningful participation reading).
const ASSET_CLASSES = [
  { dir: "commodities", assetClass: "commodity" },
  { dir: "currencies",  assetClass: "currency" },
  { dir: "indices",     assetClass: "index" },
  { dir: "crypto",      assetClass: "crypto" },
];

for (const c of ASSET_CLASSES) {
  const pricePath = join(BASE, `meridian-${c.dir}-prices.csv`);
  if (!FROM_DB && !existsSync(pricePath)) { console.log(`${c.dir}: no prices file, skipping`); continue; }
  const tickerOf = Object.fromEntries(
    readCSV(join(BASE, `meridian-${c.dir}-master.csv`)).map((m) => [m.Symbol, m.YahooTicker]));

  let rows;
  if (FROM_DB) {
    // Same trailing-window read as equities, scoped to this class's universe_ids.
    // Read per class rather than once for everything, because each class has its own
    // calendar and its own as-of date — pooling them would silently give crypto the
    // indices' date, or vice versa.
    const cutoff = new Date(Date.now() - DB_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);
    const symById = {};
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("universe")
        .select("id,symbol").eq("asset_class", c.assetClass).range(from, from + 999);
      if (error) { console.error(`reading ${c.dir} universe: ${error.message}`); process.exit(1); }
      data.forEach((r) => { symById[r.id] = r.symbol; });
      if (data.length < 1000) break;
    }
    const memberIds = new Set(Object.keys(symById).map(Number));
    rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("prices_daily")
        .select("universe_id,trade_date,high,low,close,volume")
        .in("universe_id", [...memberIds]).gte("trade_date", cutoff)
        .order("universe_id").order("trade_date").range(from, from + 999);
      if (error) { console.error(`reading ${c.dir} prices: ${error.message}`); process.exit(1); }
      for (const r of data) {
        rows.push({ ISIN: symById[r.universe_id], Date: r.trade_date,
                    High: num(r.high), Low: num(r.low), Close: num(r.close), Volume: num(r.volume) });
      }
      if (data.length < 1000) break;
    }
  } else {
    rows = readCSV(pricePath).map((r) => ({
      ISIN: r.Symbol, Date: r.Date,
      High: num(r.High), Low: num(r.Low), Close: num(r.Close), Volume: num(r.Volume),
    }));
  }
  const bySym = {};
  rows.forEach((r) => { (bySym[r.ISIN] ||= []).push(r); });
  const clsRS = computeRSUniverse(closesByKeyFromPrices(rows, "ISIN"));

  const clsComputed = Object.entries(bySym).map(([sym, rws]) => {
    const tech = computeTechnicalBlock(rws);
    return { ISIN: sym, Symbol: sym, Name: sym, tech, fund: null };
  }).filter((x) => x.tech);

  // Each class has its own trading calendar, so its own as-of date. Indices closed
  // 2026-09-08 while crypto has 2026-09-09; one shared date would misreport both.
  const clsAsOf = rows.reduce((m, r) => (r.Date > m ? r.Date : m), "");

  const clsTech = clsComputed.map((x) => {
    const t = x.tech, r = clsRS[x.ISIN] || null;
    return {
      universe_id: ids[tickerOf[x.Symbol]], as_of_date: clsAsOf,
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
      // Null for FX, which has no volume at all — not zero, which would read as
      // "traded nothing today" rather than "this instrument has no volume".
      vol_breakout_pct: r2(t.volBreakoutPct),
      ma200_slope_pct: r4(t.ma200SlopePct), ma200_rising: t.ma200Rising ?? null,
      golden_cross_state: t.goldenCrossState ?? null,
      golden_cross_streak: t.goldenCrossStreak?.streak ?? null,
      separation_pct: r4(t.separationPct),
    };
  }).filter((r) => r.universe_id);

  const clsCandidates = runGoldenBreakoutScreener(clsComputed).map((x, i) => ({
    universe_id: ids[tickerOf[x.Symbol]], as_of_date: clsAsOf, rank: i + 1,
    separation_pct: r4(x.tech.separationPct),
    freshness_days: x.tech.goldenCrossStreak?.streak ?? null,
    vol_breakout_pct: r2(x.tech.volBreakoutPct),
  })).filter((r) => r.universe_id);

  technicals.push(...clsTech);
  candidates.push(...clsCandidates);
  console.log(`  ${c.dir}: ${clsTech.length} technicals, ${clsCandidates.length} candidates, as of ${clsAsOf}`);
}

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
