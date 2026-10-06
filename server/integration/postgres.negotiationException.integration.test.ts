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

type HistoryRow = {
  field: string;
  from_value: string | null;
  to_value: string;
  reason: string | null;
  actor_user_id: string | null;
  is_override: boolean;
  overridden_rules: string[] | null;
};

describe('PostgreSQL lifecycle authority and negotiation exception (L-04)', () => {
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
  const createProperty = (stage = 'negotiation') => {
    const sql = `insert into public.properties (
          organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id, assigned_manager_id
        ) values ($1, $2, $3, $4, $5, $6) returning id`;
    const params = [orgA, projectA, `NX-${randomUUID().slice(0, 8)}-${suffix}`, stage, negotiatorAssigned, supervisorScoped];
    return stage === 'identified'
      ? asUser(pool, lamA, async (client) => (await client.query<{ id: string }>(sql, params)).rows[0].id)
      : insertPropertyFixture(lamA, sql, params);
  };

  /** A negotiation recorded by the LAM through the negotiation module's normal path. */
  const addNegotiation = (propertyId: string, status: string, archived = false) =>
    asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.negotiations (organization_id, property_id, status, assigned_negotiator_id, opening_amount, archived_at)
         values ($1, $2, $3, $4, 1000000, case when $5 then timezone('utc', now()) end) returning id`,
        [orgA, propertyId, status, negotiatorAssigned, archived],
      );
      return result.rows[0].id;
    });

  /** A negotiation-stage property with a negotiation in the given state. */
  async function negotiatingProperty(status = 'open', archived = false) {
    const property = await createProperty('negotiation');
    const negotiation = await addNegotiation(property, status, archived);
    return { property, negotiation };
  }

  const stage = (actor: string, propertyId: string, target: string, reason: string | null = null, override: boolean | null = null) =>
    asUser(pool, actor, async (client) =>
      (
        await client.query<{ acquisition_stage: string; acquisition_status: string }>(
          override === null
            ? 'select * from public.transition_property_stage($1, $2, $3)'
            : 'select * from public.transition_property_stage($1, $2, $3, $4)',
          override === null ? [propertyId, target, reason] : [propertyId, target, reason, override],
        )
      ).rows[0],
    );

  const status = (actor: string, propertyId: string, target: string, reason: string | null = null, override = false) =>
    asUser(pool, actor, async (client) =>
      (await client.query('select * from public.transition_property_status($1, $2, $3, $4)', [propertyId, target, reason, override])).rows[0],
    );

  const state = async (propertyId: string) =>
    (
      await admin.query<{ acquisition_stage: string; acquisition_status: string }>(
        'select acquisition_stage, acquisition_status from public.properties where id = $1',
        [propertyId],
      )
    ).rows[0];

  const negotiationRow = async (negotiationId: string) =>
    (await admin.query('select to_jsonb(n) as row from public.negotiations n where n.id = $1', [negotiationId])).rows[0].row;

  const eventCount = async (negotiationId: string) =>
    (await admin.query<{ n: number }>('select count(*)::int as n from public.negotiation_events where negotiation_id = $1', [negotiationId]))
      .rows[0].n;

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

  /** Expects a refusal that leaves stage, status, history, and any negotiation untouched. */
  async function expectRefused(operation: () => Promise<unknown>, code: string, propertyId: string, negotiationId?: string) {
    const before = {
      state: await state(propertyId),
      history: await changes(propertyId),
      negotiation: negotiationId ? await negotiationRow(negotiationId) : null,
    };
    await expectSqlError(operation, code);
    expect(await state(propertyId)).toEqual(before.state);
    expect(await changes(propertyId)).toEqual(before.history);
    if (negotiationId) expect(await negotiationRow(negotiationId)).toEqual(before.negotiation);
  }

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    const { default: pgModule } = await import('pg');
    admin = new pgModule.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    // Re-apply 015 under the migration advisory lock so function text always
    // matches the repo. Every table the files alter is locked before the first
    // statement (see runWithTableLocks), so re-applying cannot deadlock with
    // parallel suites.
    await reapplyWithTableLocks(admin, LIFECYCLE_TABLES, async () => {
      // 015 and the later lifecycle migrations that redefine its objects
      // (017: the capture function), so the latest definitions stay in place.
      for (const file of [
        '015_lifecycle_negotiation_exception.sql',
        '016_property_creation_rules.sql',
        '017_legacy_stage_remediation.sql',
        '018_lifecycle_optimistic_concurrency.sql',
      ]) {
        await admin.query(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', file), 'utf8'));
      }
    });

    const orgOne = await bootstrapOrg(pool, `Nx North ${suffix}`, `nx-north-${suffix}`, `auth0|nx-admin-a-${suffix}`, 'Nx Admin A', `nx-admin-a-${suffix}@example.com`);
    const orgTwo = await bootstrapOrg(pool, `Nx South ${suffix}`, `nx-south-${suffix}`, `auth0|nx-admin-b-${suffix}`, 'Nx Admin B', `nx-admin-b-${suffix}@example.com`);
    orgA = orgOne.organization_id;
    adminA = orgOne.user_id;
    adminB = orgTwo.user_id;

    const user = (key: string, name: string) => syncUser(pool, `auth0|nx-${key}-${suffix}`, name, `nx-${key}-${suffix}@example.com`);
    lamA = await user('lam', 'Nx LAM');
    legalA = await user('legal', 'Nx Legal');
    financeA = await user('finance', 'Nx Finance');
    viewerA = await user('viewer', 'Nx Viewer');
    supervisorScoped = await user('sup-scoped', 'Nx Supervisor Scoped');
    supervisorOther = await user('sup-other', 'Nx Supervisor Other');
    negotiatorAssigned = await user('neg-assigned', 'Nx Negotiator Assigned');
    negotiatorOther = await user('neg-other', 'Nx Negotiator Other');
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
        `insert into public.projects (organization_id, code, name, status) values ($1, 'NX-01', 'Exception Program', 'active') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
  }, 60_000);

  afterAll(async () => {
    await admin?.end();
    await pool.end();
  });

  describe('operation authority (N-1)', () => {
    it.each([['negotiator'], ['supervisor'], ['lam'], ['admin']] as const)('allows %s an ordinary forward transition', async (key) => {
      const property = await createProperty('documentation');
      expect(await stage(role[key](), property, 'negotiation')).toMatchObject({ acquisition_stage: 'negotiation' });
    });

    it('refuses a negotiator a backward transition, and allows supervisor, LAM, and system admin with a reason', async () => {
      const property = await createProperty('commercial_review');
      await expectRefused(() => stage(negotiatorAssigned, property, 'documentation', 'Missing papers'), '42501', property);
      for (const actor of [supervisorScoped, lamA, adminA]) {
        await expectRefused(() => stage(actor, property, 'documentation', ' '), '22023', property);
      }
      await stage(supervisorScoped, property, 'documentation', ' Missing papers ');
      expect((await changes(property)).at(-1)).toMatchObject({ reason: 'Missing papers', is_override: false, overridden_rules: null });
    });

    it.each([['legal'], ['finance'], ['viewer']] as const)('gives %s no lifecycle authority, even with an override', async (key) => {
      const property = await createProperty('documentation');
      await expectRefused(() => stage(role[key](), property, 'negotiation', 'A reason', true), '42501', property);
      await expectRefused(() => status(role[key](), property, 'on_hold'), '42501', property);
    });
  });

  describe('specific operation row over the general override (preserved from L-03)', () => {
    it.each(['active', 'on_hold', 'withdrawn'])('REJECTS a supervisor reversing complete → %s with the override', async (target) => {
      const property = await createProperty('payment_closing');
      await status(adminA, property, 'complete');
      await expectRefused(() => status(supervisorScoped, property, target, 'Payment bounced', true), '42501', property);
    });

    it.each([['lam'], ['admin']] as const)('ALLOWS %s the designated complete reversal', async (key) => {
      for (const target of ['active', 'on_hold', 'withdrawn']) {
        const property = await createProperty('payment_closing');
        await status(adminA, property, 'complete');
        await status(role[key](), property, target, 'Payment bounced', true);
        expect((await changes(property)).at(-1)).toMatchObject({
          field: 'acquisition_status',
          to_value: target,
          is_override: true,
          overridden_rules: ['complete_reversal'],
        });
      }
    });
  });

  describe('negotiation exception: blocked without it', () => {
    it.each([
      ['open', false],
      ['paused', false],
      ['open', true],
      ['paused', true],
    ])('refuses leaving negotiation with a %s negotiation (archived: %s) without the override', async (negotiationStatus, archived) => {
      const { property, negotiation } = await negotiatingProperty(negotiationStatus, archived);
      for (const actor of [supervisorScoped, lamA, adminA]) {
        for (const override of [null, false]) {
          await expectRefused(() => stage(actor, property, 'commercial_review', 'Terms agreed verbally', override), '22023', property, negotiation);
          await expectRefused(() => stage(actor, property, 'documentation', 'Back for papers', override), '22023', property, negotiation);
        }
      }
    });

    it.each(['open', 'paused'])('refuses a negotiator with a %s negotiation, with or without the override', async (negotiationStatus) => {
      const { property, negotiation } = await negotiatingProperty(negotiationStatus);
      for (const override of [null, false, true]) {
        await expectRefused(() => stage(negotiatorAssigned, property, 'commercial_review', 'Terms agreed verbally', override), '42501', property, negotiation);
      }
    });

    it('refuses the exception without a real reason', async () => {
      const { property, negotiation } = await negotiatingProperty('open');
      for (const actor of [supervisorScoped, lamA, adminA]) {
        for (const reason of [null, '', '   ', ' \t\n ']) {
          await expectRefused(() => stage(actor, property, 'commercial_review', reason, true), '22023', property, negotiation);
        }
      }
    });
  });

  describe('negotiation exception: allowed with it', () => {
    it.each([
      ['supervisor', 'open'],
      ['lam', 'open'],
      ['admin', 'open'],
      ['supervisor', 'paused'],
      ['lam', 'paused'],
      ['admin', 'paused'],
    ] as const)('lets %s leave negotiation with a %s negotiation, recording the override and leaving the negotiation unchanged', async (key, negotiationStatus) => {
      const { property, negotiation } = await negotiatingProperty(negotiationStatus);
      const before = await negotiationRow(negotiation);
      const events = await eventCount(negotiation);
      const result = await stage(role[key](), property, 'commercial_review', '  Terms agreed verbally \n', true);
      expect(result).toMatchObject({ acquisition_stage: 'commercial_review', acquisition_status: 'active' });
      expect(await changes(property)).toEqual([
        {
          field: 'acquisition_stage',
          from_value: 'negotiation',
          to_value: 'commercial_review',
          reason: 'Terms agreed verbally',
          actor_user_id: role[key](),
          is_override: true,
          overridden_rules: ['negotiation_unresolved_exit'],
        },
      ]);
      expect(await negotiationRow(negotiation)).toEqual(before);
      expect(await eventCount(negotiation)).toBe(events);
      expect((await negotiationRow(negotiation)).status).toBe(negotiationStatus);
    });

    it('applies to a backward exit too, on top of the backward reason', async () => {
      const { property, negotiation } = await negotiatingProperty('open');
      const before = await negotiationRow(negotiation);
      await stage(supervisorScoped, property, 'owner_validation', 'Title holder was misidentified', true);
      expect(await changes(property)).toEqual([
        expect.objectContaining({
          from_value: 'negotiation',
          to_value: 'owner_validation',
          reason: 'Title holder was misidentified',
          is_override: true,
          overridden_rules: ['negotiation_unresolved_exit'],
        }),
      ]);
      expect(await negotiationRow(negotiation)).toEqual(before);
    });

    it('applies to an archived but still open negotiation', async () => {
      const { property, negotiation } = await negotiatingProperty('open', true);
      await stage(lamA, property, 'commercial_review', 'Archived by mistake, still open', true);
      expect((await changes(property)).at(-1)).toMatchObject({ is_override: true, overridden_rules: ['negotiation_unresolved_exit'] });
      expect((await negotiationRow(negotiation)).status).toBe('open');
    });
  });

  describe('no exception when the negotiation is resolved or absent', () => {
    it.each(['accepted', 'rejected', 'withdrawn', 'closed'])('lets a negotiator leave negotiation after a %s negotiation, without an override', async (negotiationStatus) => {
      const { property, negotiation } = await negotiatingProperty(negotiationStatus);
      await expectRefused(() => stage(adminA, property, 'commercial_review', 'A reason', true), '22023', property, negotiation);
      await stage(negotiatorAssigned, property, 'commercial_review');
      expect((await changes(property)).at(-1)).toMatchObject({ to_value: 'commercial_review', is_override: false, overridden_rules: null, reason: null });
    });

    it('lets a property with no negotiation leave negotiation, and refuses an unneeded override', async () => {
      const property = await createProperty('negotiation');
      await expectRefused(() => stage(adminA, property, 'commercial_review', 'A reason', true), '22023', property);
      await stage(negotiatorAssigned, property, 'commercial_review');
      expect(await state(property)).toEqual({ acquisition_stage: 'commercial_review', acquisition_status: 'active' });
    });

    it('refuses an override on any other stage transition (no designated rule; sensitive list empty)', async () => {
      const property = await createProperty('identified');
      for (const actor of [supervisorScoped, lamA, adminA]) {
        await expectRefused(() => stage(actor, property, 'initial_contact', 'A reason', true), '22023', property);
        await expectRefused(() => stage(actor, property, 'payment_closing', 'A reason', true), '22023', property);
      }
      await stage(negotiatorAssigned, property, 'payment_closing');
      expect((await changes(property)).at(-1)).toMatchObject({ is_override: false });
    });

    it('does not apply to entering negotiation or to the same-stage no-op', async () => {
      const { property } = await negotiatingProperty('open');
      await stage(negotiatorAssigned, property, 'negotiation');
      expect(await changes(property)).toEqual([]);
      const other = await createProperty('documentation');
      await stage(negotiatorAssigned, other, 'negotiation');
      expect(await state(other)).toMatchObject({ acquisition_stage: 'negotiation' });
    });

    it('does not apply to status transitions, which never move the stage', async () => {
      const { property, negotiation } = await negotiatingProperty('open');
      await status(negotiatorAssigned, property, 'on_hold');
      await status(supervisorScoped, property, 'withdrawn', 'Owner unreachable');
      expect(await state(property)).toEqual({ acquisition_stage: 'negotiation', acquisition_status: 'withdrawn' });
      expect((await negotiationRow(negotiation)).status).toBe('open');
    });
  });

  describe('visibility', () => {
    it.each([
      ['a supervisor not managing the property', () => supervisorOther],
      ['a negotiator not assigned to the property', () => negotiatorOther],
      ['another organization', () => adminB],
    ])('reports the property as not found (P0002) to %s, even with the override', async (_label, actor) => {
      const { property, negotiation } = await negotiatingProperty('open');
      await expectRefused(() => stage(actor(), property, 'commercial_review', 'A reason', true), 'P0002', property, negotiation);
    });

    it('reports an unknown property as not found', async () => {
      await expectSqlError(() => stage(adminA, randomUUID(), 'commercial_review', 'A reason', true), 'P0002');
    });

    it('allows the managing supervisor on the managed property and the assigned negotiator on the assigned one', async () => {
      const managed = await negotiatingProperty('open');
      await stage(supervisorScoped, managed.property, 'commercial_review', 'Managed scope', true);
      const assigned = await createProperty('negotiation');
      await stage(negotiatorAssigned, assigned, 'commercial_review');
      expect((await state(managed.property)).acquisition_stage).toBe('commercial_review');
      expect((await state(assigned)).acquisition_stage).toBe('commercial_review');
    });
  });

  describe('bypass prevention', () => {
    it('does not record a preset stage override setting on an ordinary transition', async () => {
      const property = await createProperty('documentation');
      await asUser(pool, negotiatorAssigned, async (client) => {
        await client.query("select set_config('app.lifecycle_stage_override_rules', 'negotiation_unresolved_exit', true)");
        await client.query('select * from public.transition_property_stage($1, $2)', [property, 'negotiation']);
      });
      expect((await changes(property)).at(-1)).toMatchObject({ to_value: 'negotiation', is_override: false, overridden_rules: null });
    });

    it('still refuses a direct stage UPDATE out of negotiation, with the marker and override settings spoofed', async () => {
      const { property, negotiation } = await negotiatingProperty('open');
      await expectRefused(
        () =>
          asUser(pool, adminA, async (client) => {
            await client.query("select set_config('app.stage_transition_property', $1, true)", [property]);
            await client.query("select set_config('app.lifecycle_stage_override_rules', 'negotiation_unresolved_exit', true)");
            await client.query(`update public.properties set acquisition_stage = 'commercial_review' where id = $1`, [property]);
          }),
        '42501',
        property,
        negotiation,
      );
    });

    it('refuses history rows naming an undesignated rule, even from the owner', async () => {
      const property = await createProperty('negotiation');
      await expectSqlError(
        () =>
          admin.query(
            `insert into public.property_lifecycle_history
               (organization_id, property_id, field, from_value, to_value, reason, is_override, overridden_rules)
             values ($1, $2, 'acquisition_stage', 'negotiation', 'signing', 'x', true, array['any_rule'])`,
            [orgA, property],
          ),
        '23514',
      );
    });
  });

  describe('timeline', () => {
    it('marks the exception as an override for every property-visible role, without the reason or rule', async () => {
      const { property } = await negotiatingProperty('open');
      await stage(lamA, property, 'commercial_review', 'Confidential side agreement', true);
      const entries = await asUser(pool, viewerA, (client) => loadPropertyTimeline(client, viewerA, property, { limit: 50, offset: 0 }));
      expect(entries.filter((entry) => entry.kind === 'stage_changed').map((entry) => entry.summary)).toEqual([
        'Acquisition stage changed from Negotiation to Commercial review (override)',
        'Acquisition stage set to Negotiation',
      ]);
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toContain('Confidential side agreement');
      expect(serialized).not.toContain('negotiation_unresolved_exit');
      const expected = entries.map((entry) => entry.id);
      for (const actor of [negotiatorAssigned, supervisorScoped, lamA, adminA, legalA, financeA]) {
        const seen = await asUser(pool, actor, (client) => loadPropertyTimeline(client, actor, property, { limit: 50, offset: 0 }));
        expect(seen.map((entry) => entry.id)).toEqual(expected);
      }
    });
  });
});
