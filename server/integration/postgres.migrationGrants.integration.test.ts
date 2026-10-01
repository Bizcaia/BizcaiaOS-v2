import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../migrate.js';
import { MIGRATION_FILES } from '../migrations/migrationManifest.js';
import { requireDatabaseEnv } from './postgresHarness.js';

// Migration boundary: the application role never holds any privilege on
// public.schema_migrations: not before, not during, and not after db:migrate,
// and not after a run that fails part-way through the application grants.
// Everything runs in this suite's own disposable database, so parallel suites
// re-running migrations elsewhere cannot affect what is observed here.

const appRole = process.env.POSTGRES_APP_USER?.trim() || 'bizcaiaos_app';
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const database = `zz_migration_grants_${randomUUID().slice(0, 8)}`;

const urlFor = (db: string | null) => {
  const url = new URL(requireDatabaseEnv().migrateUrl);
  if (db) url.pathname = `/${db}`;
  return url.toString();
};

async function withClient<T>(url: string, operation: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function migrate() {
  const previous = process.env.DATABASE_MIGRATE_URL;
  process.env.DATABASE_MIGRATE_URL = urlFor(database);
  try {
    return await runMigrations();
  } finally {
    process.env.DATABASE_MIGRATE_URL = previous;
  }
}

/** Effective privileges of `role` on schema_migrations (has_table_privilege), plus explicit ACL entries. */
async function schemaMigrationsAccess(client: pg.Client, role: string) {
  const exists = (await client.query<{ found: boolean }>("select to_regclass('public.schema_migrations') is not null as found")).rows[0].found;
  if (!exists) return { exists, effective: [] as string[], granted: [] as string[] };
  const effective: string[] = [];
  for (const privilege of TABLE_PRIVILEGES) {
    const result = await client.query<{ can: boolean }>("select has_table_privilege($1, 'public.schema_migrations', $2) as can", [role, privilege]);
    if (result.rows[0].can) effective.push(privilege);
  }
  const granted = (await client.query<{ privilege_type: string }>(
    `select privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'schema_migrations' and grantee = $1 order by 1`,
    [role],
  )).rows.map((row) => row.privilege_type);
  return { exists, effective, granted };
}

/**
 * Runs db:migrate while observing, from a second connection after every
 * privilege statement the runner sends, what the application role can do on
 * schema_migrations. Optionally fails the run just after `failAfter` is sent.
 */
async function migrateObserved(options: { failAfter?: RegExp } = {}) {
  const observations: Array<{ statement: string; effective: string[] }> = [];
  const observer = new pg.Client({ connectionString: urlFor(database) });
  await observer.connect();
  const original = pg.Client.prototype.query;
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(async function (this: pg.Client, ...args: unknown[]) {
    const result = await (original as (...input: unknown[]) => Promise<unknown>).apply(this, args);
    const sql = typeof args[0] === 'string' ? args[0].trim() : '';
    if (this !== observer && /^(grant|revoke|alter default privileges)\b/i.test(sql)) {
      observations.push({ statement: sql.split(' to ')[0].split(' from ')[0], effective: (await schemaMigrationsAccess(observer, appRole)).effective });
      if (options.failAfter?.test(sql)) throw Object.assign(new Error('injected failure during application grants'), { code: 'TEST_INJECTED' });
    }
    return result;
  } as never);
  try {
    return { outcome: await migrate().then(() => 'completed', (error: { code?: string }) => error.code ?? 'failed'), observations };
  } finally {
    spy.mockRestore();
    await observer.end();
  }
}

describe('schema_migrations privilege boundary (migration runner, disposable database)', () => {
  beforeAll(async () => {
    requireDatabaseEnv();
    await withClient(urlFor(null), (admin) => admin.query(`create database ${database}`));
  }, 60_000);

  afterAll(async () => {
    await withClient(urlFor(null), (admin) => admin.query(`drop database if exists ${database} with (force)`));
  }, 60_000);

  it('before the first run there is no schema_migrations, so nothing to hold', async () => {
    expect(await withClient(urlFor(database), (client) => schemaMigrationsAccess(client, appRole))).toEqual({ exists: false, effective: [], granted: [] });
  });

  it('the first run never exposes schema_migrations to the application role, at any committed point', async () => {
    const { outcome, observations } = await migrateObserved();
    expect(outcome).toBe('completed');
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.filter((observation) => observation.effective.length)).toEqual([]);
  }, 120_000);

  it('after migration: the application role has no privilege and no grant on schema_migrations; the migrator keeps full access', async () => {
    await withClient(urlFor(database), async (client) => {
      expect(await schemaMigrationsAccess(client, appRole)).toEqual({ exists: true, effective: [], granted: [] });
      const migrator = (await client.query<{ user: string }>('select current_user as user')).rows[0].user;
      const owner = (await client.query<{ owner: string }>("select pg_get_userbyid(relowner) as owner from pg_class where oid = 'public.schema_migrations'::regclass")).rows[0].owner;
      expect(owner).toBe(migrator);
      expect((await schemaMigrationsAccess(client, migrator)).effective).toEqual(expect.arrayContaining(['SELECT', 'INSERT', 'UPDATE', 'DELETE']));
      // The application role is not a member of the migration role (no inherited access).
      const member = await client.query<{ member: boolean }>('select pg_has_role($1, $2, $3) as member', [appRole, migrator, 'MEMBER']);
      expect(member.rows[0].member).toBe(false);
      // The application keeps its intended access to application data.
      const app = await client.query<{ can: boolean }>("select has_table_privilege($1, 'public.properties', 'SELECT, INSERT, UPDATE, DELETE') as can", [appRole]);
      expect(app.rows[0].can).toBe(true);
      expect((await client.query<{ id: string }>('select id from public.schema_migrations order by id')).rows.map((row) => row.id)).toEqual(MIGRATION_FILES);
    });
  });

  it('a run that fails part-way through the application grants leaves no schema_migrations privilege behind', async () => {
    const { outcome, observations } = await migrateObserved({ failAfter: /^grant usage, select on all sequences/i });
    expect(outcome).toBe('TEST_INJECTED');
    expect(observations.filter((observation) => observation.effective.length)).toEqual([]);
    expect(await withClient(urlFor(database), (client) => schemaMigrationsAccess(client, appRole))).toEqual({ exists: true, effective: [], granted: [] });
  }, 120_000);

  it('a later run is idempotent, keeps the boundary, and clears any stray grant left by older runners', async () => {
    await withClient(urlFor(database), (admin) => admin.query(`grant select, insert, update, delete on public.schema_migrations to ${appRole}`));
    const { outcome, observations } = await migrateObserved();
    expect(outcome).toBe('completed');
    await withClient(urlFor(database), async (client) => {
      expect(await schemaMigrationsAccess(client, appRole)).toEqual({ exists: true, effective: [], granted: [] });
      // Recovery after the failed run above: nothing new to apply, and the application grants are complete again.
      expect((await client.query<{ n: number }>('select count(*)::int as n from public.schema_migrations')).rows[0].n).toBe(MIGRATION_FILES.length);
      const app = await client.query<{ can: boolean }>("select has_table_privilege($1, 'public.properties', 'SELECT, INSERT, UPDATE, DELETE') as can", [appRole]);
      expect(app.rows[0].can).toBe(true);
    });
    // The stray grant is removed before any later step can observe it again.
    expect(observations.slice(1).filter((observation) => observation.effective.length)).toEqual([]);
  }, 120_000);
});
