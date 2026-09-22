import '../loadEnv.js';
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
