-- Proves supabase-schema.sql's Row Level Security actually enforces what §6.6
-- claims, against a real Postgres. Run against an EMPTY database:
--
--     psql -v ON_ERROR_STOP=1 -f verify_rls.sql
--
-- (from the repository root — it \i's supabase-schema.sql). Exits non-zero on
-- the first failed expectation.
--
-- Why this exists: the schema was written and locked without ever being executed.
-- "RLS is enabled and there is no policy, therefore it is denied" is a reasonable
-- reading of the DDL and still worth checking, because the failure mode is silent
-- and the wrong direction — a missing GRANT is loud, an over-broad one is not.
-- Every expectation below corresponds to a sentence in §6.6.
--
-- Supabase supplies auth.*, storage.* and the three roles; they are stubbed here
-- so the run exercises this repository's DDL rather than Supabase's.

\set ON_ERROR_STOP on

create schema auth;
create table auth.users (id uuid primary key);
create schema storage;
create table storage.buckets (
  id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text, name text);
alter table storage.objects enable row level security;
-- Roles are cluster-wide rather than per-database, so a second run against a
-- fresh database would otherwise fail on a role left behind by the first.
do $r$
begin
  create role anon;          exception when duplicate_object then null;
end $r$;
do $r$
begin
  create role authenticated; exception when duplicate_object then null;
end $r$;
do $r$
begin
  create role service_role;  exception when duplicate_object then null;
end $r$;
-- Supabase derives these from the JWT; here they come from settings the test sets.
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as
  $$ select current_user::text $$;

-- CRITICAL, and the reason the first version of this test was worthless: a real
-- Supabase project pre-grants ALL privileges on everything in `public` to anon and
-- authenticated, and sets ALTER DEFAULT PRIVILEGES so every new table inherits the
-- same. Testing against a clean Postgres therefore validated the schema against an
-- environment that does not exist -- it passed while the real deployment had 77
-- grants to anon. Model the platform's defaults BEFORE applying the schema, so the
-- schema has to revoke them the way it must in production.
grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to anon, authenticated, service_role;
grant all privileges on all sequences in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

\echo '--- applying supabase-schema.sql ---'
\i supabase-schema.sql

-- ---------------------------------------------------------------- helpers
create or replace function expect_denied(role_name text, stmt text, label text)
returns void language plpgsql as $$
begin
  begin
    execute format('set local role %I', role_name);
    execute stmt;
    execute 'reset role';
    raise exception 'EXPECTED DENY BUT SUCCEEDED: %', label;
  exception
    when insufficient_privilege then execute 'reset role'; raise notice 'ok   denied: %', label;
    when others then
      execute 'reset role';
      if sqlstate = '42501' then raise notice 'ok   denied: %', label;
      else raise; end if;
  end;
end $$;

create or replace function expect_count(role_name text, stmt text, want bigint, label text)
returns void language plpgsql as $$
declare got bigint;
begin
  execute format('set local role %I', role_name);
  execute stmt into got;
  execute 'reset role';
  if got is distinct from want then
    raise exception 'EXPECTED % BUT GOT % : %', want, got, label;
  end if;
  raise notice 'ok   % = % : %', label, got, label;
end $$;

-- ---------------------------------------------------------------- seed
insert into universe (asset_class, identifier_type, identifier, symbol, name)
  values ('equity','isin','INE002A01018','RELIANCE','Reliance Industries Ltd.');
insert into prices_daily (universe_id, trade_date, close) values (1,'2026-09-04',1309.5);
insert into technicals_daily (universe_id, as_of_date, cmp) values (1,'2026-09-04',1309.5);
insert into sectoral_technicals_daily (industry_group, as_of_date) values ('Refineries','2026-09-04');
insert into fundamentals_scored (universe_id, as_of_date) values (1,'2026-09-04');
insert into golden_breakout_candidates (universe_id, as_of_date) values (1,'2026-09-04');
insert into fundamentals_annual (universe_id, fiscal_year, roe_pct) values (1,'FY2026',12.5);
insert into fetch_job_log (job_type, status) values ('daily','success');
insert into universe_change_log (universe_id, action, effective_date) values (1,'added','2026-09-04');
insert into market_breadth_daily (trade_date, pct_above_200dma) values ('2026-09-04',60.61);
insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

\echo ''
\echo '--- anon: the key shipped in the browser bundle, with no session ---'
\echo '--- §6.6: "No grants to anon anywhere, deliberately" ---'
do $$ begin
  perform expect_denied('anon','select count(*) from universe','anon reads universe');
  perform expect_denied('anon','select count(*) from prices_daily','anon reads prices_daily');
  perform expect_denied('anon','select count(*) from technicals_daily','anon reads technicals_daily');
  perform expect_denied('anon','select count(*) from golden_breakout_candidates','anon reads candidates');
  perform expect_denied('anon','select count(*) from user_consent','anon reads user_consent');
end $$;

\echo ''
\echo '--- authenticated: an invited, logged-in user ---'
\echo '--- §6.6: read-only, and only the tables the app displays ---'
do $$ begin
  perform expect_count('authenticated','select count(*) from universe',1::bigint,'reads universe');
  perform expect_count('authenticated','select count(*) from prices_daily',1::bigint,'reads prices_daily');
  perform expect_count('authenticated','select count(*) from technicals_daily',1::bigint,'reads technicals_daily');
  perform expect_count('authenticated','select count(*) from sectoral_technicals_daily',1::bigint,'reads sectoral');
  perform expect_count('authenticated','select count(*) from fundamentals_scored',1::bigint,'reads fundamentals_scored');
  perform expect_count('authenticated','select count(*) from golden_breakout_candidates',1::bigint,'reads candidates');
  perform expect_count('authenticated','select count(*) from market_breadth_daily',1::bigint,'reads breadth');
end $$;

\echo ''
\echo '--- and NOT the raw inputs or operational logs (no policy = denied) ---'
do $$ begin
  perform expect_denied('authenticated','select count(*) from fundamentals_annual','reads fundamentals_annual');
  perform expect_denied('authenticated','select count(*) from fetch_job_log','reads fetch_job_log');
  perform expect_denied('authenticated','select count(*) from universe_change_log','reads universe_change_log');
end $$;

\echo ''
\echo '--- and cannot write anywhere: service_role is the only writer ---'
do $$ begin
  perform expect_denied('authenticated',
    $q$insert into universe (asset_class,identifier_type,identifier,symbol,name)
       values ('equity','isin','X','X','X')$q$, 'inserts into universe');
  perform expect_denied('authenticated','update technicals_daily set cmp=1','updates technicals_daily');
  perform expect_denied('authenticated','delete from prices_daily','deletes prices_daily');
  perform expect_denied('authenticated','insert into market_breadth_daily (trade_date) values (''2026-09-05'')','inserts breadth');
end $$;

\echo ''
\echo '--- user_consent: the one table the frontend writes, owner-scoped both ways ---'
set test.uid = '11111111-1111-1111-1111-111111111111';
do $$ begin
  -- A writes its own row
  perform expect_count('authenticated',
    $q$with i as (insert into user_consent (user_id, tracking_consent)
        values ('11111111-1111-1111-1111-111111111111', true) returning 1)
       select count(*) from i$q$, 1::bigint, 'A writes own consent');
  -- A cannot write a row owned by B
  perform expect_denied('authenticated',
    $q$insert into user_consent (user_id, tracking_consent)
       values ('22222222-2222-2222-2222-222222222222', true)$q$, 'A writes B''s consent');
end $$;

insert into user_consent (user_id, tracking_consent)
  values ('22222222-2222-2222-2222-222222222222', false);

do $$ begin
  -- two rows exist, A sees exactly one
  perform expect_count('authenticated','select count(*) from user_consent',1::bigint,'A sees only own row');
  -- A cannot flip B's consent: the update matches no visible row
  perform expect_count('authenticated',
    $q$with u as (update user_consent set tracking_consent=true
        where user_id='22222222-2222-2222-2222-222222222222' returning 1)
       select count(*) from u$q$, 0::bigint, 'A updates B''s consent');
  -- no delete policy and no delete grant
  perform expect_denied('authenticated',
    $q$delete from user_consent where user_id='11111111-1111-1111-1111-111111111111'$q$,
    'A deletes own consent (removal is via auth.users cascade, not the app)');
end $$;

do $$
declare b boolean;
begin
  select tracking_consent into b from user_consent
    where user_id='22222222-2222-2222-2222-222222222222';
  if b is not false then raise exception 'B''s consent was modified'; end if;
  raise notice 'ok   B consent untouched';
end $$;

\echo ''
\echo '--- grant layer: the SECOND defence, independent of RLS ---'
\echo '--- §6.6: "No grants to anon anywhere, deliberately" ---'
do $$
declare n int;
begin
  select count(*) into n from information_schema.role_table_grants
    where grantee='anon' and table_schema='public';
  if n <> 0 then
    raise exception 'anon holds % table privilege(s) in public — Supabase''s default grants were not revoked', n;
  end if;
  raise notice 'ok   anon holds no table privilege in public';

  select count(*) into n from information_schema.role_table_grants
    where grantee='authenticated' and table_schema='public' and privilege_type='SELECT';
  if n <> 8 then raise exception 'expected 8 SELECT grants to authenticated (7 display + user_consent), found %', n; end if;

  select count(*) into n from information_schema.role_table_grants
    where grantee='authenticated' and table_schema='public'
      and privilege_type in ('INSERT','UPDATE');
  if n <> 2 then raise exception 'expected 2 write grants to authenticated (user_consent only), found %', n; end if;

  select count(*) into n from information_schema.role_table_grants
    where grantee='authenticated' and table_schema='public' and privilege_type='DELETE';
  if n <> 0 then raise exception 'authenticated holds % DELETE grant(s); expected none', n; end if;
  raise notice 'ok   authenticated holds exactly 8 read + 2 write grants, no delete';

  -- Default privileges matter as much as current ones: without revoking them the
  -- NEXT migration silently re-opens every table it creates.
  select count(*) into n from pg_default_acl d
    join pg_namespace ns on ns.oid = d.defaclnamespace
    where ns.nspname = 'public'
      and array_to_string(d.defaclacl, ',') ~ '(^|,)(anon|authenticated)=';
  if n <> 0 then
    raise exception 'default privileges still grant to anon/authenticated in public (% entr(y/ies))', n;
  end if;
  raise notice 'ok   no default privileges left for anon/authenticated';
end $$;

\echo ''
\echo '--- storage: the daily workbook bucket (§2.2.3) ---'
do $$
declare n int;
begin
  select count(*) into n from storage.buckets where id='workbooks' and public = false;
  if n <> 1 then raise exception 'workbooks bucket missing or not private'; end if;
  raise notice 'ok   workbooks bucket exists and is private';
  select count(*) into n from pg_policies
    where schemaname='storage' and tablename='objects' and cmd='SELECT';
  if n <> 1 then raise exception 'expected exactly one storage select policy, found %', n; end if;
  select count(*) into n from pg_policies
    where schemaname='storage' and tablename='objects' and cmd <> 'SELECT';
  if n <> 0 then raise exception 'unexpected write policy on storage.objects: %', n; end if;
  raise notice 'ok   storage.objects is read-only for authenticated, no write policy';
end $$;

\echo ''
\echo 'ALL RLS EXPECTATIONS MET'
