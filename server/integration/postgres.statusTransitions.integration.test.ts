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

const STATUSES = ['active', 'on_hold', 'withdrawn', 'complete'] as const;
type Status = (typeof STATUSES)[number];

type HistoryRow = {
  field: string;
  from_value: string | null;
  to_value: string;
  reason: string | null;
  actor_user_id: string | null;
  is_override: boolean;
  overridden_rules: string[] | null;
};

describe('PostgreSQL status transitions (L-03)', () => {
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

  const role = {
    negotiator: () => negotiatorAssigned,
    supervisor: () => supervisorScoped,
    lam: () => lamA,
    admin: () => adminA,
    legal: () => legalA,
    finance: () => financeA,
    viewer: () => viewerA,
  };

  // Since L-05 the application creates properties only in identified; other
  // starting stages are fixtures created as a controlled owner operation.
  const createProperty = (stage = 'payment_closing') => {
    const sql = `insert into public.properties (
          organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id, assigned_manager_id
        ) values ($1, $2, $3, $4, $5, $6) returning id`;
    const params = [orgA, projectA, `SS-${randomUUID().slice(0, 8)}-${suffix}`, stage, negotiatorAssigned, supervisorScoped];
    return stage === 'identified'
      ? asUser(pool, lamA, async (client) => (await client.query<{ id: string }>(sql, params)).rows[0].id)
      : insertPropertyFixture(lamA, sql, params);
  };

  const transition = (actor: string, propertyId: string, status: string, reason: string | null = null, override: boolean | null = null) =>
    asUser(pool, actor, async (client) =>
      (
        await client.query<{ id: string; acquisition_stage: string; acquisition_status: string }>(
          override === null
            ? 'select * from public.transition_property_status($1, $2, $3)'
            : 'select * from public.transition_property_status($1, $2, $3, $4)',
          override === null ? [propertyId, status, reason] : [propertyId, status, reason, override],
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
        `select field, from_value, to_value, reason, actor_user_id, is_override, overridden_rules
           from public.property_lifecycle_history
          where property_id = $1 and from_value is not null
          order by changed_at, id`,
        [propertyId],
      )
    ).rows;

  /** A property at the given stage and status, set up through the status function by a system admin. */
  async function propertyIn(status: Status, stage = 'payment_closing') {
    const property = await createProperty(stage);
    if (status === 'on_hold') await transition(adminA, property, 'on_hold');
    if (status === 'withdrawn') await transition(adminA, property, 'withdrawn', 'Fixture withdrawal');
    if (status === 'complete') await transition(adminA, property, 'complete', 'Fixture completion', stage !== 'payment_closing');
    expect(await state(property)).toEqual({ acquisition_stage: stage, acquisition_status: status });
    return property;
  }

  /** Expects a refusal that leaves stage, status, and history untouched. */
  async function expectRefused(operation: () => Promise<unknown>, code: string, propertyId: string) {
    const before = { state: await state(propertyId), history: await changes(propertyId) };
    await expectSqlError(operation, code);
    expect(await state(propertyId)).toEqual(before.state);
    expect(await changes(propertyId)).toEqual(before.history);
  }

  /** Runs a transition that must succeed, and checks status, unchanged stage, and the one new history row. */
  async function expectTransition(
    actor: string,
    propertyId: string,
    status: Status,
    options: { reason?: string | null; override?: boolean | null; storedReason?: string | null; rules?: string[] | null } = {},
  ) {
    const before = { state: await state(propertyId), history: await changes(propertyId) };
    const result = await transition(actor, propertyId, status, options.reason ?? null, options.override ?? null);
    expect(result).toMatchObject({ acquisition_stage: before.state.acquisition_stage, acquisition_status: status });
    expect(await state(propertyId)).toEqual({ acquisition_stage: before.state.acquisition_stage, acquisition_status: status });
    const after = await changes(propertyId);
    expect(after.slice(0, before.history.length)).toEqual(before.history);
    expect(after.slice(before.history.length)).toEqual([
      {
        field: 'acquisition_status',
        from_value: before.state.acquisition_status,
        to_value: status,
        reason: options.storedReason === undefined ? options.reason?.trim() || null : options.storedReason,
        actor_user_id: actor,
        is_override: (options.rules ?? null) !== null,
        overridden_rules: options.rules ?? null,
      },
    ]);
  }

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    const { default: pgModule } = await import('pg');
    admin = new pgModule.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    // Re-apply 014 and 015 (which redefines 014's capture function and rule
    // check) under the migration advisory lock so function text always matches
    // the repo. Every table the files alter is locked before the first statement
    // (see runWithTableLocks), so re-applying cannot deadlock with parallel suites.
    await reapplyWithTableLocks(admin, LIFECYCLE_TABLES, async () => {
      for (const file of [
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

    const orgOne = await bootstrapOrg(pool, `Ss North ${suffix}`, `ss-north-${suffix}`, `auth0|ss-admin-a-${suffix}`, 'Ss Admin A', `ss-admin-a-${suffix}@example.com`);
    const orgTwo = await bootstrapOrg(pool, `Ss South ${suffix}`, `ss-south-${suffix}`, `auth0|ss-admin-b-${suffix}`, 'Ss Admin B', `ss-admin-b-${suffix}@example.com`);
    orgA = orgOne.organization_id;
    adminA = orgOne.user_id;
    adminB = orgTwo.user_id;

    const user = (key: string, name: string) => syncUser(pool, `auth0|ss-${key}-${suffix}`, name, `ss-${key}-${suffix}@example.com`);
    lamA = await user('lam', 'Ss LAM');
    legalA = await user('legal', 'Ss Legal');
    financeA = await user('finance', 'Ss Finance');
    viewerA = await user('viewer', 'Ss Viewer');
    supervisorScoped = await user('sup-scoped', 'Ss Supervisor Scoped');
    supervisorOther = await user('sup-other', 'Ss Supervisor Other');
    negotiatorAssigned = await user('neg-assigned', 'Ss Negotiator Assigned');
    negotiatorOther = await user('neg-other', 'Ss Negotiator Other');
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
        `insert into public.projects (organization_id, code, name, status) values ($1, 'SS-01', 'Status Program', 'active') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
  }, 60_000);

  afterAll(async () => {
    await admin?.end();
    await pool.end();
  });

  describe('active ↔ on_hold (normal)', () => {
    it.each([['negotiator'], ['supervisor'], ['lam'], ['admin']] as const)(
      'lets %s pause and resume without a reason or override, leaving the stage alone',
      async (key) => {
        const property = await createProperty('negotiation');
        await expectTransition(role[key](), property, 'on_hold');
        await expectTransition(role[key](), property, 'active');
      },
    );

    it('keeps a reason supplied with a normal transition, trimmed', async () => {
      const property = await createProperty('negotiation');
      await expectTransition(negotiatorAssigned, property, 'on_hold', { reason: '  Owner abroad \n', storedReason: 'Owner abroad' });
    });

    it.each([['legal'], ['finance'], ['viewer']] as const)('refuses %s with 42501', async (key) => {
      const active = await createProperty('negotiation');
      await expectRefused(() => transition(role[key](), active, 'on_hold'), '42501', active);
      const onHold = await propertyIn('on_hold', 'negotiation');
      await expectRefused(() => transition(role[key](), onHold, 'active'), '42501', onHold);
    });
  });

  describe('withdrawal (controlled, reason required)', () => {
    it.each([['supervisor'], ['lam'], ['admin']] as const)('lets %s withdraw from active and on_hold with a reason', async (key) => {
      for (const from of ['active', 'on_hold'] as const) {
        const property = await propertyIn(from, 'documentation');
        await expectTransition(role[key](), property, 'withdrawn', { reason: ' Owner declined to sell ' });
      }
    });

    it.each([['negotiator'], ['legal'], ['finance'], ['viewer']] as const)('refuses %s with 42501, even with a reason', async (key) => {
      for (const from of ['active', 'on_hold'] as const) {
        const property = await propertyIn(from, 'documentation');
        await expectRefused(() => transition(role[key](), property, 'withdrawn', 'Owner declined'), '42501', property);
      }
    });

    it('does not treat withdrawal as an override', async () => {
      const property = await createProperty('documentation');
      await expectRefused(() => transition(lamA, property, 'withdrawn', 'Owner declined', true), '22023', property);
    });
  });

  describe('completion', () => {
    it.each([['supervisor'], ['lam'], ['admin']] as const)(
      'lets %s complete an active property at payment_closing without a reason or override',
      async (key) => {
        const property = await createProperty('payment_closing');
        await expectTransition(role[key](), property, 'complete');
      },
    );

    it('refuses completion away from payment_closing without the override, for every elevated role', async () => {
      const property = await createProperty('signing');
      for (const actor of [supervisorScoped, lamA, adminA]) {
        await expectRefused(() => transition(actor, property, 'complete'), '22023', property);
        await expectRefused(() => transition(actor, property, 'complete', 'Closing papers already signed'), '22023', property);
        await expectRefused(() => transition(actor, property, 'complete', 'Closing papers already signed', false), '22023', property);
      }
    });

    it.each([['supervisor'], ['lam'], ['admin']] as const)(
      'lets %s complete away from payment_closing with the completion-condition override and a reason',
      async (key) => {
        const property = await createProperty('signing');
        await expectTransition(role[key](), property, 'complete', {
          reason: ' Closing papers already signed ',
          override: true,
          rules: ['completion_stage_condition'],
        });
      },
    );

    it('refuses the completion override without a reason', async () => {
      const property = await createProperty('signing');
      for (const reason of [null, '', ' \t\n ']) {
        await expectRefused(() => transition(adminA, property, 'complete', reason, true), '22023', property);
      }
    });

    it('refuses a negotiator completion, at or away from payment_closing', async () => {
      const atClosing = await createProperty('payment_closing');
      await expectRefused(() => transition(negotiatorAssigned, atClosing, 'complete'), '42501', atClosing);
      const away = await createProperty('signing');
      await expectRefused(() => transition(negotiatorAssigned, away, 'complete', 'A reason', true), '42501', away);
    });

    it('refuses an override flag on a normal completion at payment_closing', async () => {
      const property = await createProperty('payment_closing');
      await expectRefused(() => transition(lamA, property, 'complete', 'A reason', true), '22023', property);
    });
  });

  describe('on_hold → complete (override)', () => {
    it('refuses it without the override', async () => {
      const property = await propertyIn('on_hold');
      for (const override of [null, false]) {
        await expectRefused(() => transition(lamA, property, 'complete', 'Resolved while paused', override), '22023', property);
      }
    });

    it.each([['supervisor'], ['lam'], ['admin']] as const)('lets %s complete from on_hold with the override and a reason', async (key) => {
      const property = await propertyIn('on_hold');
      await expectTransition(role[key](), property, 'complete', {
        reason: 'Resolved while paused',
        override: true,
        rules: ['on_hold_completion'],
      });
    });

    it('records both designated rules away from payment_closing', async () => {
      const property = await propertyIn('on_hold', 'signing');
      await expectTransition(lamA, property, 'complete', {
        reason: 'Resolved while paused',
        override: true,
        rules: ['on_hold_completion', 'completion_stage_condition'],
      });
    });

    it('refuses a negotiator', async () => {
      const property = await propertyIn('on_hold');
      await expectRefused(() => transition(negotiatorAssigned, property, 'complete', 'A reason', true), '42501', property);
    });
  });

  describe('withdrawn reversal (override)', () => {
    it.each([['supervisor'], ['lam'], ['admin']] as const)('lets %s reverse a withdrawal to active, on_hold, and complete', async (key) => {
      for (const target of ['active', 'on_hold', 'complete'] as const) {
        const property = await propertyIn('withdrawn');
        await expectTransition(role[key](), property, target, {
          reason: 'Owner changed their mind',
          override: true,
          rules: ['withdrawn_reversal'],
        });
      }
    });

    it('records both designated rules when completing a withdrawn property away from payment_closing', async () => {
      const property = await propertyIn('withdrawn', 'legal_review');
      await expectTransition(adminA, property, 'complete', {
        reason: 'Closed outside the workflow',
        override: true,
        rules: ['withdrawn_reversal', 'completion_stage_condition'],
      });
    });

    it('refuses a reversal without the override', async () => {
      const property = await propertyIn('withdrawn');
      for (const target of ['active', 'on_hold', 'complete']) {
        for (const override of [null, false]) {
          await expectRefused(() => transition(lamA, property, target, 'Owner changed their mind', override), '22023', property);
        }
      }
    });

    it.each([['negotiator'], ['legal'], ['finance'], ['viewer']] as const)('refuses %s with 42501', async (key) => {
      const property = await propertyIn('withdrawn');
      for (const target of ['active', 'on_hold', 'complete']) {
        await expectRefused(() => transition(role[key](), property, target, 'Owner changed their mind', true), '42501', property);
      }
    });
  });

  describe('complete reversal (override; the specific row governs)', () => {
    it.each(['active', 'on_hold', 'withdrawn'] as const)('REJECTS a supervisor reversing complete → %s, even with the override', async (target) => {
      const property = await propertyIn('complete');
      await expectRefused(() => transition(supervisorScoped, property, target, 'Payment bounced', true), '42501', property);
    });

    it.each([['lam'], ['admin']] as const)('ALLOWS %s to reverse complete → active, on_hold, and withdrawn', async (key) => {
      for (const target of ['active', 'on_hold', 'withdrawn'] as const) {
        const property = await propertyIn('complete');
        await expectTransition(role[key](), property, target, {
          reason: 'Payment bounced',
          override: true,
          rules: ['complete_reversal'],
        });
      }
    });

    it('refuses a reversal without the override', async () => {
      const property = await propertyIn('complete');
      for (const override of [null, false]) {
        await expectRefused(() => transition(lamA, property, 'active', 'Payment bounced', override), '22023', property);
      }
    });

    it.each([['negotiator'], ['legal'], ['finance'], ['viewer']] as const)('refuses %s with 42501', async (key) => {
      const property = await propertyIn('complete');
      await expectRefused(() => transition(role[key](), property, 'active', 'Payment bounced', true), '42501', property);
    });
  });

  describe('reasons and override flags', () => {
    // Every reason-required operation, with the actor and override it needs.
    const reasonRequired: Array<[Status, Status, boolean]> = [
      ['active', 'withdrawn', false],
      ['on_hold', 'withdrawn', false],
      ['on_hold', 'complete', true],
      ['withdrawn', 'active', true],
      ['withdrawn', 'on_hold', true],
      ['withdrawn', 'complete', true],
      ['complete', 'active', true],
      ['complete', 'on_hold', true],
      ['complete', 'withdrawn', true],
    ];

    it.each(reasonRequired)('refuses %s → %s without a real reason and stores a valid one trimmed', async (from, to, override) => {
      const property = await propertyIn(from);
      for (const reason of [null, '', '   ', ' \t\n ']) {
        await expectRefused(() => transition(lamA, property, to, reason, override), '22023', property);
      }
      await expectTransition(lamA, property, to, {
        reason: '\n  Documented in the file  \t',
        override,
        storedReason: 'Documented in the file',
        rules: override ? expect.any(Array) : null,
      });
    });

    it.each([
      ['active', 'on_hold'],
      ['on_hold', 'active'],
      ['active', 'withdrawn'],
      ['on_hold', 'withdrawn'],
      ['active', 'complete'],
    ] as Array<[Status, Status]>)('refuses override = true where no designated rule applies (%s → %s)', async (from, to) => {
      const property = await propertyIn(from);
      await expectRefused(() => transition(adminA, property, to, 'A reason', true), '22023', property);
    });
  });

  describe('no-op', () => {
    it.each(STATUSES)('treats %s → %s as a no-op for every role, without stage, status, or history changes', async (status) => {
      const property = await propertyIn(status, 'signing');
      const before = { state: await state(property), history: await changes(property) };
      for (const actor of [negotiatorAssigned, supervisorScoped, lamA, adminA, legalA, financeA, viewerA]) {
        const result = await transition(actor, property, status);
        expect(result).toMatchObject({ acquisition_stage: 'signing', acquisition_status: status });
      }
      expect(await state(property)).toEqual(before.state);
      expect(await changes(property)).toEqual(before.history);
    });
  });

  describe('visibility', () => {
    it.each([
      ['a supervisor not managing the property', () => supervisorOther],
      ['a negotiator not assigned to the property', () => negotiatorOther],
      ['another organization', () => adminB],
    ])('reports the property as not found (P0002) to %s', async (_label, actor) => {
      const property = await createProperty('negotiation');
      await expectRefused(() => transition(actor(), property, 'on_hold'), 'P0002', property);
    });

    it('reports an unknown property as not found', async () => {
      await expectSqlError(() => transition(adminA, randomUUID(), 'on_hold'), 'P0002');
    });

    it('allows the assigned negotiator and the managing supervisor on their property', async () => {
      const property = await createProperty('negotiation');
      await expectTransition(negotiatorAssigned, property, 'on_hold');
      await expectTransition(supervisorScoped, property, 'active');
    });
  });

  describe('legacy stage values', () => {
    it.each(['on_hold', 'withdrawn', 'acquisition_complete'])(
      'applies the status rules on a %s stage without converting the stage',
      async (legacy) => {
        const property = await createProperty(legacy);
        await expectTransition(negotiatorAssigned, property, 'on_hold');
        await expectTransition(negotiatorAssigned, property, 'active');
        // Not payment_closing, so completion needs the designated override.
        await expectRefused(() => transition(lamA, property, 'complete'), '22023', property);
        await expectTransition(lamA, property, 'complete', {
          reason: 'Reviewed manually',
          override: true,
          rules: ['completion_stage_condition'],
        });
        expect((await state(property)).acquisition_stage).toBe(legacy);
      },
    );
  });

  describe('bypass prevention', () => {
    it('refuses a direct status UPDATE from every role', async () => {
      const property = await createProperty('negotiation');
      for (const actor of [adminA, lamA, supervisorScoped]) {
        await expectRefused(
          () => asUser(pool, actor, (client) => client.query(`update public.properties set acquisition_status = 'complete' where id = $1`, [property])),
          '42501',
          property,
        );
      }
      for (const actor of [negotiatorAssigned, legalA, financeA, viewerA]) {
        const updated = await asUser(pool, actor, async (client) => {
          try {
            return (await client.query(`update public.properties set acquisition_status = 'on_hold' where id = $1`, [property])).rowCount;
          } catch (error) {
            expect((error as { code?: string }).code).toBe('42501');
            return 0;
          }
        });
        expect(updated).toBe(0);
      }
      expect(await state(property)).toEqual({ acquisition_stage: 'negotiation', acquisition_status: 'active' });
    });

    it('cannot be bypassed by setting the transition marker or override settings from the application role', async () => {
      const property = await createProperty('negotiation');
      await expectRefused(
        () =>
          asUser(pool, lamA, async (client) => {
            await client.query("select set_config('app.status_transition_property', $1, true)", [property]);
            await client.query("select set_config('app.lifecycle_override_rules', 'complete_reversal', true)");
            await client.query(`update public.properties set acquisition_status = 'complete' where id = $1`, [property]);
          }),
        '42501',
        property,
      );
      await expectSqlError(
        () =>
          asUser(pool, legalA, async (client) => {
            await client.query("select set_config('app.status_transition_property', $1, true)", [property]);
            await client.query(`update public.properties set risk = 'high' where id = $1`, [property]);
          }),
        '42501',
      );
      // A preset override setting is never recorded on an ordinary transition.
      await asUser(pool, negotiatorAssigned, async (client) => {
        await client.query("select set_config('app.lifecycle_override_rules', 'complete_reversal', true)");
        await client.query('select * from public.transition_property_status($1, $2)', [property, 'on_hold']);
      });
      expect((await changes(property)).at(-1)).toMatchObject({ to_value: 'on_hold', is_override: false, overridden_rules: null });
    });

    it('refuses history rows naming an undesignated rule, even from the owner', async () => {
      const property = await createProperty('negotiation');
      await expectSqlError(
        () =>
          admin.query(
            `insert into public.property_lifecycle_history
               (organization_id, property_id, field, from_value, to_value, reason, is_override, overridden_rules)
             values ($1, $2, 'acquisition_status', 'active', 'complete', 'x', true, array['any_rule'])`,
            [orgA, property],
          ),
        '23514',
      );
    });

    it('keeps other property updates working under the existing field permissions', async () => {
      const property = await createProperty('negotiation');
      await asUser(pool, lamA, (client) => client.query(`update public.properties set risk = 'high', readiness_percent = 30 where id = $1`, [property]));
      await asUser(pool, supervisorScoped, (client) => client.query(`update public.properties set readiness_percent = 40 where id = $1`, [property]));
      await asUser(pool, financeA, (client) => client.query(`update public.properties set payment_status = 'in_progress' where id = $1`, [property]));
      const row = await admin.query('select risk, readiness_percent, payment_status, acquisition_status from public.properties where id = $1', [property]);
      expect(row.rows[0]).toEqual({ risk: 'high', readiness_percent: 40, payment_status: 'in_progress', acquisition_status: 'active' });
    });
  });

  describe('stage transitions still work (L-02)', () => {
    it('leaves status unchanged when the stage moves, whatever the status', async () => {
      for (const status of STATUSES) {
        const property = await propertyIn(status, 'negotiation');
        await asUser(pool, negotiatorAssigned, (client) =>
          client.query('select * from public.transition_property_stage($1, $2)', [property, 'commercial_review']),
        );
        expect(await state(property)).toEqual({ acquisition_stage: 'commercial_review', acquisition_status: status });
      }
    });
  });

  describe('timeline', () => {
    it('shows status entries and marks overrides, without reasons, to every property-visible role', async () => {
      const property = await propertyIn('withdrawn', 'signing');
      await transition(adminA, property, 'active', 'Confidential settlement terms', true);
      const entries = await asUser(pool, viewerA, (client) => loadPropertyTimeline(client, viewerA, property, { limit: 50, offset: 0 }));
      const statusSummaries = entries.filter((entry) => entry.kind === 'status_changed').map((entry) => entry.summary);
      expect(statusSummaries).toEqual([
        'Acquisition status changed from Withdrawn to Active (override)',
        'Acquisition status changed from Active to Withdrawn',
        'Acquisition status set to Active',
      ]);
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toContain('Confidential settlement terms');
      expect(serialized).not.toContain('withdrawn_reversal');
      const expected = entries.map((entry) => entry.id);
      for (const actor of [negotiatorAssigned, supervisorScoped, lamA, legalA, financeA]) {
        const seen = await asUser(pool, actor, (client) => loadPropertyTimeline(client, actor, property, { limit: 50, offset: 0 }));
        expect(seen.map((entry) => entry.id)).toEqual(expected);
      }
    });
  });
});
