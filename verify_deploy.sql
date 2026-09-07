-- Confirms a Supabase deployment of supabase-schema.sql actually landed what §6.6
-- specifies. Paste into the Supabase SQL Editor and run — it is read-only and
-- changes nothing.
--
-- Worth running even after the editor says "Success. No rows returned", which is
-- what it says for ANY successful DDL and tells you nothing about what was
-- created. In particular the last statement in the schema creates a policy on
-- storage.objects, a table Supabase owns rather than you, and that is the one most
-- likely to be refused on a managed instance.
--
-- Every row should read found = expected. Verified against a local Postgres 16
-- carrying a clean apply of the schema.
select 'tables'            as check, count(*)::text as found, '11' as expected
  from pg_tables where schemaname='public'
union all
select 'RLS enabled', count(*)::text, '11'
  from pg_tables where schemaname='public' and rowsecurity
union all
select 'policies (public)', count(*)::text, '10'
  from pg_policies where schemaname='public'
union all
select 'policy on storage.objects', count(*)::text, '1'
  from pg_policies where schemaname='storage' and tablename='objects'
union all
select 'workbooks bucket private',
       coalesce((select (not public)::text from storage.buckets where id='workbooks'),'MISSING'), 'true'
union all
select 'grants to anon (must be 0)', count(*)::text, '0'
  from information_schema.role_table_grants
  where grantee='anon' and table_schema='public'
union all
select 'read grants to authenticated (7 display + user_consent)', count(*)::text, '8'
  from information_schema.role_table_grants
  where grantee='authenticated' and table_schema='public' and privilege_type='SELECT'
union all
select 'write grants to authenticated (user_consent only)', count(*)::text, '2'
  from information_schema.role_table_grants
  where grantee='authenticated' and table_schema='public'
    and privilege_type in ('INSERT','UPDATE')
union all
-- Default privileges matter as much as current ones: leave them and the NEXT
-- migration silently re-opens every table it creates.
--
-- But only the entries owned by the role that RUNS migrations can do that.
-- ALTER DEFAULT PRIVILEGES is keyed on the creating role, so `supabase_admin`'s
-- entries never apply to a table the SQL Editor creates as `postgres`. Counting
-- all of them (as an earlier version of this file did) reports 3 on a correctly
-- configured project and sends you chasing something inert.
select 'default privs granting anon/authenticated, YOUR role (must be 0)', count(*)::text, '0'
  from pg_default_acl d
  join pg_namespace ns on ns.oid = d.defaclnamespace
  where ns.nspname='public'
    and d.defaclrole = current_user::regrole
    and array_to_string(d.defaclacl, ',') ~ '(^|,)(anon|authenticated)='
union all
select 'default privs owned by other roles (informational, inert)', count(*)::text, 'n/a'
  from pg_default_acl d
  join pg_namespace ns on ns.oid = d.defaclnamespace
  where ns.nspname='public'
    and d.defaclrole <> current_user::regrole
    and array_to_string(d.defaclacl, ',') ~ '(^|,)(anon|authenticated)='
order by 1;
