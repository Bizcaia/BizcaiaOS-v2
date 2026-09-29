import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';
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

const LATER_NORMAL_STAGES = [
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

describe('PostgreSQL property creation rules (L-05)', () => {
  const pool = createAppPool();
  let admin: pg.Client;
  let orgA: string;
  let orgB: string;
  let adminA: string;
  let adminB: string;
  let lamA: string;
  let legalA: string;
  let financeA: string;
  let viewerA: string;
  let supervisorA: string;
  let negotiatorA: string;
  let projectA: string;
  let projectB: string;

  const role = {
    admin: () => adminA,
    lam: () => lamA,
    supervisor: () => supervisorA,
    negotiator: () => negotiatorA,
    legal: () => legalA,
    finance: () => financeA,
    viewer: () => viewerA,
  };

  type Columns = {
    organization_id?: string;
    project_id?: string;
    property_reference?: string | null;
    acquisition_stage?: string;
    acquisition_status?: string;
    assigned_negotiator_id?: string | null;
  };

  /** Inserts through the application role, with only the given columns (the rest use their defaults). */
  const create = (actor: string, columns: Columns = {}) => {
    const row: Columns = {
      organization_id: orgA,
      project_id: projectA,
      property_reference: `CR-${randomUUID().slice(0, 8)}-${suffix}`,
      ...columns,
    };
    const names = Object.keys(row);
    return asUser(pool, actor, async (client) =>
      (
        await client.query<{ id: string; acquisition_stage: string; acquisition_status: string }>(
          `insert into public.properties (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})
           returning id, acquisition_stage, acquisition_status`,
          Object.values(row),
        )
      ).rows[0],
    );
  };

  // Scoped to this suite's properties (every reference ends with the run's
  // suffix, in any organization), since parallel suites create their own.
  // properties is named first so its lock is taken before the history table's,
  // the same order as the suites' migration re-apply (no deadlock).
  const historyCount = async () =>
    (
      await admin.query<{ n: number }>(
        `select count(*)::int as n from public.properties p
           join public.property_lifecycle_history h on h.property_id = p.id
          where p.property_reference like '%-' || $1`,
        [suffix],
      )
    ).rows[0].n;

  const propertyCount = async () =>
    (await admin.query<{ n: number }>(`select count(*)::int as n from public.properties where property_reference like '%-' || $1`, [suffix]))
      .rows[0].n;

  /** Expects a refused creation that leaves no property and no lifecycle history behind. */
  async function expectRefused(operation: () => Promise<unknown>, code: string) {
    const before = { properties: await propertyCount(), history: await historyCount() };
    await expectSqlError(operation, code);
    expect(await propertyCount()).toBe(before.properties);
    expect(await historyCount()).toBe(before.history);
  }

  const history = async (propertyId: string) =>
    (
      await admin.query(
        `select field, from_value, to_value, reason, actor_user_id, is_override, overridden_rules
           from public.property_lifecycle_history where property_id = $1 order by field`,
        [propertyId],
      )
    ).rows;

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    const { default: pgModule } = await import('pg');
    admin = new pgModule.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    // Re-apply 016 under the migration advisory lock so function text always
    // matches the repo. The strongest properties lock (drop trigger needs it)
    // is taken first, so re-applying never upgrades a lock mid-transaction and
    // cannot deadlock with parallel suites.
    try {
      await admin.query('select pg_advisory_lock(87236401)');
      await admin.query('begin');
      try {
        await admin.query('lock table public.properties in access exclusive mode');
        await admin.query(
          readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', '016_property_creation_rules.sql'), 'utf8'),
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

    const orgOne = await bootstrapOrg(pool, `Cr North ${suffix}`, `cr-north-${suffix}`, `auth0|cr-admin-a-${suffix}`, 'Cr Admin A', `cr-admin-a-${suffix}@example.com`);
    const orgTwo = await bootstrapOrg(pool, `Cr South ${suffix}`, `cr-south-${suffix}`, `auth0|cr-admin-b-${suffix}`, 'Cr Admin B', `cr-admin-b-${suffix}@example.com`);
    orgA = orgOne.organization_id;
    adminA = orgOne.user_id;
    orgB = orgTwo.organization_id;
    adminB = orgTwo.user_id;

    const user = (key: string, name: string) => syncUser(pool, `auth0|cr-${key}-${suffix}`, name, `cr-${key}-${suffix}@example.com`);
    lamA = await user('lam', 'Cr LAM');
    legalA = await user('legal', 'Cr Legal');
    financeA = await user('finance', 'Cr Finance');
    viewerA = await user('viewer', 'Cr Viewer');
    supervisorA = await user('sup', 'Cr Supervisor');
    negotiatorA = await user('neg', 'Cr Negotiator');
    await addMember(pool, adminA, orgA, lamA, 'land_acquisition_manager');
    await addMember(pool, adminA, orgA, legalA, 'legal_documentation');
    await addMember(pool, adminA, orgA, financeA, 'finance');
    await addMember(pool, adminA, orgA, viewerA, 'viewer');
    await addMember(pool, adminA, orgA, supervisorA, 'supervisor');
    await addMember(pool, adminA, orgA, negotiatorA, 'negotiator');

    const project = (actor: string, organization: string, code: string) =>
      asUser(pool, actor, async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into public.projects (organization_id, code, name, status, manager_user_id) values ($1, $2, 'Creation Program', 'active', $3) returning id`,
          [organization, code, actor === lamA ? supervisorA : null],
        );
        return result.rows[0].id;
      });
    projectA = await project(lamA, orgA, 'CR-01');
    projectB = await project(adminB, orgB, 'CR-B');
  }, 60_000);

  afterAll(async () => {
    await admin?.end();
    await pool.end();
  });

  describe('authorized creation', () => {
    it.each([['admin'], ['lam']] as const)('lets %s create a property, which starts identified and active with its creation history', async (key) => {
      const created = await create(role[key]());
      expect(created).toMatchObject({ acquisition_stage: 'identified', acquisition_status: 'active' });
      expect(await history(created.id)).toEqual([
        { field: 'acquisition_stage', from_value: null, to_value: 'identified', reason: null, actor_user_id: role[key](), is_override: false, overridden_rules: null },
        { field: 'acquisition_status', from_value: null, to_value: 'active', reason: null, actor_user_id: role[key](), is_override: false, overridden_rules: null },
      ]);
    });

    it('accepts identified and active when given explicitly', async () => {
      const created = await create(lamA, { acquisition_stage: 'identified', acquisition_status: 'active' });
      expect(created).toMatchObject({ acquisition_stage: 'identified', acquisition_status: 'active' });
    });

    it('moves on afterwards only through the controlled transitions', async () => {
      const created = await create(lamA);
      await expectSqlError(
        () => asUser(pool, lamA, (client) => client.query(`update public.properties set acquisition_stage = 'negotiation' where id = $1`, [created.id])),
        '42501',
      );
      await asUser(pool, lamA, (client) => client.query('select * from public.transition_property_stage($1, $2)', [created.id, 'negotiation']));
      await asUser(pool, lamA, (client) => client.query('select * from public.transition_property_status($1, $2)', [created.id, 'on_hold']));
      const row = await admin.query('select acquisition_stage, acquisition_status from public.properties where id = $1', [created.id]);
      expect(row.rows[0]).toEqual({ acquisition_stage: 'negotiation', acquisition_status: 'on_hold' });
    });
  });

  describe('unauthorized creation', () => {
    it.each([['supervisor'], ['negotiator'], ['legal'], ['finance'], ['viewer']] as const)(
      'refuses %s with 42501, leaving no property or history',
      async (key) => {
        await expectRefused(() => create(role[key]()), '42501');
      },
    );
  });

  describe('initial lifecycle state (P-6)', () => {
    it.each(LATER_NORMAL_STAGES)('refuses creating in %s (no controlled entry point is approved)', async (stage) => {
      for (const actor of [adminA, lamA]) {
        await expectRefused(() => create(actor, { acquisition_stage: stage }), '22023');
      }
    });

    it.each(LEGACY_STAGES)('refuses the legacy value %s as a creation stage', async (stage) => {
      for (const actor of [adminA, lamA]) {
        await expectRefused(() => create(actor, { acquisition_stage: stage }), '22023');
      }
    });

    it.each(['on_hold', 'withdrawn', 'complete'])('refuses creating with status %s', async (status) => {
      for (const actor of [adminA, lamA]) {
        await expectRefused(() => create(actor, { acquisition_status: status }), '22023');
      }
    });

    it('rejects values outside the lifecycle enums', async () => {
      await expectRefused(() => create(adminA, { acquisition_stage: 'complete' }), '22P02');
      await expectRefused(() => create(adminA, { acquisition_status: 'completed' }), '22P02');
    });

    it('cannot be bypassed with the transition markers or override settings', async () => {
      await expectRefused(
        () =>
          asUser(pool, adminA, async (client) => {
            await client.query("select set_config('app.stage_transition_property', $1, true)", [randomUUID()]);
            await client.query("select set_config('app.status_transition_property', $1, true)", [randomUUID()]);
            await client.query("select set_config('app.lifecycle_stage_override_rules', 'negotiation_unresolved_exit', true)");
            await client.query(
              `insert into public.properties (organization_id, project_id, property_reference, acquisition_stage, acquisition_status)
               values ($1, $2, $3, 'negotiation', 'complete')`,
              [orgA, projectA, `CR-SPOOF-${suffix}`],
            );
          }),
        '22023',
      );
    });

    it('leaves controlled owner operations able to set up other starting stages', async () => {
      const id = await insertPropertyFixture(
        lamA,
        `insert into public.properties (organization_id, project_id, property_reference, acquisition_stage) values ($1, $2, $3, 'withdrawn') returning id`,
        [orgA, projectA, `CR-OWNER-${suffix}`],
      );
      expect((await history(id)).map((row) => row.to_value)).toEqual(['withdrawn', 'active']);
    });
  });

  describe('tenant and organization isolation (unchanged)', () => {
    it('refuses creating a property in another organization', async () => {
      await expectRefused(() => create(lamA, { organization_id: orgB, project_id: projectB }), '42501');
      await expectRefused(() => create(adminB, { organization_id: orgA, project_id: projectA }), '42501');
    });

    it('refuses an unknown organization', async () => {
      // The existing project-scope guard (a before-insert trigger) refuses it
      // before the row-level policy is checked.
      await expectRefused(() => create(adminA, { organization_id: randomUUID() }), '23514');
    });

    it('refuses a project from another organization', async () => {
      await expectRefused(() => create(adminA, { project_id: projectB }), '23514');
    });

    it('keeps the new property visible only within its organization', async () => {
      const created = await create(lamA);
      const seen = (actor: string) =>
        asUser(pool, actor, async (client) => (await client.query('select id from public.properties where id = $1', [created.id])).rowCount);
      expect(await seen(adminA)).toBe(1);
      expect(await seen(adminB)).toBe(0);
    });
  });

  describe('existing creation constraints (unchanged)', () => {
    it('requires a property reference', async () => {
      await expectRefused(() => create(adminA, { property_reference: null }), '23502');
    });

    it('keeps property references unique within an organization', async () => {
      const reference = `CR-DUP-${suffix}`;
      await create(adminA, { property_reference: reference });
      await expectRefused(() => create(lamA, { property_reference: reference }), '23505');
    });

    it('checks the assigned negotiator role', async () => {
      await expectRefused(() => create(adminA, { assigned_negotiator_id: legalA }), '23514');
      const created = await create(adminA, { assigned_negotiator_id: negotiatorA });
      expect(created.acquisition_stage).toBe('identified');
    });
  });
});
