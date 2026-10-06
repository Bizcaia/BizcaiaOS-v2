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
  insertPropertyFixture,
  reapplyWithTableLocks,
  requireDatabaseEnv,
  syncUser,
} from './postgresHarness.js';

/**
 * L-08 (final validation). Architecture section T defines L-08 as validation
 * only: "Full suites, twice; migrations applied twice; demo parity", accepted
 * when the section V criteria are complete. This suite adds no product
 * behavior. It closes the criteria that the slice suites cover only in part:
 *
 *   V1   locked meanings: no "completed" status; legacy stages not creatable
 *   V3   every role x operation combination, for all 7 roles, in one matrix
 *   V10  a stale lifecycle value conflicts while unrelated fields still save
 *   V11  one history row per successful change, none for a refusal
 *   V12  the lifecycle migration chain applies twice cleanly
 *   parity  the client rule mirror (used by the UI and the demo adapter) and
 *           the demo adapter itself agree with the database functions
 */

const suffix = randomUUID().slice(0, 8);
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
const ROLES = [
  'system_admin',
  'land_acquisition_manager',
  'supervisor',
  'negotiator',
  'legal_documentation',
  'finance',
  'viewer',
] as const;
type Role = (typeof ROLES)[number];
const STATUSES = ['active', 'on_hold', 'withdrawn', 'complete'] as const;
type Status = (typeof STATUSES)[number];

/** The parts of the client module (src/api/operationsApi.ts) this suite uses. */
type ClientModule = {
  demoStatusOperation: (from: string, to: Status, stage: string) => { roles: Set<string>; reasonRequired: boolean; rules: string[] };
  forwardStageRoles: Set<string>;
  backwardStageRoles: Set<string>;
  stageOrder: string[];
  legacyStages: string[];
  resetOperationsDemoState: () => void;
  DEMO_ORGANIZATION_ID: string;
  operationsApi: {
    createProperty: (input: Record<string, unknown>) => Promise<{ id: string; acquisition_stage: string; acquisition_status: string }>;
    getProperty: (id: string) => Promise<{ acquisition_stage: string; acquisition_status: string }>;
    transitionPropertyStage: (id: string, input: Record<string, unknown>) => Promise<unknown>;
    transitionPropertyStatus: (id: string, input: Record<string, unknown>) => Promise<unknown>;
    startRemediation: (id: string) => Promise<unknown>;
    escalateRemediation: (id: string, input: Record<string, unknown>) => Promise<unknown>;
    returnRemediationToReview: (id: string, input: Record<string, unknown>) => Promise<unknown>;
    resolveRemediation: (id: string, input: Record<string, unknown>) => Promise<unknown>;
    reopenRemediation: (id: string, input: Record<string, unknown>) => Promise<unknown>;
    listPropertyRemediations: (id: string) => Promise<Array<{ state: string; cycle: number }>>;
  };
};

describe('PostgreSQL lifecycle acceptance (L-08)', () => {
  const pool = createAppPool();
  let admin: pg.Client;
  let client: ClientModule;
  let orgA: string;
  let projectA: string;
  const users = {} as Record<Role, string>;

  // The seeded demo legacy property (NCP-00077, withdrawn).
  const DEMO_LEGACY = '70000000-0000-4000-8000-000000000004';

  const ok = (promise: Promise<unknown>) =>
    promise.then(
      () => ({ ok: true as const }),
      (error: { code?: string }) => ({ ok: false as const, code: error.code }),
    );

  /** A property on the given stage, assigned to the negotiator and managed by the supervisor. */
  const property = (stage = 'identified') =>
    stage === 'identified'
      ? asUser(pool, users.land_acquisition_manager, async (db) =>
          (
            await db.query<{ id: string }>(
              `insert into public.properties (organization_id, project_id, property_reference, assigned_negotiator_id, assigned_manager_id)
               values ($1, $2, $3, $4, $5) returning id`,
              [orgA, projectA, `AC-${randomUUID().slice(0, 8)}-${suffix}`, users.negotiator, users.supervisor],
            )
          ).rows[0].id,
        )
      : insertPropertyFixture(
          users.land_acquisition_manager,
          `insert into public.properties (organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id, assigned_manager_id)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [orgA, projectA, `AC-${randomUUID().slice(0, 8)}-${suffix}`, stage, users.negotiator, users.supervisor],
        );

  const state = async (id: string) =>
    (await admin.query<{ acquisition_stage: string; acquisition_status: string }>(
      'select acquisition_stage, acquisition_status from public.properties where id = $1',
      [id],
    )).rows[0];

  const historyCount = async (id: string) =>
    (await admin.query<{ n: number }>('select count(*)::int as n from public.property_lifecycle_history where property_id = $1', [id])).rows[0].n;

  const stage = (actor: string, id: string, target: string, expected: string, reason: string | null = null, override = false) =>
    asUser(pool, actor, (db) =>
      db.query('select * from public.transition_property_stage($1, $2, $3, $4, $5)', [id, target, reason, override, expected]),
    );

  const status = (actor: string, id: string, target: string, expected: string, reason: string | null = null, override = false) =>
    asUser(pool, actor, (db) =>
      db.query('select * from public.transition_property_status($1, $2, $3, $4, $5)', [id, target, reason, override, expected]),
    );

  /** Puts a fresh property into the given status through the status function, as a system admin. */
  async function propertyIn(from: Status, stageName = 'payment_closing') {
    const id = await property(stageName);
    const sa = users.system_admin;
    if (from === 'on_hold') await status(sa, id, 'on_hold', 'active');
    if (from === 'withdrawn') await status(sa, id, 'withdrawn', 'active', 'Fixture');
    if (from === 'complete') await status(sa, id, 'complete', 'active');
    return id;
  }

  const signatures = async () =>
    (
      await admin.query<{ proname: string; n: number }>(
        `select proname, count(*)::int as n from pg_proc
          where proname in ('transition_property_stage', 'transition_property_status', 'start_property_stage_remediation',
                            'escalate_property_stage_remediation', 'return_property_stage_remediation_to_review',
                            'resolve_property_stage_remediation', 'reopen_property_stage_remediation')
          group by proname order by proname`,
      )
    ).rows;

  const fingerprint = async () =>
    (
      await admin.query(
        `select (select md5(coalesce(string_agg(id::text || acquisition_stage || acquisition_status, ',' order by id), '')) from public.properties) as properties,
                (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from public.property_lifecycle_history) as history,
                (select md5(coalesce(string_agg(id::text || state, ',' order by id), '')) from public.property_stage_remediations) as remediations`,
      )
    ).rows[0];

  let chainEvidence: { signaturesAfterEachPass: unknown[]; fingerprintBefore: unknown; fingerprintAfter: unknown };

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    const { default: pgModule } = await import('pg');
    admin = new pgModule.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();

    // V12: the lifecycle migration chain (012-018), applied twice in order, in
    // one locked transaction: no failure, one signature per function, no data change.
    await reapplyWithTableLocks(admin, LIFECYCLE_TABLES, async () => {
      const fingerprintBefore = await fingerprint();
      const signaturesAfterEachPass: unknown[] = [];
      for (let pass = 0; pass < 2; pass += 1) {
        for (const file of LIFECYCLE_MIGRATIONS) {
          await admin.query(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', file), 'utf8'));
        }
        signaturesAfterEachPass.push(await signatures());
      }
      chainEvidence = { signaturesAfterEachPass, fingerprintBefore, fingerprintAfter: await fingerprint() };
    });

    // The client module in demo mode (no API base configured in tests).
    const clientPath = '../../src/api/operationsApi';
    client = (await import(clientPath)) as ClientModule;

    const org = await bootstrapOrg(pool, `Ac North ${suffix}`, `ac-north-${suffix}`, `auth0|ac-admin-${suffix}`, 'Ac Admin', `ac-admin-${suffix}@example.com`);
    orgA = org.organization_id;
    users.system_admin = org.user_id;
    for (const role of ROLES.filter((entry) => entry !== 'system_admin')) {
      users[role] = await syncUser(pool, `auth0|ac-${role}-${suffix}`, `Ac ${role}`, `ac-${role}-${suffix}@example.com`);
      await addMember(pool, users.system_admin, orgA, users[role], role);
    }
    projectA = await asUser(pool, users.land_acquisition_manager, async (db) =>
      (
        await db.query<{ id: string }>(
          `insert into public.projects (organization_id, code, name, status) values ($1, 'AC-01', 'Acceptance Program', 'active') returning id`,
          [orgA],
        )
      ).rows[0].id,
    );
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await pool.end();
  });

  describe('V12: migrations applied twice', () => {
    it('re-applies 012-018 twice with one signature per lifecycle function and no data change', () => {
      const expected = [
        { proname: 'escalate_property_stage_remediation', n: 1 },
        { proname: 'reopen_property_stage_remediation', n: 1 },
        { proname: 'resolve_property_stage_remediation', n: 1 },
        { proname: 'return_property_stage_remediation_to_review', n: 1 },
        { proname: 'start_property_stage_remediation', n: 1 },
        { proname: 'transition_property_stage', n: 1 },
        { proname: 'transition_property_status', n: 1 },
      ];
      expect(chainEvidence.signaturesAfterEachPass).toEqual([expected, expected]);
      expect(chainEvidence.fingerprintAfter).toEqual(chainEvidence.fingerprintBefore);
    });
  });

  describe('V1: locked meanings', () => {
    it('has exactly the four statuses (complete, never completed) and the eleven normal plus three legacy stages', async () => {
      const values = async (type: string) =>
        (await admin.query<{ v: string }>(`select unnest(enum_range(null::public.${type}))::text as v`)).rows.map((row) => row.v);
      expect(await values('acquisition_status')).toEqual(['active', 'on_hold', 'withdrawn', 'complete']);
      const stages = await values('acquisition_stage');
      expect(stages.filter((value) => !client.legacyStages.includes(value))).toEqual(client.stageOrder);
      expect(stages.filter((value) => client.legacyStages.includes(value)).sort()).toEqual(['acquisition_complete', 'on_hold', 'withdrawn']);
    });

    it('never lets the application create or select a legacy stage', async () => {
      for (const legacy of client.legacyStages) {
        const created = await ok(
          asUser(pool, users.system_admin, (db) =>
            db.query(`insert into public.properties (organization_id, project_id, property_reference, acquisition_stage) values ($1, $2, $3, $4)`, [
              orgA,
              projectA,
              `AC-LEG-${legacy}-${suffix}`,
              legacy,
            ]),
          ),
        );
        expect(created).toEqual({ ok: false, code: '22023' });
        const id = await property();
        expect(await ok(stage(users.system_admin, id, legacy, 'identified', 'A reason'))).toEqual({ ok: false, code: '22023' });
      }
    });
  });

  describe('V3: every role x operation, all 7 roles (client mirror = database)', () => {
    it.each(ROLES)('stage transitions for %s match the mirror: forward, backward with a reason, and the negotiation exception', async (role) => {
      const forward = await property('documentation');
      const forwardResult = await ok(stage(users[role], forward, 'negotiation', 'documentation'));
      expect(forwardResult.ok).toBe(client.forwardStageRoles.has(role));
      if (!forwardResult.ok) expect(forwardResult.code).toBe('42501');

      const backward = await property('documentation');
      const backwardResult = await ok(stage(users[role], backward, 'owner_validation', 'documentation', 'A reason'));
      expect(backwardResult.ok).toBe(client.backwardStageRoles.has(role));
      if (!backwardResult.ok) expect(backwardResult.code).toBe('42501');

      const exception = await property('negotiation');
      await asUser(pool, users.land_acquisition_manager, (db) =>
        db.query(`insert into public.negotiations (organization_id, property_id, status) values ($1, $2, 'open')`, [orgA, exception]),
      );
      const exceptionResult = await ok(stage(users[role], exception, 'commercial_review', 'negotiation', 'A reason', true));
      expect(exceptionResult.ok).toBe(['system_admin', 'land_acquisition_manager', 'supervisor'].includes(role));
    });

    const pairs = STATUSES.flatMap((from) => STATUSES.filter((to) => to !== from).map((to) => [from, to] as [Status, Status]));

    it.each(pairs)('status %s -> %s matches the mirror for all 7 roles, with one history row per success and none per refusal', async (from, to) => {
      const operation = client.demoStatusOperation(from, to, 'payment_closing');
      for (const role of ROLES) {
        const id = await propertyIn(from);
        const before = await historyCount(id);
        const result = await ok(
          status(users[role], id, to, from, operation.reasonRequired ? 'A reason' : null, operation.rules.length > 0),
        );
        expect({ role, ok: result.ok }).toEqual({ role, ok: operation.roles.has(role) });
        if (result.ok) {
          expect(await state(id)).toMatchObject({ acquisition_status: to, acquisition_stage: 'payment_closing' });
          expect(await historyCount(id)).toBe(before + 1);
        } else {
          expect(result.code).toBe('42501');
          expect(await state(id)).toMatchObject({ acquisition_status: from });
          expect(await historyCount(id)).toBe(before);
        }
      }
    });

    it.each(ROLES)('legacy remediation for %s: every step is allowed only to supervisor, LAM, and system admin', async (role) => {
      const allowed = ['system_admin', 'land_acquisition_manager', 'supervisor'].includes(role);
      const id = await property('withdrawn');
      const actor = users[role];
      const lam = users.land_acquisition_manager;
      const call = (sql: string, params: unknown[]) => ok(asUser(pool, actor, (db) => db.query(sql, params)));
      const expectStep = (result: { ok: boolean; code?: string }) => {
        expect(result.ok).toBe(allowed);
        if (!result.ok) expect(result.code).toBe('42501');
      };
      expectStep(await call('select * from public.start_property_stage_remediation($1)', [id]));
      if (!allowed) await asUser(pool, lam, (db) => db.query('select * from public.start_property_stage_remediation($1)', [id]));
      expectStep(await call('select * from public.escalate_property_stage_remediation($1, $2)', [id, 'Survey missing']));
      if (!allowed) await asUser(pool, lam, (db) => db.query('select * from public.escalate_property_stage_remediation($1, $2)', [id, 'x']));
      expectStep(await call('select * from public.return_property_stage_remediation_to_review($1, $2)', [id, null]));
      if (!allowed) await asUser(pool, lam, (db) => db.query('select * from public.return_property_stage_remediation_to_review($1, $2)', [id, null]));
      expectStep(
        await call('select * from public.resolve_property_stage_remediation($1, $2, $3, $4, null, null, $5)', [
          id,
          'documentation',
          'Survey decides',
          'Survey 2024',
          'withdrawn',
        ]),
      );
      if (!allowed) {
        await asUser(pool, lam, (db) =>
          db.query('select * from public.resolve_property_stage_remediation($1, $2, $3, $4, null, null, $5)', [
            id,
            'documentation',
            'Survey decides',
            'Survey 2024',
            'withdrawn',
          ]),
        );
      }
      expectStep(await call('select * from public.reopen_property_stage_remediation($1, $2)', [id, null]));
    });

    it.each(ROLES)('property creation for %s is allowed only to system admin and LAM', async (role) => {
      const created = await ok(
        asUser(pool, users[role], (db) =>
          db.query(`insert into public.properties (organization_id, project_id, property_reference) values ($1, $2, $3)`, [
            orgA,
            projectA,
            `AC-NEW-${role}-${suffix}`,
          ]),
        ),
      );
      expect(created.ok).toBe(['system_admin', 'land_acquisition_manager'].includes(role));
      if (!created.ok) expect(created.code).toBe('42501');
    });
  });

  describe('V10: stale lifecycle value vs unrelated fields (D-X1)', () => {
    it('refuses the stale stage but still saves an unrelated field from the same stale screen', async () => {
      const id = await property('documentation');
      // Another user moves the stage after this screen was loaded (it showed documentation).
      await stage(users.land_acquisition_manager, id, 'negotiation', 'documentation');
      // The unrelated field saves; the stage it did not touch keeps the newer value.
      await asUser(pool, users.supervisor, (db) => db.query('update public.properties set readiness_percent = 55 where id = $1', [id]));
      expect(await state(id)).toMatchObject({ acquisition_stage: 'negotiation' });
      expect((await admin.query('select readiness_percent from public.properties where id = $1', [id])).rows[0].readiness_percent).toBe(55);
      // The stale stage change conflicts and writes nothing.
      const before = await historyCount(id);
      expect(await ok(stage(users.supervisor, id, 'commercial_review', 'documentation'))).toEqual({ ok: false, code: '40001' });
      expect(await historyCount(id)).toBe(before);
    });
  });

  describe('V11: history and Timeline', () => {
    it('shows every successful change once, without reasons, and nothing for refusals', async () => {
      const id = await property('documentation');
      await stage(users.supervisor, id, 'owner_validation', 'documentation', 'Private reason A');
      await ok(stage(users.negotiator, id, 'identified', 'owner_validation', 'Refused backward'));
      await status(users.supervisor, id, 'withdrawn', 'active', 'Private reason B');
      await ok(status(users.supervisor, id, 'active', 'withdrawn', 'x'));
      await status(users.land_acquisition_manager, id, 'active', 'withdrawn', 'Private reason C', true);
      const entries = await asUser(pool, users.viewer, (db) => loadPropertyTimeline(db, users.viewer, id, { limit: 50, offset: 0 }));
      const lifecycle = entries.filter((entry) => entry.source_type === 'lifecycle').map((entry) => entry.summary).reverse();
      // The two creation entries share a timestamp and tie rank, so their order
      // is by (random) source id; compare them as a pair.
      expect(lifecycle.slice(0, 2).sort()).toEqual(['Acquisition stage set to Documentation', 'Acquisition status set to Active']);
      expect(lifecycle.slice(2)).toEqual([
        'Acquisition stage changed from Documentation to Owner validation',
        'Acquisition status changed from Active to Withdrawn',
        'Acquisition status changed from Withdrawn to Active (override)',
      ]);
      expect(JSON.stringify(entries)).not.toMatch(/Private reason|Refused backward/);
      expect(await historyCount(id)).toBe(5);
    });
  });

  describe('demo parity: the demo adapter gives the same outcomes as the database (system admin)', () => {
    type Step = { kind: 'stage' | 'status'; target: string; reason?: string | null; override?: boolean; expected?: 'stale' };
    const scenarios: Array<{ name: string; startStage: string; steps: Step[] }> = [
      {
        name: 'forward, backward without and with a reason, same-stage no-op, stale',
        startStage: 'identified',
        steps: [
          { kind: 'stage', target: 'documentation' },
          { kind: 'stage', target: 'initial_contact' },
          { kind: 'stage', target: 'initial_contact', reason: 'Owner details wrong' },
          { kind: 'stage', target: 'initial_contact' },
          { kind: 'stage', target: 'signing', expected: 'stale' },
          { kind: 'stage', target: 'on_hold', reason: 'x' },
        ],
      },
      {
        name: 'status matrix: completion condition, overrides, unneeded override, reversal',
        startStage: 'identified',
        steps: [
          { kind: 'status', target: 'complete' },
          { kind: 'status', target: 'complete', reason: 'x', override: true },
          { kind: 'status', target: 'active', reason: 'Reverse', override: true },
          { kind: 'status', target: 'on_hold', override: true },
          { kind: 'status', target: 'on_hold' },
          { kind: 'status', target: 'withdrawn' },
          { kind: 'status', target: 'withdrawn', reason: 'Declined' },
          { kind: 'status', target: 'active', reason: 'Back' },
          { kind: 'status', target: 'active', reason: 'Back', override: true },
          { kind: 'status', target: 'on_hold', expected: 'stale' },
        ],
      },
    ];

    it.each(scenarios)('$name', async ({ steps }) => {
      client.resetOperationsDemoState();
      const demo = await client.operationsApi.createProperty({
        organizationId: client.DEMO_ORGANIZATION_ID,
        projectId: '6c8e5a14-2b89-4d1d-a2f0-8f9b0a2f0001',
        propertyReference: `PARITY-${randomUUID().slice(0, 6)}`,
      });
      const db = await property();
      const outcomes: Array<{ step: number; demo: boolean; database: boolean; demoState: unknown; databaseState: unknown }> = [];
      for (const [index, step] of steps.entries()) {
        const demoNow = await client.operationsApi.getProperty(demo.id);
        const dbNow = await state(db);
        const field = step.kind === 'stage' ? 'acquisition_stage' : 'acquisition_status';
        const stale = step.expected === 'stale' ? (step.kind === 'stage' ? 'payment_closing' : 'complete') : null;
        const demoExpected = stale ?? demoNow[field];
        const dbExpected = stale ?? dbNow[field];
        const input =
          step.kind === 'stage'
            ? { targetStage: step.target, expectedStage: demoExpected, reason: step.reason ?? null, override: step.override ?? false }
            : { targetStatus: step.target, expectedStatus: demoExpected, reason: step.reason ?? null, override: step.override ?? false };
        const demoResult = await ok(
          step.kind === 'stage'
            ? client.operationsApi.transitionPropertyStage(demo.id, input)
            : client.operationsApi.transitionPropertyStatus(demo.id, input),
        );
        const dbResult = await ok(
          step.kind === 'stage'
            ? stage(users.system_admin, db, step.target, dbExpected, step.reason ?? null, step.override ?? false)
            : status(users.system_admin, db, step.target, dbExpected, step.reason ?? null, step.override ?? false),
        );
        const demoAfter = await client.operationsApi.getProperty(demo.id);
        outcomes.push({
          step: index,
          demo: demoResult.ok,
          database: dbResult.ok,
          demoState: [demoAfter.acquisition_stage, demoAfter.acquisition_status],
          databaseState: Object.values(await state(db)),
        });
      }
      for (const outcome of outcomes) {
        expect({ step: outcome.step, demo: outcome.demo, state: outcome.demoState }).toEqual({
          step: outcome.step,
          demo: outcome.database,
          state: outcome.databaseState,
        });
      }
    });

    it('remediation: the same steps give the same results and states', async () => {
      client.resetOperationsDemoState();
      const db = await property('withdrawn');
      const lam = users.system_admin;
      const dbCall = (sql: string, params: unknown[]) => ok(asUser(pool, lam, (database) => database.query(sql, params)));
      const steps: Array<[string, () => Promise<unknown>, () => Promise<{ ok: boolean }>]> = [
        ['escalate before start', () => client.operationsApi.escalateRemediation(DEMO_LEGACY, { reason: 'x' }), () => dbCall('select * from public.escalate_property_stage_remediation($1, $2)', [db, 'x'])],
        ['start', () => client.operationsApi.startRemediation(DEMO_LEGACY), () => dbCall('select * from public.start_property_stage_remediation($1)', [db])],
        ['escalate without reason', () => client.operationsApi.escalateRemediation(DEMO_LEGACY, { reason: ' ' }), () => dbCall('select * from public.escalate_property_stage_remediation($1, $2)', [db, ' '])],
        ['escalate', () => client.operationsApi.escalateRemediation(DEMO_LEGACY, { reason: 'Missing' }), () => dbCall('select * from public.escalate_property_stage_remediation($1, $2)', [db, 'Missing'])],
        ['return without reason', () => client.operationsApi.returnRemediationToReview(DEMO_LEGACY, {}), () => dbCall('select * from public.return_property_stage_remediation_to_review($1, $2)', [db, null])],
        [
          'resolve without evidence',
          () => client.operationsApi.resolveRemediation(DEMO_LEGACY, { resultingStage: 'documentation', expectedStage: 'withdrawn', reason: 'r', evidence: ' ' }),
          () => dbCall('select * from public.resolve_property_stage_remediation($1, $2, $3, $4, null, null, $5)', [db, 'documentation', 'r', ' ', 'withdrawn']),
        ],
        [
          'resolve to a legacy stage',
          () => client.operationsApi.resolveRemediation(DEMO_LEGACY, { resultingStage: 'on_hold', expectedStage: 'withdrawn', reason: 'r', evidence: 'e' }),
          () => dbCall('select * from public.resolve_property_stage_remediation($1, $2, $3, $4, null, null, $5)', [db, 'on_hold', 'r', 'e', 'withdrawn']),
        ],
        [
          'resolve with a stale stage',
          () => client.operationsApi.resolveRemediation(DEMO_LEGACY, { resultingStage: 'documentation', expectedStage: 'on_hold', reason: 'r', evidence: 'e' }),
          () => dbCall('select * from public.resolve_property_stage_remediation($1, $2, $3, $4, null, null, $5)', [db, 'documentation', 'r', 'e', 'on_hold']),
        ],
        [
          'resolve',
          () => client.operationsApi.resolveRemediation(DEMO_LEGACY, { resultingStage: 'documentation', expectedStage: 'withdrawn', reason: 'r', evidence: 'e' }),
          () => dbCall('select * from public.resolve_property_stage_remediation($1, $2, $3, $4, null, null, $5)', [db, 'documentation', 'r', 'e', 'withdrawn']),
        ],
        ['reopen without reason', () => client.operationsApi.reopenRemediation(DEMO_LEGACY, {}), () => dbCall('select * from public.reopen_property_stage_remediation($1, $2)', [db, null])],
      ];
      for (const [name, demoStep, dbStep] of steps) {
        const demoResult = await ok(demoStep());
        const dbResult = await dbStep();
        expect({ name, ok: demoResult.ok }).toEqual({ name, ok: dbResult.ok });
      }
      const demoCycles = (await client.operationsApi.listPropertyRemediations(DEMO_LEGACY)).map((cycle) => [cycle.cycle, cycle.state]);
      const dbCycles = (await admin.query('select cycle, state from public.property_stage_remediations where property_id = $1 order by cycle', [db])).rows.map(
        (row) => [row.cycle, row.state],
      );
      expect(demoCycles).toEqual(dbCycles);
      expect((await client.operationsApi.getProperty(DEMO_LEGACY)).acquisition_stage).toBe((await state(db)).acquisition_stage);
    });
  });
});
