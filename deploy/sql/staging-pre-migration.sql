-- BizcaiaOS staging: read-only checks BEFORE the first migration.
-- Runbook: docs/deployment/staging-provisioning.md, section C (steps 1-6).
--
-- Run as the migration role, never with a password on the command line:
--   psql "$DATABASE_MIGRATE_URL" -X -f deploy/sql/staging-pre-migration.sql
-- Everything runs in a READ ONLY transaction that is rolled back: this script
-- cannot create, change, or delete anything. Compare each result with the
-- "expect" line printed above it, and keep the output with the staging record.

\set ON_ERROR_STOP on
\pset footer off
begin transaction read only;

\echo '== PRE-1 connection identity -- expect: current_user = bizcaiaos_migrator, read_only = on'
select current_user, current_database(), split_part(version(), ' on ', 1) as server,
       current_setting('server_version_num') as version_num, current_setting('transaction_read_only') as read_only;

\echo '== PRE-2 role attributes -- expect: both roles present; login t; superuser, createrole, createdb, bypassrls all f'
select rolname, rolcanlogin as login, rolsuper as superuser, rolcreaterole as createrole,
       rolcreatedb as createdb, rolbypassrls as bypassrls
  from pg_roles where rolname in ('bizcaiaos_migrator', 'bizcaiaos_app') order by rolname;

\echo '== PRE-3 schema public -- expect: migrator usage t, create t; app usage f or t (db:migrate grants it), create f'
select r.rolname, has_schema_privilege(r.rolname, 'public', 'USAGE') as usage,
       has_schema_privilege(r.rolname, 'public', 'CREATE') as "create"
  from pg_roles r where r.rolname in ('bizcaiaos_migrator', 'bizcaiaos_app') order by r.rolname;

\echo '== PRE-4 pgcrypto -- expect: one row (Supabase installs it, normally in schema extensions)'
select extname, extnamespace::regnamespace as schema, extversion from pg_extension where extname = 'pgcrypto';

\echo '== PRE-5 empty project -- expect: schema_migrations absent (null); 0 relations; 0 non-extension functions in public'
select to_regclass('public.schema_migrations') as schema_migrations,
       (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace
          and c.relkind in ('r', 'p', 'v', 'm', 'S')) as public_relations,
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
          and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
                            and d.objid = p.oid and d.deptype = 'e')) as public_functions;

\echo '== PRE-6 RLS baseline -- expect: no rows (no tables in public yet)'
select c.relname, c.relrowsecurity as rls
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') order by 1;

\echo '== PRE-7 Data API roles present (record only; Data API OFF is checked over HTTPS in step 5)'
select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'authenticator') order by 1;

rollback;
