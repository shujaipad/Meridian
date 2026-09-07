-- Run in the Supabase SQL Editor after load_supabase.mjs finishes.
-- Read-only. Every row should read found = expected.
--
-- The counts are not round numbers picked for neatness; each is the figure the
-- committed CSVs and check_data_integrity.py agree on, so a mismatch means the
-- load dropped something rather than that the expectation drifted.

select 'universe rows' as check, count(*)::text as found, '2138' as expected from universe
union all
select 'universe: all equity, all isin', count(*)::text, '2138' from universe
  where asset_class='equity' and identifier_type='isin' and status='active'
union all
select 'universe: distinct ISINs', count(distinct identifier)::text, '2138' from universe
union all
select 'price rows', count(*)::text, '2140491' from prices_daily
union all
select 'instruments with prices', count(distinct universe_id)::text, '2089' from prices_daily
union all
select 'latest trade_date', max(trade_date)::text, '2026-09-04' from prices_daily
union all
select 'earliest trade_date', min(trade_date)::text, '2021-09-06' from prices_daily
union all
select 'prices: any non-positive close', count(*)::text, '0' from prices_daily where close <= 0
union all
select 'prices: any null close', count(*)::text, '0' from prices_daily where close is null
union all
select 'fundamentals rows', count(*)::text, '6477' from fundamentals_annual
union all
select 'instruments with fundamentals', count(distinct universe_id)::text, '1648'
  from fundamentals_annual
union all
-- The three ISIN revisions corrected on 2026-09-07. If the ISINs were reverted or
-- the wrong file was loaded, these lose their fundamentals silently -- no error,
-- just three companies quietly unscored.
select 'revised-ISIN companies carry fundamentals', count(*)::text, '3' from (
  select u.id from universe u
  join fundamentals_annual f on f.universe_id = u.id
  where u.identifier in ('INE419M01035','INE811A01038','INE0LZF01039')
  group by u.id) t
union all
select 'instruments clearing the 200-bar rule (§3.1)', count(*)::text, '1980' from (
  select universe_id from prices_daily group by universe_id having count(*) >= 200) t
order by 1;
