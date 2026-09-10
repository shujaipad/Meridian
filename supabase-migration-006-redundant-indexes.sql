-- Migration 006 — surface indexes that duplicate each other.
-- Run once in the SQL Editor. Safe to re-run.
--
-- prices_daily carried two btrees over (universe_id, trade_date): one from the unique
-- constraint, one declared explicitly with DESC. They index the same columns, and no
-- query in this project has ever ordered descending. On 2026-09-10 that redundancy was
-- 75.9MB -- 15% of a 500MB tier -- and it contributed to the project going read-only.
--
-- It was found twice by a person squinting at a size listing, which is exactly the
-- wrong way to find it. This makes it a check. Note the mechanism: an index's SORT
-- DIRECTION lives in `indoption`, not `indkey`, so grouping on indkey catches an
-- ASC/DESC pair as the duplicate it effectively is.
--
-- Read-only, service_role-only, same as meridian_capacity().

create or replace function public.meridian_redundant_indexes()
returns table (table_name text, indexes text[], total_mb numeric, reclaimable_mb numeric)
language sql
security definer
set search_path = public, pg_catalog
as $$
  select t.relname::text,
         array_agg(i.relname::text order by pg_relation_size(i.oid) desc),
         round(sum(pg_relation_size(i.oid)) / 1048576.0, 1),
         -- Reclaimable = everything but the smallest. Which one to KEEP is a judgement
         -- the function deliberately does not make: one of them usually backs a
         -- constraint and cannot be dropped, and only a person knows which.
         round((sum(pg_relation_size(i.oid)) - min(pg_relation_size(i.oid))) / 1048576.0, 1)
  from pg_index x
  join pg_class i on i.oid = x.indexrelid
  join pg_class t on t.oid = x.indrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
  group by t.relname, x.indrelid, x.indkey::text
  having count(*) > 1
  order by 4 desc;
$$;

revoke all on function public.meridian_redundant_indexes() from public, anon, authenticated;
grant execute on function public.meridian_redundant_indexes() to service_role;
