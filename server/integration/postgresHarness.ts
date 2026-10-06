import '../loadEnv.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg, { type PoolClient } from 'pg';

const { Pool } = pg;

export function requireDatabaseEnv() {
  const url = process.env.DATABASE_URL;
  const migrateUrl = process.env.DATABASE_MIGRATE_URL;
  if (!url || !migrateUrl) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATE_URL must be set for PostgreSQL integration tests');
  }
  return { url, migrateUrl };
}

export function createAppPool() {
  return new Pool({ connectionString: requireDatabaseEnv().url, max: 8 });
}

export async function asUser<T>(
  pool: pg.Pool,
  userId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.user_id', $1, true)", [userId]);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs migration SQL, or a function that runs it, in one transaction, holding ACCESS EXCLUSIVE on every table it
 * alters before the first statement, so the re-apply cannot deadlock with the parallel
 * suites that read and write those tables.
 *
 * A migration takes its table locks one statement at a time, in its own order (006:
 * negotiations, then negotiation_events) or by upgrading a weaker lock (create index,
 * then drop trigger). A parallel transaction that holds one of those tables and asks for
 * the next (the timeline query reads negotiation_events, then negotiations) then waits on
 * this session while this session waits on it, and PostgreSQL aborts one of the two.
 *
 * So no lock is ever waited for while another is held: the first table is waited for
 * holding nothing, the rest are taken NOWAIT, and when one is busy everything is released
 * and the busy table becomes the one to wait for. A session that never waits while holding
 * a lock cannot be part of a deadlock. The migration must not take a strong lock on a
 * table outside `tables`; that is checked before commit.
 */
export async function runWithTableLocks(
  admin: pg.Client,
  tables: readonly string[],
  work: string | (() => Promise<unknown>),
): Promise<void> {
  if (!tables.length || tables.some((table) => !/^[a-z_]+$/.test(table))) throw new Error('runWithTableLocks needs plain public table names');
  let order = [...tables];
  for (let attempt = 1; ; attempt += 1) {
    let current = order[0];
    await admin.query('begin');
    try {
      for (const table of order) {
        current = table;
        await admin.query(`lock table public.${table} in access exclusive mode${table === order[0] ? '' : ' nowait'}`);
      }
      break;
    } catch (error) {
      await admin.query('rollback');
      if ((error as { code?: string }).code !== '55P03' || attempt >= 500) throw error;
      const busy = current;
      order = [busy, ...order.filter((table) => table !== busy)];
    }
  }
  try {
    if (typeof work === 'string') await admin.query(work);
    else await work();
    const undeclared = await admin.query<{ relname: string }>(
      `select distinct c.relname
         from pg_locks l
         join pg_class c on c.oid = l.relation
         join pg_namespace n on n.oid = c.relnamespace
        where l.pid = pg_backend_pid() and l.locktype = 'relation' and l.granted
          and n.nspname = 'public' and c.relkind in ('r', 'p')
          and l.mode in ('ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
          and c.relname <> all($1::text[])
        order by c.relname`,
      [tables],
    );
    if (undeclared.rows.length) {
      throw new Error(`The migration locks tables that were not locked up front: ${undeclared.rows.map((row) => row.relname).join(', ')}`);
    }
    await admin.query('commit');
  } catch (error) {
    await admin.query('rollback');
    throw error;
  }
}

/** Every table the lifecycle migrations (012-018) alter: 012-016 the first two, 017 the last three. */
export const LIFECYCLE_TABLES = ['properties', 'property_lifecycle_history', 'property_stage_remediations', 'property_stage_remediation_events'] as const;

/**
 * runWithTableLocks under the migration advisory lock, on a session the caller keeps. The
 * lifecycle suites (012-018) use it: they used to lock properties and then wait for the
 * history table while holding it, which deadlocked with a history read (that table first,
 * then properties through its row-security function); 017 also alters both remediation
 * tables, after a share lock on each.
 */
export async function reapplyWithTableLocks(admin: pg.Client, tables: readonly string[], work: () => Promise<unknown>): Promise<void> {
  try {
    await admin.query('select pg_advisory_lock(87236401)');
    await runWithTableLocks(admin, tables, work);
  } finally {
    try {
      await admin.query('select pg_advisory_unlock(87236401)');
    } catch {
      // ignore unlock failures after a fatal error
    }
  }
}

/**
 * Re-applies one migration file under the migration advisory lock, so concurrent suites
 * do not race CREATE OR REPLACE / GRANT and function text always matches the repo even
 * when schema_migrations already recorded the file. `tables` are the tables the file
 * alters (see runWithTableLocks).
 */
export async function reapplyMigration(file: string, tables: readonly string[]): Promise<void> {
  const admin = new pg.Client({ connectionString: requireDatabaseEnv().migrateUrl });
  await admin.connect();
  try {
    await admin.query('select pg_advisory_lock(87236401)');
    const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', file), 'utf8');
    await runWithTableLocks(admin, tables, sql);
  } finally {
    try {
      await admin.query('select pg_advisory_unlock(87236401)');
    } catch {
      // ignore unlock failures after a fatal error
    }
    await admin.end();
  }
}

/**
 * Test fixture for a property that must start somewhere other than the
 * identified stage (L-05 limits application creation to identified/active).
 * The insert runs as a controlled owner operation, with actorId recorded as
 * the acting user so lifecycle history keeps the same creator.
 */
export async function insertPropertyFixture(actorId: string, sql: string, params: unknown[]): Promise<string> {
  const client = new pg.Client({ connectionString: requireDatabaseEnv().migrateUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.user_id', $1, true)", [actorId]);
    const result = await client.query<{ id: string }>(sql, params);
    await client.query('commit');
    return result.rows[0].id;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
}

export async function expectSqlError(operation: () => Promise<unknown>, code: string) {
  try {
    await operation();
    throw new Error(`Expected SQL error ${code}`);
  } catch (error) {
    const actual = (error as { code?: string }).code;
    if (actual !== code) {
      throw error;
    }
  }
}

export async function syncUser(
  pool: pg.Pool,
  subject: string,
  name: string,
  email: string,
) {
  const result = await pool.query<{ sync_authenticated_user: string }>(
    'select public.sync_authenticated_user($1, $2, $3)',
    [subject, name, email],
  );
  return result.rows[0].sync_authenticated_user;
}

export async function bootstrapOrg(
  pool: pg.Pool,
  name: string,
  slug: string,
  subject: string,
  displayName: string,
  email: string,
) {
  const result = await pool.query<{ organization_id: string; user_id: string }>(
    'select * from public.bootstrap_organization($1, $2, $3, $4, $5, $6)',
    [name, slug, subject, displayName, email, 'Asia/Manila'],
  );
  return result.rows[0];
}

export async function addMember(
  pool: pg.Pool,
  adminUserId: string,
  organizationId: string,
  userId: string,
  role: string,
) {
  await asUser(pool, adminUserId, async (client) => {
    await client.query(
      `insert into public.organization_memberships (organization_id, user_id, role, is_active)
       values ($1, $2, $3, true)`,
      [organizationId, userId, role],
    );
  });
}
