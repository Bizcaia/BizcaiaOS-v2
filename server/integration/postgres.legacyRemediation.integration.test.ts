import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';
import { loadPropertyTimeline, loadRemediationQueue } from '../operationsRoutes.js';
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
const LEGACY_STAGES = ['on_hold', 'withdrawn', 'acquisition_complete'] as const;

type Cycle = {
  id: string;
  cycle: number;
  legacy_value: string;
  stage_at_open: string;
  state: string;
  opened_by_user_id: string;
  resolved_by_user_id: string | null;
  resulting_stage: string | null;
  resolution_reason: string | null;
  evidence: string | null;
  evidence_document_id: string | null;
  evidence_interaction_id: string | null;
};

describe('PostgreSQL legacy stage remediation (L-06)', () => {
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
    supervisor: () => supervisorScoped,
    lam: () => lamA,
    admin: () => adminA,
    negotiator: () => negotiatorAssigned,
    legal: () => legalA,
    finance: () => financeA,
    viewer: () => viewerA,
  };

  /** A property already on a legacy value: a fixture, since no application path creates one. */
  const legacyProperty = (legacy: string = 'withdrawn') =>
    insertPropertyFixture(
      lamA,
      `insert into public.properties (
          organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id, assigned_manager_id
        ) values ($1, $2, $3, $4, $5, $6) returning id`,
      [orgA, projectA, `LR-${randomUUID().slice(0, 8)}-${suffix}`, legacy, negotiatorAssigned, supervisorScoped],
    );

  const call = (actor: string, sql: string, params: unknown[]) =>
    asUser(pool, actor, async (client) => (await client.query<Cycle>(sql, params)).rows[0]);

  const start = (actor: string, property: string) => call(actor, 'select * from public.start_property_stage_remediation($1)', [property]);
  const escalate = (actor: string, property: string, reason: string | null) =>
    call(actor, 'select * from public.escalate_property_stage_remediation($1, $2)', [property, reason]);
  const returnToReview = (actor: string, property: string, reason: string | null) =>
    call(actor, 'select * from public.return_property_stage_remediation_to_review($1, $2)', [property, reason]);
  const reopen = (actor: string, property: string, reason: string | null) =>
    call(actor, 'select * from public.reopen_property_stage_remediation($1, $2)', [property, reason]);
  const resolve = (
    actor: string,
    property: string,
    stage: string,
    reason: string | null,
    evidence: string | null,
    documentId: string | null = null,
    interactionId: string | null = null,
  ) =>
    call(actor, 'select * from public.resolve_property_stage_remediation($1, $2, $3, $4, $5, $6)', [
      property,
      stage,
      reason,
      evidence,
      documentId,
      interactionId,
    ]);

  /** Everything a remediation step may touch, read by the owner connection. */
  const snapshot = async (property: string) => {
    const one = async (sql: string) => (await admin.query(sql, [property])).rows;
    return {
      property: await one('select acquisition_stage, acquisition_status from public.properties where id = $1'),
      cycles: await one('select * from public.property_stage_remediations where property_id = $1 order by cycle'),
      events: await one('select * from public.property_stage_remediation_events where property_id = $1 order by occurred_at, id'),
      history: await one('select * from public.property_lifecycle_history where property_id = $1 order by changed_at, id'),
    };
  };

  /** Expects a refusal that leaves property, remediation, events, and history untouched. */
  async function expectRefused(operation: () => Promise<unknown>, code: string, property: string) {
    const before = await snapshot(property);
    await expectSqlError(operation, code);
    expect(await snapshot(property)).toEqual(before);
  }

  const cycles = async (property: string) =>
    (await admin.query<Cycle>('select * from public.property_stage_remediations where property_id = $1 order by cycle', [property])).rows;

  const events = async (property: string) =>
    (
      await admin.query(
        `select e.action, e.from_state, e.to_state, e.reason, e.actor_user_id, r.cycle
           from public.property_stage_remediation_events e
           join public.property_stage_remediations r on r.id = e.remediation_id
          where e.property_id = $1 order by e.occurred_at, e.id`,
        [property],
      )
    ).rows;

  const stageHistory = async (property: string) =>
    (
      await admin.query(
        `select from_value, to_value, reason, actor_user_id, is_override, remediation_id
           from public.property_lifecycle_history
          where property_id = $1 and field = 'acquisition_stage' and from_value is not null
          order by changed_at, id`,
        [property],
      )
    ).rows;

  const state = async (property: string) =>
    (await admin.query('select acquisition_stage, acquisition_status from public.properties where id = $1', [property])).rows[0];

  const insertDocument = (property: string) =>
    asUser(pool, lamA, async (client) =>
      (
        await client.query<{ id: string }>(
          `insert into public.documents (
              organization_id, property_id, category, title, original_filename, content_type, size_bytes, storage_key, uploaded_by_user_id
            ) values ($1, $2, 'title_deed', 'Deed copy', 'deed.pdf', 'application/pdf', 1024, $3, $4) returning id`,
          [orgA, property, `remediation/${randomUUID()}.pdf`, lamA],
        )
      ).rows[0].id,
    );

  const insertInteraction = (property: string) =>
    asUser(pool, lamA, async (client) =>
      (
        await client.query<{ id: string }>(
          `insert into public.interactions (organization_id, property_id, interaction_type, notes, recorded_by_user_id)
           values ($1, $2, 'call', 'Owner confirmed the survey status', $3) returning id`,
          [orgA, property, lamA],
        )
      ).rows[0].id,
    );

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    const { default: pgModule } = await import('pg');
    admin = new pgModule.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    // Re-apply 017 under the migration advisory lock so function text always
    // matches the repo. properties, then the history table (017 alters it), are
    // locked first, so re-applying never upgrades a lock mid-transaction and
    // cannot deadlock with parallel suites.
    try {
      await admin.query('select pg_advisory_lock(87236401)');
      await admin.query('begin');
      try {
        await admin.query('lock table public.properties in access exclusive mode');
        await admin.query('lock table public.property_lifecycle_history in access exclusive mode');
        // 017 and 018, which replaces 017's resolve function (L-07).
        for (const file of ['017_legacy_stage_remediation.sql', '018_lifecycle_optimistic_concurrency.sql']) {
          await admin.query(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', file), 'utf8'));
        }
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

    const orgOne = await bootstrapOrg(pool, `Lr North ${suffix}`, `lr-north-${suffix}`, `auth0|lr-admin-a-${suffix}`, 'Lr Admin A', `lr-admin-a-${suffix}@example.com`);
    const orgTwo = await bootstrapOrg(pool, `Lr South ${suffix}`, `lr-south-${suffix}`, `auth0|lr-admin-b-${suffix}`, 'Lr Admin B', `lr-admin-b-${suffix}@example.com`);
    orgA = orgOne.organization_id;
    adminA = orgOne.user_id;
    adminB = orgTwo.user_id;

    const user = (key: string, name: string) => syncUser(pool, `auth0|lr-${key}-${suffix}`, name, `lr-${key}-${suffix}@example.com`);
    lamA = await user('lam', 'Lr LAM');
    legalA = await user('legal', 'Lr Legal');
    financeA = await user('finance', 'Lr Finance');
    viewerA = await user('viewer', 'Lr Viewer');
    supervisorScoped = await user('sup-scoped', 'Lr Supervisor Scoped');
    supervisorOther = await user('sup-other', 'Lr Supervisor Other');
    negotiatorAssigned = await user('neg-assigned', 'Lr Negotiator Assigned');
    negotiatorOther = await user('neg-other', 'Lr Negotiator Other');
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
        `insert into public.projects (organization_id, code, name, status) values ($1, 'LR-01', 'Remediation Program', 'active') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
  }, 60_000);

  afterAll(async () => {
    await admin?.end();
    await pool.end();
  });

  describe('authority (N-1 legacy remediation)', () => {
    it.each([['supervisor'], ['lam'], ['admin']] as const)('lets %s run the whole workflow', async (key) => {
      const property = await legacyProperty();
      const actor = role[key]();
      expect(await start(actor, property)).toMatchObject({ state: 'UNDER_REVIEW', cycle: 1, opened_by_user_id: actor });
      await escalate(actor, property, 'Survey records missing');
      await returnToReview(actor, property, 'Survey records found');
      expect(await resolve(actor, property, 'documentation', 'Survey confirms documentation', 'Survey report 2024-11')).toMatchObject({
        state: 'RESOLVED',
        resolved_by_user_id: actor,
      });
      expect(await reopen(actor, property, 'Owner disputes the survey')).toMatchObject({ state: 'UNDER_REVIEW', cycle: 2 });
    });

    it.each([['negotiator'], ['legal'], ['finance'], ['viewer']] as const)('refuses %s every step with 42501', async (key) => {
      const property = await legacyProperty();
      await expectRefused(() => start(role[key](), property), '42501', property);
      await start(lamA, property);
      await expectRefused(() => escalate(role[key](), property, 'A reason'), '42501', property);
      await expectRefused(() => resolve(role[key](), property, 'documentation', 'A reason', 'Evidence'), '42501', property);
      await escalate(lamA, property, 'A reason');
      await expectRefused(() => returnToReview(role[key](), property, 'A reason'), '42501', property);
      await returnToReview(lamA, property, 'A reason');
      await resolve(lamA, property, 'documentation', 'A reason', 'Evidence');
      await expectRefused(() => reopen(role[key](), property, 'A reason'), '42501', property);
    });

    it.each([
      ['a supervisor not managing the property', () => supervisorOther],
      ['a negotiator not assigned to the property', () => negotiatorOther],
      ['another organization', () => adminB],
    ])('reports the property as not found (P0002) to %s', async (_label, actor) => {
      const property = await legacyProperty();
      await expectRefused(() => start(actor(), property), 'P0002', property);
      await start(lamA, property);
      await expectRefused(() => resolve(actor(), property, 'documentation', 'A reason', 'Evidence'), 'P0002', property);
    });

    it('reports an unknown property as not found', async () => {
      await expectSqlError(() => start(adminA, randomUUID()), 'P0002');
    });
  });

  describe.each(LEGACY_STAGES)('legacy value %s', (legacy) => {
    it('is never converted by the ordinary paths', async () => {
      const property = await legacyProperty(legacy);
      await expectRefused(
        () => asUser(pool, adminA, (client) => client.query('select * from public.transition_property_stage($1, $2, $3)', [property, 'documentation', 'A reason'])),
        '22023',
        property,
      );
      await expectRefused(
        () => asUser(pool, adminA, (client) => client.query(`update public.properties set acquisition_stage = 'documentation' where id = $1`, [property])),
        '42501',
        property,
      );
      await expectRefused(
        () =>
          asUser(pool, adminA, async (client) => {
            await client.query("select set_config('app.stage_transition_property', $1, true)", [property]);
            await client.query("select set_config('app.lifecycle_stage_override_rules', 'negotiation_unresolved_exit', true)");
            await client.query(`update public.properties set acquisition_stage = 'documentation' where id = $1`, [property]);
          }),
        '42501',
        property,
      );
    });

    it('is resolved through review, escalation, return to review, and resolution, keeping status and the original value on record', async () => {
      const property = await legacyProperty(legacy);
      await asUser(pool, lamA, (client) => client.query('select * from public.transition_property_status($1, $2)', [property, 'on_hold']));

      expect(await start(supervisorScoped, property)).toMatchObject({
        cycle: 1,
        legacy_value: legacy,
        stage_at_open: legacy,
        state: 'UNDER_REVIEW',
      });
      // R-8: insufficient evidence escalates; nothing is inferred or converted.
      expect(await escalate(supervisorScoped, property, ' Insufficient evidence ')).toMatchObject({ state: 'REQUIRES_ESCALATION' });
      expect(await state(property)).toEqual({ acquisition_stage: legacy, acquisition_status: 'on_hold' });
      await expectRefused(() => resolve(lamA, property, 'documentation', 'A reason', 'Evidence'), '22023', property);
      expect(await returnToReview(lamA, property, 'Archive retrieved')).toMatchObject({ state: 'UNDER_REVIEW' });

      const resolved = await resolve(lamA, property, 'legal_review', '  Title review is under way \n', '\t Legal memo LM-17  ');
      expect(resolved).toMatchObject({
        state: 'RESOLVED',
        resulting_stage: 'legal_review',
        resolution_reason: 'Title review is under way',
        evidence: 'Legal memo LM-17',
        resolved_by_user_id: lamA,
      });
      expect(await state(property)).toEqual({ acquisition_stage: 'legal_review', acquisition_status: 'on_hold' });
      expect(await stageHistory(property)).toEqual([
        {
          from_value: legacy,
          to_value: 'legal_review',
          reason: 'Title review is under way',
          actor_user_id: lamA,
          is_override: false,
          remediation_id: resolved.id,
        },
      ]);
      expect(await events(property)).toEqual([
        { action: 'review_started', from_state: 'NOT_REVIEWED', to_state: 'UNDER_REVIEW', reason: null, actor_user_id: supervisorScoped, cycle: 1 },
        { action: 'escalated', from_state: 'UNDER_REVIEW', to_state: 'REQUIRES_ESCALATION', reason: 'Insufficient evidence', actor_user_id: supervisorScoped, cycle: 1 },
        { action: 'returned_to_review', from_state: 'REQUIRES_ESCALATION', to_state: 'UNDER_REVIEW', reason: 'Archive retrieved', actor_user_id: lamA, cycle: 1 },
        { action: 'resolved', from_state: 'UNDER_REVIEW', to_state: 'RESOLVED', reason: 'Title review is under way', actor_user_id: lamA, cycle: 1 },
      ]);
    });
  });

  describe('Q-1: reason and supporting evidence', () => {
    it('refuses a resolution without a real reason or without real evidence, changing nothing', async () => {
      const property = await legacyProperty('acquisition_complete');
      await start(lamA, property);
      for (const reason of [null, '', '   ', ' \t\n ']) {
        await expectRefused(() => resolve(lamA, property, 'payment_closing', reason, 'Closing statement'), '22023', property);
      }
      for (const evidence of [null, '', '   ', ' \t\n ']) {
        await expectRefused(() => resolve(lamA, property, 'payment_closing', 'Closing confirmed', evidence), '22023', property);
      }
      await resolve(lamA, property, 'payment_closing', 'Closing confirmed', 'Closing statement CS-9');
      expect((await cycles(property))[0]).toMatchObject({ state: 'RESOLVED', resulting_stage: 'payment_closing' });
    });

    it('does not accept a document or interaction reference in place of the evidence text', async () => {
      const property = await legacyProperty();
      await start(lamA, property);
      const document = await insertDocument(property);
      await expectRefused(() => resolve(lamA, property, 'documentation', 'A reason', null, document), '22023', property);
    });

    it('Q-3: requires a reason to escalate, and stores it trimmed', async () => {
      const property = await legacyProperty();
      await start(lamA, property);
      for (const reason of [null, '', '  ', ' \t\n ']) await expectRefused(() => escalate(lamA, property, reason), '22023', property);
      expect(await escalate(lamA, property, '  Missing records \n')).toMatchObject({ state: 'REQUIRES_ESCALATION' });
      expect((await events(property)).at(-1)).toMatchObject({ action: 'escalated', reason: 'Missing records' });
      expect((await state(property)).acquisition_stage).toBe('withdrawn');
    });

    it('Q-4: returns to review with or without a reason, storing a given one trimmed and needing no evidence', async () => {
      const property = await legacyProperty();
      await start(lamA, property);
      for (const reason of [null, '', '   ']) {
        await escalate(lamA, property, 'Missing records');
        expect(await returnToReview(lamA, property, reason)).toMatchObject({ state: 'UNDER_REVIEW' });
        expect((await events(property)).at(-1)).toMatchObject({ action: 'returned_to_review', reason: null });
      }
      await escalate(lamA, property, 'Missing records');
      await returnToReview(supervisorScoped, property, ' Records found \t');
      expect((await events(property)).at(-1)).toMatchObject({ action: 'returned_to_review', reason: 'Records found', actor_user_id: supervisorScoped });
      expect((await cycles(property))).toHaveLength(1);
    });

    it('Q-5: reopens with or without a reason, storing a given one trimmed and needing no evidence', async () => {
      const withoutReason = await legacyProperty();
      await start(lamA, withoutReason);
      await resolve(lamA, withoutReason, 'documentation', 'A reason', 'Evidence');
      expect(await reopen(lamA, withoutReason, null)).toMatchObject({ cycle: 2, state: 'UNDER_REVIEW', evidence: null });
      expect((await events(withoutReason)).at(-1)).toMatchObject({ action: 'reopened', reason: null, cycle: 2 });

      const blankReason = await legacyProperty();
      await start(lamA, blankReason);
      await resolve(lamA, blankReason, 'documentation', 'A reason', 'Evidence');
      await reopen(lamA, blankReason, '   ');
      expect((await events(blankReason)).at(-1)).toMatchObject({ action: 'reopened', reason: null, cycle: 2 });

      const withReason = await legacyProperty();
      await start(lamA, withReason);
      await resolve(lamA, withReason, 'documentation', 'A reason', 'Evidence');
      await reopen(lamA, withReason, '\n Owner disputes the survey ');
      expect((await events(withReason)).at(-1)).toMatchObject({ action: 'reopened', reason: 'Owner disputes the survey', cycle: 2 });
    });
  });

  describe('evidence references', () => {
    it('accepts a document of the same property', async () => {
      const property = await legacyProperty();
      const document = await insertDocument(property);
      await start(lamA, property);
      expect(await resolve(lamA, property, 'documentation', 'Deed reviewed', 'Deed copy on file', document)).toMatchObject({
        evidence_document_id: document,
        evidence_interaction_id: null,
      });
    });

    it('accepts an interaction of the same property', async () => {
      const property = await legacyProperty();
      const interaction = await insertInteraction(property);
      await start(lamA, property);
      expect(await resolve(lamA, property, 'documentation', 'Owner call', 'Call notes on file', null, interaction)).toMatchObject({
        evidence_document_id: null,
        evidence_interaction_id: interaction,
      });
    });

    it('refuses references to another property, unknown records, or both kinds at once', async () => {
      const property = await legacyProperty();
      const other = await legacyProperty();
      const otherDocument = await insertDocument(other);
      const otherInteraction = await insertInteraction(other);
      const document = await insertDocument(property);
      const interaction = await insertInteraction(property);
      await start(lamA, property);
      await expectRefused(() => resolve(lamA, property, 'documentation', 'A reason', 'Evidence', otherDocument), '22023', property);
      await expectRefused(() => resolve(lamA, property, 'documentation', 'A reason', 'Evidence', null, otherInteraction), '22023', property);
      await expectRefused(() => resolve(lamA, property, 'documentation', 'A reason', 'Evidence', randomUUID()), '22023', property);
      await expectRefused(() => resolve(lamA, property, 'documentation', 'A reason', 'Evidence', document, interaction), '22023', property);
    });
  });

  describe('integrity (P-12)', () => {
    it('refuses a legacy value as the corrected stage', async () => {
      const property = await legacyProperty('on_hold');
      await start(lamA, property);
      for (const stage of LEGACY_STAGES) {
        await expectRefused(() => resolve(lamA, property, stage, 'A reason', 'Evidence'), '22023', property);
      }
    });

    it('applies the negotiation hard block and never touches the negotiation', async () => {
      // A negotiation opened while the property was in negotiation, before the
      // stage was set to a legacy value outside the controlled paths.
      const property = await insertPropertyFixture(
        lamA,
        `insert into public.properties (organization_id, project_id, property_reference, acquisition_stage)
         values ($1, $2, $3, 'negotiation') returning id`,
        [orgA, projectA, `LR-NEG-${suffix}`],
      );
      const negotiation = await asUser(pool, lamA, async (client) =>
        (
          await client.query<{ id: string }>(
            `insert into public.negotiations (organization_id, property_id, status) values ($1, $2, 'open') returning id`,
            [orgA, property],
          )
        ).rows[0].id,
      );
      await admin.query('begin');
      await admin.query("select set_config('app.user_id', $1, true)", [lamA]);
      await admin.query("select set_config('app.stage_transition_property', $1, true)", [property]);
      await admin.query(`update public.properties set acquisition_stage = 'withdrawn' where id = $1`, [property]);
      await admin.query('commit');
      const negotiationBefore = (await admin.query('select to_jsonb(n) as row from public.negotiations n where id = $1', [negotiation])).rows[0].row;

      await start(lamA, property);
      await expectRefused(() => resolve(lamA, property, 'commercial_review', 'A reason', 'Evidence'), '22023', property);
      await resolve(lamA, property, 'negotiation', 'Negotiation still running', 'Negotiation file');
      expect((await state(property)).acquisition_stage).toBe('negotiation');
      expect((await admin.query('select to_jsonb(n) as row from public.negotiations n where id = $1', [negotiation])).rows[0].row).toEqual(
        negotiationBefore,
      );
    });
  });

  describe('state machine', () => {
    it('refuses steps out of order', async () => {
      const property = await legacyProperty();
      await expectRefused(() => escalate(lamA, property, 'A reason'), '22023', property);
      await expectRefused(() => resolve(lamA, property, 'documentation', 'A reason', 'Evidence'), '22023', property);
      await expectRefused(() => reopen(lamA, property, 'A reason'), '22023', property);
      await start(lamA, property);
      await expectRefused(() => start(lamA, property), '22023', property);
      await expectRefused(() => returnToReview(lamA, property, 'A reason'), '22023', property);
      await expectRefused(() => reopen(lamA, property, 'A reason'), '22023', property);
      await resolve(lamA, property, 'documentation', 'A reason', 'Evidence');
      await expectRefused(() => escalate(lamA, property, 'A reason'), '22023', property);
      await expectRefused(() => start(lamA, property), '22023', property);
    });

    it('refuses to start a review on a property that is not on a legacy value', async () => {
      const property = await insertPropertyFixture(
        lamA,
        `insert into public.properties (organization_id, project_id, property_reference, acquisition_stage) values ($1, $2, $3, 'signing') returning id`,
        [orgA, projectA, `LR-NORMAL-${suffix}`],
      );
      await expectRefused(() => start(lamA, property), '22023', property);
    });
  });

  describe('reopen and new cycle (R-7)', () => {
    it('opens a new cycle, keeps the resolved one unchanged, and requires reason and evidence again', async () => {
      const property = await legacyProperty('withdrawn');
      await start(lamA, property);
      const first = await resolve(lamA, property, 'documentation', 'First decision', 'First evidence');
      const firstRow = (await cycles(property))[0];

      const reopened = await reopen(supervisorScoped, property, 'Owner produced a newer survey');
      expect(reopened).toMatchObject({
        cycle: 2,
        legacy_value: 'withdrawn',
        stage_at_open: 'documentation',
        state: 'UNDER_REVIEW',
        opened_by_user_id: supervisorScoped,
      });
      expect((await cycles(property))[0]).toEqual(firstRow);

      for (const reason of [null, ' ']) {
        await expectRefused(() => resolve(lamA, property, 'property_validation', reason, 'Newer survey'), '22023', property);
      }
      for (const evidence of [null, ' ']) {
        await expectRefused(() => resolve(lamA, property, 'property_validation', 'Newer survey decides', evidence), '22023', property);
      }
      const second = await resolve(lamA, property, 'property_validation', 'Newer survey decides', 'Survey 2025-02');
      expect(second).toMatchObject({ cycle: 2, state: 'RESOLVED', resulting_stage: 'property_validation' });
      expect((await cycles(property))[0]).toEqual(firstRow);
      expect((await stageHistory(property)).map((row) => [row.from_value, row.to_value, row.remediation_id])).toEqual([
        ['withdrawn', 'documentation', first.id],
        ['documentation', 'property_validation', second.id],
      ]);
      expect((await events(property)).map((event) => [event.cycle, event.action])).toEqual([
        [1, 'review_started'],
        [1, 'resolved'],
        [2, 'reopened'],
        [2, 'resolved'],
      ]);
    });

    it('can confirm the current stage in a reopened cycle without a stage change', async () => {
      const property = await legacyProperty('on_hold');
      await start(lamA, property);
      await resolve(lamA, property, 'identified', 'A reason', 'Evidence');
      await reopen(lamA, property, 'Second look');
      const confirmed = await resolve(lamA, property, 'identified', 'Stage confirmed', 'Evidence re-checked');
      expect(confirmed).toMatchObject({ cycle: 2, state: 'RESOLVED', resulting_stage: 'identified' });
      expect(await stageHistory(property)).toHaveLength(1);
    });
  });

  describe('records are protected', () => {
    it('refuses direct writes to remediation records from the application, and changes to resolved cycles from anyone', async () => {
      const property = await legacyProperty();
      await start(lamA, property);
      await expectRefused(
        () =>
          asUser(pool, adminA, (client) =>
            client.query(
              `insert into public.property_stage_remediations (organization_id, property_id, cycle, legacy_value, stage_at_open, state, opened_by_user_id)
               values ($1, $2, 9, 'withdrawn', 'withdrawn', 'UNDER_REVIEW', $3)`,
              [orgA, property, adminA],
            ),
          ),
        '42501',
        property,
      );
      const updated = await asUser(pool, adminA, async (client) =>
        (await client.query(`update public.property_stage_remediations set state = 'RESOLVED' where property_id = $1`, [property])).rowCount,
      );
      expect(updated).toBe(0);
      await expectRefused(
        () =>
          asUser(pool, adminA, (client) =>
            client.query(
              `insert into public.property_stage_remediation_events (organization_id, property_id, remediation_id, action, to_state, actor_user_id)
               select organization_id, property_id, id, 'resolved', 'RESOLVED', $2 from public.property_stage_remediations where property_id = $1`,
              [property, adminA],
            ),
          ),
        '42501',
        property,
      );
      await resolve(lamA, property, 'documentation', 'A reason', 'Evidence');
      await expectSqlError(() => admin.query(`update public.property_stage_remediations set evidence = 'x' where property_id = $1`, [property]), '42501');
      await expectSqlError(() => admin.query('delete from public.property_stage_remediation_events where property_id = $1', [property]), '42501');
    });

    it('does not record a spoofed override on a resolution, nor link a later ordinary transition to the cycle', async () => {
      const property = await legacyProperty();
      await start(lamA, property);
      await asUser(pool, lamA, async (client) => {
        await client.query("select set_config('app.lifecycle_stage_override_rules', 'negotiation_unresolved_exit', true)");
        await client.query('select * from public.resolve_property_stage_remediation($1, $2, $3, $4)', [property, 'documentation', 'A reason', 'Evidence']);
      });
      await asUser(pool, lamA, (client) => client.query('select * from public.transition_property_stage($1, $2)', [property, 'negotiation']));
      const rows = await stageHistory(property);
      expect(rows.map((row) => [row.to_value, row.is_override, row.remediation_id !== null])).toEqual([
        ['documentation', false, true],
        ['negotiation', false, false],
      ]);
    });
  });

  describe('visibility of records and the queue', () => {
    it('shows cycles and events wherever the property is visible, and nowhere else', async () => {
      const property = await legacyProperty();
      await start(lamA, property);
      const seen = (actor: string) =>
        asUser(pool, actor, async (client) => ({
          cycles: (await client.query('select id from public.property_stage_remediations where property_id = $1', [property])).rowCount,
          events: (await client.query('select id from public.property_stage_remediation_events where property_id = $1', [property])).rowCount,
        }));
      for (const actor of [adminA, lamA, supervisorScoped, negotiatorAssigned, legalA, financeA, viewerA]) {
        expect(await seen(actor)).toEqual({ cycles: 1, events: 1 });
      }
      for (const actor of [supervisorOther, negotiatorOther, adminB]) {
        expect(await seen(actor)).toEqual({ cycles: 0, events: 0 });
      }
    });

    it('lists legacy properties as NOT_REVIEWED, then by the state of their latest cycle, and drops them once resolved', async () => {
      const notReviewed = await legacyProperty('on_hold');
      const underReview = await legacyProperty('withdrawn');
      const escalated = await legacyProperty('acquisition_complete');
      const resolved = await legacyProperty('withdrawn');
      await start(lamA, underReview);
      await start(lamA, escalated);
      await escalate(lamA, escalated, 'Missing records');
      await start(lamA, resolved);
      await resolve(lamA, resolved, 'documentation', 'A reason', 'Evidence');

      const queue = await asUser(pool, lamA, (client) => loadRemediationQueue(client, orgA));
      const byProperty = new Map(queue.map((row) => [row.property_id, row.state]));
      expect(byProperty.get(notReviewed)).toBe('NOT_REVIEWED');
      expect(byProperty.get(underReview)).toBe('UNDER_REVIEW');
      expect(byProperty.get(escalated)).toBe('REQUIRES_ESCALATION');
      expect(byProperty.has(resolved)).toBe(false);

      const otherTenant = await asUser(pool, adminB, (client) => loadRemediationQueue(client, orgA));
      expect(otherTenant).toEqual([]);
    });
  });

  describe('timeline', () => {
    it('shows a resolution as a legacy remediation, without the reason or evidence', async () => {
      const property = await legacyProperty('withdrawn');
      await start(lamA, property);
      await resolve(lamA, property, 'documentation', 'Confidential settlement note', 'Private ledger entry');
      const entries = await asUser(pool, viewerA, (client) => loadPropertyTimeline(client, viewerA, property, { limit: 50, offset: 0 }));
      expect(entries.filter((entry) => entry.kind === 'stage_changed').map((entry) => entry.summary)).toEqual([
        'Acquisition stage changed from Withdrawn to Documentation (legacy remediation)',
        'Acquisition stage set to Withdrawn',
      ]);
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toContain('Confidential settlement note');
      expect(serialized).not.toContain('Private ledger entry');
    });
  });
});
