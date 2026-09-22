import './loadEnv.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const MIGRATION_FILES = [
  '001_core_schema.sql',
  '002_rbac_rls.sql',
  '003_organization_onboarding.sql',
  '004_property_workflow_rls.sql',
  '005_projects_write_rls.sql',
  '006_negotiations_rls.sql',
  '007_documents.sql',
  '008_tasks.sql',
  '009_payments.sql',
];

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required to run migrations`);
  }
  return value;
}

export async function runMigrations() {
  const migrateUrl = requiredEnv('DATABASE_MIGRATE_URL');
  const appRole = process.env.POSTGRES_APP_USER?.trim() || 'bizcaiaos_app';
  const appPassword = requiredEnv('POSTGRES_APP_PASSWORD');
  const databaseDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'database');

  const listed = readdirSync(databaseDir).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
  const unexpected = listed.filter((name) => !MIGRATION_FILES.includes(name));
  if (unexpected.length) {
    throw new Error(`Unknown numbered SQL files in database/: ${unexpected.join(', ')}`);
  }

  const client = new Client({ connectionString: migrateUrl });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock(87236401)');
    await client.query('begin');
    await client.query(`
      create table if not exists public.schema_migrations (
        id text primary key,
        applied_at timestamptz not null default timezone('utc', now())
      )
    `);
    await client.query('commit');

    const applied = new Set(
      (await client.query<{ id: string }>('select id from public.schema_migrations order by id')).rows.map(
        (row) => row.id,
      ),
    );

    for (const filename of MIGRATION_FILES) {
      if (applied.has(filename)) {
        continue;
      }
      const sql = readFileSync(join(databaseDir, filename), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into public.schema_migrations (id) values ($1)', [filename]);
        await client.query('commit');
        console.log(`applied ${filename}`);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }

    await ensureApplicationRole(client, appRole, appPassword);
    await grantApplicationPrivileges(client, appRole);
    console.log('migrations complete');
  } finally {
    try {
      await client.query('select pg_advisory_unlock(87236401)');
    } catch {
      // connection may already be closed after a fatal error
    }
    await client.end();
  }
}

async function ensureApplicationRole(client: pg.Client, roleName: string, password: string) {
  const existing = await client.query<{ exists: boolean }>(
    'select exists(select 1 from pg_roles where rolname = $1) as exists',
    [roleName],
  );
  const quotedRole = quoteIdent(roleName);
  const quotedPassword = quoteLiteral(password);
  if (!existing.rows[0]?.exists) {
    await client.query(
      `create role ${quotedRole} login nosuperuser nocreatedb nocreaterole nobypassrls password ${quotedPassword}`,
    );
    console.log(`created application role ${roleName}`);
  } else {
    await client.query(`alter role ${quotedRole} with login nosuperuser nobypassrls password ${quotedPassword}`);
  }
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

function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdent(value: string) {
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
