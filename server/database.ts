import './loadEnv.js';

import pg, { type PoolClient, type QueryResultRow } from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('DATABASE_URL is not configured; API database calls will fail.');
}

export const pool = new Pool({
  connectionString,
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
