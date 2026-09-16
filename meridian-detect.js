/**
 * The two restatement detectors the daily fetch runs against every instrument, kept
 * apart from the job itself so they can be tested without a network or a database.
 *
 * Their job is to answer one question per instrument: has the history we already hold
 * become wrong? A missed restatement is silent and permanent -- the corrupted series
 * is perfectly well-formed and nothing downstream complains -- so the bar for saying
 * "no" is high. But the bar for saying "yes" matters just as much, and that is what
 * the first version of this got wrong: on 2026-09-15 it flagged 1,009 of 2,238
 * instruments for a five-year re-pull, the cap refused, and the night's prices never
 * landed. 972 of those 1,009 were false.
 */

/** Yahoo timestamps are UTC seconds; a bar belongs to its exchange's LOCAL date. */
export function exchangeDateFormatter(result) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: result?.meta?.exchangeTimezoneName || "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
}

/**
 * DETECTOR 1 — an explicit dividend or split we cannot already have absorbed.
 *
 * The events feed returns every dividend and split in the requested range, and the
 * range is a month. Across 2,238 instruments a month holds ~335 ex-dividend dates,
 * every one of them ordinary and every one of them already reflected in the prices we
 * stored: an adjustment applied before our newest stored bar was applied to the fetch
 * that produced that bar. Counting them all was not a detector, it was a calendar --
 * it flagged 335 instruments on a quiet Tuesday and by itself would have exceeded the
 * re-pull cap twice over.
 *
 * What cannot already be absorbed is an event dated AFTER our newest stored bar. That
 * one rescaled every bar before it, including bars we hold, and we have not refetched
 * since.
 *
 * Returns the event date when there is one to act on, else null. An instrument with
 * no stored bars returns null: "we hold nothing" is a different finding with a
 * different remedy, and the caller reports it separately rather than calling a
 * first-ever fetch a corporate action.
 */
export function unabsorbedEventDate(result, newestStored) {
  if (!newestStored) return null;
  const ev = result?.events || {};
  const fmt = exchangeDateFormatter(result);
  let latest = null;
  for (const e of [...Object.values(ev.dividends || {}), ...Object.values(ev.splits || {})]) {
    if (typeof e?.date !== "number") continue;
    const d = fmt.format(new Date(e.date * 1000));
    if (latest === null || d > latest) latest = d;
  }
  return latest !== null && latest > newestStored ? latest : null;
}

/**
 * DETECTOR 2 — the stored close and the freshly fetched close disagree on a date we
 * already hold. Authoritative, because it answers WHETHER the history moved whatever
 * the cause: a late or missing event record, an event during an outage, a continuous
 * futures contract rolling, or Yahoo simply correcting a bad bar.
 *
 * COMPARE LIKE WITH LIKE. Everything this pipeline writes goes through r4 -- four
 * decimals -- but the original five-year load did not, so ~5 instruments still hold
 * values like 0.330915 and 9.463849. Against a relative epsilon of 1e-6 the rounding
 * alone reads as a restatement: |0.330915 - 0.3309| / 0.330915 is 4.5e-5, forty-five
 * times the threshold, for two numbers that are the same number. Those instruments
 * would have been re-pulled every night forever. Rounding the stored value the same
 * way the fetched one was rounded removes the entire class exactly, rather than
 * hiding it under a looser epsilon.
 *
 * The epsilon that remains guards float noise, not precision: after both sides are
 * at four decimals a real difference is at least 1e-4, and noise is ~1e-12. The
 * smallest restatement worth catching is far above either -- measured across a year
 * of adjustments, median 0.29% and p90 2.06%.
 *
 * Returns { date, was, now } for the first disagreeing date, else null.
 */
export const RESTATEMENT_ABS_TOL = 5e-5;   // half a step at four decimals
export const RESTATEMENT_REL_TOL = 1e-4;   // 0.01%, ~30x below the median restatement

export function restatementOf(bars, have, r4) {
  for (const b of bars) {
    const prev = have[b.date];
    if (prev == null) continue;                 // a new bar, not an overlap
    const was = r4(Number(prev));
    if (was == null || b.close == null) continue;
    const diff = Math.abs(b.close - was);
    if (diff > Math.max(RESTATEMENT_ABS_TOL, RESTATEMENT_REL_TOL * Math.abs(was))) {
      return { date: b.date, was: prev, now: b.close };
    }
  }
  return null;
}

/**
 * How many instruments the nightly job may deep re-pull before it refuses and reports.
 *
 * The cap guards a SYSTEMIC signal -- a feed change, a wholesale re-adjustment, a
 * partial load -- and "systemic" is a rate. A flat count silently assumes the job ran
 * last night: one night of arrears and a handful of ordinary corporate actions are
 * the same number, but eleven nights of arrears carry eleven nights of them. The flat
 * 150 would have refused that catch-up, which is to say the guard would have become
 * the reason the pipeline stayed broken while looking like the reason it was safe.
 *
 * 40 per trading day is generous against what this universe measurably produces: 335
 * ex-dividend dates across a month, so ~15 a day. The floor keeps a normal night's
 * headroom; the ceiling still refuses the 1,009 of 2026-09-15 without hesitating.
 */
export const REPULL_PER_TRADING_DAY = 40;
export const REPULL_FLOOR = 150;
export const REPULL_CEILING = 400;

export function deepRepullCap(tradingArrears) {
  const days = Math.max(1, Math.ceil(tradingArrears || 1));
  return Math.min(REPULL_CEILING, Math.max(REPULL_FLOOR, REPULL_PER_TRADING_DAY * days));
}

/** Calendar days between a YYYY-MM-DD and now, converted to trading days at 5/7. */
export function tradingArrearsSince(dateStr, now = Date.now()) {
  if (!dateStr) return 1;
  const calendar = Math.max(1, Math.round((now - Date.parse(`${dateStr}T00:00:00Z`)) / 86400_000));
  return Math.max(1, Math.ceil(calendar * 5 / 7));
}

/** The middle newest-stored-bar date across instruments, robust to a few dead scrips. */
export function medianNewestStored(storedBy) {
  const newest = Object.values(storedBy)
    .map((byDate) => Object.keys(byDate).reduce((a, b) => (b > a ? b : a), ""))
    .filter(Boolean)
    .sort();
  return newest.length ? newest[Math.floor(newest.length / 2)] : null;
}
