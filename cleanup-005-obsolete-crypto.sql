-- Cleanup 005 — retire the five crypto instruments corrected or removed on 2026-09-09.
-- Run once in the SQL Editor, AFTER migrations 003 and 004 and BEFORE reloading.
--
-- load_supabase.mjs upserts the universe on (asset_class, identifier), and identifier
-- IS the Yahoo ticker. Three of these tickers changed and two instruments were removed
-- entirely, so a reload creates the corrected rows and leaves the old ones sitting
-- there — with their price history attached, and a Crypto screen showing both.
--
--   UNI-USD       was labelled Uniswap; it is UNICORN Token       -> UNI7083-USD
--   MATIC-USD     Polygon, frozen at the POL rebrand              -> POL28321-USD
--   USDE-USD      Ethena USDe, series stops 2025-01-19            -> USDE29470-USD
--   CC-USD        was labelled Canton; it is CloudCoin            -> removed (no source)
--   TONCOIN-USD   Toncoin, series stops 2022-10-09                -> removed (2 bars)
--
-- prices_daily, technicals_daily, fundamentals_scored and golden_breakout_candidates
-- all reference universe(id) ON DELETE CASCADE, so this one delete takes their rows
-- with it. Nothing else references them.
--
-- Scoped to asset_class = 'crypto' deliberately: 'CC-USD' and short tickers could
-- plausibly exist in another class, and an unscoped delete on identifier alone is the
-- kind of thing that is only wrong once.

begin;

-- What is about to go, and how much history goes with it.
select u.symbol, u.name, u.identifier, count(p.id) as price_rows
from universe u
left join prices_daily p on p.universe_id = u.id
where u.asset_class = 'crypto'
  and u.identifier in ('UNI-USD','MATIC-USD','USDE-USD','CC-USD','TONCOIN-USD')
group by u.symbol, u.name, u.identifier
order by u.symbol;

delete from universe
where asset_class = 'crypto'
  and identifier in ('UNI-USD','MATIC-USD','USDE-USD','CC-USD','TONCOIN-USD');

-- Should be 0. If it is not, stop and do not commit.
select count(*) as should_be_zero
from universe
where asset_class = 'crypto'
  and identifier in ('UNI-USD','MATIC-USD','USDE-USD','CC-USD','TONCOIN-USD');

commit;
