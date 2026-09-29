import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';
import { loadPropertyTimeline } from '../operationsRoutes.js';
import {
  addMember,
  asUser,
  bootstrapOrg,
  createAppPool,
  expectSqlError,
  insertPropertyFixture,
  requireDatabaseEnv,
  syncUser,
} from './postgresHarness.js';

const suffix = randomUUID().slice(0, 8);

type HistoryRow = {
  organization_id: string;
  property_id: string;
  field: string;
  from_value: string | null;
  to_value: string;
  reason: string | null;
  actor_user_id: string | null;
};

describe('PostgreSQL property lifecycle history', () => {
  const pool = createAppPool();
  let admin: pg.Client;
  let orgA: string;
  let adminA: string;
  let adminB: string;
  let lamA: string;
  let legalA: string;
  let financeA: string;
  let viewerA: string;
  let supervisorScoped: string;
  let supervisorOther: string;
  let negotiatorAssigned: string;
  let negotiatorOther: string;
  let projectA: string;
  let historyCountBeforeReapply: number;
  let historyCountAfterReapply: number;

  // 012 plus the later lifecycle migrations that redefine its objects (the
  // capture trigger function and the property guards), re-applied in order so
  // the database always ends at the latest definitions.
  const migrationSql = () =>
    [
      '012_property_lifecycle_history.sql',
      '013_property_stage_transitions.sql',
      '014_property_status_transitions.sql',
      '015_lifecycle_negotiation_exception.sql',
      '016_property_creation_rules.sql',
      '017_legacy_stage_remediation.sql',
      '018_lifecycle_optimistic_concurrency.sql',
    ]
      .map((file) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', file), 'utf8'))
      .join('\n');

  const historyCount = async () =>
    (await admin.query<{ n: number }>('select count(*)::int as n from public.property_lifecycle_history')).rows[0].n;

  /** All history for a property, read by the owner connection (no RLS). */
  const history = async (propertyId: string) =>
    (
      await admin.query<HistoryRow>(
        `select organization_id, property_id, field, from_value, to_value, reason, actor_user_id
           from public.property_lifecycle_history
          where property_id = $1
          order by changed_at, field`,
        [propertyId],
      )
    ).rows;

  // Since L-05 the application creates properties only in identified; other
  // starting stages are fixtures created as a controlled owner operation.
  const createProperty = (reference: string, stage = 'identified') => {
    const sql = `insert into public.properties (
          organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id, assigned_manager_id
        ) values ($1, $2, $3, $4, $5, $6) returning id`;
    const params = [orgA, projectA, `${reference}-${suffix}`, stage, negotiatorAssigned, supervisorScoped];
    return stage === 'identified'
      ? asUser(pool, lamA, async (client) => (await client.query<{ id: string }>(sql, params)).rows[0].id)
      : insertPropertyFixture(lamA, sql, params);
  };

  const updateProperty = (actor: string, propertyId: string, set: string, reason?: string) =>
    asUser(pool, actor, async (client) => {
      if (reason !== undefined) await client.query("select set_config('app.lifecycle_reason', $1, true)", [reason]);
      return (await client.query(`update public.properties set ${set} where id = $1`, [propertyId])).rowCount;
    });

  // Since L-02 the stage changes only through transition_property_stage().
  const transitionStage = (actor: string, propertyId: string, stage: string, reason?: string) =>
    asUser(pool, actor, (client) =>
      client.query('select * from public.transition_property_stage($1, $2, $3)', [propertyId, stage, reason ?? null]),
    );

  // Since L-03 the status changes only through transition_property_status().
  const transitionStatus = (actor: string, propertyId: string, status: string, reason?: string) =>
    asUser(pool, actor, (client) =>
      client.query('select * from public.transition_property_status($1, $2, $3)', [propertyId, status, reason ?? null]),
    );

  const visibleHistory = (actor: string, propertyId: string) =>
    asUser(pool, actor, async (client) =>
      (await client.query('select id from public.property_lifecycle_history where property_id = $1', [propertyId])).rowCount,
    );

  const timeline = (actor: string, propertyId: string) =>
    asUser(pool, actor, (client) => loadPropertyTimeline(client, actor, propertyId, { limit: 200, offset: 0 }));

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    const { default: pgModule } = await import('pg');
    admin = new pgModule.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    // Re-apply 012-014 under the migration advisory lock so function text always
    // matches the repo, and record that re-applying writes no history (no backfill).
    try {
      await admin.query('select pg_advisory_lock(87236401)');
      // Take the strongest properties lock first (drop trigger needs it), then
      // the history table (014 alters it), so re-applying never upgrades a lock
      // or reverses a property write's lock order and cannot deadlock with
      // parallel suites.
      await admin.query('begin');
      try {
        await admin.query('lock table public.properties in access exclusive mode');
        await admin.query('lock table public.property_lifecycle_history in access exclusive mode');
        historyCountBeforeReapply = await historyCount();
        await admin.query(migrationSql());
        historyCountAfterReapply = await historyCount();
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

    const orgOne = await bootstrapOrg(pool, `Lh North ${suffix}`, `lh-north-${suffix}`, `auth0|lh-admin-a-${suffix}`, 'Lh Admin A', `lh-admin-a-${suffix}@example.com`);
    const orgTwo = await bootstrapOrg(pool, `Lh South ${suffix}`, `lh-south-${suffix}`, `auth0|lh-admin-b-${suffix}`, 'Lh Admin B', `lh-admin-b-${suffix}@example.com`);
    orgA = orgOne.organization_id;
    adminA = orgOne.user_id;
    adminB = orgTwo.user_id;

    const user = (key: string, name: string) => syncUser(pool, `auth0|lh-${key}-${suffix}`, name, `lh-${key}-${suffix}@example.com`);
    lamA = await user('lam', 'Lh LAM');
    legalA = await user('legal', 'Lh Legal');
    financeA = await user('finance', 'Lh Finance');
    viewerA = await user('viewer', 'Lh Viewer');
    supervisorScoped = await user('sup-scoped', 'Lh Supervisor Scoped');
    supervisorOther = await user('sup-other', 'Lh Supervisor Other');
    negotiatorAssigned = await user('neg-assigned', 'Lh Negotiator Assigned');
    negotiatorOther = await user('neg-other', 'Lh Negotiator Other');
    await addMember(pool, adminA, orgA, lamA, 'land_acquisition_manager');
    await addMember(pool, adminA, orgA, legalA, 'legal_documentation');
    await addMember(pool, adminA, orgA, financeA, 'finance');
    await addMember(pool, adminA, orgA, viewerA, 'viewer');
    await addMember(pool, adminA, orgA, supervisorScoped, 'supervisor');
    await addMember(pool, adminA, orgA, supervisorOther, 'supervisor');
    await addMember(pool, adminA, orgA, negotiatorAssigned, 'negotiator');
    await addMember(pool, adminA, orgA, negotiatorOther, 'negotiator');

    projectA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status) values ($1, 'LH-01', 'Lifecycle Program', 'active') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
  }, 60_000);

  afterAll(async () => {
    await admin?.end();
    await pool.end();
  });

  describe('capture', () => {
    it('re-applies the migration without writing history for existing properties (no backfill)', () => {
      expect(historyCountAfterReapply).toBe(historyCountBeforeReapply);
    });

    it('records the initial stage and status when a property is created', async () => {
      const property = await createProperty('LH-CREATE');
      expect(await history(property)).toEqual([
        { organization_id: orgA, property_id: property, field: 'acquisition_stage', from_value: null, to_value: 'identified', reason: null, actor_user_id: lamA },
        { organization_id: orgA, property_id: property, field: 'acquisition_status', from_value: null, to_value: 'active', reason: null, actor_user_id: lamA },
      ]);
    });

    it('records one row per changed field, and both fields as two rows', async () => {
      const property = await createProperty('LH-CHANGE');
      await transitionStage(lamA, property, 'initial_contact');
      await transitionStatus(lamA, property, 'on_hold');
      // One UPDATE changing both fields is now possible only in an owner-controlled
      // operation (L-02/L-03); the capture trigger still writes one row per field.
      await admin.query('begin');
      try {
        await admin.query("select set_config('app.user_id', $1, true)", [adminA]);
        await admin.query("select set_config('app.stage_transition_property', $1, true)", [property]);
        await admin.query(
          `update public.properties set acquisition_stage = 'owner_validation', acquisition_status = 'active' where id = $1`,
          [property],
        );
        await admin.query('commit');
      } catch (error) {
        await admin.query('rollback');
        throw error;
      }
      const changes = (await history(property)).slice(2).map((row) => [row.field, row.from_value, row.to_value, row.actor_user_id]);
      expect(changes).toEqual([
        ['acquisition_stage', 'identified', 'initial_contact', lamA],
        ['acquisition_status', 'active', 'on_hold', lamA],
        ['acquisition_stage', 'initial_contact', 'owner_validation', adminA],
        ['acquisition_status', 'on_hold', 'active', adminA],
      ]);
    });

    it('records nothing for readiness, other fields, or an unchanged stage and status', async () => {
      const property = await createProperty('LH-NOCHANGE');
      await updateProperty(lamA, property, `readiness_percent = 55, risk = 'high', municipality = 'Calamba'`);
      await updateProperty(supervisorScoped, property, `readiness_percent = 60`);
      await updateProperty(lamA, property, `acquisition_stage = acquisition_stage, acquisition_status = 'active'`);
      expect(await history(property)).toHaveLength(2);
    });

    it('stores a supplied reason, and no reason when none or only whitespace is supplied', async () => {
      const property = await createProperty('LH-REASON');
      await transitionStatus(lamA, property, 'on_hold', 'Owner travelling until March');
      await transitionStatus(lamA, property, 'active', ' \t\n ');
      await transitionStage(lamA, property, 'initial_contact', '\n Surveyor visit booked \t');
      await transitionStage(lamA, property, 'owner_validation');
      expect((await history(property)).slice(2).map((row) => row.reason)).toEqual([
        'Owner travelling until March',
        null,
        'Surveyor visit booked',
        null,
      ]);
    });

    it('records a null actor for a controlled operation without an application actor', async () => {
      const property = await createProperty('LH-NULLACTOR');
      // The property guards require an application actor, so a controlled
      // operation bypasses them inside a transaction that is rolled back.
      await admin.query('begin');
      try {
        await admin.query('alter table public.properties disable trigger properties_scope_guard');
        await admin.query('alter table public.properties disable trigger properties_field_permission_guard');
        await admin.query(`update public.properties set acquisition_stage = 'initial_contact' where id = $1`, [property]);
        expect((await history(property)).at(-1)).toMatchObject({
          field: 'acquisition_stage',
          from_value: 'identified',
          to_value: 'initial_contact',
          actor_user_id: null,
        });
      } finally {
        await admin.query('rollback');
      }
      expect(await history(property)).toHaveLength(2);
    });

    it('records legacy stage values as text without converting or rewriting them', async () => {
      // Since L-02 a legacy value can no longer be a transition target, so each
      // one is recorded here from creation.
      for (const legacy of ['on_hold', 'withdrawn', 'acquisition_complete']) {
        const property = await createProperty(`LH-LEGACY-${legacy}`, legacy);
        expect((await history(property)).map((row) => [row.field, row.from_value, row.to_value])).toEqual([
          ['acquisition_stage', null, legacy],
          ['acquisition_status', null, 'active'],
        ]);
        const current = await admin.query('select acquisition_stage, acquisition_status from public.properties where id = $1', [property]);
        expect(current.rows[0]).toEqual({ acquisition_stage: legacy, acquisition_status: 'active' });
      }
    });
  });

  describe('immutability', () => {
    it('refuses direct inserts from every application role', async () => {
      const property = await createProperty('LH-INSERT');
      for (const actor of [adminA, lamA]) {
        await expectSqlError(
          () =>
            asUser(pool, actor, (client) =>
              client.query(
                `insert into public.property_lifecycle_history (organization_id, property_id, field, from_value, to_value, actor_user_id)
                 values ($1, $2, 'acquisition_stage', 'identified', 'signing', $3)`,
                [orgA, property, actor],
              ),
            ),
          '42501',
        );
      }
    });

    it('lets no application role update or delete history, and refuses it even for the table owner', async () => {
      const property = await createProperty('LH-IMMUTABLE');
      for (const actor of [adminA, lamA]) {
        expect(await asUser(pool, actor, async (client) =>
          (await client.query(`update public.property_lifecycle_history set reason = 'x' where property_id = $1`, [property])).rowCount,
        )).toBe(0);
        expect(await asUser(pool, actor, async (client) =>
          (await client.query('delete from public.property_lifecycle_history where property_id = $1', [property])).rowCount,
        )).toBe(0);
      }
      await expectSqlError(() => admin.query(`update public.property_lifecycle_history set reason = 'x' where property_id = $1`, [property]), '42501');
      await expectSqlError(() => admin.query('delete from public.property_lifecycle_history where property_id = $1', [property]), '42501');
      expect(await history(property)).toHaveLength(2);
    });

    it('prevents deleting a property that has history', async () => {
      const property = await createProperty('LH-DELETE');
      await admin.query('begin');
      try {
        await expectSqlError(() => admin.query('delete from public.properties where id = $1', [property]), '23503');
      } finally {
        await admin.query('rollback');
      }
      expect(await history(property)).toHaveLength(2);
    });

    it('rejects unknown fields and unchanged values', async () => {
      const property = await createProperty('LH-CHECKS');
      await expectSqlError(
        () =>
          admin.query(
            `insert into public.property_lifecycle_history (organization_id, property_id, field, to_value) values ($1, $2, 'readiness_percent', '80')`,
            [orgA, property],
          ),
        '23514',
      );
      await expectSqlError(
        () =>
          admin.query(
            `insert into public.property_lifecycle_history (organization_id, property_id, field, from_value, to_value) values ($1, $2, 'acquisition_stage', 'signing', 'signing')`,
            [orgA, property],
          ),
        '23514',
      );
    });
  });

  describe('visibility', () => {
    it.each([
      ['system_admin', () => adminA],
      ['land_acquisition_manager', () => lamA],
      ['supervisor managing the property', () => supervisorScoped],
      ['negotiator assigned to the property', () => negotiatorAssigned],
      ['legal_documentation', () => legalA],
      ['finance', () => financeA],
      ['viewer', () => viewerA],
    ])('shows history to %s wherever the property is visible', async (_label, actor) => {
      const property = await createProperty(`LH-SEE-${randomUUID().slice(0, 4)}`);
      expect(await visibleHistory(actor(), property)).toBe(2);
    });

    it.each([
      ['a supervisor not managing the property', () => supervisorOther],
      ['a negotiator not assigned to the property', () => negotiatorOther],
      ['another organization', () => adminB],
    ])('hides history from %s', async (_label, actor) => {
      const property = await createProperty(`LH-HIDE-${randomUUID().slice(0, 4)}`);
      expect(await visibleHistory(actor(), property)).toBe(0);
    });
  });

  describe('timeline', () => {
    it('shows lifecycle entries at source 8 to every property-visible role, without the reason', async () => {
      const property = await createProperty('LH-TIMELINE');
      await transitionStatus(lamA, property, 'on_hold', 'Confidential family dispute');
      await transitionStage(lamA, property, 'payment_closing');

      const entries = await timeline(adminA, property);
      expect(entries.every((entry) => entry.source_type === 'lifecycle' && entry.basis === 'occurrence' && entry.precision === 'timestamp')).toBe(true);
      expect(entries.map((entry) => entry.summary).sort()).toEqual([
        'Acquisition stage changed from Identified to Payment / closing',
        'Acquisition stage set to Identified',
        'Acquisition status changed from Active to On hold',
        'Acquisition status set to Active',
      ]);
      expect(entries.find((entry) => entry.summary.startsWith('Acquisition status changed'))).toMatchObject({
        kind: 'status_changed',
        actor: { id: lamA, display_name: 'Lh LAM' },
      });
      expect(JSON.stringify(entries)).not.toContain('Confidential family dispute');

      const expected = entries.map((entry) => entry.id);
      for (const actor of [lamA, supervisorScoped, negotiatorAssigned, legalA, financeA, viewerA]) {
        expect((await timeline(actor, property)).map((entry) => entry.id)).toEqual(expected);
      }
    });
  });
});
