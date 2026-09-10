-- Migration 005 — let the pipeline see its own size.
-- Run once in the SQL Editor. Safe to re-run.
--
-- On 2026-09-10 this project hit Supabase's 500MB ceiling and went read-only, and the
-- reconstruction afterwards was the uncomfortable part: prices_daily was 368MB on the
-- day of the FIRST load. Seventy-four per cent of the budget, before a single nightly
-- append, and 118MB of it two indexes serving nothing. The limit was not unknown --
-- §6.5 of the requirements document records "500MB storage" -- it had simply never
-- been compared against a measurement.
--
-- Byte sizes need a real SQL query, which PostgREST cannot issue. This function is how
-- the pipeline asks. It is read-only, returns nothing but names and numbers, and is
-- callable only by service_role -- the daily job and the maintenance workflow, never a
-- signed-in user.

create or replace function public.meridian_capacity()
returns table (object text, size_mb numeric)
language sql
security definer
set search_path = public, pg_catalog
as $$
  select 'DATABASE TOTAL'::text,
         round(pg_database_size(current_database()) / 1048576.0, 1)
  union all
  select c.relname::text || case when c.relkind = 'i' then '  (index)' else '' end,
         round(pg_total_relation_size(c.oid) / 1048576.0, 1)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'i')
    and pg_total_relation_size(c.oid) > 1048576   -- skip anything under a megabyte
  order by 2 desc;
$$;

-- security definer means this runs as its owner, so the grant is the whole access
-- control. Revoke from everyone first rather than relying on the default.
revoke all on function public.meridian_capacity() from public, anon, authenticated;
grant execute on function public.meridian_capacity() to service_role;

comment on function public.meridian_capacity() is
  'Table and index sizes in MB, for the capacity check in db_report.mjs. Added after '
  'the 2026-09-10 read-only incident, when nothing anywhere measured a limit.';
