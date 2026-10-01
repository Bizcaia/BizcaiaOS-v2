-- BizcaiaOS staging: read-only Migration 019 security verification AFTER
-- migrations 001-019. Runbook: docs/deployment/staging-provisioning.md,
-- section C (steps 8 and 11-16).
--
--   psql "$DATABASE_MIGRATE_URL" -X -f deploy/sql/staging-post-migration.sql
-- Everything runs in a READ ONLY transaction that is rolled back. Unlike an
-- earlier draft of the verification list, nothing here creates a temporary
-- function: future-function privileges are read from pg_default_acl.
-- Compare each result with its "expect" line; any difference is a stop.

\set ON_ERROR_STOP on
\pset footer off
begin transaction read only;

\echo '== POST-1 identity -- expect: current_user = bizcaiaos_migrator, read_only = on'
select current_user, current_database(), split_part(version(), ' on ', 1) as server,
       current_setting('transaction_read_only') as read_only;

\echo '== POST-2 migrations -- expect: recorded 19, m019 1, first 001_core_schema.sql, last 019_revoke_public_function_execute.sql'
select count(*) as recorded,
       count(*) filter (where id = '019_revoke_public_function_execute.sql') as m019,
       min(id) as first, max(id) as last
  from public.schema_migrations;
select id from public.schema_migrations order by id;

\echo '== POST-3 ownership -- expect: no rows (the migrator owns every BizcaiaOS relation and function)'
select 'relation' as kind, c.relname as name, pg_get_userbyid(c.relowner) as owner
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S')
   and pg_get_userbyid(c.relowner) <> 'bizcaiaos_migrator'
union all
select 'function', p.oid::regprocedure::text, pg_get_userbyid(p.proowner)
  from pg_proc p where p.pronamespace = 'public'::regnamespace
   and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
   and pg_get_userbyid(p.proowner) <> 'bizcaiaos_migrator'
order by 1, 2;

\echo '== POST-4 PUBLIC execute -- expect: no rows (no non-extension function in public is executable by PUBLIC)'
select p.oid::regprocedure::text as function
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
   and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE')
 order by 1;

\echo '== POST-5 anon / authenticated -- expect: no rows (no table, sequence, or function privilege in public)'
select r.rolname as role, 'table' as kind, c.relname as name
  from pg_roles r cross join pg_class c
 where r.rolname in ('anon', 'authenticated') and c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm')
   and has_table_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
union all
select r.rolname, 'sequence', c.relname
  from pg_roles r cross join pg_class c
 where r.rolname in ('anon', 'authenticated') and c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
   and has_sequence_privilege(r.oid, c.oid, 'USAGE, SELECT, UPDATE')
union all
select r.rolname, 'function', p.oid::regprocedure::text
  from pg_roles r cross join pg_proc p
 where r.rolname in ('anon', 'authenticated') and p.pronamespace = 'public'::regnamespace
   and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
   and has_function_privilege(r.oid, p.oid, 'EXECUTE')
order by 1, 2, 3;

\echo '== POST-6 application role -- expect: no rows (CRUD on every table except schema_migrations, execute on every function)'
select 'table missing CRUD' as problem, c.relname as name
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname <> 'schema_migrations'
   and not (has_table_privilege('bizcaiaos_app', c.oid, 'SELECT') and has_table_privilege('bizcaiaos_app', c.oid, 'INSERT')
        and has_table_privilege('bizcaiaos_app', c.oid, 'UPDATE') and has_table_privilege('bizcaiaos_app', c.oid, 'DELETE'))
union all
select 'function not executable', p.oid::regprocedure::text
  from pg_proc p where p.pronamespace = 'public'::regnamespace
   and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
   and not has_function_privilege('bizcaiaos_app', p.oid, 'EXECUTE')
order by 1, 2;
\echo '   expect: app_can_touch_schema_migrations = f'
select has_table_privilege('bizcaiaos_app', 'public.schema_migrations', 'SELECT, INSERT, UPDATE, DELETE') as app_can_touch_schema_migrations;

\echo '== POST-7 trusted identity functions -- expect: exactly bizcaiaos_app and bizcaiaos_migrator for each of the 3 functions'
select p.proname as function, string_agg(distinct case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, ', ') as execute_grantees
  from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('sync_authenticated_user', 'bootstrap_organization', 'accept_organization_invitation')
   and a.privilege_type = 'EXECUTE'
 group by p.proname order by 1;

\echo '== POST-8 future functions -- expect: migrator_global_function_default t, public_execute_by_default f, app_execute_by_default t'
select exists (select 1 from pg_default_acl d where d.defaclrole = 'bizcaiaos_migrator'::regrole
                 and d.defaclnamespace = 0 and d.defaclobjtype = 'f') as migrator_global_function_default,
       exists (select 1 from pg_default_acl d, aclexplode(d.defaclacl) a
                where d.defaclrole = 'bizcaiaos_migrator'::regrole and d.defaclnamespace = 0
                  and d.defaclobjtype = 'f' and a.grantee = 0) as public_execute_by_default,
       exists (select 1 from pg_default_acl d, aclexplode(d.defaclacl) a
                where d.defaclrole = 'bizcaiaos_migrator'::regrole and d.defaclnamespace = 'public'::regnamespace
                  and d.defaclobjtype = 'f' and a.grantee = 'bizcaiaos_app'::regrole
                  and a.privilege_type = 'EXECUTE') as app_execute_by_default;

\echo '== POST-9 RLS -- expect: tables 18, with_rls 18, policies 49; the list below shows only schema_migrations'
select count(*) filter (where c.relname <> 'schema_migrations') as tables,
       count(*) filter (where c.relname <> 'schema_migrations' and c.relrowsecurity) as with_rls,
       (select count(*) from pg_policies where schemaname = 'public') as policies
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p');
select c.relname as table_without_rls from pg_class c
 where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1;

\echo '== POST-10 default privileges inventory (record only; provider roles may still grant to anon/authenticated on objects THEY create)'
select pg_get_userbyid(d.defaclrole) as role, coalesce(n.nspname, '(all schemas)') as schema, d.defaclobjtype as type,
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       string_agg(a.privilege_type, ',' order by a.privilege_type) as privileges
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
 group by 1, 2, 3, 4 order by 1, 2, 3, 4;

rollback;
