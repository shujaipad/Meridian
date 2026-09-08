-- Migration 002 — columns the UI displays but the original schema could not hold.
-- Run once in the SQL Editor. Safe to re-run (every statement is IF NOT EXISTS).
--
-- §6.4's schema was written from the model's needs — the five Golden Breakout
-- gates and the composite score — rather than from the screens. Auditing
-- meridian.jsx against it before building the production frontend found fields the
-- app renders on every row with nowhere to live: the 1D change, the 52-week range,
-- three of the six moving averages, and the RS band and streak that drive the
-- coloured RS pill. Storing them is not optional dressing; without them the
-- production app would be visibly poorer than the prototype.
--
-- Every REVOKE/GRANT from the base schema still applies: these are new columns on
-- existing tables, not new tables, so they inherit those tables' privileges and
-- RLS policies and need no further grants.

alter table technicals_daily
  add column if not exists change_pct       numeric(8, 4),
  add column if not exists high52           numeric(12, 4),
  add column if not exists low52            numeric(12, 4),
  add column if not exists pct_from_high52  numeric(8, 4),
  add column if not exists pct_from_low52   numeric(8, 4),
  -- The engine computes six MAs (3, 8, 30, 50, 100, 200); the schema carried the
  -- three the Golden Breakout model gates on. The other three drive the price-vs-MA
  -- signal grid the Stocks screen renders on every row.
  add column if not exists ma3              numeric(12, 4),
  add column if not exists ma30             numeric(12, 4),
  add column if not exists ma100            numeric(12, 4),
  -- computeRSUniverse returns {rating, band, streakDays, capped}, not a bare number.
  -- rs_rating alone loses the band colour and the "74d" persistence the pill shows —
  -- and band is NOT safely derivable downstream, because deriving it again is the
  -- same duplicate-logic trap that put a wrong FinExempt list in the old workbook.
  add column if not exists rs_band          text,
  add column if not exists rs_streak_days   int,
  add column if not exists rs_capped        boolean;

alter table sectoral_technicals_daily
  add column if not exists constituents     int,
  add column if not exists change_pct       numeric(8, 4),
  add column if not exists rsi              numeric(6, 2),
  add column if not exists rs_rating        numeric(5, 2),
  add column if not exists rs_band          text,
  add column if not exists rs_streak_days   int;

-- Widen the ratios whose denominator can be small. This is the same failure the
-- fundamentals load hit (ROE at 100,489% overflowing numeric(8,4)) and it recurs
-- wherever a percentage divides by something that can approach zero. The rule
-- applied here is which quantities are UNBOUNDED, not which happen to overflow on
-- today's data:
--
--   pct_from_low52   unbounded above. Mrugesh Trading is +18,616% (Rs0.58 -> Rs108.55),
--                    which overflows numeric(8,4) at 10^4. Real microcaps, not bad data.
--   vol_breakout_pct unbounded. Today's max is 2,754%, but a dormant scrip whose
--                    30-day average volume is a handful of shares can trade a
--                    million and print six figures.
--   separation_pct   divides by the 200DMA, which for a sub-rupee scrip is small;
--                    the universe spans Rs0.11 to Rs162,005.
--
-- Deliberately NOT widened, because each is bounded by construction rather than by
-- luck: change_pct (daily, and Indian circuit limits cap it), pct_from_high52
-- (cmp <= high52 always, so it lives in [-100, 0]), rsi (0-100), rs_rating (1-99).
alter table technicals_daily
  alter column pct_from_low52   type numeric(12, 4),
  alter column vol_breakout_pct type numeric(12, 2),
  alter column separation_pct   type numeric(12, 4);

alter table sectoral_technicals_daily
  alter column separation_pct   type numeric(12, 4);

-- Breadth: the engine emits a high/low ratio alongside the counts, and null there
-- is meaningful (no new lows at all — an undefined ratio, not zero), so it is
-- stored rather than derived to keep that distinction intact.
alter table market_breadth_daily
  add column if not exists high_low_ratio   numeric(10, 4);

-- The frontend's first query is "the newest screen", so let it answer that from an
-- index rather than a scan of every row.
create index if not exists technicals_daily_as_of_idx on technicals_daily (as_of_date);
create index if not exists sectoral_technicals_daily_as_of_idx on sectoral_technicals_daily (as_of_date);
create index if not exists golden_breakout_candidates_rank_idx on golden_breakout_candidates (as_of_date, rank);
