import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';
import { LIFECYCLE_TABLES, reapplyWithTableLocks, requireDatabaseEnv, runWithTableLocks } from './postgresHarness.js';

const LIFECYCLE_MIGRATIONS = [
  '012_property_lifecycle_history.sql',
  '013_property_stage_transitions.sql',
  '014_property_status_transitions.sql',
  '015_lifecycle_negotiation_exception.sql',
  '016_property_creation_rules.sql',
  '017_legacy_stage_remediation.sql',
  '018_lifecycle_optimistic_concurrency.sql',
  '020_property_risk_history.sql',
];

/**
 * The suites re-apply migration files while parallel suites use the same tables.
 * A re-apply that took its table locks statement by statement deadlocked with a
 * transaction holding one of those tables and asking for the next: the timeline
 * query against 006 (negotiation_events, then negotiations) was the observed case.
 * Each case below puts a transaction in exactly that position.
 */
describe('PostgreSQL migration re-apply locking', () => {
  const migrationSql = (file: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', file), 'utf8');

  async function connect() {
    const client = new pg.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await client.connect();
    return client;
  }

  /** The strong table locks a session holds or waits for. */
  async function strongLocks(observer: pg.Client, pid: number) {
    const result = await observer.query<{ relname: string; mode: string; granted: boolean }>(
      `select c.relname, l.mode, l.granted
         from pg_locks l
         join pg_class c on c.oid = l.relation
         join pg_namespace n on n.oid = c.relnamespace
        where l.pid = $1 and l.locktype = 'relation' and n.nspname = 'public' and c.relkind = 'r'
          and l.mode in ('ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
        order by c.relname, l.mode`,
      [pid],
    );
    return result.rows;
  }

  /** Runs `operation` on a migration-owner session that holds the migration advisory lock. */
  async function asReapplier<T>(operation: (admin: pg.Client, pid: number) => Promise<T>): Promise<T> {
    const admin = await connect();
    try {
      await admin.query('select pg_advisory_lock(87236401)');
      const pid = (await admin.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid;
      return await operation(admin, pid);
    } finally {
      try {
        await admin.query('select pg_advisory_unlock(87236401)');
      } catch {
        // ignore unlock failures after a fatal error
      }
      await admin.end();
    }
  }

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
  }, 60_000);

  it.each([
    // The timeline query reads negotiation_events and then negotiations; 006 alters them in the opposite order.
    ['006_negotiations_rls.sql', ['negotiations', 'negotiation_events'], 'negotiation_events', 'access share', 'negotiations', 'access share'],
    // The timeline query reads documents and then agreement_signatures; 010 alters them in the opposite order.
    ['010_agreement_signatures.sql', ['agreement_signatures', 'property_owners', 'documents'], 'documents', 'access share', 'agreement_signatures', 'access share'],
    // A transaction reads documents and then writes to it; 007 takes a share lock (create index) and then upgrades it.
    ['007_documents.sql', ['documents'], 'documents', 'access share', 'documents', 'row exclusive'],
  ])(
    're-applies %s while a transaction holds one of its tables and then asks for the next',
    async (file, tables, heldTable, heldMode, nextTable, nextMode) => {
      const observer = await connect();
      const other = await connect();
      try {
        await asReapplier(async (admin, pid) => {
          await other.query('begin');
          await other.query(`lock table public.${heldTable} in ${heldMode} mode`);
          const reapply = runWithTableLocks(admin, tables, migrationSql(file));
          const settled = reapply.then(
            () => 'applied',
            (error: Error) => error,
          );
          try {
            // The re-apply ends up waiting for the held table while holding no other table,
            // so the other transaction's next lock is free.
            await expect
              .poll(() => strongLocks(observer, pid), { timeout: 10_000, interval: 25 })
              .toEqual([{ relname: heldTable, mode: 'AccessExclusiveLock', granted: false }]);
            await other.query(`lock table public.${nextTable} in ${nextMode} mode`);
            await other.query('commit');
            expect(await settled).toBe('applied');
            expect(await strongLocks(observer, pid)).toEqual([]);
          } finally {
            // Let the re-apply finish before its session is closed, also when an expectation failed.
            await other.query('rollback').catch(() => undefined);
            await settled;
          }
        });
      } finally {
        await other.query('rollback').catch(() => undefined);
        await other.end();
        await observer.end();
      }
    },
    60_000,
  );

  // The lifecycle suites re-apply 012-018 through reapplyWithTableLocks. They used to lock
  // properties and then the history table one after the other, and 017 alters both
  // remediation tables after a share lock on each.
  it.each([
    // A history read takes the history table and then, through its row-security function, properties.
    ['property_lifecycle_history', 'access share', 'properties', 'access share'],
    // A transaction reads a remediation table and then writes to it; 017 takes a share lock (create index) and then upgrades it.
    ['property_stage_remediations', 'access share', 'property_stage_remediations', 'row exclusive'],
    // A transaction reads the remediation events and then a property; 017 alters the events table after properties is held.
    ['property_stage_remediation_events', 'access share', 'properties', 'access share'],
  ])(
    're-applies the lifecycle migrations while a transaction holds %s (%s) and then asks for %s (%s)',
    async (heldTable, heldMode, nextTable, nextMode) => {
      const observer = await connect();
      const other = await connect();
      try {
        // The advisory lock is held before the other transaction takes its table, as in the
        // cases above: no other suite's re-apply can then be waiting behind that transaction.
        await asReapplier(async (admin, pid) => {
          await other.query('begin');
          await other.query(`lock table public.${heldTable} in ${heldMode} mode`);
          // The whole chain, in order: later files redefine objects of earlier ones.
          const settled = reapplyWithTableLocks(admin, LIFECYCLE_TABLES, async () => {
            for (const file of LIFECYCLE_MIGRATIONS) await admin.query(migrationSql(file));
          }).then(
            () => 'applied',
            (error: Error) => error,
          );
          try {
            await expect
              .poll(() => strongLocks(observer, pid), { timeout: 10_000, interval: 25 })
              .toEqual([{ relname: heldTable, mode: 'AccessExclusiveLock', granted: false }]);
            await other.query(`lock table public.${nextTable} in ${nextMode} mode`);
            await other.query('commit');
            expect(await settled).toBe('applied');
            expect(await strongLocks(observer, pid)).toEqual([]);
          } finally {
            // Let the re-apply finish before its session is closed, also when an expectation failed.
            await other.query('rollback').catch(() => undefined);
            await settled;
          }
        });
      } finally {
        await other.query('rollback').catch(() => undefined);
        await Promise.all([other.end(), observer.end()]);
      }
    },
    60_000,
  );

  it('refuses SQL that takes a strong lock on a table it did not declare, and rolls everything back', async () => {
    const observer = await connect();
    try {
      await asReapplier(async (admin, pid) => {
        // The undeclared lock is one that ordinary reads and writes do not conflict with, so
        // this deliberately wrong call cannot itself wait behind a parallel suite.
        const sql = `create table public.zz_reapply_guard (); lock table public.negotiations in share update exclusive mode;`;
        await expect(runWithTableLocks(admin, ['negotiation_events'], sql)).rejects.toThrow(
          'The migration locks tables that were not locked up front: negotiations, zz_reapply_guard',
        );
        expect(await strongLocks(observer, pid)).toEqual([]);
        expect((await admin.query<{ found: string | null }>(`select to_regclass('public.zz_reapply_guard')::text as found`)).rows[0].found).toBeNull();
      });
    } finally {
      await observer.end();
    }
  }, 60_000);

  it('refuses table names it cannot use as given', async () => {
    await asReapplier(async (admin) => {
      await expect(runWithTableLocks(admin, [], 'select 1')).rejects.toThrow('plain public table names');
      await expect(runWithTableLocks(admin, ['public.tasks'], 'select 1')).rejects.toThrow('plain public table names');
    });
  });
});
