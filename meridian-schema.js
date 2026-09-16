/**
 * The tables compute_and_publish.mjs replaces wholesale, and the column each one is
 * cleared by.
 *
 * `clearOn` exists because a bare DELETE needs a predicate, and the predicate has to
 * name a column the table actually has. The first version of clear() used `as_of_date`
 * for everything. Four of these five carry that column; market_breadth_daily is keyed
 * by trade_date and does not. So it was quietly left out of the clear list -- deleting
 * it would have errored -- and it has been upserted-only ever since.
 *
 * The consequence is invisible until you count. Each run publishes exactly 500 breadth
 * days, and on 2026-09-16 the table held 508: as the 500-day window slides forward,
 * the dates that fall off the back are never removed. The chart the app draws had
 * eight points in it that the current computation does not produce, and left alone the
 * table grows by one row a night forever.
 *
 * Kept here rather than inline so the same list can be checked against the schema --
 * a `clearOn` column that does not exist on its table is precisely the bug above, and
 * it is a static fact, testable without a database.
 */
export const SNAPSHOT_TABLES = [
  { table: "golden_breakout_candidates", clearOn: "as_of_date", floor: "1900-01-01" },
  { table: "fundamentals_scored",        clearOn: "as_of_date", floor: "1900-01-01" },
  { table: "technicals_daily",           clearOn: "as_of_date", floor: "1900-01-01" },
  { table: "sectoral_technicals_daily",  clearOn: "as_of_date", floor: "1900-01-01" },
  { table: "market_breadth_daily",       clearOn: "trade_date", floor: "1900-01-01" },
];
