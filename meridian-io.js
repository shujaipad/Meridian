/**
 * Shared plumbing for the pipeline scripts — CSV reading, numeric coercion, the
 * PostgREST paging loop, and the transient-failure retry.
 *
 * None of this is model logic; that all lives in meridian-engine.js and this file
 * imports nothing from it. What these have in common is that each was copied by hand
 * into three to seven scripts, and copies drift. Two shipped bugs in one week came
 * from exactly that: the sectoral technical row was a third copy of a builder that
 * had gained thirteen columns elsewhere, and the fixture's `select` was a second
 * implementation of PostgREST's that did not project columns. §7.2 rejects duplicate
 * implementations of the model for this reason; the reason applies just as well to a
 * CSV parser.
 *
 * `readAll` matters most. PostgREST caps a response at 1,000 rows and returns the
 * first page WITHOUT an error, so an unpaged read silently drops everything past
 * row 1,000 — the failure this codebase fears most, and there were seven separate
 * hand-written mitigations for it.
 */
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------- CSV
// Quote-aware, because the company master carries fields like
// "Food, Beverages & Tobacco" and a naive split on commas shifts every later column.
export function splitCSVLine(line) {
  const out = [];
  let field = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out;
}

// The `\r$` strips are not decoration: a CRLF file left the last header as
// "Volume\r", so every row's `Volume` read undefined and every volume figure in the
// build was null, with nothing raised anywhere.
export function readCSV(path) {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
  const head = splitCSVLine(lines.shift().replace(/\r$/, ""));
  return lines.map((l) => Object.fromEntries(
    splitCSVLine(l.replace(/\r$/, "")).map((v, i) => [head[i], v])));
}

// ---------------------------------------------------------------- numbers
// An empty CSV cell is absent, not zero. Coercing "" to 0 would put a real reading
// of zero and a missing reading into the same bucket.
export const num = (v) => (v === "" || v == null ? null : Number(v));
export const r4 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 1e4) / 1e4);

/**
 * Rounding for a PRICE, which r4 is not.
 *
 * `r4` is four decimal places, and four decimal places cannot hold SHIB at $0.000005:
 * Math.round(0.000005 * 1e4) is 0. Migration 004 widened the column to numeric(20,10)
 * precisely because 1,807 of SHIB's 1,827 stored bars were a literal zero -- and then
 * the daily fetch went on rounding every bar it wrote to four decimals, which would
 * have put the zeros straight back. A wider column does not help a value that was
 * already destroyed in JavaScript.
 *
 * Fixed decimals are the wrong idea for a universe spanning $0.000005 to ₹162,005.
 * At or above 1 this is r4 exactly, so nothing that works today changes. Below 1 it
 * keeps four significant decimals past the leading zeros, up to the ten the column
 * holds.
 *
 * It also ends a second, quieter problem. A legacy value like 0.70815 sits a hair
 * below the representable halfway point, so Math.round(0.70815 * 1e4) is 7081 while
 * Yahoo's own rounding gave 0.7082 -- a one-step disagreement that the restatement
 * detector read as real, for seven instruments, every night. Keeping five decimals
 * for a sub-1 value preserves it exactly and the disagreement disappears.
 */
export const rPrice = (v) => {
  if (v == null || Number.isNaN(v)) return null;
  const mag = Math.abs(v);
  if (mag >= 1 || mag === 0) return Math.round(v * 1e4) / 1e4;
  const f = 10 ** Math.min(10, 4 + Math.ceil(-Math.log10(mag)));
  return Math.round(v * f) / f;
};
export const r2 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 100) / 100);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- retention
/**
 * How much price history the database keeps. Shared rather than written twice: the
 * nightly prune deletes past this line and a deep re-pull must not write past it,
 * and two copies of the number drift the moment one of them is tuned. ~3 years,
 * deliberately well clear of compute's 800-day read window (see prune_prices.mjs).
 */
export const DEFAULT_RETENTION_DAYS = 1100;

// ---------------------------------------------------------------- paged reads
export const PAGE = 1000;

export function requireOrderBy(table, orderBy) {
  if (!Array.isArray(orderBy) || orderBy.length === 0) {
    throw new Error(
      `reading ${table}: orderBy is required. Paged reads without a total order return `
      + "the right NUMBER of rows and the wrong ones -- duplicates for some keys, "
      + "nothing for others -- and no row count will show it.");
  }
  return orderBy;
}

/**
 * ORDER IS NOT OPTIONAL, and this is the single most expensive thing this file knows.
 *
 * `range(from, to)` is LIMIT/OFFSET. SQL without ORDER BY makes no promise at all
 * about which rows those are, and Postgres genuinely varies it between two identical
 * queries: `synchronize_seqscans` is on by default, so a sequential scan joins an
 * already-running one and starts wherever that one has reached, wrapping around at
 * the end. Fifty-five pages of a fifty-five-thousand-row read are fifty-five separate
 * queries, each free to begin at a different block.
 *
 * The failure that produces is almost undetectable by inspection. The row COUNT is
 * always exactly right -- offsets 0..N walk N rows however the scan is ordered -- so
 * every length check, every "did we get everything" log line, and every row-count
 * assertion passes. What is wrong is the SET: some rows come back twice and the rows
 * that would have taken their place never come back at all.
 *
 * Measured, in production, on the same data two nights running: of the 2,189
 * instruments that hold recent bars, 2026-09-14's read found 1,067 and 2026-09-15's
 * found 1,553. Nothing wrote to prices_daily in between. The 2026-09-15 read
 * returned 54,817 rows, which is to the row the number of bars the committed CSVs
 * hold since 2026-08-01 -- a complete count over an incomplete set, ~40% duplicates. The daily fetch concluded that 637
 * instruments, TCS and ITC and BHARTIARTL among them, had no recent history and
 * needed a five-year re-pull each; the deep-re-pull cap refused, and the job failed.
 *
 * So `orderBy` is required, and must be a key unique per row. Ordering by a
 * non-unique column is the same bug wearing a hat: ties between pages are still
 * unordered.
 *
 * `filter` receives the query builder and returns it with .eq/.gte/.in applied, so
 * callers keep their own predicates without re-implementing the loop.
 *
 * `onPage`, when given, is handed each page and nothing is accumulated — for reads
 * whose result is folded into something smaller anyway (a price array keyed by ISIN,
 * an id map). The 800-day prices_daily window is over two million rows; materialising
 * it and then reducing it holds both at once for no reason.
 */
export async function readAll(db, table, columns, { orderBy, filter, onPage } = {}) {
  requireOrderBy(table, orderBy);
  const out = onPage ? null : [];
  for (let from = 0; ; from += PAGE) {
    let q = db.from(table).select(columns);
    for (const col of orderBy) q = q.order(col);
    if (filter) q = filter(q);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`reading ${table}: ${error.message}`);
    if (onPage) onPage(data); else out.push(...data);
    if (data.length < PAGE) return out;
  }
}

/**
 * Read every row for a set of instruments, a block of instruments at a time.
 *
 * `readAll` pages with OFFSET, which is fine for a few thousand rows and quietly
 * quadratic beyond that: to return rows 800,000-801,000 the database must produce and
 * discard the 800,000 before them, every time. Reading the 800-day price window that
 * way -- 2.1M rows, ~2,100 pages -- got slower with every page until one crossed
 * Supabase's statement timeout and the whole run died with
 * `canceling statement due to statement timeout` at around page 800.
 *
 * Filtering to a small block of universe_ids first bounds the offset to that block's
 * own rows: 25 instruments x ~800 bars is ~20,000 rows, so the deepest offset any
 * single query sees is 20,000 rather than 2,100,000. Same number of requests overall,
 * each one cheap and constant-cost.
 *
 * Row ORDER within an instrument is load-bearing -- computeTechnicalBlock walks the
 * bars as given -- so `orderBy` must end in the date column. It is required here for
 * the same reason as in readAll: a block of 25 instruments is still ~20,000 rows and
 * still pages, and an unordered page boundary inside a block silently duplicates some
 * bars and drops others. Blocking by id cannot disturb a correct order: every row for
 * an instrument falls in exactly one block.
 */
export async function readAllChunked(db, table, columns, { idColumn, ids, orderBy, chunkSize = 25, filter, onPage } = {}) {
  requireOrderBy(table, orderBy);
  const out = onPage ? null : [];
  const list = [...ids];
  for (let i = 0; i < list.length; i += chunkSize) {
    const block = list.slice(i, i + chunkSize);
    for (let from = 0; ; from += PAGE) {
      let q = db.from(table).select(columns).in(idColumn, block);
      for (const col of orderBy) q = q.order(col);
      if (filter) q = filter(q);
      const { data, error } = await q.range(from, from + PAGE - 1);
      if (error) throw new Error(`reading ${table}: ${error.message}`);
      if (onPage) onPage(data); else out.push(...data);
      if (data.length < PAGE) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- retry
// Transport failures are retried; deterministic ones are not. A home connection
// dropping mid-upload aborted the first real load, and every write behind this is an
// upsert on a natural key, so retrying one either lands or is a no-op. A constraint
// violation or a missing column, by contrast, will fail identically every time —
// retrying those only delays the error.
export const TRANSIENT =
  /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|502|503|504|timeout/i;

export async function withRetry(fn, label) {
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
