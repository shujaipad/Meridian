-- Migration 004 — widen the price columns so a sub-cent instrument survives storage.
-- Run once in the SQL Editor. Safe to re-run (ALTER ... TYPE to the same type is a
-- no-op in effect, though it does rewrite the table).
--
-- `numeric(12, 4)` cannot represent a price below 0.00005: it rounds to 0.0000. That
-- is not a rounding nuisance, it is total data loss for one instrument. Shiba Inu
-- trades around $0.000005, so 1,808 of its 1,827 stored bars were the literal value
-- zero, and every technical derived from them -- all six moving averages, RSI, the
-- 52-week range, the golden-cross state -- was computed over a series of zeros and
-- rendered on the Crypto screen as though it meant something.
--
-- The source CSV was correct throughout (Yahoo returns 7e-06 and the fetcher stores
-- it faithfully). The loss happened at the column, which is why check_data_integrity.py
-- reported the file clean while verify_load.sql found 1,857 non-positive closes in the
-- loaded rows. Two guards disagreeing is what surfaced it; neither would have alone.
--
-- numeric(20, 10) holds ten integer digits and ten decimals: the costliest equity in
-- the universe (Rs 162,005) and a token at 0.0000000001 both fit exactly. numeric is
-- arbitrary-precision and stores only the digits present, so widening the declaration
-- costs nothing for the 2.28M rows that were already fine.
--
-- AFTER RUNNING THIS, the crypto prices must be reloaded: the zeros are already
-- written, and widening a column cannot recover digits the old type discarded.
--   node load_supabase.mjs        (idempotent; upserts on universe_id, trade_date)

alter table prices_daily
  alter column high  type numeric(20, 10),
  alter column low   type numeric(20, 10),
  alter column close type numeric(20, 10);

-- The same floor applies to every derived price the screens display. An instrument
-- whose close rounds to zero has moving averages that round to zero too.
alter table technicals_daily
  alter column cmp    type numeric(20, 10),
  alter column high52 type numeric(20, 10),
  alter column low52  type numeric(20, 10),
  alter column ma3    type numeric(20, 10),
  alter column ma8    type numeric(20, 10),
  alter column ma30   type numeric(20, 10),
  alter column ma50   type numeric(20, 10),
  alter column ma100  type numeric(20, 10),
  alter column ma200  type numeric(20, 10);

-- Sectoral indices are all based at 100 and cannot go sub-cent in practice, but they
-- run through the identical row builder and screen components, so they get the
-- identical types. A column that differs only where nobody has looked yet is how the
-- sectoral table came to hold thirteen of twenty-six columns in the first place.
alter table sectoral_technicals_daily
  alter column cmp    type numeric(20, 10),
  alter column high52 type numeric(20, 10),
  alter column low52  type numeric(20, 10),
  alter column ma3    type numeric(20, 10),
  alter column ma8    type numeric(20, 10),
  alter column ma30   type numeric(20, 10),
  alter column ma50   type numeric(20, 10),
  alter column ma100  type numeric(20, 10),
  alter column ma200  type numeric(20, 10);
