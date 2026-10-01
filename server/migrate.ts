import './loadEnv.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

export const MIGRATION_FILES = [
  '001_core_schema.sql',
  '002_rbac_rls.sql',
  '003_organization_onboarding.sql',
  '004_property_workflow_rls.sql',
  '005_projects_write_rls.sql',
  '006_negotiations_rls.sql',
  '007_documents.sql',
  '008_tasks.sql',
  '009_payments.sql',
  '010_agreement_signatures.sql',
  '011_interactions.sql',
  '012_property_lifecycle_history.sql',
  '013_property_stage_transitions.sql',
  '014_property_status_transitions.sql',
  '015_lifecycle_negotiation_exception.sql',
  '016_property_creation_rules.sql',
  '017_legacy_stage_remediation.sql',
  '018_lifecycle_optimistic_concurrency.sql',
  '019_revoke_public_function_execute.sql',
];

export function requiredEnv(name: string, purpose = 'run migrations') {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required to ${purpose}`);
  }
  return value;
}

export function applicationRoleName() {
  const roleName = process.env.POSTGRES_APP_USER?.trim() || 'bizcaiaos_app';
  quoteIdent(roleName);
  return roleName;
}

/**
 * Schema migration only. The runner never creates, alters, or sets a password
 * on the application role: that role belongs to the database operator (or to
 * `npm run db:provision-app-role` for local databases). It must already exist
 * and passes a read-only preflight before anything is written.
 */
export async function runMigrations(): Promise<{ applied: string[] }> {
  const migrateUrl = requiredEnv('DATABASE_MIGRATE_URL');
  const appRole = applicationRoleName();
  const databaseDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'database');

  const listed = readdirSync(databaseDir).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
  const unexpected = listed.filter((name) => !MIGRATION_FILES.includes(name));
  if (unexpected.length) {
    throw new Error(`Unknown numbered SQL files in database/: ${unexpected.join(', ')}`);
  }

  const applied: string[] = [];
  const client = new Client({ connectionString: migrateUrl });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock(87236401)');

    const problems = await preflightProblems(client, appRole);
    if (problems.length) {
      throw new Error(`Migration preflight failed; nothing was changed:\n- ${problems.join('\n- ')}`);
    }

    await client.query('begin');
    await client.query(`
      create table if not exists public.schema_migrations (
        id text primary key,
        applied_at timestamptz not null default timezone('utc', now())
      )
    `);
    await client.query('commit');

    const recorded = new Set(
      (await client.query<{ id: string }>('select id from public.schema_migrations order by id')).rows.map(
        (row) => row.id,
      ),
    );

    for (const filename of MIGRATION_FILES) {
      if (recorded.has(filename)) {
        continue;
      }
      const sql = readFileSync(join(databaseDir, filename), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into public.schema_migrations (id) values ($1)', [filename]);
        await client.query('commit');
        applied.push(filename);
        console.log(`applied ${filename}`);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }

    await grantApplicationPrivileges(client, appRole);
    console.log('migrations complete');
    return { applied };
  } finally {
    try {
      await client.query('select pg_advisory_unlock(87236401)');
    } catch {
      // connection may already be closed after a fatal error
    }
    await client.end();
  }
}

/**
 * Read-only checks run before the runner writes anything. Each returned string
 * is one failed check; an empty list means the migration may proceed.
 */
export async function preflightProblems(client: pg.Client, appRole: string): Promise<string[]> {
  const problems: string[] = [];

  const identity = await client.query<{ current_user: string; can_create: boolean }>(
    `select current_user, has_schema_privilege(current_user, 'public', 'CREATE') as can_create`,
  );
  const { current_user: migrationRole, can_create: canCreate } = identity.rows[0];
  if (migrationRole === appRole) {
    problems.push(`DATABASE_MIGRATE_URL connects as the application role "${appRole}"; use the owner/migration role`);
  }
  if (!canCreate) {
    problems.push(`migration role "${migrationRole}" cannot create objects in schema public`);
  }

  const role = await client.query<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>(
    'select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = $1',
    [appRole],
  );
  const app = role.rows[0];
  if (!app) {
    problems.push(
      `application role "${appRole}" does not exist; the database operator must create it ` +
        '(locally: npm run db:provision-app-role)',
    );
  } else {
    if (!app.rolcanlogin) problems.push(`application role "${appRole}" cannot log in`);
    if (app.rolsuper) problems.push(`application role "${appRole}" is a superuser; RLS would not apply`);
    if (app.rolbypassrls) problems.push(`application role "${appRole}" has BYPASSRLS; RLS would not apply`);
  }

  const notOwned = await client.query<{ relname: string }>(
    `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p', 'v', 'm', 'S')
        and not pg_has_role(current_user, c.relowner, 'USAGE')
      order by c.relname`,
  );
  if (notOwned.rows.length) {
    problems.push(
      `migration role "${migrationRole}" does not own: ${notOwned.rows.map((row) => row.relname).join(', ')}`,
    );
  }

  if (app) {
    const appOwned = await client.query<{ relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relowner = (select oid from pg_roles where rolname = $1)
        order by c.relname`,
      [appRole],
    );
    if (appOwned.rows.length) {
      problems.push(
        `application role "${appRole}" owns ${appOwned.rows.map((row) => row.relname).join(', ')}; RLS would not apply`,
      );
    }
  }

  const tracked = await client.query<{ exists: boolean; readable: boolean }>(
    `select to_regclass('public.schema_migrations') is not null as exists,
            to_regclass('public.schema_migrations') is not null
              and has_table_privilege(current_user, 'public.schema_migrations', 'select') as readable`,
  );
  if (tracked.rows[0]?.exists && !tracked.rows[0].readable) {
    problems.push(`migration role "${migrationRole}" cannot read public.schema_migrations`);
  } else if (tracked.rows[0]?.exists) {
    const recorded = (
      await client.query<{ id: string }>('select id from public.schema_migrations order by id')
    ).rows.map((row) => row.id);
    const prefixProblem = migrationPrefixProblem(recorded, MIGRATION_FILES);
    if (prefixProblem) problems.push(prefixProblem);
  }

  return problems;
}

/** The recorded migrations must be exactly the first N registered files. */
export function migrationPrefixProblem(recorded: string[], registered: string[]): string | null {
  const unknown = recorded.filter((id) => !registered.includes(id));
  if (unknown.length) {
    return `schema_migrations records unregistered migrations: ${unknown.join(', ')}`;
  }
  const expected = registered.slice(0, recorded.length);
  const recordedSet = new Set(recorded);
  const missing = expected.filter((id) => !recordedSet.has(id));
  if (missing.length) {
    return `schema_migrations is not a prefix of the registered list; missing: ${missing.join(', ')}`;
  }
  return null;
}

async function grantApplicationPrivileges(client: pg.Client, roleName: string) {
  const role = quoteIdent(roleName);
  await client.query(`grant usage on schema public to ${role}`);
  await client.query(`grant select, insert, update, delete on all tables in schema public to ${role}`);
  await client.query(`grant usage, select on all sequences in schema public to ${role}`);
  await client.query(`grant execute on all functions in schema public to ${role}`);
  await client.query(`alter default privileges in schema public grant select, insert, update, delete on tables to ${role}`);
  await client.query(`alter default privileges in schema public grant usage, select on sequences to ${role}`);
  await client.query(`alter default privileges in schema public grant execute on functions to ${role}`);
  await client.query(`revoke all on table public.schema_migrations from ${role}`);
}

export function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function quoteIdent(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

const invokedDirectly = process.argv[1]?.replaceAll('\\', '/').endsWith('/migrate.ts');
if (invokedDirectly) {
  runMigrations().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
