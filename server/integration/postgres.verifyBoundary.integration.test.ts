import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Check } from '../boundary/checks.js';
import { databaseChecks, QUERIES, TRANSACTION } from '../boundary/database.js';
import { repositoryChecks } from '../boundary/repository.js';
import { runMigrations } from '../migrate.js';
import { MIGRATION_FILES } from '../migrations/migrationManifest.js';
import { requireDatabaseEnv } from './postgresHarness.js';

// R1 against real PostgreSQL. Plain PostgreSQL has no Supabase roles, so
// anon/authenticated are normally NOT_APPLICABLE. Every state-dependent test
// runs in R1's own disposable database, which is dropped afterwards.
//
// Roles are cluster-wide, and the function-privilege suite runs in parallel and
// briefly creates and drops anon/authenticated. While they exist R1 evaluates
// them (correctly), and a role dropped in the middle of a snapshot makes the
// catalog call fail (the CLI would exit 2, changing nothing). These tests
// accept either role state and retry that one transient error.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appRole = process.env.POSTGRES_APP_USER?.trim() || 'bizcaiaos_app';
const { rls } = repositoryChecks(ROOT, MIGRATION_FILES);
const API_ROLE_CHECKS = ['R1-DB-ANON', 'R1-DB-AUTHENTICATED'];
async function verify(url: string, role = appRole): Promise<Check[]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await databaseChecks(url, { target: 'local', appRole: role, registered: MIGRATION_FILES, rls });
    } catch (error) {
      const concurrentRoleDrop = (error as { code?: string }).code === '42704';
      if (!concurrentRoleDrop || attempt === 5) throw error;
    }
  }
}
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
  beforeAll(() => {
    requireDatabaseEnv();
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

  // Everything that depends on database state runs in R1's own disposable
  // database: other suites re-run db:migrate on the shared database in
  // parallel, and the runner's grants pass through transient states (see
  // grantApplicationPrivileges in server/migrate.ts) that R1 would, correctly,
  // report.
  describe('in its own disposable database', () => {
    const database = `zz_r1_db_${randomUUID().slice(0, 8)}`;
    const urlFor = (base: string, db: string | null) => {
      const url = new URL(base);
      if (db) url.pathname = `/${db}`;
      return url.toString();
    };
    const adminUrl = (db: string | null) => urlFor(requireDatabaseEnv().migrateUrl, db);
    // pg_roles is cluster-wide: parallel suites create and drop their fixture
    // roles (zz_*, and anon/authenticated on plain PostgreSQL) at any moment,
    // so those are left out. Every other role, including the application and
    // migration roles, stays in.
    const fingerprint = (client: pg.Client) => client.query<{ hash: string }>(`
      select md5(string_agg(entry, '|' order by entry)) as hash from (
        select 'p' || oid || coalesce(proacl::text, '') as entry from pg_proc
        union all select 'c' || oid || relrowsecurity || coalesce(relacl::text, '') from pg_class
        union all select 'r' || oid || rolname from pg_roles where rolname not in ('anon', 'authenticated') and left(rolname, 3) <> 'zz_'
        union all select 'y' || oid || polname from pg_policy
        union all select 'd' || oid || defaclacl::text from pg_default_acl) entries`).then((result) => result.rows[0].hash);

    beforeAll(async () => {
      await withClient(adminUrl(null), (admin) => admin.query(`create database ${database}`));
      const previous = process.env.DATABASE_MIGRATE_URL;
      process.env.DATABASE_MIGRATE_URL = adminUrl(database);
      try {
        await runMigrations();
      } finally {
        process.env.DATABASE_MIGRATE_URL = previous;
      }
    }, 120_000);

    afterAll(async () => {
      await withClient(adminUrl(null), (admin) => admin.query(`drop database if exists ${database} with (force)`));
    }, 60_000);

    it('reports no failures on a database migrated through the full chain', async () => {
      const checks = await verify(adminUrl(database));
      expect(failed(checks)).toEqual([]);
      expect(statusOf(checks)).toMatchObject({
        'R1-DB-IDENTITY': 'VERIFIED',
        'R1-DB-ROLES': 'VERIFIED',
        'R1-DB-APP-MEMBERSHIP': 'VERIFIED',
        'R1-DB-MIGRATIONS': 'VERIFIED',
        'R1-DB-OWNER': 'VERIFIED',
        'R1-DB-APP-PRIVILEGES': 'VERIFIED',
        'R1-DB-PUBLIC': 'VERIFIED',
        'R1-DB-FUTURE-FUNCTIONS': 'VERIFIED',
        'R1-DB-TRUSTED-FUNCTIONS': 'VERIFIED',
        'R1-DB-RLS': 'VERIFIED',
      });
      for (const id of API_ROLE_CHECKS) expect(['NOT_APPLICABLE', 'VERIFIED'], id).toContain(statusOf(checks)[id]);
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
        await verify(adminUrl(database));
      } finally {
        spy.mockRestore();
      }
      const allowed = new Set<string>([...Object.values(QUERIES), TRANSACTION.begin, TRANSACTION.end]);
      expect(sent[0]).toBe(TRANSACTION.begin);
      expect(sent.at(-1)).toBe(TRANSACTION.end);
      expect(sent.filter((sql) => !allowed.has(sql))).toEqual([]);
    });

    it('reports the application-role connection as wrong verification access, without failing to run', async () => {
      const checks = await verify(urlFor(requireDatabaseEnv().url, database));
      expect(statusOf(checks)).toMatchObject({ 'R1-DB-IDENTITY': 'FAIL', 'R1-DB-MIGRATIONS': 'NOT_VERIFIED', 'R1-DB-OWNER': 'NOT_VERIFIED' });
    });

    // Memberships are cluster-wide, so this uses its own throwaway application
    // role: other suites check bizcaiaos_app's memberships in parallel.
    it('fails on any membership in the migration owner, including NOINHERIT + SET that no privilege check shows', async () => {
      const url = adminUrl(database);
      const suffix = randomUUID().slice(0, 8);
      const app = `zz_r1_app_${suffix}`;
      const safe = `zz_r1_safe_${suffix}`;
      const password = randomUUID();
      const membership = async () => {
        const checks = await verify(url, app);
        return { status: statusOf(checks)['R1-DB-APP-MEMBERSHIP'], evidence: checks.find((item) => item.id === 'R1-DB-APP-MEMBERSHIP')!.evidence.join('\n') };
      };
      await withClient(url, async (admin) => {
        const owner = (await admin.query<{ user: string }>('select current_user as user')).rows[0].user;
        try {
          await admin.query(`create role ${app} login password '${password}'`);
          await admin.query(`create role ${safe} nologin`);
          await admin.query(`grant ${safe} to ${app}`);
          // An unrelated role is not a finding.
          expect(await membership()).toMatchObject({ status: 'VERIFIED' });
          expect((await membership()).evidence).toContain(`${app} memberships, none across the boundary: ${safe}`);

          for (const [inherit, setOption] of [[true, true], [false, true], [true, false], [false, false]]) {
            await admin.query(`grant "${owner}" to ${app} with inherit ${inherit}, set ${setOption}`);
            try {
              const result = await membership();
              expect(result.status, `inherit ${inherit} set ${setOption}`).toBe('FAIL');
              expect(result.evidence).toContain(`${app} is a member of ${owner} via ${owner} (inherit=${inherit} set=${setOption} admin=false): the migration owner`);
              // The evidence states what this membership allows on the real server, nothing more.
              const allows = inherit && setOption ? `${app} inherits this role's privileges and can SET ROLE to it`
                : inherit ? `${app} inherits this role's privileges but cannot SET ROLE to it`
                  : setOption ? `${app} can SET ROLE to it but does not inherit its privileges`
                    : `${app} neither inherits its privileges nor can SET ROLE to it today`;
              expect(result.evidence).toContain(`; ${allows}`);
              if (!inherit && setOption) {
                // The gap this check closes: no effective privilege, yet SET ROLE reaches the owner.
                expect((await admin.query('select has_table_privilege($1, \'public.schema_migrations\', \'SELECT\') as can', [app])).rows[0].can).toBe(false);
                const asApp = new URL(url);
                asApp.username = app;
                asApp.password = password;
                const read = await withClient(asApp.toString(), async (client) => {
                  await client.query(`set role "${owner}"`);
                  return (await client.query('select count(*)::int as n from public.schema_migrations')).rows[0].n;
                });
                expect(read).toBe(MIGRATION_FILES.length);
              }
            } finally {
              await admin.query(`revoke "${owner}" from ${app}`);
            }
          }

          for (const predefined of ['pg_read_all_data', 'pg_write_all_data']) {
            await admin.query(`grant ${predefined} to ${app}`);
            try {
              expect(await membership()).toMatchObject({ status: 'FAIL' });
              expect((await membership()).evidence).toContain(`member of ${predefined} via ${predefined}`);
            } finally {
              await admin.query(`revoke ${predefined} from ${app}`);
            }
          }
          expect(await membership()).toMatchObject({ status: 'VERIFIED' });
        } finally {
          await admin.query(`drop role if exists ${app}`);
          await admin.query(`drop role if exists ${safe}`);
        }
      });
    }, 120_000);

    // The other forbidden kinds, on real catalog output. Throwaway zz_ roles
    // only, all dropped again; the probe function is dropped before the next test.
    it('fails on nested, SUPERUSER, BYPASSRLS, server-file and other-owner memberships, read from the real catalog', async () => {
      const url = adminUrl(database);
      const suffix = randomUUID().slice(0, 8);
      const [app, mid, superRole, bypassRole, otherOwner] = ['app', 'mid', 'super', 'bypass', 'owner'].map((kind) => `zz_r1_${kind}_${suffix}`);
      const probeFunction = `public.zz_r1_owned_${suffix}()`;
      const membership = async () => {
        const checks = await verify(url, app);
        return { status: statusOf(checks)['R1-DB-APP-MEMBERSHIP'], evidence: checks.find((item) => item.id === 'R1-DB-APP-MEMBERSHIP')!.evidence.join('\n') };
      };
      const expectFinding = async (grant: string, revoke: string, expected: string[]) => {
        await withClient(url, (admin) => admin.query(grant));
        try {
          const result = await membership();
          expect(result.status, grant).toBe('FAIL');
          for (const text of expected) expect(result.evidence, grant).toContain(text);
        } finally {
          await withClient(url, (admin) => admin.query(revoke));
        }
      };
      await withClient(url, async (admin) => {
        const owner = (await admin.query<{ user: string }>('select current_user as user')).rows[0].user;
        try {
          await admin.query(`create role ${app} nologin`);
          await admin.query(`create role ${mid} nologin`);
          await admin.query(`create role ${superRole} superuser nologin`);
          await admin.query(`create role ${bypassRole} bypassrls nologin`);
          await admin.query(`create role ${otherOwner} nologin`);
          expect(await membership()).toMatchObject({ status: 'VERIFIED' });

          // Nested: app -> mid -> owner; the options shown are the last link's.
          await admin.query(`grant "${owner}" to ${mid} with inherit false, set true`);
          await expectFinding(`grant ${mid} to ${app}`, `revoke ${mid} from ${app}`, [
            `${app} is a member of ${owner} via ${mid} -> ${owner} (last link ${mid} -> ${owner}: inherit=false set=true admin=false): the migration owner`,
            'nested: what the application role can do depends on every link in the path',
          ]);
          await admin.query(`revoke "${owner}" from ${mid}`);

          await expectFinding(`grant ${superRole} to ${app} with inherit false, set true`, `revoke ${superRole} from ${app}`, [
            `${app} is a member of ${superRole} via ${superRole} (inherit=false set=true admin=false): SUPERUSER; ${app} can SET ROLE to it`,
          ]);
          await expectFinding(`grant ${bypassRole} to ${app}`, `revoke ${bypassRole} from ${app}`, [
            `${app} is a member of ${bypassRole} via ${bypassRole} (inherit=true set=true admin=false): BYPASSRLS`,
          ]);
          for (const predefined of ['pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program']) {
            await expectFinding(`grant ${predefined} to ${app}`, `revoke ${predefined} from ${app}`, [
              `${app} is a member of ${predefined} via ${predefined} (inherit=true set=true admin=false): privileged predefined role`,
            ]);
          }

          // Another role owning a BizcaiaOS object in public.
          await admin.query(`create function ${probeFunction} returns integer language sql as 'select 1'`);
          await admin.query(`alter function ${probeFunction} owner to ${otherOwner}`);
          await expectFinding(`grant ${otherOwner} to ${app} with inherit false, set false`, `revoke ${otherOwner} from ${app}`, [
            `${app} is a member of ${otherOwner} via ${otherOwner} (inherit=false set=false admin=false): owns BizcaiaOS objects in public; ${app} neither inherits its privileges nor can SET ROLE to it today`,
          ]);
          await admin.query(`drop function ${probeFunction}`);

          expect(await membership()).toMatchObject({ status: 'VERIFIED' });
        } finally {
          await admin.query(`drop function if exists ${probeFunction}`);
          for (const role of [app, mid, superRole, bypassRole, otherOwner]) await admin.query(`drop role if exists ${role}`);
        }
      });
    }, 120_000);

    // Last: it breaks the boundary in this database on purpose.
    it('GOOD state passes and verification leaves the catalog unchanged; BAD grants and RLS changes fail', async () => {
      const url = adminUrl(database);
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
      const evidence = (id: string) => checks.find((item) => item.id === id)!.evidence.join('\n');
      // A PUBLIC grant also reaches anon/authenticated whenever those roles exist, and R1 reports that too.
      for (const id of failed(checks).filter((check) => API_ROLE_CHECKS.includes(check))) {
        expect(evidence(id)).toContain('can execute current_app_user_id()');
      }
      expect(failed(checks).filter((id) => !API_ROLE_CHECKS.includes(id)).sort()).toEqual(['R1-DB-APP-PRIVILEGES', 'R1-DB-PUBLIC', 'R1-DB-RLS']);
      expect(evidence('R1-DB-PUBLIC')).toContain('PUBLIC can execute: current_app_user_id()');
      expect(evidence('R1-DB-RLS')).toContain(`RLS disabled on: ${broken.table}`);
      expect(evidence('R1-DB-RLS')).toContain(`expected policy missing: ${broken.policy.table}.${broken.policy.name}`);
      expect(evidence('R1-DB-APP-PRIVILEGES')).toContain(`missing SELECT/INSERT/UPDATE/DELETE on: ${broken.table}`);
    }, 120_000);
  });
});
