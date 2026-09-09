-- Run in the Supabase SQL Editor after load_supabase.mjs finishes. Read-only.
-- Every row should read ok = true.
--
-- Rewritten 2026-09-09, for the same reason as verify_screens.sql: the previous
-- version asserted the exact counts of one particular load -- 2,138 universe rows,
-- 2,140,491 prices, 2,089 priced instruments -- and every one of those went stale the
-- moment the four non-equity classes were added. Run today it reported seven of
-- thirteen rows as mismatches on a perfectly good load, which is worse than useless:
-- it teaches you that red rows are noise.
--
-- These are invariants and cross-checks instead. The one place a literal count still
-- appears is where the count IS the assertion (the three revised ISINs), and that one
-- cannot drift with the data.

-- ---- shape ----------------------------------------------------------------------
select 'universe: every row has a class and an identifier type' as check,
       (select count(*) from universe
         where asset_class is null or identifier_type is null)::text as found,
       '0' as expected,
       not exists (select 1 from universe where asset_class is null or identifier_type is null) as ok
union all
select 'universe: identifiers unique within a class',
       (select count(*) from (select asset_class, identifier from universe
                              group by 1,2 having count(*) > 1) d)::text, '0',
       not exists (select 1 from (select asset_class, identifier from universe
                                  group by 1,2 having count(*) > 1) d2)
union all
select 'universe: equities are ISINs, non-equities are Yahoo tickers',
       (select count(*) from universe
         where (asset_class = 'equity') <> (identifier_type = 'isin'))::text, '0',
       not exists (select 1 from universe
                    where (asset_class = 'equity') <> (identifier_type = 'isin'))
union all
select 'universe: all five asset classes present',
       (select count(distinct asset_class) from universe)::text, '5',
       (select count(distinct asset_class) from universe) = 5

-- ---- referential integrity -------------------------------------------------------
union all
select 'prices: no orphan universe_id',
       (select count(*) from prices_daily p
         where not exists (select 1 from universe u where u.id = p.universe_id))::text, '0',
       not exists (select 1 from prices_daily p
                    where not exists (select 1 from universe u where u.id = p.universe_id))
union all
select 'fundamentals: no orphan universe_id',
       (select count(*) from fundamentals_annual f
         where not exists (select 1 from universe u where u.id = f.universe_id))::text, '0',
       not exists (select 1 from fundamentals_annual f
                    where not exists (select 1 from universe u where u.id = f.universe_id))
union all
select 'prices: no duplicate (instrument, date)',
       (select count(*) from (select universe_id, trade_date from prices_daily
                              group by 1,2 having count(*) > 1) d)::text, '0',
       not exists (select 1 from (select universe_id, trade_date from prices_daily
                                  group by 1,2 having count(*) > 1) d2)

-- ---- price sanity ----------------------------------------------------------------
union all
select 'prices: no null close',
       (select count(*) from prices_daily where close is null)::text, '0',
       not exists (select 1 from prices_daily where close is null)
union all
-- Zero is the signature of a price that did not survive its column, not of a market.
-- numeric(12,4) stored Shiba Inu's entire history as 0.0000 -- 1,807 of 1,827 bars --
-- while the source CSV held the correct 7e-06 throughout. Migration 004 widened these
-- to numeric(20,10); this is the check that catches it if a narrower type ever
-- returns.
select 'prices: no non-positive close',
       (select count(*) from prices_daily where close <= 0)::text, '0',
       not exists (select 1 from prices_daily where close <= 0)
union all
select 'prices: high >= low on every bar',
       (select count(*) from prices_daily where high is not null and low is not null
         and high < low)::text, '0',
       not exists (select 1 from prices_daily where high is not null and low is not null
                    and high < low)
union all
-- REPORTED, NOT ASSERTED. Yahoo itself returns bars where the close sits outside its
-- own high/low, on 30 non-equity instruments -- continuous futures and thin FX crosses,
-- where it publishes a settlement close alongside a session high/low that does not
-- cover it. COFFEE has 179 such bars out of 1,257, several with high = low exactly.
-- The fetcher is not the cause: it scales high and low by the same adjustment ratio
-- as the close, so the bar stays internally consistent with whatever Yahoo sent.
--
-- Left as a number to watch rather than a failure, because it cannot pass and asserting
-- it would just train you to ignore a red row. It costs nothing today: `high` and `low`
-- feed only volatilityContractionPct, which §4.3 tested and rejected as a gate and which
-- no screen displays. The 52-week range is computed from CLOSE. If a future feature ever
-- reads high/low, this row is where to start.
select 'bars where Yahoo''s close sits outside its own high/low (informational)',
       (select count(*) from prices_daily where high is not null and low is not null
         and (close > high * 1.0001 or close < low * 0.9999))::text,
       'Yahoo data, no model impact', true

-- ---- the load actually matches the files -----------------------------------------
union all
-- Not a fixed number: every EQUITY that has prices must have at least 200 bars is the
-- rule (§3.1), and the count of exceptions is the interesting figure. It is currently
-- non-zero by a known, recorded deviation (§9 item 3a) -- 109 priced equities sit below
-- the minimum, plus 49 with no prices at all. Left as a reported number rather than a
-- hard failure until that item is decided.
select 'equities below the §3.1 200-bar minimum (see §9 item 3a)',
       (select count(*) from (
          select p.universe_id from prices_daily p join universe u on u.id = p.universe_id
          where u.asset_class = 'equity' group by 1 having count(*) < 200) t)::text,
       'known: 109', true
union all
select 'non-equities below the §3.1 200-bar minimum',
       (select count(*) from (
          select p.universe_id from prices_daily p join universe u on u.id = p.universe_id
          where u.asset_class <> 'equity' group by 1 having count(*) < 200) t)::text,
       '0',
       not exists (select 1 from (
          select p.universe_id from prices_daily p join universe u on u.id = p.universe_id
          where u.asset_class <> 'equity' group by 1 having count(*) < 200) t2)
union all
-- Each class has its own calendar, so each has its own latest bar; what must NOT
-- happen is a class whose newest bar is far behind the newest bar anywhere. That is
-- the signature of a dead ticker, which is how UNI-USD (UNICORN Token, not Uniswap)
-- and four other crypto instruments sat on the screens showing years-old prices.
select 'no asset class stalled more than 7 days behind the newest bar',
       (select count(*) from (
          select u.asset_class from prices_daily p join universe u on u.id = p.universe_id
          group by u.asset_class
          having max(p.trade_date) < (select max(trade_date) from prices_daily) - 7) t)::text,
       '0',
       not exists (select 1 from (
          select u.asset_class from prices_daily p join universe u on u.id = p.universe_id
          group by u.asset_class
          having max(p.trade_date) < (select max(trade_date) from prices_daily) - 7) t2)
union all
-- The three ISIN revisions corrected on 2026-09-07. If the ISINs were reverted or the
-- wrong file loaded, these lose their fundamentals silently -- no error, just three
-- companies quietly unscored. A literal 3 is right here: it is the assertion.
select 'revised-ISIN companies carry fundamentals',
       (select count(*) from (
          select u.id from universe u join fundamentals_annual f on f.universe_id = u.id
          where u.identifier in ('INE419M01035','INE811A01038','INE0LZF01039')
          group by u.id) t)::text,
       '3',
       (select count(*) from (
          select u.id from universe u join fundamentals_annual f on f.universe_id = u.id
          where u.identifier in ('INE419M01035','INE811A01038','INE0LZF01039')
          group by u.id) t2) = 3
order by 1;
