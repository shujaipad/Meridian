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

-- RUN THESE THREE SEPARATELY, not as one block. Supabase's SQL Editor displays only
-- the LAST result set of a multi-statement run, so pasting all of this at once hides
-- the preview -- which is the only part that lets you check what is about to go before
-- it goes. A delete you cannot see the input to is not reviewable.

-- ---- RUN 1: look before you delete -------------------------------------------
-- Expect exactly five rows: CC, MATIC, TON, UNI, USDE. Anything else, stop.
select u.symbol, u.name, u.identifier, count(p.id) as price_rows
from universe u
left join prices_daily p on p.universe_id = u.id
where u.asset_class = 'crypto'
  and u.identifier in ('UNI-USD','MATIC-USD','USDE-USD','CC-USD','TONCOIN-USD')
group by u.symbol, u.name, u.identifier
order by u.symbol;

-- ---- RUN 2: delete -----------------------------------------------------------
-- A single DELETE is atomic on its own; no explicit transaction is needed. Expect 5
-- rows affected. prices_daily, technicals_daily, fundamentals_scored and
-- golden_breakout_candidates all cascade from universe(id), so their rows go too.
delete from universe
where asset_class = 'crypto'
  and identifier in ('UNI-USD','MATIC-USD','USDE-USD','CC-USD','TONCOIN-USD');

-- ---- RUN 3: verify -----------------------------------------------------------
-- should_be_zero = 0, crypto_left = 21, universe_total = 2235.
-- The last two look low on purpose: the three CORRECTED instruments do not exist yet
-- under their new tickers. load_supabase.mjs creates them, taking crypto to 24 and the
-- universe to 2,238.
select
  (select count(*) from universe
    where asset_class='crypto'
      and identifier in ('UNI-USD','MATIC-USD','USDE-USD','CC-USD','TONCOIN-USD')) as should_be_zero,
  (select count(*) from universe where asset_class='crypto') as crypto_left,
  (select count(*) from universe) as universe_total;
