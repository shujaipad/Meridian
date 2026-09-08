-- Run in the Supabase SQL Editor after compute_and_publish.mjs.
-- Read-only. Every row should read found = expected.
--
-- The expectations are the figures meridian.xlsx was built from by the same engine
-- on the same data, so a mismatch means the publish dropped or mangled something
-- rather than that an expectation drifted.

select 'technicals rows' as check, count(*)::text as found, '2089' as expected from technicals_daily
union all
select 'technicals as_of', max(as_of_date)::text, '2026-09-04' from technicals_daily
union all
select 'fundamentals scored', count(*)::text, '1648' from fundamentals_scored
union all
-- Quintiles are assigned by population rank, not by fixed score thresholds (§4.2),
-- so the sizes follow from the scored count: 1,648 x 0.2 = 329.6, which puts 330 in
-- High and Good, 329 in Average and Poor. These are not round numbers by accident,
-- and they moved when the ISIN fix took the scored population from 1,645 to 1,648.
select 'tier: High', count(*)::text, '330' from fundamentals_scored where tier='High'
union all
select 'tier: Poor', count(*)::text, '329' from fundamentals_scored where tier='Poor'
union all
select 'tiers sum to the scored population',
  (select count(*)::text from fundamentals_scored where tier is not null),
  (select count(*)::text from fundamentals_scored)
union all
select 'golden breakout candidates', count(*)::text, '12' from golden_breakout_candidates
union all
select 'candidate ranks 1..12 contiguous', (max(rank)-min(rank)+1)::text, '12' from golden_breakout_candidates
union all
select 'industry indices', count(*)::text, '120' from sectoral_technicals_daily
union all
select 'industries in golden cross', count(*)::text, '104'
  from sectoral_technicals_daily where golden_cross_state
union all
select 'breadth days', count(*)::text, '500' from market_breadth_daily
union all
select 'latest breadth date', max(trade_date)::text, '2026-09-04' from market_breadth_daily
union all
select 'RS band: green', count(*)::text, '404' from technicals_daily where rs_band='green'
union all
select 'RS band: red', count(*)::text, '1212' from technicals_daily where rs_band='red'
union all
-- The five gates rebuilt from the published columns must reproduce the screener's
-- own output, exactly as the workbook's Dashboard self-check does.
select 'gate funnel reproduces the screener',
  (select count(*)::text from technicals_daily
    where golden_cross_state and ma200_rising
      and (s_signals->>'50')::boolean and (s_signals->>'8')::boolean
      and separation_pct >= 3 and golden_cross_streak <= 15),
  (select count(*)::text from golden_breakout_candidates)
union all
select 'no null CMP', count(*)::text, '0' from technicals_daily where cmp is null
order by 1;
