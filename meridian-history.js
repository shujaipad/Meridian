/**
 * Reading the committed price history the way anything downstream should read it.
 *
 * The files are a base plus a sequence of immutable per-run appends (see
 * append_history.mjs for why that shape and what the alternatives measured). That is
 * only useful if everyone agrees on how to fold them back together, so the rule lives
 * here as code rather than in prose someone has to re-implement:
 *
 *   base CSVs, then every history/appends file in FILENAME ORDER,
 *   and the LAST value for a (Key, Date) wins.
 *
 * Last-wins is what makes one mechanism carry two meanings. A new bar collides with
 * nothing, so order is irrelevant to it. A correction from a deep re-pull is meant to
 * overwrite what is already there, and arriving later is exactly how it does that.
 */

/** Fold an ordered sequence of row batches into one array, last value per key winning. */
export function mergeRows(batches, { keyOf = (r) => `${r.Key}|${r.Date}` } = {}) {
  const out = new Map();
  for (const batch of batches) for (const r of batch) out.set(keyOf(r), r);
  return [...out.values()];
}

/**
 * The newest date held, PER ASSET CLASS.
 *
 * Per class and not one global maximum, because the classes genuinely differ: the
 * committed equity history ends 2026-09-04 and the four non-equity files end
 * 2026-09-09. A single watermark at the later date would skip five days of equity bars
 * — and skip them invisibly, because a gap in a price CSV looks exactly like a market
 * holiday.
 */
export function newestByClass(rows, { classOf = (r) => r.AssetClass, dateOf = (r) => r.Date } = {}) {
  const wm = {};
  for (const r of rows) {
    const c = classOf(r), d = dateOf(r);
    if (!c || !d) continue;
    if (!wm[c] || d > wm[c]) wm[c] = d;
  }
  return wm;
}

/** The next free immutable filename for a run: today's, then .2, .3 — never a rewrite. */
export function nextAppendName(date, exists) {
  if (!exists(`${date}.csv`)) return `${date}.csv`;
  for (let n = 2; ; n++) if (!exists(`${date}.${n}.csv`)) return `${date}.${n}.csv`;
}

// ---------------------------------------------------------------- reading the files
/**
 * These two walk a CSV as TEXT, never as parsed rows. The equity base files hold 2.1
 * million bars between them and readCSV would build an object per bar — several
 * hundred megabytes of garbage to answer a question that is one string comparison per
 * line. They live here rather than inside append_history.mjs so they can be tested
 * without a database, which is the same reason barsOf moved (§11l).
 *
 * Field positions differ by file and are passed in: the base files are
 * `ISIN,Date,...` and `Symbol,Date,...` (key 0, date 1), the appends are
 * `AssetClass,Key,Date,...` (key 1, date 2).
 */
function eachLine(text, fn) {
  let from = text.indexOf("\n") + 1;                        // skip the header
  while (from > 0 && from < text.length) {
    const end = text.indexOf("\n", from);
    const line = text.slice(from, end === -1 ? text.length : end);
    if (line) fn(line);
    if (end === -1) break;
    from = end + 1;
  }
}

/** The i-th comma-separated field, without splitting the whole line. */
function field(line, i) {
  let start = 0;
  for (let n = 0; n < i; n++) {
    const c = line.indexOf(",", start);
    if (c === -1) return "";
    start = c + 1;
  }
  const end = line.indexOf(",", start);
  return line.slice(start, end === -1 ? line.length : end);
}

/** The newest date in a CSV, by string comparison on ISO dates. */
export function maxDateIn(text, dateField) {
  let max = "";
  eachLine(text, (line) => {
    const d = field(line, dateField);
    if (d > max) max = d;
  });
  return max;
}

/**
 * The `Key|Date` of every bar in a CSV dated on or after `since`, as a Set.
 *
 * This is what makes the mirror able to notice a bar it never received. A date
 * watermark can only ask "is this newer than the furthest I have got", which is the
 * wrong question when a bar arrives late for a day already passed — and that question
 * cost the mirror ~27,000 equity bars over three weeks (§11r).
 *
 * The date is checked before the key is extracted, so the 2.1 million bars outside the
 * window cost one comparison and no allocation.
 */
export function heldKeys(text, { keyField, dateField, since, into = new Set() } = {}) {
  eachLine(text, (line) => {
    const d = field(line, dateField);
    if (d < since) return;
    into.add(`${field(line, keyField)}|${d}`);
  });
  return into;
}

/** `days` before `today`, as an ISO date. Pure so the window is testable. */
export function windowStart(today, days) {
  const t = Date.parse(`${today}T00:00:00Z`);
  return new Date(t - days * 86400_000).toISOString().slice(0, 10);
}
