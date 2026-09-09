-- Migration 003 — give sectoral_technicals_daily the same technical row as equities.
-- Run once in the SQL Editor. Safe to re-run (every statement is IF NOT EXISTS).
--
-- The Sectoral screen is not a reduced view of a stock. It renders the SAME
-- component grid as the Stocks screen: six price-vs-MA pills (S3/S8/S30/S50/S100/
-- S200), four MA-vs-MA pills (M3/M8/M30/M100), the 52-week range, and all six
-- moving averages in its expanded row. The table held thirteen columns of the
-- twenty-six that row needs, so in production every signal pill rendered inactive
-- (grey, never green) and MA3, MA30, MA100 and the 52-week range came out blank.
--
-- Nothing was miscomputed. computeTechnicalBlock produces the whole block for a
-- synthetic industry index exactly as it does for a stock -- the pipeline threw
-- two thirds of it away on the way to the database, because the sectoral row was
-- written by hand as a third copy of a row builder the equity and non-equity paths
-- also each had their own copy of. Migration 002 audited meridian.jsx against
-- technicals_daily and fixed precisely this gap there; it did not repeat the audit
-- for the sectoral table, which renders the same fields. compute_and_publish.mjs
-- now builds all three from one function, so the copies cannot drift again.
--
-- Every REVOKE/GRANT from the base schema still applies: these are new columns on
-- an existing table, so they inherit its privileges and RLS policy.

alter table sectoral_technicals_daily
  -- The 52-week range shown in the expanded row.
  add column if not exists high52           numeric(12, 4),
  add column if not exists low52            numeric(12, 4),
  add column if not exists pct_from_high52  numeric(8, 4),
  -- Unbounded above, by the same rule migration 002 applied to technicals_daily:
  -- an equal-weighted industry index that has multiplied off a low base is not
  -- capped at 10^4. Bounded quantities (pct_from_high52, change_pct, rsi,
  -- rs_rating) keep their narrow types.
  add column if not exists pct_from_low52   numeric(12, 4),
  -- Three of the six MAs the screen prints. The table carried 8/50/200 because
  -- those are what the Golden Breakout model gates on; the screen shows all six.
  add column if not exists ma3              numeric(12, 4),
  add column if not exists ma30             numeric(12, 4),
  add column if not exists ma100            numeric(12, 4),
  -- The signal grid itself. Without these every pill is inactive -- which does not
  -- read as "missing data" to someone looking at the screen, it reads as an
  -- industry with no signals at all. A wrong answer, not an absent one.
  add column if not exists s_signals        jsonb,
  add column if not exists m_signals        jsonb,
  add column if not exists s_streaks        jsonb,
  add column if not exists m_streaks        jsonb,
  -- Completes the RS pill: 002 added rating, band and streak but not the cap flag.
  add column if not exists rs_capped        boolean,
  -- Rendered by the Sectoral Breakout screen, which is fed from these same rows.
  add column if not exists vol_breakout_pct numeric(12, 2);
