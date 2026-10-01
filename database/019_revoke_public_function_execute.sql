-- BizcaiaOS public privilege boundary (D-PROD-13).
-- Apply after 018_lifecycle_optimistic_concurrency.sql.
--
-- Supabase Auth is the identity provider only; the BizcaiaOS API is the sole
-- data path, and the Supabase Data API is not part of it. Nothing in public
-- may therefore be callable or readable by PUBLIC, anon, or authenticated:
-- the API connects as the application role, which db:migrate grants
-- explicitly (and by default for new objects), so it keeps every privilege it
-- uses. RLS policies, table and function definitions, ownership, data, and
-- service_role are unchanged.

-- PostgreSQL grants EXECUTE to PUBLIC on every new function. Remove it from
-- the existing functions in public. Functions the migration role does not own
-- (for example extension functions installed by a superuser) are left as they
-- are, with a warning rather than an error.
revoke execute on all functions in schema public from public;

-- And from functions the migration role creates later. This must be the
-- global form: the built-in PUBLIC EXECUTE default cannot be removed by a
-- per-schema (IN SCHEMA) default privilege.
alter default privileges revoke execute on functions from public;

-- The Supabase Data API roles exist only on Supabase. Elsewhere (local
-- PostgreSQL, tests) this block does nothing.
do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on all tables in schema public from %I', api_role);
      execute format('revoke all on all sequences in schema public from %I', api_role);
      execute format('revoke all on all functions in schema public from %I', api_role);
      execute format('alter default privileges in schema public revoke all on tables from %I', api_role);
      execute format('alter default privileges in schema public revoke all on sequences from %I', api_role);
      execute format('alter default privileges in schema public revoke all on functions from %I', api_role);
    end if;
  end loop;
end
$$;
