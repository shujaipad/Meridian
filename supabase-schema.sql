-- Meridian production schema & Row Level Security policies
-- Reference: meridian-requirements.md §6.4 (schema), §6.6 (access control)
--
-- Design principles this file implements:
--   1. Two-key model (§6.6): service_role (the Node pipeline) bypasses RLS by
--      Supabase default and is the ONLY writer. authenticated (the ~100
--      invited users, via the anon key + a logged-in session) gets read-only
--      access, gated by RLS, to the tables the app actually displays.
--   2. Default-deny: RLS is enabled on every table. A table with no policy
--      below is intentionally locked to service_role only -- raw inputs and
--      operational logs are not meant to be queried by the frontend.
--   3. technicals_daily and sectoral_technicals_daily are SNAPSHOT tables
--      (one row per instrument, replaced wholesale each run), not append-only
--      history -- see the sizing discussion in meridian-requirements.md §9.
--      prices_daily and market_breadth_daily are the only genuine time series.

-- ============================================================================
-- RAW DATA TABLES
-- ============================================================================

create table universe (
  id                bigserial primary key,
  asset_class       text not null check (asset_class in ('equity', 'commodity', 'currency', 'index', 'crypto')),
  identifier_type   text not null check (identifier_type in ('isin', 'yahoo_ticker')),
  identifier        text not null,
  symbol            text not null,
  name              text not null,
  sector            text,
  industry_group    text,
  market_cap        numeric,
  status            text not null default 'active' check (status in ('active', 'removed')),
  added_date        date not null default current_date,
  removed_date      date,
  unique (asset_class, identifier)
);

create table prices_daily (
  id            bigserial primary key,
  universe_id   bigint not null references universe(id) on delete cascade,
  trade_date    date not null,
  high          numeric(12, 4),
  low           numeric(12, 4),
  close         numeric(12, 4) not null,
  volume        bigint,
  unique (universe_id, trade_date)
);
create index on prices_daily (universe_id, trade_date desc);

create table fundamentals_annual (
  id            bigserial primary key,
  universe_id   bigint not null references universe(id) on delete cascade,
  fiscal_year   text not null,
  -- numeric(12,4), not (8,4). These three are ratios with a denominator that can
  -- approach zero -- near-zero equity produces an ROE of 100,489% -- and the real
  -- data carries three such values that would have overflowed numeric(8,4) partway
  -- through the load. They are not clamped: the composite score ranks by percentile
  -- (§4.2), so an absurd value simply sits at the top of its metric without
  -- distorting anyone else's score, and clamping here would make the database
  -- disagree with what the engine already computes.
  roe_pct       numeric(12, 4),
  roce_pct      numeric(12, 4),
  debt_equity   numeric(12, 4),
  eps           numeric(12, 4),
  sales         numeric(16, 2),
  fixed_assets  numeric(16, 2),
  cwip          numeric(16, 2),
  unique (universe_id, fiscal_year)
);

-- ============================================================================
-- COMPUTED OUTPUT TABLES -- refreshed by the nightly/quarterly pipeline via
-- the staging-table-then-atomic-swap pattern (requirements doc §6.3/§8).
-- Snapshot tables carry no history of their own; the history lives in
-- prices_daily and fundamentals_annual, which the pipeline reads to compute
-- these fresh on every run.
-- ============================================================================

create table technicals_daily (
  universe_id         bigint primary key references universe(id) on delete cascade,
  as_of_date          date not null,
  cmp                 numeric(12, 4),
  ma8                 numeric(12, 4),
  ma50                numeric(12, 4),
  ma200               numeric(12, 4),
  rsi                 numeric(6, 2),
  s_signals           jsonb,
  m_signals           jsonb,
  s_streaks           jsonb,
  m_streaks           jsonb,
  rs_rating           numeric(5, 2),
  vol_breakout_pct    numeric(8, 2),
  ma200_slope_pct     numeric(8, 4),
  ma200_rising        boolean,
  golden_cross_state  boolean,
  golden_cross_streak int,
  separation_pct      numeric(8, 4)
);

create table sectoral_technicals_daily (
  industry_group      text primary key,
  as_of_date          date not null,
  cmp                 numeric(12, 4),
  ma8                 numeric(12, 4),
  ma50                numeric(12, 4),
  ma200               numeric(12, 4),
  ma200_slope_pct     numeric(8, 4),
  ma200_rising        boolean,
  golden_cross_state  boolean,
  golden_cross_streak int,
  separation_pct      numeric(8, 4)
);

create table fundamentals_scored (
  universe_id       bigint primary key references universe(id) on delete cascade,
  as_of_date        date not null,
  composite_score   numeric(5, 2),
  tier              text,
  per_metric        jsonb
);

create table golden_breakout_candidates (
  universe_id       bigint primary key references universe(id) on delete cascade,
  as_of_date        date not null,
  rank              int,
  separation_pct    numeric(8, 4),
  freshness_days    int,
  vol_breakout_pct  numeric(8, 2)
);

create table market_breadth_daily (
  trade_date            date primary key,
  pct_above_200dma      numeric(5, 2),
  pct_above_200dma_ma30 numeric(5, 2),
  pct_above_200dma_ma100 numeric(5, 2),
  pct_above_200dma_ma200 numeric(5, 2),
  new_highs             int,
  new_lows              int
);

-- ============================================================================
-- OPERATIONAL TABLES -- service_role / admin only, never read by the frontend.
-- ============================================================================

create table fetch_job_log (
  id            bigserial primary key,
  run_date      date not null default current_date,
  asset_class   text,
  job_type      text check (job_type in ('daily', 'quarterly', 'annual_fundamentals')),
  status        text not null check (status in ('success', 'failure')),
  message       text,
  started_at    timestamptz,
  finished_at   timestamptz
);

create table universe_change_log (
  id            bigserial primary key,
  universe_id   bigint references universe(id),
  action        text not null check (action in ('added', 'removed')),
  effective_date date not null,
  reason        text
);

-- ============================================================================
-- USER CONSENT -- backs the mandatory tracking-disclosure gate (§6.6). Each
-- row is owned by exactly one user; RLS restricts read/write to that owner.
-- ============================================================================

create table user_consent (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  tracking_consent boolean not null,
  consented_at    timestamptz not null default now()
);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

alter table universe                    enable row level security;
alter table prices_daily                enable row level security;
alter table fundamentals_annual         enable row level security;
alter table technicals_daily            enable row level security;
alter table sectoral_technicals_daily   enable row level security;
alter table fundamentals_scored         enable row level security;
alter table golden_breakout_candidates  enable row level security;
alter table market_breadth_daily        enable row level security;
alter table fetch_job_log               enable row level security;
alter table universe_change_log         enable row level security;
alter table user_consent                enable row level security;

-- Read access for logged-in invited users, on the tables Meridian's UI
-- actually displays. fundamentals_annual, fetch_job_log, and
-- universe_change_log intentionally get NO policy below -- they stay
-- locked to service_role (raw input / operational data, not shown in-app).

create policy "authenticated_read" on universe                   for select using (auth.role() = 'authenticated');
create policy "authenticated_read" on prices_daily                for select using (auth.role() = 'authenticated');
create policy "authenticated_read" on technicals_daily            for select using (auth.role() = 'authenticated');
create policy "authenticated_read" on sectoral_technicals_daily   for select using (auth.role() = 'authenticated');
create policy "authenticated_read" on fundamentals_scored         for select using (auth.role() = 'authenticated');
create policy "authenticated_read" on golden_breakout_candidates  for select using (auth.role() = 'authenticated');
create policy "authenticated_read" on market_breadth_daily        for select using (auth.role() = 'authenticated');

-- user_consent: owner-only, both directions. A user can see and set only
-- their own consent record -- this is the one table where the frontend
-- writes directly (via the anon key + their session), everywhere else all
-- writes are service_role-only by omission of any INSERT/UPDATE policy.
create policy "read_own_consent"   on user_consent for select using (auth.uid() = user_id);
create policy "insert_own_consent" on user_consent for insert with check (auth.uid() = user_id);
create policy "update_own_consent" on user_consent for update using (auth.uid() = user_id);

-- ============================================================================
-- REVOKE SUPABASE'S DEFAULT GRANTS FIRST -- added 2026-09-07 after the first
-- real deployment proved this file was NOT self-sufficient.
-- ============================================================================
-- A Supabase project ships with `grant all privileges on all tables in schema
-- public to anon, authenticated, service_role` AND a matching ALTER DEFAULT
-- PRIVILEGES, so every table created afterwards silently inherits full
-- privileges for both public roles. Applying this file to a fresh project
-- therefore produced 77 grants to `anon` (11 tables x 7 privilege types), not
-- the zero the section below assumed.
--
-- RLS still held -- anon read 0 rows and every write was refused -- but the
-- two-layer model §6.6 describes had quietly become one layer, and the failure
-- mode had inverted. Without a grant, anon gets a loud "permission denied". With
-- a grant and RLS, anon gets a silent empty result. So a future change that
-- disabled RLS on one table, or added one over-broad policy, would expose
-- everything -- reads AND writes -- with nothing raising its voice.
--
-- Revoke before granting, so this file produces the same end state whether it
-- runs on a clean database or a real Supabase project.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
-- No RPC is exposed today. If one is ever added, grant execute on it explicitly
-- rather than relaxing this line.
revoke all on all functions in schema public from anon, authenticated;

-- Stop NEW tables from inheriting the same. Without this, the next migration
-- silently re-opens everything it creates.
--
-- ALTER DEFAULT PRIVILEGES only affects defaults created by the role running it,
-- and Supabase sets its own as `supabase_admin`, not as `postgres`. A plain
-- `alter default privileges ... revoke` therefore succeeds, reports nothing, and
-- changes nothing -- which is exactly what happened on the first deployment: the
-- grants cleared, three default-privilege entries survived, and the file still
-- said "Success". So discover the owning role rather than assuming it.
--
-- Wrapped so a refusal cannot abort the whole apply. `postgres` on a managed
-- instance may not be a member of the role that set these. That is survivable:
-- the REVOKEs above run on every apply, so any table this file creates ends up
-- correct regardless. What a leftover default ACL affects is a table created by
-- some FUTURE migration that forgets to revoke -- so the warning below is a real
-- instruction, not noise.
do $defacl$
declare r record; n int := 0;
begin
  for r in
    select pg_get_userbyid(d.defaclrole) as role_name,
           case d.defaclobjtype when 'r' then 'TABLES' when 'S' then 'SEQUENCES'
                when 'f' then 'FUNCTIONS' when 'T' then 'TYPES' end as objtype
    from pg_default_acl d
    join pg_namespace ns on ns.oid = d.defaclnamespace
    where ns.nspname = 'public'
      and array_to_string(d.defaclacl, ',') ~ '(^|,)(anon|authenticated)='
  loop
    begin
      execute format(
        'alter default privileges for role %I in schema public revoke all on %s from anon, authenticated',
        r.role_name, r.objtype);
      raise notice 'cleared default % privileges set by role %', r.objtype, r.role_name;
      n := n + 1;
    exception when insufficient_privilege then
      raise warning 'COULD NOT clear default % privileges set by role % -- every future migration MUST revoke explicitly after creating tables',
        r.objtype, r.role_name;
    end;
  end loop;
  if n = 0 then raise notice 'no default privileges for anon/authenticated to clear'; end if;
end $defacl$;

-- ============================================================================
-- TABLE-LEVEL GRANTS -- PostgREST (Supabase's API layer) also checks plain
-- SQL grants before RLS ever runs. No grants to `anon` anywhere, deliberately:
-- every table requires a real authenticated session at both layers, not RLS
-- alone.
-- ============================================================================

grant usage on schema public to authenticated;
grant select on
  universe, prices_daily, technicals_daily, sectoral_technicals_daily,
  fundamentals_scored, golden_breakout_candidates, market_breadth_daily
  to authenticated;
grant select, insert, update on user_consent to authenticated;

-- ============================================================================
-- STORAGE -- the daily Excel workbook
-- ============================================================================
-- The workbook is a genuine parallel deliverable (§2.2), regenerated by the same
-- nightly job that refreshes the screens and published here rather than to a new
-- service. Storage is already in the locked stack, so this adds no infrastructure.
--
-- Private bucket: `public = false` means the object URLs are not guessable-and-
-- fetchable. The frontend never links to a raw object; it calls createSignedUrl()
-- with the user's own session and gets a short-lived URL back, so access is
-- revoked the moment the user is.
--
-- ~775 KB per build. A 90-day retention window is ~70 MB, which sits inside the
-- 500 MB budget alongside the ~150-170 MB of price history. The pruning step in
-- the nightly job is what keeps that true.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('workbooks', 'workbooks', false, 52428800,
        array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;

-- Same posture as every other table: invited, logged-in users read; only the
-- pipeline (service_role, which bypasses RLS) writes. No insert/update/delete
-- policy exists for `authenticated`, so those are denied by default rather than
-- by an explicit rule that could later be edited to say otherwise.
create policy "authenticated_read_workbooks" on storage.objects
  for select to authenticated
  using (bucket_id = 'workbooks');
