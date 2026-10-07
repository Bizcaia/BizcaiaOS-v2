import './loadEnv.js';

import pg, { type PoolClient, type QueryResultRow } from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('DATABASE_URL is not configured; API database calls will fail.');
}

// A PostgreSQL date is a calendar day, not an instant. The driver would turn
// it into a Date at the server's local midnight, which reaches the client as
// a timestamp that depends on the server timezone (and can be the day
// before). The API returns the stored day, YYYY-MM-DD, instead.
const DATE_OID = 1082;
const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === DATE_OID && format !== 'binary'
      ? (value: string) => value
      : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
};

export const pool = new Pool({
  connectionString,
  types,
  max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
  ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: true } : undefined,
});

export async function withTransaction<T>(
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
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

export async function withActorTransaction<T>(
  actorUserId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(async (client) => {
    await client.query("select set_config('app.user_id', $1, true)", [actorUserId]);
    return operation(client);
  });
}

export function firstRow<T extends QueryResultRow>(rows: T[], message = 'Record not found'): T {
  const row = rows[0];
  if (!row) {
    const error = new Error(message) as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  return row;
}
