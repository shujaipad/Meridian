-- Run in the Supabase SQL Editor after compute_and_publish.mjs. Read-only.
-- Every row should read ok = true.
--
-- Rewritten 2026-09-09. The previous version hard-coded the counts of one particular
-- publish -- 2,089 technicals, 12 candidates, 404 green RS bands -- and three of those
-- had already gone stale when the four non-equity classes were added, so it would have
-- reported false failures on a perfectly good publish. Worse, it asserted nothing about
-- the columns that were actually missing: the sectoral signal grid shipped empty for a
-- full release under an all-green report from this file.
--
-- So these are INVARIANTS, not snapshots. A count that changes every time prices move
-- is not an assertion, it is a maintenance burden that trains you to ignore red rows.
-- Each row below states something that must hold on ANY correct publish.

with u as (select id, asset_class from universe),
cls as (
  select u.asset_class, count(*) as n
  from technicals_daily t join u on u.id = t.universe_id
  group by u.asset_class
),
cand as (
  select u.asset_class, count(*) as n, min(c.rank) as lo, max(c.rank) as hi
  from golden_breakout_candidates c join u on u.id = c.universe_id
  group by u.asset_class
)

-- ---- shape: every class present, nothing pooled across classes -----------------
select 'every asset class has technicals' as check,
       (select count(*) from cls)::text as found, '5' as expected,
       (select count(*) from cls) = 5 as ok
union all
select 'technicals never exceed the universe',
       (select count(*) from technicals_daily)::text,
       '<= ' || (select count(*) from universe)::text,
       (select count(*) from technicals_daily) <= (select count(*) from universe)
union all
select 'no technicals row without a universe row',
       (select count(*) from technicals_daily t where not exists
          (select 1 from universe u where u.id = t.universe_id))::text,
       '0',
       not exists (select 1 from technicals_daily t
                   where not exists (select 1 from universe u where u.id = t.universe_id))

-- ---- per-class as-of dates: each class has exactly one -------------------------
-- Each class trades on its own calendar (indices closed 2026-09-08 while crypto had
-- 2026-09-09), so a SHARED date would be the bug, not a difference between them.
union all
select 'each asset class has exactly one as-of date',
       (select count(*) from (select u.asset_class from technicals_daily t join u on u.id=t.universe_id
                              group by u.asset_class having count(distinct t.as_of_date) > 1) x)::text,
       '0',
       not exists (select 1 from technicals_daily t join u on u.id=t.universe_id
                   group by u.asset_class having count(distinct t.as_of_date) > 1)
union all
select 'breadth is as of the equity screen',
       (select max(trade_date)::text from market_breadth_daily),
       (select max(t.as_of_date)::text from technicals_daily t join u on u.id=t.universe_id
         where u.asset_class='equity'),
       (select max(trade_date) from market_breadth_daily)
         = (select max(t.as_of_date) from technicals_daily t join u on u.id=t.universe_id
             where u.asset_class='equity')

-- ---- Golden Breakout: the published list must equal what the gates select ------
-- Rebuilt from the stored columns, exactly as the workbook's self-check does. If the
-- publisher dropped or rounded a gate input, these two stop agreeing.
union all
select 'gate funnel reproduces the published candidates',
       (select count(*) from technicals_daily
         where golden_cross_state and ma200_rising
           and (s_signals->>'50')::boolean and (s_signals->>'8')::boolean
           and separation_pct >= 3 and golden_cross_streak <= 15)::text,
       (select count(*) from golden_breakout_candidates)::text,
       (select count(*) from technicals_daily
         where golden_cross_state and ma200_rising
           and (s_signals->>'50')::boolean and (s_signals->>'8')::boolean
           and separation_pct >= 3 and golden_cross_streak <= 15)
       = (select count(*) from golden_breakout_candidates)
union all
-- Ranks restart at 1 WITHIN each asset class -- they are not globally contiguous, and
-- the previous version's max-min+1 check silently assumed they were.
select 'candidate ranks are 1..n within each asset class',
       (select count(*) from cand where lo <> 1 or hi <> n)::text, '0',
       not exists (select 1 from cand where lo <> 1 or hi <> n)

-- ---- fundamentals: quintiles by rank, so each tier is 20% +/- rounding ---------
union all
select 'every scored row has a tier',
       (select count(*) from fundamentals_scored where composite_score is not null and tier is null)::text,
       '0',
       not exists (select 1 from fundamentals_scored where composite_score is not null and tier is null)
union all
select 'each tier is within one row of a fifth of the population',
       (select count(*) from (
          select tier from fundamentals_scored where tier is not null group by tier
          having abs(count(*) - (select count(*) from fundamentals_scored where tier is not null)/5.0) > 1
        ) x)::text,
       '0',
       not exists (select 1 from (
          select tier from fundamentals_scored where tier is not null group by tier
          having abs(count(*) - (select count(*) from fundamentals_scored where tier is not null)/5.0) > 1
        ) y)
union all
select 'composite scores stay inside [0,100]',
       (select count(*) from fundamentals_scored where composite_score < 0 or composite_score > 100)::text,
       '0',
       not exists (select 1 from fundamentals_scored where composite_score < 0 or composite_score > 100)

-- ---- completeness: the columns the screens render on EVERY row ------------------
-- This block is the one that would have caught the sectoral release. A screen renders
-- a column for every row; a column that is null on every row is not "sparse data", it
-- is a publish that dropped it -- and it shows up as a grid of inactive pills rather
-- than as anything visibly missing.
union all
select 'no null CMP in technicals',
       (select count(*) from technicals_daily where cmp is null)::text, '0',
       not exists (select 1 from technicals_daily where cmp is null)
union all
select 'technicals: signal grid populated',
       (select count(*) from technicals_daily where s_signals is null or s_signals = '{}'::jsonb)::text,
       '0',
       not exists (select 1 from technicals_daily where s_signals is null or s_signals = '{}'::jsonb)
union all
-- The Sectoral screen renders the same grid and the same six MAs as the Stocks screen.
-- Migration 003 gave the table the columns; this asserts the publisher fills them.
select 'sectoral: signal grid populated',
       (select count(*) from sectoral_technicals_daily
         where s_signals is null or s_signals = '{}'::jsonb
            or m_signals is null or m_signals = '{}'::jsonb)::text,
       '0',
       not exists (select 1 from sectoral_technicals_daily
                    where s_signals is null or s_signals = '{}'::jsonb
                       or m_signals is null or m_signals = '{}'::jsonb)
union all
select 'sectoral: all six moving averages present',
       (select count(*) from sectoral_technicals_daily
         where ma3 is null or ma8 is null or ma30 is null
            or ma50 is null or ma100 is null or ma200 is null)::text,
       '0',
       not exists (select 1 from sectoral_technicals_daily
                    where ma3 is null or ma8 is null or ma30 is null
                       or ma50 is null or ma100 is null or ma200 is null)
union all
select 'sectoral: 52-week range present',
       (select count(*) from sectoral_technicals_daily where high52 is null or low52 is null)::text,
       '0',
       not exists (select 1 from sectoral_technicals_daily where high52 is null or low52 is null)
union all
-- A synthetic index of returns has no traded volume, so this must be null rather than
-- the constant 100% a placeholder volume used to produce (§4 / meridian-engine.js).
select 'sectoral: volume breakout is null, not a fabricated constant',
       (select count(*) from sectoral_technicals_daily where vol_breakout_pct is not null)::text,
       '0',
       not exists (select 1 from sectoral_technicals_daily where vol_breakout_pct is not null)

-- ---- sanity on the ranges themselves -------------------------------------------
union all
select 'RS ratings inside 1..99',
       (select count(*) from technicals_daily where rs_rating is not null
         and (rs_rating < 1 or rs_rating > 99))::text, '0',
       not exists (select 1 from technicals_daily where rs_rating is not null
                    and (rs_rating < 1 or rs_rating > 99))
union all
select 'RS band always agrees with RS rating',
       (select count(*) from technicals_daily where rs_rating is not null and rs_band <>
          case when rs_rating < 60 then 'red' when rs_rating < 80 then 'amber' else 'green' end)::text,
       '0',
       not exists (select 1 from technicals_daily where rs_rating is not null and rs_band <>
          case when rs_rating < 60 then 'red' when rs_rating < 80 then 'amber' else 'green' end)
union all
select 'RSI inside 0..100',
       (select count(*) from technicals_daily where rsi is not null and (rsi < 0 or rsi > 100))::text,
       '0',
       not exists (select 1 from technicals_daily where rsi is not null and (rsi < 0 or rsi > 100))
union all
select 'CMP never above the 52-week high',
       (select count(*) from technicals_daily
         where cmp is not null and high52 is not null and cmp > high52 * 1.0001)::text, '0',
       not exists (select 1 from technicals_daily
                    where cmp is not null and high52 is not null and cmp > high52 * 1.0001)
union all
select 'CMP never below the 52-week low',
       (select count(*) from technicals_daily
         where cmp is not null and low52 is not null and cmp < low52 * 0.9999)::text, '0',
       not exists (select 1 from technicals_daily
                    where cmp is not null and low52 is not null and cmp < low52 * 0.9999)
order by 1;
