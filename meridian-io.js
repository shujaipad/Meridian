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
export const r2 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 100) / 100);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- paged reads
export const PAGE = 1000;

/**
 * Read every row of a table, one 1,000-row page at a time.
 *
 * `filter` receives the query builder and returns it with .eq/.gte/.in/.order
 * applied, so callers keep their own predicates without re-implementing the loop.
 *
 * `onPage`, when given, is handed each page and nothing is accumulated — for reads
 * whose result is folded into something smaller anyway (a price array keyed by ISIN,
 * an id map). The 800-day prices_daily window is over two million rows; materialising
 * it and then reducing it holds both at once for no reason.
 */
export async function readAll(db, table, columns, { filter, onPage } = {}) {
  const out = onPage ? null : [];
  for (let from = 0; ; from += PAGE) {
    let q = db.from(table).select(columns).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
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
 * bars as given -- so callers must keep their .order("trade_date"). Blocking by id
 * cannot disturb that: every row for an instrument falls in exactly one block.
 */
export async function readAllChunked(db, table, columns, { idColumn, ids, chunkSize = 25, filter, onPage } = {}) {
  const out = onPage ? null : [];
  const list = [...ids];
  for (let i = 0; i < list.length; i += chunkSize) {
    const block = list.slice(i, i + chunkSize);
    for (let from = 0; ; from += PAGE) {
      let q = db.from(table).select(columns).in(idColumn, block).range(from, from + PAGE - 1);
      if (filter) q = filter(q);
      const { data, error } = await q;
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
