import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_FILES, runMigrations } from '../migrate.js';
import { provisionApplicationRole } from '../provisionAppRole.js';
import { requireDatabaseEnv } from './postgresHarness.js';

// C-02: the runner must work for a non-superuser database owner and must never
// create, alter, or re-password the application role. Every database and role
// here is disposable and dropped in afterAll; the shared database is only read.

const suffix = randomUUID().slice(0, 8);
const ownerRole = `zz_c02_owner_${suffix}`;
const appRole = `zz_c02_app_${suffix}`;
const bypassRole = `zz_c02_bypass_${suffix}`;
const otherRole = `zz_c02_other_${suffix}`;
const provisionedRole = `zz_c02_prov_${suffix}`;
const mainDb = `zz_c02_main_${suffix}`;
const emptyDb = `zz_c02_empty_${suffix}`;
const roles = [ownerRole, appRole, bypassRole, otherRole, provisionedRole];
const databases = [mainDb, emptyDb];
const rolePassword = `pw_${suffix}`;

function urlFor(user: string, password: string, database: string) {
  const url = new URL(requireDatabaseEnv().migrateUrl);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

async function withEnv<T>(overrides: Record<string, string | undefined>, operation: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Superuser session on the given database (the local migrate role is a superuser). */
async function asAdmin<T>(database: string | null, operation: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = new URL(requireDatabaseEnv().migrateUrl);
  if (database) url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function passwordHash(roleName: string) {
  return asAdmin(null, async (client) => {
    const result = await client.query<{ rolpassword: string | null }>(
      'select rolpassword from pg_authid where rolname = $1',
      [roleName],
    );
    return result.rows[0]?.rolpassword ?? null;
  });
}

function migrateAsOwner(database: string, role = appRole) {
  return withEnv(
    {
      DATABASE_MIGRATE_URL: urlFor(ownerRole, rolePassword, database),
      POSTGRES_APP_USER: role,
      POSTGRES_APP_PASSWORD: undefined,
    },
    () => runMigrations(),
  );
}

describe('migration runner privileges (C-02)', () => {
  beforeAll(async () => {
    await asAdmin(null, async (client) => {
      const superuser = await client.query<{ rolsuper: boolean }>(
        'select rolsuper from pg_roles where rolname = current_user',
      );
      if (!superuser.rows[0]?.rolsuper) {
        throw new Error('This suite needs the local DATABASE_MIGRATE_URL role to be a superuser');
      }
      // A normal managed-PostgreSQL style owner: no SUPERUSER, no CREATEROLE.
      await client.query(`create role ${ownerRole} login nosuperuser nocreaterole password '${rolePassword}'`);
      await client.query(`create role ${appRole} login nosuperuser nobypassrls password '${rolePassword}'`);
      await client.query(`create role ${bypassRole} login nosuperuser bypassrls password '${rolePassword}'`);
      await client.query(`create role ${otherRole} login nosuperuser password '${rolePassword}'`);
      for (const database of databases) {
        await client.query(`create database ${database} owner ${ownerRole}`);
      }
    });
  }, 60_000);

  afterAll(async () => {
    await asAdmin(null, async (client) => {
      for (const database of databases) {
        await client.query(`drop database if exists ${database} with (force)`);
      }
      for (const role of roles) {
        await client.query(`drop role if exists ${role}`);
      }
    });
  }, 60_000);

  it('applies 001-018 as a non-superuser owner without touching the application role', async () => {
    const before = await passwordHash(appRole);

    const first = await migrateAsOwner(mainDb);
    expect(first.applied).toEqual(MIGRATION_FILES);

    const second = await migrateAsOwner(mainDb);
    expect(second.applied).toEqual([]);

    expect(await passwordHash(appRole)).toBe(before);
    await asAdmin(mainDb, async (client) => {
      const role = await client.query('select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = $1', [
        appRole,
      ]);
      expect(role.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });

      const recorded = await client.query<{ id: string }>('select id from public.schema_migrations order by id');
      expect(recorded.rows.map((row) => row.id)).toEqual(MIGRATION_FILES);

      const signatures = await client.query<{ proname: string; count: number }>(
        `select proname, count(*)::int as count from pg_proc
          where pronamespace = 'public'::regnamespace
            and proname in ('transition_property_stage', 'transition_property_status', 'resolve_property_stage_remediation')
          group by proname order by proname`,
      );
      expect(signatures.rows.map((row) => row.count)).toEqual([1, 1, 1]);

      const privileges = await client.query(
        `select has_table_privilege($1, 'public.property_lifecycle_history', 'select') as history,
                has_table_privilege($1, 'public.property_stage_remediations', 'select') as remediations,
                has_function_privilege($1,
                  'public.transition_property_stage(uuid, public.acquisition_stage, text, boolean, public.acquisition_stage)',
                  'execute') as transition,
                has_table_privilege($1, 'public.schema_migrations', 'select') as migrations`,
        [appRole],
      );
      expect(privileges.rows[0]).toEqual({ history: true, remediations: true, transition: true, migrations: false });
    });
  }, 120_000);

  it('does not require POSTGRES_APP_PASSWORD and leaves the shared application role unchanged', async () => {
    const sharedApp = process.env.POSTGRES_APP_USER?.trim() || 'bizcaiaos_app';
    const before = await passwordHash(sharedApp);
    const result = await withEnv({ POSTGRES_APP_PASSWORD: undefined }, () => runMigrations());
    expect(result.applied).toEqual([]);
    expect(await passwordHash(sharedApp)).toBe(before);
  }, 60_000);

  it('refuses before writing anything when the application role is missing', async () => {
    await expect(migrateAsOwner(emptyDb, `zz_c02_missing_${suffix}`)).rejects.toThrow(
      /preflight failed; nothing was changed[\s\S]*does not exist/,
    );
    await asAdmin(emptyDb, async (client) => {
      const tracked = await client.query(`select to_regclass('public.schema_migrations') as tracked`);
      expect(tracked.rows[0].tracked).toBeNull();
    });
  });

  it('refuses an application role with BYPASSRLS', async () => {
    await expect(migrateAsOwner(emptyDb, bypassRole)).rejects.toThrow(/BYPASSRLS/);
  });

  it('refuses to migrate as the application role', async () => {
    await expect(
      withEnv(
        { DATABASE_MIGRATE_URL: urlFor(appRole, rolePassword, mainDb), POSTGRES_APP_USER: appRole },
        () => runMigrations(),
      ),
    ).rejects.toThrow(/connects as the application role/);
  });

  it('refuses a migration role that does not own the existing tables', async () => {
    await asAdmin(mainDb, (client) => client.query(`grant create on schema public to ${otherRole}`));
    await expect(
      withEnv(
        { DATABASE_MIGRATE_URL: urlFor(otherRole, rolePassword, mainDb), POSTGRES_APP_USER: appRole },
        () => runMigrations(),
      ),
    ).rejects.toThrow(/does not own: .*properties/);
  });

  it('refuses a migration history that is not a prefix of the registered list', async () => {
    const gap = '005_projects_write_rls.sql';
    await asAdmin(mainDb, (client) => client.query('delete from public.schema_migrations where id = $1', [gap]));
    try {
      await expect(migrateAsOwner(mainDb)).rejects.toThrow(/not a prefix[\s\S]*005_projects_write_rls\.sql/);
      await asAdmin(mainDb, async (client) => {
        const count = await client.query<{ count: number }>('select count(*)::int as count from public.schema_migrations');
        expect(count.rows[0].count).toBe(MIGRATION_FILES.length - 1);
      });
    } finally {
      await asAdmin(mainDb, (client) => client.query('insert into public.schema_migrations (id) values ($1)', [gap]));
    }

    await asAdmin(mainDb, (client) => client.query(`insert into public.schema_migrations (id) values ('999_unknown.sql')`));
    try {
      await expect(migrateAsOwner(mainDb)).rejects.toThrow(/unregistered migrations: 999_unknown\.sql/);
    } finally {
      await asAdmin(mainDb, (client) => client.query(`delete from public.schema_migrations where id = '999_unknown.sql'`));
    }
  });

  it('provisions a missing application role once and never alters an existing one', async () => {
    const env = { DATABASE_MIGRATE_URL: requireDatabaseEnv().migrateUrl, POSTGRES_APP_USER: provisionedRole };

    const created = await withEnv({ ...env, POSTGRES_APP_PASSWORD: `first_${suffix}` }, () => provisionApplicationRole());
    expect(created).toEqual({ created: true, roleName: provisionedRole });
    const hash = await passwordHash(provisionedRole);
    await asAdmin(null, async (client) => {
      const role = await client.query('select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname = $1', [
        provisionedRole,
      ]);
      expect(role.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreaterole: false });
    });

    const again = await withEnv({ ...env, POSTGRES_APP_PASSWORD: `second_${suffix}` }, () => provisionApplicationRole());
    expect(again).toEqual({ created: false, roleName: provisionedRole });
    expect(await passwordHash(provisionedRole)).toBe(hash);

    await expect(
      withEnv({ ...env, POSTGRES_APP_USER: bypassRole }, () => provisionApplicationRole()),
    ).rejects.toThrow(/must be LOGIN, NOSUPERUSER and NOBYPASSRLS; it was not changed/);
  });
});
