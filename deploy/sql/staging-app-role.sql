-- BizcaiaOS staging: read-only check of the API's own connection AFTER
-- migrations. Runbook: docs/deployment/staging-provisioning.md, section C
-- (step 14).
--
--   psql "$DATABASE_URL" -X -f deploy/sql/staging-app-role.sql
-- DATABASE_URL is the bizcaiaos_app connection the Render Web Service uses.
-- Everything runs in a READ ONLY transaction that is rolled back.

\set ON_ERROR_STOP on
\pset footer off
begin transaction read only;

\echo '== APP-1 identity -- expect: current_user = bizcaiaos_app; superuser f, bypassrls f'
select current_user, r.rolsuper as superuser, r.rolbypassrls as bypassrls
  from pg_roles r where r.rolname = current_user;

\echo '== APP-2 RLS applies -- expect: actor null, organizations_visible 0, properties_visible 0 (no actor set, RLS hides every row)'
select public.current_app_user_id() as actor,
       (select count(*) from public.organizations) as organizations_visible,
       (select count(*) from public.properties) as properties_visible;

\echo '== APP-3 no migration access -- expect: f, f'
select has_table_privilege(current_user, 'public.schema_migrations', 'SELECT') as can_read_schema_migrations,
       has_schema_privilege(current_user, 'public', 'CREATE') as can_create_in_public;

rollback;
