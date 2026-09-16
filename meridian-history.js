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
