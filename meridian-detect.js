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

/**
 * THE NEWEST BARS ARE NOT EVIDENCE. The job runs at 14:30 UTC, which is 10:30 in New
 * York: every commodity, index, FX pair and crypto bar it writes is an intraday
 * snapshot of a session still in progress. Yahoo settles them hours later, and the
 * next night's comparison finds a value that moved -- correctly, expectedly, and by
 * about a percent.
 *
 * That is not hypothetical. Of the 91 restatements the 2026-09-16 run reported, 86
 * fell on exactly two dates: 2026-09-09, the last bar in the committed non-equity
 * CSVs, and 2026-09-15, the last bar the previous run appended. Both were written
 * mid-session. Between them they accounted for every commodity, every currency,
 * every index and every crypto instrument in the universe -- flagged for a five-year
 * re-pull, every night, forever, for the crime of having been fetched before the
 * close.
 *
 * So bars newer than the settlement window are excluded here, and the caller
 * re-writes them instead: an upsert of the settled value costs one row and fixes the
 * thing a re-pull was being asked to fix. Excluding them delays a genuine
 * restatement on a recent date by a day or two; it never loses one, because the bar
 * ages out of the window and is compared like any other.
 */
export const SETTLEMENT_DAYS = 4;          // covers a Friday bar compared on Monday

export function unsettledFrom(now = Date.now()) {
  return new Date(now - SETTLEMENT_DAYS * 86400_000).toISOString().slice(0, 10);
}

export function restatementOf(bars, have, round, { settledBefore } = {}) {
  for (const b of bars) {
    if (settledBefore && b.date >= settledBefore) continue;   // still moving, by design
    const prev = have[b.date];
    if (prev == null) continue;                 // a new bar, not an overlap
    const was = round(Number(prev));
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
 * the same number, but eleven nights of arrears carry eleven nights of them. A flat
 * 150 would have refused that catch-up, which is to say the guard would have become
 * the reason the pipeline stayed broken while looking like the reason it was safe.
 *
 * Two terms, and the binding one says what "systemic" means:
 *
 *   RATE  0.07 per instrument-day of arrears. Measured on 2026-09-16, the real rate
 *         was 0.024 -- 254 flags from ~10,600 instrument-days -- so this carries a
 *         factor of three. A fully caught-up universe of ~2,200 lands on the floor,
 *         which is where a flat 150 was right all along.
 *   SHARE 20% of the universe in one night, whatever the arrears. A feed change or a
 *         partial load moves everything, not a fifth of everything; 1,009 of 2,238 is
 *         45% and stays refused. This is the term that actually bites.
 *
 * The truncation case -- an empty prices_daily -- reduces arrears to zero, so the cap
 * falls to the floor and 2,240 flags are refused. The 50%-of-universe guard above the
 * sweep catches it first in any case.
 */
export const REPULL_RATE = 0.07;           // per instrument-day of arrears
export const REPULL_FLOOR = 150;
export const REPULL_CEILING_SHARE = 0.20;  // of the universe, in one night

export function deepRepullCap(instrumentDaysOfArrears, universeSize) {
  const ceiling = Math.max(REPULL_FLOOR, Math.round(universeSize * REPULL_CEILING_SHARE));
  const allowed = Math.max(REPULL_FLOOR, Math.round(REPULL_RATE * (instrumentDaysOfArrears || 0)));
  return Math.min(ceiling, allowed);
}

/**
 * Total instrument-days of arrears: for every instrument that holds history, how many
 * trading days behind it is, summed.
 *
 * The median was the obvious measure and it was wrong. A partially-completed run
 * leaves a bimodal universe -- half of it caught up to yesterday, half still eleven
 * days behind -- and the median lands on whichever half is larger while the flags all
 * come from the other one. On 2026-09-16 the median said four days of arrears and 149
 * of the 163 corporate actions came from instruments nine days behind.
 *
 * Summing is also the honest model: each instrument-day carries its own independent
 * chance of a dividend, a split or a restatement, so the number of flags to expect
 * scales with the total, not with any one instrument's lag.
 */
export function arrearsInstrumentDays(storedBy, now = Date.now()) {
  let total = 0;
  for (const byDate of Object.values(storedBy)) {
    const newest = Object.keys(byDate).reduce((a, b) => (b > a ? b : a), "");
    if (newest) total += tradingArrearsSince(newest, now);
  }
  return total;
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
