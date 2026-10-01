import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Check } from '../boundary/checks.js';
import { databaseChecks, QUERIES, TRANSACTION } from '../boundary/database.js';
import { repositoryChecks } from '../boundary/repository.js';
import { MIGRATION_FILES, runMigrations } from '../migrate.js';
import { requireDatabaseEnv } from './postgresHarness.js';

// R1 against real PostgreSQL. Plain PostgreSQL has no Supabase roles, so
// anon/authenticated are reported NOT_APPLICABLE. The negative control runs in
// its own disposable database, which is dropped afterwards.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appRole = process.env.POSTGRES_APP_USER?.trim() || 'bizcaiaos_app';
const { rls } = repositoryChecks(ROOT, MIGRATION_FILES);
const verify = (url: string) => databaseChecks(url, { target: 'local', appRole, registered: MIGRATION_FILES, rls });
const statusOf = (checks: Check[]) => Object.fromEntries(checks.map((item) => [item.id, item.status]));
const failed = (checks: Check[]) => checks.filter((item) => item.status === 'FAIL').map((item) => item.id);

async function withClient<T>(url: string, operation: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

describe('R1 read-only boundary verifier (real database)', () => {
  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
  }, 60_000);

  it('reports no failures on a database migrated through the full chain', async () => {
    const checks = await verify(requireDatabaseEnv().migrateUrl);
    expect(failed(checks)).toEqual([]);
    expect(statusOf(checks)).toMatchObject({
      'R1-DB-IDENTITY': 'PASS',
      'R1-DB-ROLES': 'PASS',
      'R1-DB-MIGRATIONS': 'PASS',
      'R1-DB-OWNER': 'PASS',
      'R1-DB-APP-PRIVILEGES': 'PASS',
      'R1-DB-PUBLIC': 'PASS',
      'R1-DB-FUTURE-FUNCTIONS': 'PASS',
      'R1-DB-TRUSTED-FUNCTIONS': 'PASS',
      'R1-DB-RLS': 'PASS',
      'R1-DB-ANON': 'NOT_APPLICABLE',
      'R1-DB-AUTHENTICATED': 'NOT_APPLICABLE',
    });
    expect(checks.find((item) => item.id === 'R1-DB-RLS')!.evidence[0]).toBe('expected 18 tables with RLS and 49 policies; found 18 with RLS and 49 policies');
  });

  it('sends only the read-only transaction and allowlisted catalog SELECTs', async () => {
    const sent: string[] = [];
    const original = pg.Client.prototype.query;
    const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      if (typeof args[0] === 'string') sent.push(args[0]);
      return (original as (...input: unknown[]) => unknown).apply(this, args);
    } as never);
    try {
      await verify(requireDatabaseEnv().migrateUrl);
    } finally {
      spy.mockRestore();
    }
    const allowed = new Set<string>([...Object.values(QUERIES), TRANSACTION.begin, TRANSACTION.end]);
    expect(sent[0]).toBe(TRANSACTION.begin);
    expect(sent.at(-1)).toBe(TRANSACTION.end);
    expect(sent.filter((sql) => !allowed.has(sql))).toEqual([]);
  });

  it('runs inside a transaction PostgreSQL itself keeps read-only (a write attempt fails with 25006)', async () => {
    const probe = `zz_r1_probe_${randomUUID().slice(0, 8)}`;
    await withClient(requireDatabaseEnv().migrateUrl, async (client) => {
      await client.query(TRANSACTION.begin);
      await expect(client.query(`create table public.${probe} (id int)`)).rejects.toMatchObject({ code: '25006' });
      await client.query(TRANSACTION.end);
      expect((await client.query('select to_regclass($1) as found', [`public.${probe}`])).rows[0].found).toBeNull();
    });
  });

  it('reports the application-role connection as wrong verification access, without failing to run', async () => {
    const checks = await verify(requireDatabaseEnv().url);
    expect(statusOf(checks)).toMatchObject({ 'R1-DB-IDENTITY': 'FAIL', 'R1-DB-MIGRATIONS': 'NOT_VERIFIED', 'R1-DB-OWNER': 'NOT_VERIFIED' });
  });

  describe('negative control in a disposable database', () => {
    const database = `zz_r1_db_${randomUUID().slice(0, 8)}`;
    const urlFor = (db: string | null) => {
      const url = new URL(requireDatabaseEnv().migrateUrl);
      if (db) url.pathname = `/${db}`;
      return url.toString();
    };
    const fingerprint = (client: pg.Client) => client.query<{ hash: string }>(`
      select md5(string_agg(entry, '|' order by entry)) as hash from (
        select 'p' || oid || coalesce(proacl::text, '') as entry from pg_proc
        union all select 'c' || oid || relrowsecurity || coalesce(relacl::text, '') from pg_class
        union all select 'r' || oid || rolname from pg_roles
        union all select 'y' || oid || polname from pg_policy
        union all select 'd' || oid || defaclacl::text from pg_default_acl) entries`).then((result) => result.rows[0].hash);

    beforeAll(async () => {
      await withClient(urlFor(null), (admin) => admin.query(`create database ${database}`));
      const previous = process.env.DATABASE_MIGRATE_URL;
      process.env.DATABASE_MIGRATE_URL = urlFor(database);
      try {
        await runMigrations();
      } finally {
        process.env.DATABASE_MIGRATE_URL = previous;
      }
    }, 120_000);

    afterAll(async () => {
      await withClient(urlFor(null), (admin) => admin.query(`drop database if exists ${database} with (force)`));
    }, 60_000);

    it('GOOD state passes and verification leaves the catalog unchanged; BAD grants and RLS changes fail', async () => {
      const url = urlFor(database);
      const before = await withClient(url, fingerprint);
      expect(failed(await verify(url))).toEqual([]);
      expect(await withClient(url, fingerprint)).toBe(before);

      // Break the boundary deliberately (test setup, as the database admin; never done by R1).
      const broken = await withClient(url, async (admin) => {
        const table = (await admin.query<{ name: string }>(
          "select c.relname as name from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname <> 'schema_migrations' order by 1 limit 1",
        )).rows[0].name;
        const policy = (await admin.query<{ table: string; name: string }>(
          "select tablename as table, policyname as name from pg_policies where schemaname = 'public' and tablename <> $1 order by 1, 2 limit 1",
          [table],
        )).rows[0];
        await admin.query('grant execute on function public.current_app_user_id() to public');
        await admin.query(`alter table public.${table} disable row level security`);
        await admin.query(`drop policy ${policy.name} on public.${policy.table}`);
        await admin.query(`revoke delete on public.${table} from ${appRole}`);
        return { table, policy };
      });

      const checks = await verify(url);
      expect(failed(checks).sort()).toEqual(['R1-DB-APP-PRIVILEGES', 'R1-DB-PUBLIC', 'R1-DB-RLS']);
      const evidence = (id: string) => checks.find((item) => item.id === id)!.evidence.join('\n');
      expect(evidence('R1-DB-PUBLIC')).toContain('PUBLIC can execute: current_app_user_id()');
      expect(evidence('R1-DB-RLS')).toContain(`RLS disabled on: ${broken.table}`);
      expect(evidence('R1-DB-RLS')).toContain(`expected policy missing: ${broken.policy.table}.${broken.policy.name}`);
      expect(evidence('R1-DB-APP-PRIVILEGES')).toContain(`missing SELECT/INSERT/UPDATE/DELETE on: ${broken.table}`);
    }, 120_000);
  });
});
