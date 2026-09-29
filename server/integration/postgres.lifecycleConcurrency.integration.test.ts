import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';
import { loadPropertyTimeline } from '../operationsRoutes.js';
import {
  addMember,
  asUser,
  bootstrapOrg,
  createAppPool,
  insertPropertyFixture,
  requireDatabaseEnv,
  syncUser,
} from './postgresHarness.js';

const suffix = randomUUID().slice(0, 8);

type Outcome = { ok: true } | { ok: false; code: string | undefined; detail: unknown };

/**
 * L-07: real concurrency. Operation A runs inside an open transaction and holds
 * the property row lock; operation B is then started in a second session and
 * is observed waiting on that lock before A commits. The database serializes
 * them, and B then runs against A's committed result.
 */
describe('PostgreSQL lifecycle concurrency and stale screens (L-07)', () => {
  const pool = createAppPool();
  let admin: pg.Client;
  let orgA: string;
  let lamA: string;
  let supervisorScoped: string;
  let negotiatorAssigned: string;
  let viewerA: string;
  let projectA: string;

  const createProperty = () =>
    asUser(pool, lamA, async (client) =>
      (
        await client.query<{ id: string }>(
          `insert into public.properties (organization_id, project_id, property_reference, assigned_negotiator_id, assigned_manager_id)
           values ($1, $2, $3, $4, $5) returning id`,
          [orgA, projectA, `CC-${randomUUID().slice(0, 8)}-${suffix}`, negotiatorAssigned, supervisorScoped],
        )
      ).rows[0].id,
    );

  const legacyProperty = () =>
    insertPropertyFixture(
      lamA,
      `insert into public.properties (organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id, assigned_manager_id)
       values ($1, $2, $3, 'withdrawn', $4, $5) returning id`,
      [orgA, projectA, `CC-L-${randomUUID().slice(0, 8)}-${suffix}`, negotiatorAssigned, supervisorScoped],
    );

  async function session(actor: string) {
    const client = await pool.connect();
    await client.query('begin');
    await client.query("select set_config('app.user_id', $1, true)", [actor]);
    const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid;
    return { client, pid };
  }

  async function waitUntilBlocked(pid: number) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const row = (await admin.query<{ wait_event_type: string | null }>('select wait_event_type from pg_stat_activity where pid = $1', [pid])).rows[0];
      if (row?.wait_event_type === 'Lock') return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`session ${pid} never waited on a lock`);
  }

  const outcome = (promise: Promise<unknown>): Promise<Outcome> =>
    promise.then(
      () => ({ ok: true }) as const,
      (error: { code?: string; detail?: string }) => ({
        ok: false,
        code: error.code,
        detail: error.detail ? JSON.parse(error.detail) : undefined,
      }),
    );

  /** Runs A (holding the row lock), then B concurrently; commits A, then settles B. */
  async function race(
    actorA: string,
    operationA: (client: PoolClient) => Promise<unknown>,
    actorB: string,
    operationB: (client: PoolClient) => Promise<unknown>,
  ) {
    const a = await session(actorA);
    const b = await session(actorB);
    try {
      await operationA(a.client);
      const pendingB = outcome(operationB(b.client));
      await waitUntilBlocked(b.pid);
      await a.client.query('commit');
      const resultB = await pendingB;
      await b.client.query(resultB.ok ? 'commit' : 'rollback');
      return resultB;
    } finally {
      await a.client.query('rollback').catch(() => undefined);
      await b.client.query('rollback').catch(() => undefined);
      a.client.release();
      b.client.release();
    }
  }

  const stage = (property: string, target: string, expected: string | null, reason: string | null = null) => (client: PoolClient) =>
    client.query('select * from public.transition_property_stage($1, $2, $3, false, $4)', [property, target, reason, expected]);
  const status = (property: string, target: string, expected: string | null, reason: string | null = null) => (client: PoolClient) =>
    client.query('select * from public.transition_property_status($1, $2, $3, false, $4)', [property, target, reason, expected]);
  const resolve = (property: string, target: string, expected: string | null) => (client: PoolClient) =>
    client.query('select * from public.resolve_property_stage_remediation($1, $2, $3, $4, null, null, $5)', [
      property,
      target,
      'Survey decides',
      'Survey 2024',
      expected,
    ]);

  const state = async (property: string) =>
    (await admin.query('select acquisition_stage, acquisition_status from public.properties where id = $1', [property])).rows[0];

  /** Lifecycle history after the two creation rows. */
  const changes = async (property: string) =>
    (
      await admin.query(
        `select field, from_value, to_value, actor_user_id, remediation_id is not null as remediation
           from public.property_lifecycle_history
          where property_id = $1 and from_value is not null
          order by changed_at, id`,
        [property],
      )
    ).rows;

  const timelineChanges = async (property: string) =>
    (await asUser(pool, viewerA, (client) => loadPropertyTimeline(client, viewerA, property, { limit: 50, offset: 0 })))
      .filter((entry) => entry.source_type === 'lifecycle' && !entry.summary.includes(' set to '))
      .map((entry) => entry.summary)
      .reverse();

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    const { default: pgModule } = await import('pg');
    admin = new pgModule.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    // Re-apply 018 under the migration advisory lock so function text always
    // matches the repo; properties, then the history table, are locked first.
    try {
      await admin.query('select pg_advisory_lock(87236401)');
      await admin.query('begin');
      try {
        await admin.query('lock table public.properties in access exclusive mode');
        await admin.query('lock table public.property_lifecycle_history in access exclusive mode');
        await admin.query(
          readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', '018_lifecycle_optimistic_concurrency.sql'), 'utf8'),
        );
        await admin.query('commit');
      } catch (error) {
        await admin.query('rollback');
        throw error;
      }
    } finally {
      try {
        await admin.query('select pg_advisory_unlock(87236401)');
      } catch {
        // ignore unlock failures after a fatal error
      }
    }

    const org = await bootstrapOrg(pool, `Cc North ${suffix}`, `cc-north-${suffix}`, `auth0|cc-admin-${suffix}`, 'Cc Admin', `cc-admin-${suffix}@example.com`);
    orgA = org.organization_id;
    const user = (key: string, name: string) => syncUser(pool, `auth0|cc-${key}-${suffix}`, name, `cc-${key}-${suffix}@example.com`);
    lamA = await user('lam', 'Cc LAM');
    supervisorScoped = await user('sup', 'Cc Supervisor');
    negotiatorAssigned = await user('neg', 'Cc Negotiator');
    viewerA = await user('viewer', 'Cc Viewer');
    await addMember(pool, org.user_id, orgA, lamA, 'land_acquisition_manager');
    await addMember(pool, org.user_id, orgA, supervisorScoped, 'supervisor');
    await addMember(pool, org.user_id, orgA, negotiatorAssigned, 'negotiator');
    await addMember(pool, org.user_id, orgA, viewerA, 'viewer');
    projectA = await asUser(pool, lamA, async (client) =>
      (
        await client.query<{ id: string }>(
          `insert into public.projects (organization_id, code, name, status) values ($1, 'CC-01', 'Concurrency Program', 'active') returning id`,
          [orgA],
        )
      ).rows[0].id,
    );
  }, 60_000);

  afterAll(async () => {
    await admin?.end();
    await pool.end();
  });

  describe('Case A: concurrent stage transitions', () => {
    it('lets the first commit and refuses the stale second as a conflict, with no lost update or false history', async () => {
      const property = await createProperty();
      const result = await race(
        lamA,
        stage(property, 'initial_contact', 'identified'),
        supervisorScoped,
        stage(property, 'owner_validation', 'identified'),
      );
      expect(result).toEqual({
        ok: false,
        code: '40001',
        detail: { conflict: 'lifecycle', field: 'acquisition_stage', current: 'initial_contact', expected: 'identified' },
      });
      expect(await state(property)).toEqual({ acquisition_stage: 'initial_contact', acquisition_status: 'active' });
      expect(await changes(property)).toEqual([
        { field: 'acquisition_stage', from_value: 'identified', to_value: 'initial_contact', actor_user_id: lamA, remediation: false },
      ]);
      expect(await timelineChanges(property)).toEqual(['Acquisition stage changed from Identified to Initial contact']);
    });

    it('serializes calls without an expected value (owner-controlled path): the second applies to the first result, history stays exact', async () => {
      const property = await createProperty();
      const result = await race(
        lamA,
        stage(property, 'initial_contact', null),
        supervisorScoped,
        stage(property, 'owner_validation', null),
      );
      expect(result).toEqual({ ok: true });
      expect(await state(property)).toMatchObject({ acquisition_stage: 'owner_validation' });
      expect((await changes(property)).map((row) => [row.from_value, row.to_value, row.actor_user_id])).toEqual([
        ['identified', 'initial_contact', lamA],
        ['initial_contact', 'owner_validation', supervisorScoped],
      ]);
    });
  });

  describe('Case B: concurrent status transitions', () => {
    it('lets the first commit and refuses the stale second as a conflict, writing no history for it', async () => {
      const property = await createProperty();
      const result = await race(
        negotiatorAssigned,
        status(property, 'on_hold', 'active'),
        supervisorScoped,
        status(property, 'withdrawn', 'active', 'Owner declined'),
      );
      expect(result).toEqual({
        ok: false,
        code: '40001',
        detail: { conflict: 'lifecycle', field: 'acquisition_status', current: 'on_hold', expected: 'active' },
      });
      expect(await state(property)).toEqual({ acquisition_stage: 'identified', acquisition_status: 'on_hold' });
      expect(await changes(property)).toEqual([
        { field: 'acquisition_status', from_value: 'active', to_value: 'on_hold', actor_user_id: negotiatorAssigned, remediation: false },
      ]);
      expect(await timelineChanges(property)).toEqual(['Acquisition status changed from Active to On hold']);
    });
  });

  describe('Mixed: concurrent stage and status transitions', () => {
    it('lets both proceed, since they change different lifecycle fields (D-X1)', async () => {
      const property = await createProperty();
      const result = await race(
        lamA,
        stage(property, 'initial_contact', 'identified'),
        negotiatorAssigned,
        status(property, 'on_hold', 'active'),
      );
      expect(result).toEqual({ ok: true });
      expect(await state(property)).toEqual({ acquisition_stage: 'initial_contact', acquisition_status: 'on_hold' });
      expect((await changes(property)).map((row) => [row.field, row.from_value, row.to_value])).toEqual([
        ['acquisition_stage', 'identified', 'initial_contact'],
        ['acquisition_status', 'active', 'on_hold'],
      ]);
      expect(await timelineChanges(property)).toEqual([
        'Acquisition stage changed from Identified to Initial contact',
        'Acquisition status changed from Active to On hold',
      ]);
    });
  });

  describe('Case C: concurrent remediation', () => {
    it('resolves once: a concurrent second resolution with the legacy stage is a conflict, not a second resolution', async () => {
      const property = await legacyProperty();
      await asUser(pool, lamA, (client) => client.query('select * from public.start_property_stage_remediation($1)', [property]));
      const result = await race(
        lamA,
        resolve(property, 'documentation', 'withdrawn'),
        supervisorScoped,
        resolve(property, 'legal_review', 'withdrawn'),
      );
      expect(result).toEqual({
        ok: false,
        code: '40001',
        detail: { conflict: 'lifecycle', field: 'acquisition_stage', current: 'documentation', expected: 'withdrawn' },
      });
      const cycles = (await admin.query('select cycle, state, resulting_stage from public.property_stage_remediations where property_id = $1', [property])).rows;
      expect(cycles).toEqual([{ cycle: 1, state: 'RESOLVED', resulting_stage: 'documentation' }]);
      const resolutions = (
        await admin.query(`select count(*)::int as n from public.property_stage_remediation_events where property_id = $1 and action = 'resolved'`, [property])
      ).rows[0].n;
      expect(resolutions).toBe(1);
      expect(await changes(property)).toEqual([
        { field: 'acquisition_stage', from_value: 'withdrawn', to_value: 'documentation', actor_user_id: lamA, remediation: true },
      ]);
    });

    it('refuses a resolution that races an escalation, keeping the escalation and the legacy stage', async () => {
      const property = await legacyProperty();
      await asUser(pool, lamA, (client) => client.query('select * from public.start_property_stage_remediation($1)', [property]));
      const result = await race(
        lamA,
        (client) => client.query('select * from public.escalate_property_stage_remediation($1, $2)', [property, 'Survey missing']),
        supervisorScoped,
        resolve(property, 'documentation', 'withdrawn'),
      );
      expect(result).toMatchObject({ ok: false, code: '22023' });
      expect((await admin.query('select state from public.property_stage_remediations where property_id = $1', [property])).rows).toEqual([
        { state: 'REQUIRES_ESCALATION' },
      ]);
      expect(await state(property)).toMatchObject({ acquisition_stage: 'withdrawn' });
      expect(await changes(property)).toEqual([]);
    });

    it('opens only one cycle when two reviews start concurrently', async () => {
      const property = await legacyProperty();
      const result = await race(
        lamA,
        (client) => client.query('select * from public.start_property_stage_remediation($1)', [property]),
        supervisorScoped,
        (client) => client.query('select * from public.start_property_stage_remediation($1)', [property]),
      );
      expect(result).toMatchObject({ ok: false, code: '22023' });
      expect((await admin.query('select cycle, state from public.property_stage_remediations where property_id = $1', [property])).rows).toEqual([
        { cycle: 1, state: 'UNDER_REVIEW' },
      ]);
    });
  });

  describe('stale screens', () => {
    it('refuses a change from a stale screen, writes nothing, and succeeds once the client reloads', async () => {
      const property = await createProperty();
      // Client A loads the property.
      const seenByA = await asUser(pool, negotiatorAssigned, async (client) =>
        (await client.query<{ acquisition_stage: string }>('select acquisition_stage from public.properties where id = $1', [property])).rows[0]
          .acquisition_stage,
      );
      // Client B changes it.
      await asUser(pool, lamA, stage(property, 'documentation', 'identified'));
      // Client A acts on what it saw.
      const stale = await outcome(asUser(pool, negotiatorAssigned, stage(property, 'initial_contact', seenByA)));
      expect(stale).toEqual({
        ok: false,
        code: '40001',
        detail: { conflict: 'lifecycle', field: 'acquisition_stage', current: 'documentation', expected: 'identified' },
      });
      expect((await changes(property)).map((row) => row.to_value)).toEqual(['documentation']);
      // Client A reloads and retries.
      const reloaded = (await state(property)).acquisition_stage;
      await asUser(pool, negotiatorAssigned, stage(property, 'negotiation', reloaded));
      expect((await changes(property)).map((row) => [row.from_value, row.to_value])).toEqual([
        ['identified', 'documentation'],
        ['documentation', 'negotiation'],
      ]);
    });

    it('does not report a stale no-op as success', async () => {
      const property = await createProperty();
      await asUser(pool, lamA, stage(property, 'initial_contact', 'identified'));
      // The stale screen asks for the value the property now has.
      const stale = await outcome(asUser(pool, supervisorScoped, stage(property, 'initial_contact', 'identified')));
      expect(stale).toMatchObject({ ok: false, code: '40001' });
      const staleStatus = await outcome(asUser(pool, supervisorScoped, status(property, 'active', 'on_hold')));
      expect(staleStatus).toMatchObject({ ok: false, code: '40001' });
      expect(await changes(property)).toHaveLength(1);
    });

    it('checks the screen value after visibility, and before authority and validation', async () => {
      const property = await createProperty();
      await asUser(pool, lamA, stage(property, 'documentation', 'identified'));
      // A backward move without a reason from a stale screen is reported as the conflict.
      const stale = await outcome(asUser(pool, supervisorScoped, stage(property, 'identified', 'initial_contact')));
      expect(stale).toMatchObject({ ok: false, code: '40001' });
      // An invisible property is still not found, whatever the screen showed.
      const hidden = await outcome(asUser(pool, viewerA, stage(randomUUID(), 'documentation', 'identified')));
      expect(hidden).toMatchObject({ ok: false, code: 'P0002' });
    });
  });
});
