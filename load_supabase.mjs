/**
 * One-time initial load of the committed CSVs into Supabase (§6.4).
 *
 * Run this on YOUR machine, not from a Claude Code session: it needs the
 * service_role key, which bypasses RLS entirely and must never pass through a
 * chat transcript.
 *
 *   npm i @supabase/supabase-js
 *   export SUPABASE_URL="https://<project>.supabase.co"
 *   export SUPABASE_SERVICE_ROLE_KEY="<service_role key>"
 *   node --max-old-space-size=4096 load_supabase.mjs
 *
 * Loads, in dependency order: universe (2,138) -> fundamentals_annual (~6,485)
 * -> prices_daily (2,140,491). The last one is the long pole; expect 15-40
 * minutes depending on your connection.
 *
 * Design points that matter:
 *
 *   * RESUMABLE. Progress is written to load_supabase_progress.json after every
 *     committed batch. An interrupted run continues rather than restarting, which
 *     matters when the third table takes half an hour.
 *   * IDEMPOTENT. Every write is an upsert on the table's natural key, so a
 *     re-run repairs rather than duplicates. Re-running the whole thing after a
 *     data correction is a supported operation, not a recovery procedure.
 *   * STREAMED. The price files are 130MB across three parts. They are read line
 *     by line and flushed per batch rather than parsed into one array, because
 *     2.1M row objects held at once is roughly 2GB of heap.
 *   * FAILURES ARE LOUD. A failed batch aborts with the server's message and the
 *     progress file left intact. It never advances past a batch it could not
 *     write -- the same rule the daily job lives by (§7.3).
 *
 * Windows notes, from the first real run (2026-09-08):
 *
 *   * `npm i` fails with "running scripts is disabled on this system". That is
 *     PowerShell's default execution policy refusing npm's .ps1 shim, not a
 *     problem with npm or the machine. Use `npm.cmd i @supabase/supabase-js`,
 *     which sidesteps it without changing any system setting.
 *   * Environment variables are set with `$env:NAME="value"`, and live only in
 *     that PowerShell window.
 *   * Confirm the key took without printing it: `$env:SUPABASE_SERVICE_ROLE_KEY.Length`
 *     should be a few hundred characters.
 *
 * Measured on the first real run: 2,140,491 price rows in 3.6 minutes to Supabase
 * Mumbai from an Indian connection -- comfortably inside the 15-40 minutes
 * estimated, and a direct dividend of the region choice (§6.8).
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = dirname(fileURLToPath(import.meta.url));
const PROGRESS = join(BASE,
  process.argv.includes("--dry-run") ? "dryrun-progress.json" : "load_supabase_progress.json");

const MASTER = join(BASE, "meridian-company-master-2138.csv");
// The four non-equity classes (§3.2a). Keyed by Yahoo ticker rather than ISIN,
// because that is the only identifier they have — hence `identifier_type` on the
// universe table, which existed for exactly this from the start.
const ASSET_CLASSES = [
  { dir: "commodities", assetClass: "commodity", sectorField: "Category" },
  { dir: "currencies",  assetClass: "currency",  sectorField: null },
  { dir: "indices",     assetClass: "index",     sectorField: "Region" },
  { dir: "crypto",      assetClass: "crypto",    sectorField: null },
];
const FUNDAMENTALS = join(BASE, "meridian-fundamentals-742.csv");
const PRICE_PARTS = [1, 2, 3].map((i) =>
  join(BASE, `meridian-price-history-2090-part${i}of3.csv`));

// 1000 keeps each request well inside PostgREST's default statement timeout on
// the free tier. Larger batches are faster right up until one times out, and a
// timeout mid-load costs more than the throughput saved.
const BATCH = 1000;

// --dry-run shapes every row exactly as the real run would and writes it to TSV
// instead of sending it, so the output can be COPYed into a Postgres carrying the
// real schema. That is what proves 2.1M rows actually FIT -- three ratio columns
// overflowed numeric(8,4) on this very data, and finding that 80% through a
// half-hour load against a live project would be a bad way to learn it.
const DRY = process.argv.includes("--dry-run");
const DRY_DIR = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1] : join(BASE, "dryrun");

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!DRY && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  console.error("The service_role key bypasses RLS — keep it in your shell, not in a file you commit.");
  process.exit(1);
}
// Imported dynamically so --dry-run needs no dependencies at all: the dry run's
// whole point is to be runnable anywhere, including where @supabase/supabase-js
// is not installed.
let db = null;
if (!DRY) {
  const { createClient } = await import("@supabase/supabase-js");
  db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

const tsv = (v) => (v === null || v === undefined ? "\\N" : String(v));
const dryStreams = {};
function dryWrite(table, rows) {
  if (!rows.length) return;
  if (!existsSync(DRY_DIR)) mkdirSync(DRY_DIR, { recursive: true });
  const cols = Object.keys(rows[0]);
  if (!dryStreams[table]) {
    dryStreams[table] = { cols, fd: createWriteStream(join(DRY_DIR, `${table}.tsv`)) };
    writeFileSync(join(DRY_DIR, `${table}.cols`), cols.join(","));
  }
  const { fd } = dryStreams[table];
  fd.write(rows.map((r) => cols.map((c) => tsv(r[c])).join("\t")).join("\n") + "\n");
}

const progress = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, "utf8")) : {};
const save = () => writeFileSync(PROGRESS, JSON.stringify(progress, null, 2));

const num = (v) => (v === "" || v == null ? null : Number(v));
const int = (v) => (v === "" || v == null ? null : Math.round(Number(v)));

// 75 master rows carry quoted fields with embedded commas ("Food, Beverages &
// Tobacco"), so a split(",") would corrupt them.
function splitCSVLine(line) {
  const out = [];
  let field = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out;
}

function readCSV(path) {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
  const head = splitCSVLine(lines.shift().replace(/\r$/, ""));
  return lines.map((l) => Object.fromEntries(
    splitCSVLine(l.replace(/\r$/, "")).map((v, i) => [head[i], v])));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A dropped connection is not a reason to abandon a 2.3-million-row upload. Uploading
// this much over a home connection makes a transient TCP reset near-certain at some
// point, and the first real run hit exactly that: ECONNRESET partway through part 2,
// aborting the whole job. Every write here is an upsert on a natural key, so retrying
// one is always safe — it either lands or is a no-op.
//
// Retried only for TRANSPORT failures. A constraint violation, a bad column or a
// rejected key is deterministic: retrying it just fails four more times slowly and
// buries the real message. Those still abort immediately.
const TRANSIENT = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|502|503|504|timeout/i;

async function upsert(table, rows, onConflict, label) {
  if (DRY) { dryWrite(table, rows); return; }
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    let error;
    try {
      ({ error } = await db.from(table).upsert(rows, { onConflict, count: "exact" }));
    } catch (e) {
      // supabase-js surfaces some transport failures as a thrown TypeError rather
      // than an error field, so both shapes have to be caught.
      error = { message: String(e?.message || e) };
    }
    if (!error) return;
    lastError = error;
    const transient = TRANSIENT.test(error.message || "");
    if (!transient || attempt === 4) break;
    const wait = 2 ** attempt * 1000 + Math.random() * 500;
    console.error(`\n  ${table}: ${error.message} — retrying in ${(wait / 1000).toFixed(1)}s `
                + `(attempt ${attempt + 2}/5)`);
    await sleep(wait);
  }
  console.error(`\n  FAILED writing ${label} to ${table}: ${lastError.message}`);
  if (lastError.details) console.error(`  details: ${lastError.details}`);
  console.error(`  Progress kept in ${PROGRESS} — fix the cause and re-run to continue.`);
  process.exit(1);
}

// ---------------------------------------------------------- non-equity universe
async function loadAssetClassUniverse() {
  const rows = [];
  for (const c of ASSET_CLASSES) {
    const path = join(BASE, `meridian-${c.dir}-master.csv`);
    if (!existsSync(path)) { console.log(`  ${c.dir}: no master, skipping`); continue; }
    for (const m of readCSV(path)) {
      rows.push({
        asset_class: c.assetClass,
        identifier_type: "yahoo_ticker",
        identifier: m.YahooTicker,
        symbol: m.Symbol,
        name: m.Name,
        // Commodities carry a Category and indices a Region; both are the natural
        // grouping for their class, and both land in the same column the equity
        // universe uses for Industry Name.
        sector: c.sectorField ? (m[c.sectorField] || null) : null,
        industry_group: null,
        market_cap: null,
        status: "active",
      });
    }
  }
  console.log(`non-equity universe: ${rows.length} instruments`);
  for (let i = 0; i < rows.length; i += BATCH) {
    await upsert("universe", rows.slice(i, i + BATCH), "asset_class,identifier", `rows ${i}`);
  }
  console.log("  done");
}

async function loadAssetClassPrices(ids) {
  for (const c of ASSET_CLASSES) {
    const path = join(BASE, `meridian-${c.dir}-prices.csv`);
    if (!existsSync(path)) continue;
    if (progress[`prices-${c.dir}`] === "complete") { console.log(`prices ${c.dir}: already complete`); continue; }
    // Yahoo ticker, not symbol: `ids` is keyed by the universe table's `identifier`,
    // and two classes could otherwise collide on a short symbol.
    const tickerOf = Object.fromEntries(
      readCSV(join(BASE, `meridian-${c.dir}-master.csv`)).map((m) => [m.Symbol, m.YahooTicker]));
    const rows = readCSV(path).map((r) => ({
      universe_id: ids[tickerOf[r.Symbol]], trade_date: r.Date,
      high: num(r.High), low: num(r.Low), close: num(r.Close), volume: int(r.Volume),
    })).filter((r) => r.universe_id);
    console.log(`prices ${c.dir}: ${rows.length.toLocaleString()} rows`);
    for (let i = 0; i < rows.length; i += BATCH) {
      await upsert("prices_daily", rows.slice(i, i + BATCH), "universe_id,trade_date", `${c.dir} ${i}`);
      process.stdout.write(`\r  ${c.dir}: ${Math.min(i + BATCH, rows.length).toLocaleString()}/${rows.length.toLocaleString()}`);
    }
    progress[`prices-${c.dir}`] = "complete"; save();
    console.log("");
  }
}

// ---------------------------------------------------------------- universe
async function loadUniverse() {
  const master = readCSV(MASTER);
  console.log(`universe: ${master.length} instruments`);
  const rows = master.map((m) => ({
    asset_class: "equity",
    identifier_type: "isin",
    identifier: m.ISIN,
    symbol: m.Symbol,
    name: m.Name,
    sector: m.Sector || null,             // granular Industry Name (§4.5)
    industry_group: m.IndustryGroup || null,
    market_cap: num(m.MarketCap),
    status: "active",
  }));
  for (let i = 0; i < rows.length; i += BATCH) {
    await upsert("universe", rows.slice(i, i + BATCH),
                 "asset_class,identifier", `rows ${i}-${i + BATCH}`);
    process.stdout.write(`\r  upserted ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  console.log("\n  done");
}

// The rest of the load joins on universe_id, so every row needs the ISIN -> id
// map. Paged, because PostgREST caps a single response at 1,000 rows and silently
// returns only the first page otherwise — which would orphan 1,138 instruments.
async function idByIsin() {
  if (DRY) {
    const map = {};
    let n = 0;
    readCSV(MASTER).forEach((m) => { map[m.ISIN] = ++n; });
    for (const c of ASSET_CLASSES) {
      const path = join(BASE, `meridian-${c.dir}-master.csv`);
      if (existsSync(path)) readCSV(path).forEach((m) => { map[m.YahooTicker] = ++n; });
    }
    return map;
  }
  const map = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("universe")
      .select("id,identifier").range(from, from + 999);
    if (error) { console.error(`reading universe: ${error.message}`); process.exit(1); }
    data.forEach((r) => { map[r.identifier] = r.id; });
    if (data.length < 1000) break;
  }
  return map;
}

// ------------------------------------------------------------ fundamentals
async function loadFundamentals(ids) {
  const rows = [], skipped = new Set();
  for (const f of readCSV(FUNDAMENTALS)) {
    const id = ids[f.ISIN];
    if (!id) { skipped.add(f.ISIN); continue; }
    rows.push({
      universe_id: id, fiscal_year: f.FY,
      roe_pct: num(f.ROE_Pct), roce_pct: num(f.ROCE_Pct), debt_equity: num(f.DebtEquity),
      eps: num(f.EPS), sales: num(f.Sales),
      fixed_assets: num(f.FixedAssets), cwip: num(f.CWIP),
    });
  }
  console.log(`fundamentals: ${rows.length} rows` +
    (skipped.size ? `  (skipped ${skipped.size} ISIN(s) outside the universe: ${[...skipped].join(", ")})` : ""));
  for (let i = 0; i < rows.length; i += BATCH) {
    await upsert("fundamentals_annual", rows.slice(i, i + BATCH),
                 "universe_id,fiscal_year", `rows ${i}-${i + BATCH}`);
    process.stdout.write(`\r  upserted ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  console.log("\n  done");
}

// ------------------------------------------------------------------ prices
async function loadPrices(ids) {
  progress.prices ||= {};
  for (const path of PRICE_PARTS) {
    const name = path.split("/").pop();
    const done = progress.prices[name] ?? 0;
    if (done === "complete") { console.log(`prices ${name}: already complete, skipping`); continue; }

    console.log(`prices ${name}: resuming from row ${done}`);
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    let head = null, n = 0, batch = [], written = done;

    for await (const line of rl) {
      if (line.trim() === "") continue;
      if (!head) { head = splitCSVLine(line.replace(/\r$/, "")); continue; }
      n++;
      if (n <= done) continue;                    // already committed on an earlier run
      const c = splitCSVLine(line.replace(/\r$/, ""));
      const r = Object.fromEntries(c.map((v, i) => [head[i], v]));
      const id = ids[r.ISIN];
      if (!id) continue;                          // guarded against by check_data_integrity
      batch.push({
        universe_id: id, trade_date: r.Date,
        high: num(r.High), low: num(r.Low), close: num(r.Close), volume: int(r.Volume),
      });
      if (batch.length >= BATCH) {
        await upsert("prices_daily", batch, "universe_id,trade_date", `${name} row ~${n}`);
        written += batch.length; batch = [];
        progress.prices[name] = n; save();
        process.stdout.write(`\r  ${name}: ${n.toLocaleString()} rows`);
      }
    }
    if (batch.length) {
      await upsert("prices_daily", batch, "universe_id,trade_date", `${name} tail`);
      written += batch.length;
    }
    progress.prices[name] = "complete"; save();
    console.log(`\r  ${name}: ${n.toLocaleString()} rows read, ${written.toLocaleString()} written`);
  }
}

// -------------------------------------------------------------------- main
const t0 = Date.now();
if (progress.universe !== "complete") {
  await loadUniverse(); progress.universe = "complete"; save();
} else console.log("universe: already complete, skipping");

if (progress.assetUniverse !== "complete") {
  await loadAssetClassUniverse(); progress.assetUniverse = "complete"; save();
} else console.log("non-equity universe: already complete, skipping");

const ids = await idByIsin();
console.log(`universe id map: ${Object.keys(ids).length} instruments`);

if (progress.fundamentals !== "complete") {
  await loadFundamentals(ids); progress.fundamentals = "complete"; save();
} else console.log("fundamentals: already complete, skipping");

await loadPrices(ids);
await loadAssetClassPrices(ids);

console.log(`\nloaded in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
console.log("Verify with verify_load.sql in the Supabase SQL Editor.");
