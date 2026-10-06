import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_FILES, runMigrations } from '../migrate.js';
import { requireDatabaseEnv } from './postgresHarness.js';

// Migration 019 (D-PROD-13): nothing in public is executable by PUBLIC, and the
// Supabase Data API roles (anon, authenticated) hold no privileges there, while
// the application role keeps everything BizcaiaOS uses. The first block checks
// the shared database; the second builds a disposable database that imitates
// Supabase (non-superuser owner, anon/authenticated with Supabase-style default
// grants) to prove the guarded Supabase branch. Disposable objects are dropped.

const TRUSTED_FUNCTIONS = ['sync_authenticated_user', 'bootstrap_organization', 'accept_organization_invitation'];
const API_ROLES = ['anon', 'authenticated'];

/** Functions BizcaiaOS defines in public (extension members such as pgcrypto excluded). */
const bizcaiaosFunctionsSql = `
  select p.oid::regprocedure::text as signature, p.oid
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and not exists (
       select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
     )
   order by 1`;

async function withClient<T>(url: string, operation: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

/** Functions the given role (or 'public') can execute, among BizcaiaOS functions. */
async function executableBy(client: pg.Client, role: string) {
  const result = await client.query<{ signature: string; can: boolean }>(
    `select f.signature, has_function_privilege($1, f.oid, 'EXECUTE') as can from (${bizcaiaosFunctionsSql}) f`,
    [role],
  );
  return result.rows;
}

/** Every table/view and sequence privilege the role holds in public. */
async function relationPrivileges(client: pg.Client, role: string) {
  const result = await client.query<{ relname: string }>(
    `select c.relname
       from pg_class c
      where c.relnamespace = 'public'::regnamespace
        and ((c.relkind in ('r', 'p', 'v', 'm')
              and has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
          or (c.relkind = 'S' and has_sequence_privilege($1, c.oid, 'USAGE, SELECT, UPDATE')))
      order by 1`,
    [role],
  );
  return result.rows.map((row) => row.relname);
}

/** Roles named in the ACLs of the trusted identity functions. */
async function trustedFunctionGrantees(client: pg.Client) {
  const result = await client.query<{ proname: string; grantee: string }>(
    `select p.proname, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
       from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.pronamespace = 'public'::regnamespace and p.proname = any($1::text[]) and a.privilege_type = 'EXECUTE'`,
    [TRUSTED_FUNCTIONS],
  );
  return result.rows;
}

describe('public function privilege boundary (migration 019)', () => {
  const appRole = process.env.POSTGRES_APP_USER?.trim() || 'bizcaiaos_app';

  describe('shared database', () => {
    beforeAll(async () => {
      requireDatabaseEnv();
      await runMigrations();
    }, 60_000);

    it('records 019 once, in order, after the earlier migrations', async () => {
      await withClient(requireDatabaseEnv().migrateUrl, async (client) => {
        const recorded = (await client.query<{ id: string }>('select id from public.schema_migrations order by id')).rows.map(
          (row) => row.id,
        );
        expect(recorded).toEqual(MIGRATION_FILES);
        expect(recorded[18]).toBe('019_revoke_public_function_execute.sql');
      });
    });

    it('PUBLIC cannot execute any BizcaiaOS function; the application role can execute all of them', async () => {
      await withClient(requireDatabaseEnv().migrateUrl, async (client) => {
        const publicAccess = await executableBy(client, 'public');
        expect(publicAccess.length).toBeGreaterThan(0);
        expect(publicAccess.filter((row) => row.can).map((row) => row.signature)).toEqual([]);
        const appAccess = await executableBy(client, appRole);
        expect(appAccess.filter((row) => !row.can).map((row) => row.signature)).toEqual([]);
      });
    });

    it('anon and authenticated, where they exist, hold nothing in public', async () => {
      await withClient(requireDatabaseEnv().migrateUrl, async (client) => {
        const existing = (
          await client.query<{ rolname: string }>('select rolname from pg_roles where rolname = any($1::text[])', [API_ROLES])
        ).rows.map((row) => row.rolname);
        for (const role of existing) {
          expect((await executableBy(client, role)).filter((row) => row.can)).toEqual([]);
          expect(await relationPrivileges(client, role)).toEqual([]);
        }
      });
    });

    it('limits the trusted identity functions to their owner and the application role', async () => {
      await withClient(requireDatabaseEnv().migrateUrl, async (client) => {
        const owner = (await client.query<{ owner: string }>('select current_user as owner')).rows[0].owner;
        const grantees = await trustedFunctionGrantees(client);
        expect(new Set(grantees.map((row) => row.proname))).toEqual(new Set(TRUSTED_FUNCTIONS));
        expect(new Set(grantees.map((row) => row.grantee))).toEqual(new Set([owner, appRole]));
      });
    });
  });

  describe('Supabase-like database (anon/authenticated with default grants)', () => {
    const suffix = randomUUID().slice(0, 8);
    const ownerRole = `zz_f019_owner_${suffix}`;
    const appRoleLocal = `zz_f019_app_${suffix}`;
    const database = `zz_f019_db_${suffix}`;
    const password = `pw_${suffix}`;
    const createdApiRoles: string[] = [];

    const urlFor = (user: string, pass: string, db: string | null) => {
      const url = new URL(requireDatabaseEnv().migrateUrl);
      url.username = user;
      url.password = pass;
      if (db) url.pathname = `/${db}`;
      return url.toString();
    };
    const adminUrl = (db: string | null) => {
      const url = new URL(requireDatabaseEnv().migrateUrl);
      if (db) url.pathname = `/${db}`;
      return url.toString();
    };

    async function migrateDisposable() {
      const previous = {
        DATABASE_MIGRATE_URL: process.env.DATABASE_MIGRATE_URL,
        POSTGRES_APP_USER: process.env.POSTGRES_APP_USER,
      };
      process.env.DATABASE_MIGRATE_URL = urlFor(ownerRole, password, database);
      process.env.POSTGRES_APP_USER = appRoleLocal;
      try {
        return await runMigrations();
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }

    beforeAll(async () => {
      await withClient(adminUrl(null), async (admin) => {
        const superuser = await admin.query<{ rolsuper: boolean }>('select rolsuper from pg_roles where rolname = current_user');
        if (!superuser.rows[0]?.rolsuper) throw new Error('This suite needs the local DATABASE_MIGRATE_URL role to be a superuser');
        for (const role of API_ROLES) {
          const exists = await admin.query('select 1 from pg_roles where rolname = $1', [role]);
          if (!exists.rowCount) {
            await admin.query(`create role ${role} nologin`);
            createdApiRoles.push(role);
          }
        }
        // A managed-PostgreSQL style owner: no SUPERUSER, no CREATEROLE.
        await admin.query(`create role ${ownerRole} login nosuperuser nocreaterole password '${password}'`);
        await admin.query(`create role ${appRoleLocal} login nosuperuser nobypassrls password '${password}'`);
        await admin.query(`create database ${database} owner ${ownerRole}`);
      });
      // Supabase grants the Data API roles everything the owner creates in public.
      await withClient(adminUrl(database), async (admin) => {
        for (const kind of ['tables', 'sequences', 'functions']) {
          await admin.query(`alter default privileges for role ${ownerRole} in schema public grant all on ${kind} to anon, authenticated`);
        }
      });
    }, 60_000);

    afterAll(async () => {
      await withClient(adminUrl(null), async (admin) => {
        await admin.query(`drop database if exists ${database} with (force)`);
        for (const role of [ownerRole, appRoleLocal, ...createdApiRoles]) {
          await admin.query(`drop role if exists ${role}`);
        }
      });
    }, 60_000);

    it('applies 001-019 as a non-superuser owner, then nothing on a second run', async () => {
      expect((await migrateDisposable()).applied).toEqual(MIGRATION_FILES);
      expect((await migrateDisposable()).applied).toEqual([]);
      await withClient(adminUrl(database), async (admin) => {
        const count = await admin.query<{ n: number }>(
          `select count(*)::int as n from public.schema_migrations where id = '019_revoke_public_function_execute.sql'`,
        );
        expect(count.rows[0].n).toBe(1);
      });
    }, 120_000);

    it('removes every anon/authenticated privilege on tables (including schema_migrations), sequences and functions', async () => {
      await withClient(adminUrl(database), async (admin) => {
        for (const role of API_ROLES) {
          expect(await relationPrivileges(admin, role)).toEqual([]);
          expect((await executableBy(admin, role)).filter((row) => row.can).map((row) => row.signature)).toEqual([]);
          const migrations = await admin.query<{ can: boolean }>(
            `select has_table_privilege($1, 'public.schema_migrations', 'SELECT, INSERT, UPDATE, DELETE') as can`,
            [role],
          );
          expect(migrations.rows[0].can).toBe(false);
        }
        const defaults = await admin.query<{ n: number }>(
          `select count(*)::int as n
             from pg_default_acl d, aclexplode(d.defaclacl) a
            where a.grantee in (select oid from pg_roles where rolname = any($1::text[]))`,
          [API_ROLES],
        );
        expect(defaults.rows[0].n).toBe(0);
      });
    });

    it('keeps the application role able to execute every BizcaiaOS function, and PUBLIC unable', async () => {
      await withClient(adminUrl(database), async (admin) => {
        expect((await executableBy(admin, appRoleLocal)).filter((row) => !row.can)).toEqual([]);
        expect((await executableBy(admin, 'public')).filter((row) => row.can)).toEqual([]);
        const grantees = await trustedFunctionGrantees(admin);
        expect(new Set(grantees.map((row) => row.grantee))).toEqual(new Set([ownerRole, appRoleLocal]));
      });
    });

    it('a function the owner creates later is executable by the application role only', async () => {
      await withClient(urlFor(ownerRole, password, database), async (owner) => {
        await owner.query(`create function public.zz_f019_future_check() returns integer language sql as 'select 1'`);
      });
      try {
        await withClient(adminUrl(database), async (admin) => {
          const access = await admin.query<{ role: string; can: boolean }>(
            `select r as role, has_function_privilege(r, 'public.zz_f019_future_check()', 'EXECUTE') as can
               from unnest($1::text[]) r`,
            [['public', 'anon', 'authenticated', appRoleLocal]],
          );
          expect(Object.fromEntries(access.rows.map((row) => [row.role, row.can]))).toEqual({
            public: false,
            anon: false,
            authenticated: false,
            [appRoleLocal]: true,
          });
        });
      } finally {
        await withClient(urlFor(ownerRole, password, database), (owner) =>
          owner.query('drop function if exists public.zz_f019_future_check()'),
        );
      }
    });
  });
});
