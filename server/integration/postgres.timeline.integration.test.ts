import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';
import { loadPropertyTimeline, type TimelineEntry } from '../operationsRoutes.js';
import { propertyTimelineQuerySchema } from '../operationsSchemas.js';
import {
  addMember,
  asUser,
  bootstrapOrg,
  createAppPool,
  expectSqlError,
  requireDatabaseEnv,
  syncUser,
} from './postgresHarness.js';

const suffix = randomUUID().slice(0, 8);

describe('PostgreSQL property timeline', () => {
  const pool = createAppPool();
  let orgA: string;
  let orgB: string;
  let orgC: string;
  let adminA: string;
  let adminB: string;
  let adminC: string;
  let lamA: string;
  let legalA: string;
  let financeA: string;
  let viewerA: string;
  let supervisorScoped: string;
  let supervisorOther: string;
  let negotiatorAssigned: string;
  let negotiatorUnassigned: string;
  let negotiationOnly: string;
  let departedLegal: string;
  let projectA: string;
  let propertyA: string;
  let propertyHidden: string;
  let propertyPay: string;
  let propertyArch: string;
  let propertyTime: string;
  let propertyPage: string;
  let propertyB: string;
  let propertyC: string;
  let today: string;
  let tomorrow: string;
  const ids: Record<string, string> = {};

  function timeline(actor: string, propertyId: string, page: Partial<{ limit: number; offset: number }> = {}) {
    return asUser(pool, actor, (client) =>
      loadPropertyTimeline(client, actor, propertyId, { limit: page.limit ?? 50, offset: page.offset ?? 0 }),
    );
  }

  async function expectNotFound(operation: () => Promise<unknown>) {
    await expect(operation()).rejects.toMatchObject({ status: 404 });
  }

  function insertOne(actor: string, sql: string, params: unknown[]) {
    return asUser(pool, actor, async (client) => (await client.query<{ id: string }>(sql, params)).rows[0].id);
  }

  function insertProperty(reference: string, stage: string, negotiator: string | null = null, manager: string | null = null) {
    return insertOne(
      lamA,
      `insert into public.properties (
          organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id, assigned_manager_id
        ) values ($1, $2, $3, $4, $5, $6) returning id`,
      [orgA, projectA, `${reference}-${suffix}`, stage, negotiator, manager],
    );
  }

  function insertDocument(
    actor: string,
    propertyId: string,
    category: string,
    title: string,
    createdAt: string,
    organizationId = orgA,
  ) {
    return insertOne(
      actor,
      `insert into public.documents (
          organization_id, property_id, category, title, original_filename,
          content_type, size_bytes, storage_key, uploaded_by_user_id, created_at
        ) values ($1,$2,$3,$4,'file.pdf','application/pdf',1024,$5,$6,$7) returning id`,
      [organizationId, propertyId, category, title, `timeline/${randomUUID()}.pdf`, actor, createdAt],
    );
  }

  function insertTask(propertyId: string, title: string, createdAt: string, id: string = randomUUID(), dueOn: string | null = null) {
    return insertOne(
      lamA,
      `insert into public.tasks (id, organization_id, property_id, title, due_on, created_by_user_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [id, orgA, propertyId, title, dueOn, lamA, createdAt],
    );
  }

  function insertPayment(
    propertyId: string,
    status: string,
    paidOn: string | null,
    createdAt: string,
    amount = 500000,
    paymentType = 'deposit',
  ) {
    return insertOne(
      financeA,
      `insert into public.payments (
          organization_id, property_id, amount, payment_type, status, scheduled_on, paid_on, recorded_by_user_id, created_at
        ) values ($1, $2, $3, $4, $5, '2026-01-01', $6, $7, $8) returning id`,
      [orgA, propertyId, amount, paymentType, status, paidOn, financeA, createdAt],
    );
  }

  async function insertLinkedOwner(actor: string, organizationId: string, propertyId: string, name: string) {
    const ownerId = await insertOne(
      actor,
      `insert into public.owners (organization_id, owner_type, display_name) values ($1, 'individual', $2) returning id`,
      [organizationId, name],
    );
    await asUser(pool, actor, (client) =>
      client.query(`insert into public.property_owners (property_id, owner_id) values ($1, $2)`, [propertyId, ownerId]),
    );
    return ownerId;
  }

  function insertSignature(
    actor: string,
    propertyId: string,
    documentId: string,
    ownerId: string,
    signedOn: string,
    organizationId = orgA,
  ) {
    return insertOne(
      actor,
      `insert into public.agreement_signatures (
          organization_id, property_id, document_id, owner_id, signed_on, recorded_by_user_id
        ) values ($1,$2,$3,$4,$5,$6) returning id`,
      [organizationId, propertyId, documentId, ownerId, signedOn, actor],
    );
  }

  function insertNegotiation(propertyId: string, createdAt: string, negotiator: string | null, openingAmount: number | null = null) {
    return insertOne(
      lamA,
      `insert into public.negotiations (organization_id, property_id, assigned_negotiator_id, opening_amount, created_at)
       values ($1, $2, $3, $4, $5) returning id`,
      [orgA, propertyId, negotiator, openingAmount, createdAt],
    );
  }

  function insertEvent(negotiationId: string, eventType: string, amount: number | null, occurredAt: string, note: string | null = null) {
    return insertOne(
      lamA,
      `insert into public.negotiation_events (organization_id, negotiation_id, event_type, amount, actor_user_id, contextual_note, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [orgA, negotiationId, eventType, amount, lamA, note, occurredAt],
    );
  }

  const kindsFor = (entries: TimelineEntry[], sourceId: string) =>
    entries.filter((entry) => entry.source_id === sourceId).map((entry) => entry.kind).sort();

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();

    const orgOne = await bootstrapOrg(pool, `Tl North ${suffix}`, `tl-north-${suffix}`, `auth0|tl-admin-a-${suffix}`, 'Tl Admin A', `tl-admin-a-${suffix}@example.com`);
    const orgTwo = await bootstrapOrg(pool, `Tl South ${suffix}`, `tl-south-${suffix}`, `auth0|tl-admin-b-${suffix}`, 'Tl Admin B', `tl-admin-b-${suffix}@example.com`);
    const orgThree = await bootstrapOrg(pool, `Tl Zone ${suffix}`, `tl-zone-${suffix}`, `auth0|tl-admin-c-${suffix}`, 'Tl Admin C', `tl-admin-c-${suffix}@example.com`);
    orgA = orgOne.organization_id;
    adminA = orgOne.user_id;
    orgB = orgTwo.organization_id;
    adminB = orgTwo.user_id;
    orgC = orgThree.organization_id;
    adminC = orgThree.user_id;

    const user = (key: string, name: string) => syncUser(pool, `auth0|tl-${key}-${suffix}`, name, `tl-${key}-${suffix}@example.com`);
    lamA = await user('lam', 'Tl LAM');
    legalA = await user('legal', 'Tl Legal');
    financeA = await user('finance', 'Tl Finance');
    viewerA = await user('viewer', 'Tl Viewer');
    supervisorScoped = await user('sup-scoped', 'Tl Supervisor Scoped');
    supervisorOther = await user('sup-other', 'Tl Supervisor Other');
    negotiatorAssigned = await user('neg-assigned', 'Tl Negotiator Assigned');
    negotiatorUnassigned = await user('neg-unassigned', 'Tl Negotiator Unassigned');
    negotiationOnly = await user('neg-only', 'Tl Negotiation-only Negotiator');
    departedLegal = await user('departed', 'Tl Departed Legal');
    await addMember(pool, adminA, orgA, lamA, 'land_acquisition_manager');
    await addMember(pool, adminA, orgA, legalA, 'legal_documentation');
    await addMember(pool, adminA, orgA, financeA, 'finance');
    await addMember(pool, adminA, orgA, viewerA, 'viewer');
    await addMember(pool, adminA, orgA, supervisorScoped, 'supervisor');
    await addMember(pool, adminA, orgA, supervisorOther, 'supervisor');
    await addMember(pool, adminA, orgA, negotiatorAssigned, 'negotiator');
    await addMember(pool, adminA, orgA, negotiatorUnassigned, 'negotiator');
    await addMember(pool, adminA, orgA, negotiationOnly, 'negotiator');
    await addMember(pool, adminA, orgA, departedLegal, 'legal_documentation');

    const dates = await pool.query<{ today: string; tomorrow: string }>(
      `select to_char((now() at time zone 'Asia/Manila')::date, 'YYYY-MM-DD') as today,
              to_char((now() at time zone 'Asia/Manila')::date + 1, 'YYYY-MM-DD') as tomorrow`,
    );
    today = dates.rows[0].today;
    tomorrow = dates.rows[0].tomorrow;

    projectA = await insertOne(
      lamA,
      `insert into public.projects (organization_id, code, name, status) values ($1, 'TL-01', 'Timeline Program', 'active') returning id`,
      [orgA],
    );

    // --- propertyA: one of every kind, used for mapping, ordering, and access.
    propertyA = await insertProperty('TL-A', 'negotiation', negotiatorAssigned, supervisorScoped);
    ids.negotiationA = await insertNegotiation(propertyA, '2026-02-01T00:00:00Z', negotiatorAssigned, 10000000);
    ids.offerA = await insertEvent(ids.negotiationA, 'offer', 11000000, '2026-02-02T01:00:00Z', 'confidential negotiation note');
    ids.callA = await insertEvent(ids.negotiationA, 'call', null, '2026-02-03T01:00:00Z', 'another private note');
    ids.futureEventA = await insertEvent(ids.negotiationA, 'meeting', null, '2999-01-01T00:00:00Z');
    ids.documentA = await insertDocument(legalA, propertyA, 'title_deed', 'Title A', '2026-02-04T01:00:00Z');
    ids.taskA = await insertTask(propertyA, 'Survey follow-up', '2026-02-05T01:00:00Z', randomUUID(), '2026-02-20');
    ids.paymentA = await insertPayment(propertyA, 'paid', '2026-02-06', '2026-02-06T01:00:00Z');
    ids.deedA = await insertDocument(legalA, propertyA, 'agreement_executed', 'Deed A', '2026-02-07T01:00:00Z');
    const ownerA = await insertLinkedOwner(lamA, orgA, propertyA, 'Rosa Timeline');
    ids.signatureA = await insertSignature(legalA, propertyA, ids.deedA, ownerA, '2026-02-08');

    // --- propertyHidden: negotiation/task assignees without property visibility.
    propertyHidden = await insertProperty('TL-HIDDEN', 'negotiation');
    ids.hiddenNegotiation = await insertNegotiation(propertyHidden, '2026-02-01T00:00:00Z', negotiationOnly);
    ids.hiddenTask = await insertOne(
      lamA,
      `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
       values ($1, $2, 'Assigned elsewhere', $3, $4) returning id`,
      [orgA, propertyHidden, supervisorOther, lamA],
    );

    // --- propertyPay: the payment_paid (B1-a) truth table.
    propertyPay = await insertProperty('TL-PAY', 'payment_closing');
    ids.paidWithDate = await insertPayment(propertyPay, 'paid', '2026-03-01', '2026-03-01T01:00:00Z');
    ids.paidNoDate = await insertPayment(propertyPay, 'paid', null, '2026-03-01T02:00:00Z');
    ids.pendingWithDate = await insertPayment(propertyPay, 'pending', '2026-03-02', '2026-03-01T03:00:00Z');
    ids.pendingNoDate = await insertPayment(propertyPay, 'pending', null, '2026-03-01T04:00:00Z');
    ids.paidTomorrow = await insertPayment(propertyPay, 'paid', tomorrow, '2026-03-01T05:00:00Z');
    ids.paidToday = await insertPayment(propertyPay, 'paid', today, '2026-03-01T06:00:00Z');
    ids.paidArchived = await insertPayment(propertyPay, 'paid', '2026-03-03', '2026-03-01T07:00:00Z');
    await asUser(pool, financeA, (client) =>
      client.query(`update public.payments set archived_at = timezone('utc', now()) where id = $1`, [ids.paidArchived]),
    );

    // --- propertyArch: archive rules.
    propertyArch = await insertProperty('TL-ARCH', 'negotiation');
    ids.archivedNegotiation = await insertNegotiation(propertyArch, '2026-05-01T00:00:00Z', null, 900000);
    ids.archivedNegotiationEvent = await insertEvent(ids.archivedNegotiation, 'offer', 950000, '2026-05-02T00:00:00Z');
    await asUser(pool, lamA, (client) =>
      client.query(`update public.negotiations set status = 'withdrawn', archived_at = timezone('utc', now()) where id = $1`, [
        ids.archivedNegotiation,
      ]),
    );
    ids.archivedDocument = await insertDocument(legalA, propertyArch, 'survey_plan', 'Archived survey', '2026-05-03T00:00:00Z');
    await asUser(pool, legalA, (client) =>
      client.query(`update public.documents set archived_at = timezone('utc', now()) where id = $1`, [ids.archivedDocument]),
    );
    ids.archivedTask = await insertTask(propertyArch, 'Archived task', '2026-05-04T00:00:00Z');
    await asUser(pool, lamA, (client) =>
      client.query(`update public.tasks set archived_at = timezone('utc', now()) where id = $1`, [ids.archivedTask]),
    );
    ids.deedArchived = await insertDocument(legalA, propertyArch, 'agreement_executed', 'Deed later archived', '2026-05-05T00:00:00Z');
    const ownerKeep = await insertLinkedOwner(lamA, orgA, propertyArch, 'Owner Keep');
    const ownerDrop = await insertLinkedOwner(lamA, orgA, propertyArch, 'Owner Drop');
    ids.signatureOnArchivedDeed = await insertSignature(legalA, propertyArch, ids.deedArchived, ownerKeep, '2026-05-06');
    ids.archivedSignature = await insertSignature(legalA, propertyArch, ids.deedArchived, ownerDrop, '2026-05-06');
    await asUser(pool, legalA, async (client) => {
      await client.query(`update public.agreement_signatures set archived_at = timezone('utc', now()) where id = $1`, [ids.archivedSignature]);
      await client.query(`update public.documents set archived_at = timezone('utc', now()) where id = $1`, [ids.deedArchived]);
    });
    ids.departedDocument = await insertDocument(departedLegal, propertyArch, 'legal_opinion', 'Departed opinion', '2026-05-07T00:00:00Z');
    await asUser(pool, adminA, (client) =>
      client.query(`update public.organization_memberships set is_active = false where organization_id = $1 and user_id = $2`, [
        orgA,
        departedLegal,
      ]),
    );

    // --- propertyTime: tie-breaking, calendar days in Asia/Manila, future dates.
    propertyTime = await insertProperty('TL-TIME', 'signing');
    ids.deedTime = await insertDocument(legalA, propertyTime, 'agreement_executed', 'Deed Time', '2026-03-30T00:00:00Z');
    // Fresh per run (rows persist between runs); only the last hex digit differs, so low < high.
    const tiePrefix = randomUUID().slice(0, 35);
    ids.taskTieHigh = await insertTask(propertyTime, 'Tie task B', '2026-04-01T02:00:00Z', `${tiePrefix}b`);
    ids.taskTieLow = await insertTask(propertyTime, 'Tie task A', '2026-04-01T02:00:00Z', `${tiePrefix}a`);
    ids.documentTie = await insertDocument(legalA, propertyTime, 'survey_plan', 'Tie survey', '2026-04-01T02:00:00Z');
    // 20:00Z is 04:00 on 2 April in Manila; 17:00Z on 31 March is 01:00 on 1 April.
    ids.documentLateUtc = await insertDocument(legalA, propertyTime, 'other', 'Late UTC upload', '2026-04-01T20:00:00Z');
    ids.documentEarlyManila = await insertDocument(legalA, propertyTime, 'other', 'Early Manila upload', '2026-03-31T17:00:00Z');
    const ownerOn = await insertLinkedOwner(lamA, orgA, propertyTime, 'Owner Dated');
    const ownerToday = await insertLinkedOwner(lamA, orgA, propertyTime, 'Owner Today');
    const ownerTomorrow = await insertLinkedOwner(lamA, orgA, propertyTime, 'Owner Tomorrow');
    ids.signatureDated = await insertSignature(legalA, propertyTime, ids.deedTime, ownerOn, '2026-04-01');
    ids.signatureToday = await insertSignature(legalA, propertyTime, ids.deedTime, ownerToday, today);
    ids.signatureTomorrow = await insertSignature(legalA, propertyTime, ids.deedTime, ownerTomorrow, tomorrow);

    // --- propertyPage: 205 tasks, one second apart.
    propertyPage = await insertProperty('TL-PAGE', 'identified');
    await asUser(pool, lamA, (client) =>
      client.query(
        `insert into public.tasks (organization_id, property_id, title, created_by_user_id, created_at)
         select $1, $2, 'Page task ' || n, $3, timestamptz '2026-06-01T00:00:00Z' + n * interval '1 second'
           from generate_series(1, 205) as n`,
        [orgA, propertyPage, lamA],
      ),
    );

    // --- tenant B and the timezone organization.
    const projectB = await insertOne(
      adminB,
      `insert into public.projects (organization_id, code, name, status) values ($1, 'TL-B', 'South', 'active') returning id`,
      [orgB],
    );
    propertyB = await insertOne(
      adminB,
      `insert into public.properties (organization_id, project_id, property_reference) values ($1, $2, 'TL-B-001') returning id`,
      [orgB, projectB],
    );
    const projectC = await insertOne(
      adminC,
      `insert into public.projects (organization_id, code, name, status) values ($1, 'TL-C', 'Zone', 'active') returning id`,
      [orgC],
    );
    propertyC = await insertOne(
      adminC,
      `insert into public.properties (organization_id, project_id, property_reference, acquisition_stage) values ($1, $2, 'TL-C-001', 'signing') returning id`,
      [orgC, projectC],
    );
    const deedC = await insertDocument(adminC, propertyC, 'agreement_executed', 'Deed C', '2026-01-01T00:00:00Z', orgC);
    const ownerC = await insertLinkedOwner(adminC, orgC, propertyC, 'Owner Zone');
    const kiritimatiToday = (
      await pool.query<{ day: string }>(`select to_char((now() at time zone 'Pacific/Kiritimati')::date, 'YYYY-MM-DD') as day`)
    ).rows[0].day;
    ids.signatureKiritimati = await insertSignature(adminC, propertyC, deedC, ownerC, kiritimatiToday, orgC);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function setOrganizationTimezone(timezone: string) {
    await asUser(pool, adminC, (client) => client.query(`update public.organizations set timezone = $2 where id = $1`, [orgC, timezone]));
  }

  describe('source mapping and ordering', () => {
    it('maps every source to its locked kind, timestamp, precision, basis, and actor, newest first', async () => {
      const entries = await timeline(adminA, propertyA);
      expect(entries.map((entry) => [entry.kind, entry.source_id])).toEqual([
        ['agreement_signed', ids.signatureA],
        ['document_uploaded', ids.deedA],
        ['payment_paid', ids.paymentA],
        ['payment_recorded', ids.paymentA],
        ['task_created', ids.taskA],
        ['document_uploaded', ids.documentA],
        ['negotiation_event', ids.callA],
        ['negotiation_event', ids.offerA],
        ['negotiation_recorded', ids.negotiationA],
      ]);

      const byKind = (kind: string, sourceId: string) => entries.find((entry) => entry.kind === kind && entry.source_id === sourceId)!;
      expect(byKind('agreement_signed', ids.signatureA)).toEqual({
        id: `agreement_signature:${ids.signatureA}:agreement_signed`,
        kind: 'agreement_signed',
        source_type: 'agreement_signature',
        source_id: ids.signatureA,
        occurred_at: '2026-02-08',
        precision: 'date',
        basis: 'occurrence',
        actor: { id: legalA, display_name: 'Tl Legal' },
        summary: 'Rosa Timeline signed Deed A',
        archived: false,
      });
      expect(byKind('payment_paid', ids.paymentA)).toMatchObject({
        source_type: 'payment',
        occurred_at: '2026-02-06',
        precision: 'date',
        basis: 'occurrence',
        actor: null,
        summary: 'Deposit paid: PHP 500,000',
      });
      expect(byKind('payment_recorded', ids.paymentA)).toMatchObject({
        occurred_at: '2026-02-06T01:00:00.000Z',
        precision: 'timestamp',
        basis: 'recorded',
        actor: { id: financeA, display_name: 'Tl Finance' },
        summary: 'Deposit recorded: PHP 500,000 · Paid',
      });
      expect(byKind('task_created', ids.taskA)).toMatchObject({
        occurred_at: '2026-02-05T01:00:00.000Z',
        basis: 'recorded',
        actor: { id: lamA, display_name: 'Tl LAM' },
        summary: 'Task created: Survey follow-up',
      });
      expect(byKind('document_uploaded', ids.documentA)).toMatchObject({
        basis: 'recorded',
        actor: { id: legalA, display_name: 'Tl Legal' },
        summary: 'Title deed: Title A',
      });
      expect(byKind('negotiation_event', ids.offerA)).toMatchObject({
        occurred_at: '2026-02-02T01:00:00.000Z',
        precision: 'timestamp',
        basis: 'occurrence',
        actor: { id: lamA, display_name: 'Tl LAM' },
        summary: 'Offer: PHP 11,000,000',
      });
      expect(byKind('negotiation_event', ids.callA).summary).toBe('Call logged');
      expect(byKind('negotiation_recorded', ids.negotiationA)).toMatchObject({
        source_type: 'negotiation',
        occurred_at: '2026-02-01T00:00:00.000Z',
        basis: 'recorded',
        actor: null,
        summary: 'Negotiation recorded · opening PHP 10,000,000',
      });
    });

    it('never exposes notes, planned dates, owner links, or future occurrences', async () => {
      const entries = await timeline(adminA, propertyA);
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toContain('confidential');
      expect(serialized).not.toContain('private note');
      expect(serialized).not.toContain('2026-02-20');
      expect(entries.some((entry) => entry.source_id === ids.futureEventA)).toBe(false);
      expect(entries.every((entry) => entry.archived === false)).toBe(true);
      expect(new Set(entries.map((entry) => entry.source_type))).toEqual(
        new Set(['negotiation_event', 'negotiation', 'document', 'task', 'payment', 'agreement_signature']),
      );
    });

    it('orders date-only entries at the end of their day in the organization timezone, then by tie rank and source id', async () => {
      const entries = await timeline(adminA, propertyTime);
      expect(entries.map((entry) => entry.source_id)).toEqual([
        ids.signatureToday,
        ids.documentLateUtc,
        ids.signatureDated,
        ids.documentTie,
        ids.taskTieLow,
        ids.taskTieHigh,
        ids.documentEarlyManila,
        ids.deedTime,
      ]);
      expect(entries.some((entry) => entry.source_id === ids.signatureTomorrow)).toBe(false);
    });

    it('uses the organization timezone for date eligibility and fails with 22023 on an unrecognized zone', async () => {
      await setOrganizationTimezone('Pacific/Kiritimati');
      expect((await timeline(adminC, propertyC)).map((entry) => entry.source_id)).toContain(ids.signatureKiritimati);

      // Pago Pago is 25 hours behind Kiritimati, so that date has not arrived there yet.
      await setOrganizationTimezone('Pacific/Pago_Pago');
      expect((await timeline(adminC, propertyC)).map((entry) => entry.source_id)).not.toContain(ids.signatureKiritimati);

      await setOrganizationTimezone('Not/AZone');
      await expectSqlError(() => timeline(adminC, propertyC), '22023');
      await setOrganizationTimezone('Asia/Manila');
    });
  });

  describe('payment_paid (B1-a)', () => {
    it('emits payment_paid only for status paid with a reached paid_on date', async () => {
      const entries = await timeline(adminA, propertyPay);
      expect(kindsFor(entries, ids.paidWithDate)).toEqual(['payment_paid', 'payment_recorded']);
      expect(kindsFor(entries, ids.paidNoDate)).toEqual(['payment_recorded']);
      expect(kindsFor(entries, ids.pendingWithDate)).toEqual(['payment_recorded']);
      expect(kindsFor(entries, ids.pendingNoDate)).toEqual(['payment_recorded']);
      expect(kindsFor(entries, ids.paidTomorrow)).toEqual(['payment_recorded']);
      expect(kindsFor(entries, ids.paidToday)).toEqual(['payment_paid', 'payment_recorded']);
      expect(kindsFor(entries, ids.paidArchived)).toEqual([]);
      expect(entries.filter((entry) => entry.kind === 'payment_paid').every((entry) => entry.actor === null)).toBe(true);
    });
  });

  describe('archiving', () => {
    it('excludes archived records, follows negotiation archiving for events, and keeps signatures on archived documents', async () => {
      const entries = await timeline(adminA, propertyArch);
      const sourceIds = entries.map((entry) => entry.source_id);
      expect(sourceIds).not.toContain(ids.archivedNegotiation);
      expect(sourceIds).not.toContain(ids.archivedNegotiationEvent);
      expect(sourceIds).not.toContain(ids.archivedDocument);
      expect(sourceIds).not.toContain(ids.archivedTask);
      expect(sourceIds).not.toContain(ids.deedArchived);
      expect(sourceIds).not.toContain(ids.archivedSignature);
      expect(entries.find((entry) => entry.source_id === ids.signatureOnArchivedDeed)).toMatchObject({
        kind: 'agreement_signed',
        summary: 'Owner Keep signed Deed later archived',
      });
    });

    it('keeps an entry whose actor has left, with the actor id and no name', async () => {
      const entries = await timeline(adminA, propertyArch);
      expect(entries.find((entry) => entry.source_id === ids.departedDocument)?.actor).toEqual({
        id: departedLegal,
        display_name: null,
      });
    });
  });

  describe('access', () => {
    it.each([
      ['system_admin', () => adminA],
      ['land_acquisition_manager', () => lamA],
      ['legal_documentation', () => legalA],
      ['finance', () => financeA],
      ['viewer', () => viewerA],
      ['supervisor managing the property', () => supervisorScoped],
      ['negotiator assigned to the property', () => negotiatorAssigned],
    ])('shows the full timeline to %s', async (_label, actor) => {
      const expected = (await timeline(adminA, propertyA)).map((entry) => entry.id);
      expect((await timeline(actor(), propertyA)).map((entry) => entry.id)).toEqual(expected);
    });

    it.each([
      ['a supervisor outside the property scope', () => supervisorOther],
      ['an unassigned negotiator', () => negotiatorUnassigned],
    ])('returns 404 to %s', async (_label, actor) => {
      await expectNotFound(() => timeline(actor(), propertyA));
    });

    it('returns 404 to a negotiation-only assignee even though the negotiation itself is readable', async () => {
      const readable = await asUser(pool, negotiationOnly, (client) =>
        client.query(`select id from public.negotiations where id = $1`, [ids.hiddenNegotiation]),
      );
      expect(readable.rowCount).toBe(1);
      await expectNotFound(() => timeline(negotiationOnly, propertyHidden));
    });

    it('returns 404 to a task-only assignee even though the task itself is readable', async () => {
      const readable = await asUser(pool, supervisorOther, (client) =>
        client.query(`select id from public.tasks where id = $1`, [ids.hiddenTask]),
      );
      expect(readable.rowCount).toBe(1);
      await expectNotFound(() => timeline(supervisorOther, propertyHidden));
    });

    it('isolates tenants', async () => {
      await expectNotFound(() => timeline(adminB, propertyA));
      await expectNotFound(() => timeline(adminA, propertyB));
      await expectNotFound(() => timeline(adminA, randomUUID()));
    });
  });

  describe('pagination', () => {
    it('defaults to 50, caps at 200, pages by offset, and keeps page boundaries deterministic', async () => {
      expect(propertyTimelineQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
      expect(propertyTimelineQuerySchema.safeParse({ limit: '200' }).success).toBe(true);
      expect(propertyTimelineQuerySchema.safeParse({ limit: '201' }).success).toBe(false);

      const firstPage = await timeline(adminA, propertyPage);
      expect(firstPage).toHaveLength(50);
      expect(firstPage[0].summary).toBe('Task created: Page task 205');

      const max = await timeline(adminA, propertyPage, { limit: 200 });
      expect(max).toHaveLength(200);
      const rest = await timeline(adminA, propertyPage, { limit: 200, offset: 200 });
      expect(rest.map((entry) => entry.summary)).toEqual([
        'Task created: Page task 5',
        'Task created: Page task 4',
        'Task created: Page task 3',
        'Task created: Page task 2',
        'Task created: Page task 1',
      ]);

      const pageOne = await timeline(adminA, propertyPage, { limit: 120 });
      const pageTwo = await timeline(adminA, propertyPage, { limit: 120, offset: 120 });
      const stitched = [...pageOne, ...pageTwo].map((entry) => entry.id);
      expect(stitched).toEqual([...max, ...rest].map((entry) => entry.id));
      expect(new Set(stitched).size).toBe(205);
    });
  });

  describe('security and side effects', () => {
    it('checks property visibility first, runs without elevated privileges, and never writes', async () => {
      const statements: string[] = [];
      const snapshot = (client: PoolClient) =>
        client.query(
          `select
             (select jsonb_agg(to_jsonb(x) order by x.id) from public.negotiations x where x.property_id = $1) as negotiations,
             (select jsonb_agg(to_jsonb(e) order by e.id) from public.negotiation_events e
                join public.negotiations n on n.id = e.negotiation_id where n.property_id = $1) as events,
             (select jsonb_agg(to_jsonb(x) order by x.id) from public.documents x where x.property_id = $1) as documents,
             (select jsonb_agg(to_jsonb(x) order by x.id) from public.tasks x where x.property_id = $1) as tasks,
             (select jsonb_agg(to_jsonb(x) order by x.id) from public.payments x where x.property_id = $1) as payments,
             (select jsonb_agg(to_jsonb(x) order by x.id) from public.agreement_signatures x where x.property_id = $1) as signatures,
             (select to_jsonb(p) from public.properties p where p.id = $1) as property`,
          [propertyA],
        );

      const before = (await asUser(pool, adminA, snapshot)).rows[0];
      const privileges = await asUser(pool, legalA, async (client) => {
        const recording = new Proxy(client, {
          get(target, key, receiver) {
            if (key === 'query') {
              return (sql: string, params?: unknown[]) => {
                statements.push(sql);
                return target.query(sql, params);
              };
            }
            return Reflect.get(target, key, receiver);
          },
        });
        await loadPropertyTimeline(recording, legalA, propertyA, { limit: 50, offset: 0 });
        return (
          await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
            `select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
          )
        ).rows[0];
      });
      const after = (await asUser(pool, adminA, snapshot)).rows[0];

      expect(privileges).toEqual({ rolsuper: false, rolbypassrls: false });
      expect(statements[0]).toMatch(/select organization_id from public\.properties where id=\$1/);
      expect(statements.some((sql) => /\b(insert|update|delete|security\s+definer)\b/i.test(sql))).toBe(false);
      expect(after).toEqual(before);
    });
  });
});
