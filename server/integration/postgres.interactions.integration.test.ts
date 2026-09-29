import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';
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

describe('PostgreSQL interactions security', () => {
  const pool = createAppPool();
  let orgA: string;
  let orgB: string;
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
  let propertyA: string;
  let propertyB: string;
  let ownerLinked: string;
  let ownerUnlinked: string;
  let ownerB: string;

  function insertInteraction(
    client: PoolClient,
    recordedBy: string,
    options: {
      organizationId?: string;
      propertyId?: string;
      ownerId?: string | null;
      type?: string;
      notes?: string | null;
      occurredAt?: string | null;
    } = {},
  ) {
    const occurredSql = options.occurredAt === undefined ? 'default' : '$7::timestamptz';
    const params: unknown[] = [
      options.organizationId ?? orgA,
      options.propertyId ?? propertyA,
      options.ownerId ?? null,
      options.type ?? 'call',
      options.notes === undefined ? 'Spoke with the owner about access.' : options.notes,
      recordedBy,
    ];
    if (options.occurredAt !== undefined) params.push(options.occurredAt);
    return client.query<{ id: string; occurred_at: Date }>(
      `insert into public.interactions (
          organization_id, property_id, owner_id, interaction_type, notes, recorded_by_user_id, occurred_at
        ) values ($1, $2, $3, $4, $5, $6, ${occurredSql}) returning id, occurred_at`,
      params,
    );
  }

  const record = (actor: string, options: Parameters<typeof insertInteraction>[2] = {}) =>
    asUser(pool, actor, async (client) => (await insertInteraction(client, actor, options)).rows[0].id);

  const visibleCount = (actor: string, interactionId: string) =>
    asUser(pool, actor, async (client) =>
      (await client.query(`select id from public.interactions where id = $1`, [interactionId])).rowCount,
    );

  const archive = (actor: string, interactionId: string) =>
    asUser(pool, actor, async (client) =>
      (
        await client.query(
          `update public.interactions set archived_at = coalesce(archived_at, timezone('utc', now())) where id = $1`,
          [interactionId],
        )
      ).rowCount,
    );

  async function insertOwner(actor: string, organizationId: string, name: string) {
    return asUser(pool, actor, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.owners (organization_id, owner_type, display_name) values ($1, 'individual', $2) returning id`,
        [organizationId, name],
      );
      return result.rows[0].id;
    });
  }

  async function linkOwner(actor: string, propertyId: string, ownerId: string) {
    await asUser(pool, actor, (client) =>
      client.query(`insert into public.property_owners (property_id, owner_id) values ($1, $2)`, [propertyId, ownerId]),
    );
  }

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    // Re-apply 011 under the migration advisory lock so function text always
    // matches the repo even when schema_migrations already recorded it.
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    try {
      await admin.query('select pg_advisory_lock(87236401)');
      const sql = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', '011_interactions.sql'),
        'utf8',
      );
      await admin.query(sql);
    } finally {
      try {
        await admin.query('select pg_advisory_unlock(87236401)');
      } catch {
        // ignore unlock failures after a fatal error
      }
      await admin.end();
    }

    const orgOne = await bootstrapOrg(pool, `Int North ${suffix}`, `int-north-${suffix}`, `auth0|int-admin-a-${suffix}`, 'Int Admin A', `int-admin-a-${suffix}@example.com`);
    const orgTwo = await bootstrapOrg(pool, `Int South ${suffix}`, `int-south-${suffix}`, `auth0|int-admin-b-${suffix}`, 'Int Admin B', `int-admin-b-${suffix}@example.com`);
    orgA = orgOne.organization_id;
    adminA = orgOne.user_id;
    orgB = orgTwo.organization_id;
    adminB = orgTwo.user_id;

    const user = (key: string, name: string) => syncUser(pool, `auth0|int-${key}-${suffix}`, name, `int-${key}-${suffix}@example.com`);
    lamA = await user('lam', 'Int LAM');
    legalA = await user('legal', 'Int Legal');
    financeA = await user('finance', 'Int Finance');
    viewerA = await user('viewer', 'Int Viewer');
    supervisorScoped = await user('sup-scoped', 'Int Supervisor Scoped');
    supervisorOther = await user('sup-other', 'Int Supervisor Other');
    negotiatorAssigned = await user('neg-assigned', 'Int Negotiator Assigned');
    negotiatorOther = await user('neg-other', 'Int Negotiator Other');
    await addMember(pool, adminA, orgA, lamA, 'land_acquisition_manager');
    await addMember(pool, adminA, orgA, legalA, 'legal_documentation');
    await addMember(pool, adminA, orgA, financeA, 'finance');
    await addMember(pool, adminA, orgA, viewerA, 'viewer');
    await addMember(pool, adminA, orgA, supervisorScoped, 'supervisor');
    await addMember(pool, adminA, orgA, supervisorOther, 'supervisor');
    await addMember(pool, adminA, orgA, negotiatorAssigned, 'negotiator');
    await addMember(pool, adminA, orgA, negotiatorOther, 'negotiator');

    const projectA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status) values ($1, 'INT-01', 'Interaction Program', 'active') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
    const projectB = await asUser(pool, adminB, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status) values ($1, 'INT-B', 'South Program', 'active') returning id`,
        [orgB],
      );
      return result.rows[0].id;
    });
    // 'identified': interactions are recorded before any negotiation exists.
    propertyA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id, assigned_manager_id
          ) values ($1, $2, 'INT-001', 'identified', $3, $4) returning id`,
        [orgA, projectA, negotiatorAssigned, supervisorScoped],
      );
      return result.rows[0].id;
    });
    propertyB = await asUser(pool, adminB, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (organization_id, project_id, property_reference) values ($1, $2, 'INT-B-001') returning id`,
        [orgB, projectB],
      );
      return result.rows[0].id;
    });
    ownerLinked = await insertOwner(lamA, orgA, 'Linked Owner');
    ownerUnlinked = await insertOwner(lamA, orgA, 'Unlinked Owner');
    ownerB = await insertOwner(adminB, orgB, 'Foreign Owner');
    await linkOwner(lamA, propertyA, ownerLinked);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('access', () => {
    it.each([
      ['system_admin', () => adminA],
      ['land_acquisition_manager', () => lamA],
      ['supervisor managing the property', () => supervisorScoped],
      ['negotiator assigned to the property', () => negotiatorAssigned],
    ])('lets %s record, read, and archive an interaction', async (_label, actor) => {
      const id = await record(actor());
      expect(await visibleCount(actor(), id)).toBe(1);
      expect(await archive(actor(), id)).toBe(1);
    });

    it.each([
      ['a supervisor outside the property scope', () => supervisorOther],
      ['an unassigned negotiator', () => negotiatorOther],
      ['legal_documentation', () => legalA],
      ['finance', () => financeA],
      ['viewer', () => viewerA],
    ])('denies %s recording, reading, or archiving', async (_label, actor) => {
      const existing = await record(lamA);
      await expectSqlError(() => asUser(pool, actor(), (client) => insertInteraction(client, actor())), '42501');
      expect(await visibleCount(actor(), existing)).toBe(0);
      expect(await archive(actor(), existing)).toBe(0);
      expect(await visibleCount(lamA, existing)).toBe(1);
    });

    it('isolates tenants', async () => {
      const inA = await record(lamA);
      expect(await visibleCount(adminB, inA)).toBe(0);
      expect(await archive(adminB, inA)).toBe(0);
      // A foreign tenant naming its own organization is refused by the scope
      // trigger; naming this property's organization is refused by RLS.
      await expectSqlError(
        () => asUser(pool, adminB, (client) => insertInteraction(client, adminB, { organizationId: orgB, propertyId: propertyA })),
        '23514',
      );
      await expectSqlError(
        () => asUser(pool, adminB, (client) => insertInteraction(client, adminB, { organizationId: orgA, propertyId: propertyA })),
        '42501',
      );
      // Right property, wrong organization: the scope trigger refuses it.
      await expectSqlError(
        () => asUser(pool, adminA, (client) => insertInteraction(client, adminA, { organizationId: orgB })),
        '23514',
      );
      const inB = await record(adminB, { organizationId: orgB, propertyId: propertyB });
      expect(await visibleCount(adminA, inB)).toBe(0);
    });

    it('requires the recorder to be the authenticated user', async () => {
      await expectSqlError(() => asUser(pool, adminA, (client) => insertInteraction(client, lamA)), '42501');
    });

    it('lets a supervisor or negotiator archive an interaction recorded by someone else in scope', async () => {
      const byNegotiator = await record(negotiatorAssigned);
      expect(await archive(supervisorScoped, byNegotiator)).toBe(1);
      const byManager = await record(lamA);
      expect(await archive(negotiatorAssigned, byManager)).toBe(1);
    });
  });

  describe('validation', () => {
    it('accepts every locked type and rejects anything else, including note and follow_up', async () => {
      for (const type of ['call', 'meeting', 'site_visit', 'message', 'other']) {
        expect(await record(lamA, { type })).toBeTruthy();
      }
      for (const type of ['note', 'follow_up', 'offer']) {
        await expectSqlError(() => asUser(pool, lamA, (client) => insertInteraction(client, lamA, { type })), '22P02');
      }
    });

    it('requires non-empty notes', async () => {
      await expectSqlError(() => asUser(pool, lamA, (client) => insertInteraction(client, lamA, { notes: '' })), '23514');
      await expectSqlError(() => asUser(pool, lamA, (client) => insertInteraction(client, lamA, { notes: '  \n\t ' })), '23514');
      await expectSqlError(() => asUser(pool, lamA, (client) => insertInteraction(client, lamA, { notes: null })), '23502');
    });

    it('keeps the owner optional, accepts a linked owner, and rejects an unlinked or foreign owner', async () => {
      expect(await record(lamA, { ownerId: null })).toBeTruthy();
      expect(await record(lamA, { ownerId: ownerLinked })).toBeTruthy();
      await expectSqlError(() => asUser(pool, lamA, (client) => insertInteraction(client, lamA, { ownerId: ownerUnlinked })), '23514');
      await expectSqlError(() => asUser(pool, lamA, (client) => insertInteraction(client, lamA, { ownerId: ownerB })), '23514');
    });

    it('rejects a future occurred_at with zero tolerance and accepts the server clock or any past time', async () => {
      // One second ahead of the server clock is already the future.
      await expectSqlError(
        () =>
          asUser(pool, lamA, (client) =>
            client.query(
              `insert into public.interactions (organization_id, property_id, interaction_type, notes, recorded_by_user_id, occurred_at)
               values ($1, $2, 'call', 'Future call', $3, clock_timestamp() + interval '1 second')`,
              [orgA, propertyA, lamA],
            ),
          ),
        '23514',
      );
      // Exactly the server clock at the time of the statement is not in the future.
      const atServerClock = await asUser(pool, lamA, async (client) =>
        (
          await client.query(
            `insert into public.interactions (organization_id, property_id, interaction_type, notes, recorded_by_user_id, occurred_at)
             values ($1, $2, 'call', 'Boundary call', $3, clock_timestamp()) returning id`,
            [orgA, propertyA, lamA],
          )
        ).rowCount,
      );
      expect(atServerClock).toBe(1);
      expect(await record(lamA, { occurredAt: '2026-01-15T09:30:00.000Z' })).toBeTruthy();

      // Omitted: the server stamps its own time.
      const stamped = await asUser(pool, lamA, async (client) => {
        const inserted = (await insertInteraction(client, lamA)).rows[0];
        const clock = (await client.query<{ now: Date }>(`select now() as now`)).rows[0].now;
        return { occurredAt: inserted.occurred_at, now: clock };
      });
      expect(new Date(stamped.occurredAt).getTime()).toBe(new Date(stamped.now).getTime());
    });
  });

  describe('immutability, archive, and delete', () => {
    it.each([
      ['notes', `notes = 'Rewritten'`],
      ['interaction_type', `interaction_type = 'meeting'`],
      ['owner_id', `owner_id = null`],
      ['occurred_at', `occurred_at = occurred_at - interval '1 day'`],
      ['recorded_by_user_id', `recorded_by_user_id = id`],
      ['property_id', `property_id = property_id`],
      ['created_at', `created_at = created_at - interval '1 day'`],
    ])('refuses to change %s after recording', async (column, assignment) => {
      const id = await record(lamA, { ownerId: ownerLinked });
      if (column === 'property_id') {
        // A no-op assignment must be allowed; moving it must not.
        expect(await asUser(pool, lamA, async (client) => (await client.query(`update public.interactions set ${assignment} where id = $1`, [id])).rowCount)).toBe(1);
        return;
      }
      await expectSqlError(
        () => asUser(pool, lamA, (client) => client.query(`update public.interactions set ${assignment} where id = $1`, [id])),
        '42501',
      );
    });

    it('archives idempotently, keeps the first archive time, and never restores', async () => {
      const id = await record(lamA);
      expect(await archive(lamA, id)).toBe(1);
      const first = await asUser(pool, lamA, async (client) =>
        (await client.query<{ archived_at: Date }>(`select archived_at from public.interactions where id = $1`, [id])).rows[0].archived_at,
      );
      expect(await archive(lamA, id)).toBe(1);
      const second = await asUser(pool, lamA, async (client) =>
        (await client.query<{ archived_at: Date }>(`select archived_at from public.interactions where id = $1`, [id])).rows[0].archived_at,
      );
      expect(second).toEqual(first);
      await expectSqlError(
        () => asUser(pool, adminA, (client) => client.query(`update public.interactions set archived_at = null where id = $1`, [id])),
        '42501',
      );
      await expectSqlError(
        () =>
          asUser(pool, adminA, (client) =>
            client.query(`update public.interactions set archived_at = archived_at + interval '1 hour' where id = $1`, [id]),
          ),
        '42501',
      );
    });

    it('has no DELETE policy: a delete matches zero rows even for system_admin', async () => {
      const id = await record(lamA);
      const deleted = await asUser(pool, adminA, async (client) =>
        (await client.query(`delete from public.interactions where id = $1`, [id])).rowCount,
      );
      expect(deleted).toBe(0);
      expect(await visibleCount(lamA, id)).toBe(1);
    });
  });

  describe('owner relationship and multiplicity', () => {
    it('keeps an interaction valid after its owner is unlinked, without blocking the unlink', async () => {
      const ownerTemp = await insertOwner(lamA, orgA, 'Temporary Owner');
      await linkOwner(lamA, propertyA, ownerTemp);
      const id = await record(lamA, { ownerId: ownerTemp, type: 'site_visit' });
      const unlinked = await asUser(pool, lamA, async (client) =>
        (await client.query(`delete from public.property_owners where property_id = $1 and owner_id = $2`, [propertyA, ownerTemp])).rowCount,
      );
      expect(unlinked).toBe(1);
      const row = await asUser(pool, lamA, async (client) =>
        (await client.query<{ owner_id: string }>(`select owner_id from public.interactions where id = $1`, [id])).rows[0],
      );
      expect(row.owner_id).toBe(ownerTemp);
      expect(await archive(lamA, id)).toBe(1);
    });

    it('allows many interactions per property and per owner', async () => {
      const ownerMany = await insertOwner(lamA, orgA, 'Frequent Owner');
      await linkOwner(lamA, propertyA, ownerMany);
      for (const type of ['call', 'call', 'message']) {
        await record(negotiatorAssigned, { ownerId: ownerMany, type });
      }
      const counts = await asUser(pool, lamA, async (client) =>
        (
          await client.query<{ for_owner: string; for_property: string }>(
            `select count(*) filter (where owner_id = $2) as for_owner, count(*) as for_property
               from public.interactions where property_id = $1`,
            [propertyA, ownerMany],
          )
        ).rows[0],
      );
      expect(Number(counts.for_owner)).toBe(3);
      expect(Number(counts.for_property)).toBeGreaterThan(3);
    });
  });

  it('changes no lifecycle field and no other vertical when recording and archiving', async () => {
    const snapshot = () =>
      asUser(pool, adminA, async (client) =>
        (
          await client.query(
            `select
               (select to_jsonb(p) from public.properties p where p.id = $1) as property,
               (select count(*) from public.negotiations where property_id = $1) as negotiations,
               (select count(*) from public.tasks where property_id = $1) as tasks,
               (select count(*) from public.payments where property_id = $1) as payments,
               (select count(*) from public.documents where property_id = $1) as documents,
               (select count(*) from public.agreement_signatures where property_id = $1) as signatures,
               (select count(*) from public.property_owners where property_id = $1) as owner_links`,
            [propertyA],
          )
        ).rows[0],
      );
    const before = await snapshot();
    const id = await record(supervisorScoped, { ownerId: ownerLinked, type: 'meeting' });
    await archive(negotiatorAssigned, id);
    expect(await snapshot()).toEqual(before);
  });
});
