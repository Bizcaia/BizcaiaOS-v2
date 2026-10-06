import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';
import { loadPropertyTimeline } from '../operationsRoutes.js';
import {
  LIFECYCLE_TABLES,
  addMember,
  asUser,
  bootstrapOrg,
  createAppPool,
  expectSqlError,
  insertPropertyFixture,
  reapplyWithTableLocks,
  requireDatabaseEnv,
  syncUser,
} from './postgresHarness.js';

const suffix = randomUUID().slice(0, 8);

const NORMAL_STAGES = [
  'identified',
  'initial_contact',
  'owner_validation',
  'property_validation',
  'documentation',
  'negotiation',
  'commercial_review',
  'legal_review',
  'agreement_preparation',
  'signing',
  'payment_closing',
];
const LEGACY_STAGES = ['on_hold', 'withdrawn', 'acquisition_complete'];

type HistoryRow = { field: string; from_value: string | null; to_value: string; reason: string | null; actor_user_id: string | null };

describe('PostgreSQL stage transitions (L-02)', () => {
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

  // Since L-05 the application creates properties only in identified; other
  // starting stages are fixtures created as a controlled owner operation.
  const createProperty = (stage = 'identified') => {
    const sql = `insert into public.properties (
          organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id, assigned_manager_id
        ) values ($1, $2, $3, $4, $5, $6) returning id`;
    const params = [orgA, projectA, `ST-${randomUUID().slice(0, 8)}-${suffix}`, stage, negotiatorAssigned, supervisorScoped];
    return stage === 'identified'
      ? asUser(pool, lamA, async (client) => (await client.query<{ id: string }>(sql, params)).rows[0].id)
      : insertPropertyFixture(lamA, sql, params);
  };

  const transition = (actor: string, propertyId: string, stage: string, reason: string | null = null) =>
    asUser(pool, actor, async (client) =>
      (
        await client.query<{ id: string; acquisition_stage: string; acquisition_status: string }>(
          'select * from public.transition_property_stage($1, $2, $3)',
          [propertyId, stage, reason],
        )
      ).rows[0],
    );

  const state = async (propertyId: string) =>
    (
      await admin.query<{ acquisition_stage: string; acquisition_status: string }>(
        'select acquisition_stage, acquisition_status from public.properties where id = $1',
        [propertyId],
      )
    ).rows[0];

  /** History after the two creation rows, read by the owner connection. */
  const changes = async (propertyId: string) =>
    (
      await admin.query<HistoryRow>(
        `select field, from_value, to_value, reason, actor_user_id
           from public.property_lifecycle_history
          where property_id = $1 and from_value is not null
          order by changed_at, id`,
        [propertyId],
      )
    ).rows;

  /** Expects a refusal that leaves the stage and the history untouched. */
  async function expectRefused(operation: () => Promise<unknown>, code: string, propertyId: string) {
    const before = { state: await state(propertyId), history: await changes(propertyId) };
    await expectSqlError(operation, code);
    expect(await state(propertyId)).toEqual(before.state);
    expect(await changes(propertyId)).toEqual(before.history);
  }

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    const { default: pgModule } = await import('pg');
    admin = new pgModule.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    // Re-apply 013 and the later lifecycle migrations that redefine its objects
    // (014: the field-guard trigger; 015: the stage function) under the
    // migration advisory lock so function text always matches the repo. Every
    // table the files alter is locked before the first statement (see
    // runWithTableLocks), so re-applying cannot deadlock with parallel suites.
    await reapplyWithTableLocks(admin, LIFECYCLE_TABLES, async () => {
      for (const file of [
        '013_property_stage_transitions.sql',
        '014_property_status_transitions.sql',
        '015_lifecycle_negotiation_exception.sql',
        '016_property_creation_rules.sql',
        '017_legacy_stage_remediation.sql',
        '018_lifecycle_optimistic_concurrency.sql',
        '020_property_risk_history.sql',
      ]) {
        await admin.query(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', file), 'utf8'));
      }
    });

    const orgOne = await bootstrapOrg(pool, `St North ${suffix}`, `st-north-${suffix}`, `auth0|st-admin-a-${suffix}`, 'St Admin A', `st-admin-a-${suffix}@example.com`);
    const orgTwo = await bootstrapOrg(pool, `St South ${suffix}`, `st-south-${suffix}`, `auth0|st-admin-b-${suffix}`, 'St Admin B', `st-admin-b-${suffix}@example.com`);
    orgA = orgOne.organization_id;
    adminA = orgOne.user_id;
    adminB = orgTwo.user_id;

    const user = (key: string, name: string) => syncUser(pool, `auth0|st-${key}-${suffix}`, name, `st-${key}-${suffix}@example.com`);
    lamA = await user('lam', 'St LAM');
    legalA = await user('legal', 'St Legal');
    financeA = await user('finance', 'St Finance');
    viewerA = await user('viewer', 'St Viewer');
    supervisorScoped = await user('sup-scoped', 'St Supervisor Scoped');
    supervisorOther = await user('sup-other', 'St Supervisor Other');
    negotiatorAssigned = await user('neg-assigned', 'St Negotiator Assigned');
    negotiatorOther = await user('neg-other', 'St Negotiator Other');
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
        `insert into public.projects (organization_id, code, name, status) values ($1, 'ST-01', 'Stage Program', 'active') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
  }, 60_000);

  afterAll(async () => {
    await admin?.end();
    await pool.end();
  });

  describe('ordinary forward', () => {
    it.each([
      ['negotiator (assigned)', () => negotiatorAssigned],
      ['supervisor (managing)', () => supervisorScoped],
      ['land_acquisition_manager', () => lamA],
      ['system_admin', () => adminA],
    ])('lets %s move forward without a reason, recording history and leaving status alone', async (_label, actor) => {
      const property = await createProperty();
      const result = await transition(actor(), property, 'initial_contact');
      expect(result).toMatchObject({ id: property, acquisition_stage: 'initial_contact', acquisition_status: 'active' });
      expect(await state(property)).toEqual({ acquisition_stage: 'initial_contact', acquisition_status: 'active' });
      expect(await changes(property)).toEqual([
        { field: 'acquisition_stage', from_value: 'identified', to_value: 'initial_contact', reason: null, actor_user_id: actor() },
      ]);
    });

    it('treats every forward step and skip as ordinary: no reason, no sensitive handling (N-3 list is empty)', async () => {
      const stepwise = await createProperty();
      for (const stage of NORMAL_STAGES.slice(1)) {
        await transition(negotiatorAssigned, stepwise, stage);
      }
      expect((await changes(stepwise)).map((row) => [row.from_value, row.to_value, row.reason])).toEqual(
        NORMAL_STAGES.slice(1).map((stage, index) => [NORMAL_STAGES[index], stage, null]),
      );

      // Non-linear (X2-2): a later stage may skip intermediate ones.
      const skipping = await createProperty();
      await transition(negotiatorAssigned, skipping, 'payment_closing');
      expect(await state(skipping)).toEqual({ acquisition_stage: 'payment_closing', acquisition_status: 'active' });
    });

    it('keeps a reason supplied with a forward transition, trimmed, and never manufactures one', async () => {
      const property = await createProperty();
      await transition(lamA, property, 'initial_contact', '  Owner called back \n');
      await transition(lamA, property, 'owner_validation', ' \t ');
      expect((await changes(property)).map((row) => row.reason)).toEqual(['Owner called back', null]);
    });

    it.each([
      ['legal_documentation', () => legalA],
      ['finance', () => financeA],
      ['viewer', () => viewerA],
    ])('refuses %s with 42501 and no history', async (_label, actor) => {
      const property = await createProperty();
      await expectRefused(() => transition(actor(), property, 'initial_contact'), '42501', property);
    });
  });

  describe('backward', () => {
    it('refuses a negotiator, even with a reason', async () => {
      const property = await createProperty('negotiation');
      await expectRefused(() => transition(negotiatorAssigned, property, 'documentation', 'Missing papers'), '42501', property);
    });

    it.each([
      ['supervisor (managing)', () => supervisorScoped],
      ['land_acquisition_manager', () => lamA],
      ['system_admin', () => adminA],
    ])('lets %s move backward with a reason, which history keeps', async (_label, actor) => {
      const property = await createProperty('negotiation');
      const result = await transition(actor(), property, 'owner_validation', '  Title holder was misidentified ');
      expect(result).toMatchObject({ acquisition_stage: 'owner_validation', acquisition_status: 'active' });
      expect(await changes(property)).toEqual([
        {
          field: 'acquisition_stage',
          from_value: 'negotiation',
          to_value: 'owner_validation',
          reason: 'Title holder was misidentified',
          actor_user_id: actor(),
        },
      ]);
    });

    it.each([
      ['no reason', null],
      ['an empty reason', ''],
      ['a whitespace-only reason', ' \t\n '],
    ])('refuses a backward transition with %s (22023), for every elevated role', async (_label, reason) => {
      const property = await createProperty('signing');
      for (const actor of [supervisorScoped, lamA, adminA]) {
        await expectRefused(() => transition(actor, property, 'negotiation', reason), '22023', property);
      }
    });

    it('refuses legal, finance, and viewer backward with 42501', async () => {
      const property = await createProperty('signing');
      for (const actor of [legalA, financeA, viewerA]) {
        await expectRefused(() => transition(actor, property, 'negotiation', 'A reason'), '42501', property);
      }
    });
  });

  describe('visibility', () => {
    it.each([
      ['a supervisor not managing the property', () => supervisorOther],
      ['a negotiator not assigned to the property', () => negotiatorOther],
      ['another organization', () => adminB],
    ])('reports the property as not found (P0002) to %s', async (_label, actor) => {
      const property = await createProperty();
      await expectRefused(() => transition(actor(), property, 'initial_contact'), 'P0002', property);
    });

    it('reports an unknown property as not found', async () => {
      await expectSqlError(() => transition(adminA, randomUUID(), 'initial_contact'), 'P0002');
    });
  });

  describe('same stage and legacy values', () => {
    it('treats the same stage as a no-op that records nothing', async () => {
      const property = await createProperty('documentation');
      const result = await transition(negotiatorAssigned, property, 'documentation');
      expect(result).toMatchObject({ acquisition_stage: 'documentation' });
      expect(await changes(property)).toEqual([]);
    });

    it('never accepts a legacy value as a target', async () => {
      const property = await createProperty('signing');
      for (const legacy of LEGACY_STAGES) {
        await expectRefused(() => transition(adminA, property, legacy, 'A reason'), '22023', property);
      }
    });

    it('does not move a property on a legacy value, which stays unconverted until remediation', async () => {
      for (const legacy of LEGACY_STAGES) {
        const property = await createProperty(legacy);
        for (const target of ['identified', 'payment_closing']) {
          await expectRefused(() => transition(adminA, property, target, 'A reason'), '22023', property);
        }
        expect(await state(property)).toEqual({ acquisition_stage: legacy, acquisition_status: 'active' });
      }
    });
  });

  describe('bypass prevention', () => {
    it('refuses a direct stage UPDATE from every role that may update properties', async () => {
      const property = await createProperty();
      for (const actor of [adminA, lamA, supervisorScoped]) {
        await expectRefused(
          () => asUser(pool, actor, (client) => client.query(`update public.properties set acquisition_stage = 'initial_contact' where id = $1`, [property])),
          '42501',
          property,
        );
      }
      for (const actor of [negotiatorAssigned, legalA, financeA, viewerA]) {
        const updated = await asUser(pool, actor, async (client) => {
          try {
            return (await client.query(`update public.properties set acquisition_stage = 'initial_contact' where id = $1`, [property])).rowCount;
          } catch (error) {
            expect((error as { code?: string }).code).toBe('42501');
            return 0;
          }
        });
        expect(updated).toBe(0);
      }
      expect(await state(property)).toEqual({ acquisition_stage: 'identified', acquisition_status: 'active' });
    });

    it('cannot be bypassed by setting the transition marker from the application role', async () => {
      const property = await createProperty();
      await expectRefused(
        () =>
          asUser(pool, lamA, async (client) => {
            await client.query("select set_config('app.stage_transition_property', $1, true)", [property]);
            await client.query(`update public.properties set acquisition_stage = 'signing' where id = $1`, [property]);
          }),
        '42501',
        property,
      );
      // Nor does the marker switch off the field-permission guard for other fields.
      await expectSqlError(
        () =>
          asUser(pool, legalA, async (client) => {
            await client.query("select set_config('app.stage_transition_property', $1, true)", [property]);
            await client.query(`update public.properties set risk = 'high' where id = $1`, [property]);
          }),
        '42501',
      );
    });

    it('keeps other property updates working under the existing field permissions', async () => {
      const property = await createProperty();
      await asUser(pool, lamA, (client) => client.query(`update public.properties set risk = 'high', readiness_percent = 30 where id = $1`, [property]));
      await asUser(pool, supervisorScoped, (client) => client.query(`update public.properties set readiness_percent = 40 where id = $1`, [property]));
      await asUser(pool, legalA, (client) => client.query(`update public.properties set legal_status = 'clear' where id = $1`, [property]));
      const row = await admin.query('select risk, readiness_percent, legal_status, acquisition_stage from public.properties where id = $1', [property]);
      expect(row.rows[0]).toEqual({ risk: 'high', readiness_percent: 40, legal_status: 'clear', acquisition_stage: 'identified' });
    });
  });

  describe('stage and status stay separate', () => {
    it('changes only the stage, whatever the status is', async () => {
      for (const status of ['on_hold', 'withdrawn', 'complete']) {
        const property = await createProperty('negotiation');
        // Since L-03 the status changes only through transition_property_status();
        // completing away from payment_closing needs the designated override.
        await asUser(pool, lamA, (client) =>
          client.query('select * from public.transition_property_status($1, $2, $3, $4)', [
            property,
            status,
            status === 'on_hold' ? null : 'Status fixture',
            status === 'complete',
          ]),
        );
        await transition(negotiatorAssigned, property, 'commercial_review');
        await transition(supervisorScoped, property, 'documentation', 'Back for missing papers');
        expect(await state(property)).toEqual({ acquisition_stage: 'documentation', acquisition_status: status });
        expect((await changes(property)).filter((row) => row.field === 'acquisition_status')).toHaveLength(1);
      }
    });

    it('does not leak a transition reason into a later change in the same transaction', async () => {
      const property = await createProperty('negotiation');
      await asUser(pool, lamA, async (client) => {
        await client.query('select * from public.transition_property_stage($1, $2, $3)', [property, 'documentation', 'Back for papers']);
        await client.query('select * from public.transition_property_status($1, $2)', [property, 'on_hold']);
      });
      // Both rows share the transaction's timestamp, so compare without order.
      expect((await changes(property)).map((row) => [row.field, row.reason]).sort()).toEqual([
        ['acquisition_stage', 'Back for papers'],
        ['acquisition_status', null],
      ]);
    });
  });

  describe('timeline', () => {
    it('shows transitions as stage entries without the reason', async () => {
      const property = await createProperty('negotiation');
      await transition(negotiatorAssigned, property, 'legal_review');
      await transition(lamA, property, 'commercial_review', 'Confidential valuation dispute');
      const entries = await asUser(pool, viewerA, (client) =>
        loadPropertyTimeline(client, viewerA, property, { limit: 50, offset: 0 }),
      );
      const summaries = entries.filter((entry) => entry.kind === 'stage_changed').map((entry) => entry.summary);
      expect(summaries).toEqual([
        'Acquisition stage changed from Legal review to Commercial review',
        'Acquisition stage changed from Negotiation to Legal review',
        'Acquisition stage set to Negotiation',
      ]);
      expect(JSON.stringify(entries)).not.toContain('Confidential valuation dispute');
    });
  });
});
