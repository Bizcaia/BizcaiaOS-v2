import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('PostgreSQL negotiations security', () => {
  const pool = createAppPool();
  let orgA: string;
  let orgB: string;
  let adminA: string;
  let adminB: string;
  let lamA: string;
  let negotiatorA: string;
  let negotiatorExtra: string;
  let legalA: string;
  let viewerA: string;
  let projectA: string;
  let projectB: string;
  let propertyA: string;
  let propertyIdentified: string;
  let propertyB: string;
  let propertyChronology: string;
  let negotiationA: string;
  let offerEventId: string;

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    // Re-apply 006 under the same advisory lock as migrate so concurrent suites
    // do not race CREATE OR REPLACE / GRANT, and so function text matches the repo
    // even when schema_migrations already recorded an earlier 006 revision.
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    try {
      await admin.query('select pg_advisory_lock(87236401)');
      const sql = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', '006_negotiations_rls.sql'),
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
    const orgOne = await bootstrapOrg(
      pool,
      `Neg North ${suffix}`,
      `neg-north-${suffix}`,
      `auth0|neg-admin-a-${suffix}`,
      'Neg Admin A',
      `neg-admin-a-${suffix}@example.com`,
    );
    const orgTwo = await bootstrapOrg(
      pool,
      `Neg South ${suffix}`,
      `neg-south-${suffix}`,
      `auth0|neg-admin-b-${suffix}`,
      'Neg Admin B',
      `neg-admin-b-${suffix}@example.com`,
    );
    orgA = orgOne.organization_id;
    adminA = orgOne.user_id;
    orgB = orgTwo.organization_id;
    adminB = orgTwo.user_id;
    lamA = await syncUser(pool, `auth0|neg-lam-${suffix}`, 'Neg LAM', `neg-lam-${suffix}@example.com`);
    negotiatorA = await syncUser(pool, `auth0|neg-n1-${suffix}`, 'Neg N1', `neg-n1-${suffix}@example.com`);
    negotiatorExtra = await syncUser(pool, `auth0|neg-n2-${suffix}`, 'Neg N2', `neg-n2-${suffix}@example.com`);
    legalA = await syncUser(pool, `auth0|neg-legal-${suffix}`, 'Neg Legal', `neg-legal-${suffix}@example.com`);
    viewerA = await syncUser(pool, `auth0|neg-view-${suffix}`, 'Neg Viewer', `neg-view-${suffix}@example.com`);
    await addMember(pool, adminA, orgA, lamA, 'land_acquisition_manager');
    await addMember(pool, adminA, orgA, negotiatorA, 'negotiator');
    await addMember(pool, adminA, orgA, negotiatorExtra, 'negotiator');
    await addMember(pool, adminA, orgA, legalA, 'legal_documentation');
    await addMember(pool, adminA, orgA, viewerA, 'viewer');

    projectA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status)
         values ($1, 'NEG-01', 'Negotiation Program', 'active') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
    projectB = await asUser(pool, adminB, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status)
         values ($1, 'NEG-B', 'South Program', 'active') returning id`,
        [orgB],
      );
      return result.rows[0].id;
    });
    propertyA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id
          ) values ($1, $2, 'NEG-001', 'negotiation', $3) returning id`,
        [orgA, projectA, negotiatorA],
      );
      return result.rows[0].id;
    });
    propertyChronology = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id
          ) values ($1, $2, 'NEG-CHRONO', 'negotiation', $3) returning id`,
        [orgA, projectA, negotiatorA],
      );
      return result.rows[0].id;
    });
    propertyIdentified = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id
          ) values ($1, $2, 'NEG-002', 'identified', $3) returning id`,
        [orgA, projectA, negotiatorA],
      );
      return result.rows[0].id;
    });
    propertyB = await asUser(pool, adminB, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, acquisition_stage
          ) values ($1, $2, 'NEG-B-001', 'negotiation') returning id`,
        [orgB, projectB],
      );
      return result.rows[0].id;
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it('applies migration 006 once and remains rerunnable', async () => {
    await runMigrations();
    await runMigrations();
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    try {
      const rows = await admin.query<{ id: string }>('select id from public.schema_migrations where id = $1', [
        '006_negotiations_rls.sql',
      ]);
      expect(rows.rows).toHaveLength(1);
    } finally {
      await admin.end();
    }
  });

  it('creates negotiations for authorized manager and assigned negotiator, and rejects invalid cases', async () => {
    negotiationA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.negotiations (organization_id, property_id, assigned_negotiator_id, opening_amount, target_amount)
         values ($1, $2, $3, 10000000, 14000000) returning id`,
        [orgA, propertyA, negotiatorA],
      );
      return result.rows[0].id;
    });
    expect(negotiationA).toBeTruthy();

    const assignedCreated = await asUser(pool, negotiatorA, async (client) => {
      await client.query(`update public.negotiations set status = 'closed' where id = $1`, [negotiationA]);
      const result = await client.query<{ id: string }>(
        `insert into public.negotiations (organization_id, property_id, assigned_negotiator_id)
         values ($1, $2, $3) returning id`,
        [orgA, propertyA, negotiatorA],
      );
      return result.rows[0].id;
    });
    await asUser(pool, lamA, async (client) => {
      await client.query(`update public.negotiations set status = 'closed' where id = $1`, [assignedCreated]);
      await client.query(`update public.negotiations set status = 'open' where id = $1`, [negotiationA]);
    });

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(
            `insert into public.negotiations (organization_id, property_id, assigned_negotiator_id)
             values ($1, $2, $3)`,
            [orgA, propertyIdentified, negotiatorA],
          ),
        ),
      '23514',
    );

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(
            `insert into public.negotiations (organization_id, property_id, assigned_negotiator_id)
             values ($1, $2, $3)`,
            [orgA, propertyA, negotiatorA],
          ),
        ),
      '23505',
    );

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(
            `insert into public.negotiations (organization_id, property_id)
             values ($1, $2)`,
            [orgA, propertyB],
          ),
        ),
      '23514',
    );

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(
            `insert into public.negotiations (organization_id, property_id, assigned_negotiator_id)
             values ($1, $2, $3)`,
            [orgA, propertyA, adminA],
          ),
        ),
      '23514',
    );

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(
            `insert into public.negotiations (organization_id, property_id, assigned_negotiator_id)
             values ($1, $2, $3)`,
            [orgA, propertyA, adminB],
          ),
        ),
      '23514',
    );

    await expectSqlError(
      () =>
        asUser(pool, legalA, (client) =>
          client.query(
            `insert into public.negotiations (organization_id, property_id, assigned_negotiator_id)
             values ($1, $2, $3)`,
            [orgA, propertyA, negotiatorA],
          ),
        ),
      '42501',
    );

    // Unassigned negotiator cannot update the existing negotiation (assignment-scoped write).
    // PostgreSQL RLS UPDATE that fails USING returns 0 rows rather than 42501.
    const deniedUpdate = await asUser(pool, negotiatorExtra, async (client) => {
      const result = await client.query(`update public.negotiations set status = 'paused' where id = $1`, [
        negotiationA,
      ]);
      return result.rowCount;
    });
    expect(deniedUpdate).toBe(0);
  });

  it('appends immutable events and derives current_amount from offer and counteroffer', async () => {
    offerEventId = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.negotiation_events (organization_id, negotiation_id, event_type, amount, actor_user_id, contextual_note)
         values ($1, $2, 'offer', 11000000, $3, 'first offer') returning id`,
        [orgA, negotiationA, lamA],
      );
      return result.rows[0].id;
    });

    const afterOffer = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ current_amount: string }>(
        `select current_amount::text from public.negotiations where id = $1`,
        [negotiationA],
      );
      return result.rows[0].current_amount;
    });
    expect(afterOffer).toBe('11000000.00');

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(
            `insert into public.negotiation_events (organization_id, negotiation_id, event_type, actor_user_id)
             values ($1, $2, 'offer', $3)`,
            [orgA, negotiationA, lamA],
          ),
        ),
      '23514',
    );

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(
            `insert into public.negotiation_events (organization_id, negotiation_id, event_type, actor_user_id)
             values ($1, $2, 'counteroffer', $3)`,
            [orgA, negotiationA, lamA],
          ),
        ),
      '23514',
    );

    await asUser(pool, lamA, async (client) => {
      await client.query(
        `insert into public.negotiation_events (organization_id, negotiation_id, event_type, amount, actor_user_id)
         values ($1, $2, 'counteroffer', 11800000, $3)`,
        [orgA, negotiationA, lamA],
      );
    });

    const afterCounter = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ current_amount: string; note: string | null }>(
        `select n.current_amount::text, e.contextual_note as note
           from public.negotiations n
           join public.negotiation_events e on e.id = $2
          where n.id = $1`,
        [negotiationA, offerEventId],
      );
      return result.rows[0];
    });
    expect(afterCounter.current_amount).toBe('11800000.00');
    expect(afterCounter.note).toBe('first offer');

    const eventUpdateBlocked = await asUser(pool, lamA, async (client) => {
      try {
        const result = await client.query(
          `update public.negotiation_events set contextual_note = 'mutated' where id = $1`,
          [offerEventId],
        );
        return (result.rowCount ?? 0) > 0;
      } catch {
        return false;
      }
    });
    expect(eventUpdateBlocked).toBe(false);

    const eventDeleteBlocked = await asUser(pool, lamA, async (client) => {
      try {
        const result = await client.query(`delete from public.negotiation_events where id = $1`, [offerEventId]);
        return (result.rowCount ?? 0) > 0;
      } catch {
        return false;
      }
    });
    expect(eventDeleteBlocked).toBe(false);

    const preserved = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ note: string | null; amount: string }>(
        `select contextual_note as note, amount::text from public.negotiation_events where id = $1`,
        [offerEventId],
      );
      return result.rows[0];
    });
    expect(preserved.note).toBe('first offer');
    expect(preserved.amount).toBe('11000000.00');

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(`update public.negotiations set current_amount = 1 where id = $1`, [negotiationA]),
        ),
      '42501',
    );
  });

  it('derives current_amount from latest offer/counteroffer by occurred_at, ignoring backdated inserts', async () => {
    const negotiationId = await asUser(pool, lamA, async (client) => {
      const created = await client.query<{ id: string }>(
        `insert into public.negotiations (organization_id, property_id, assigned_negotiator_id)
         values ($1, $2, $3) returning id`,
        [orgA, propertyChronology, negotiatorA],
      );
      return created.rows[0].id;
    });

    const amountOf = () =>
      asUser(pool, lamA, async (client) => {
        const result = await client.query<{ current_amount: string | null }>(
          `select current_amount::text from public.negotiations where id = $1`,
          [negotiationId],
        );
        return result.rows[0].current_amount;
      });

    const offer10Id = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.negotiation_events (
            organization_id, negotiation_id, event_type, amount, actor_user_id, contextual_note, occurred_at
          ) values ($1, $2, 'offer', 10000000, $3, '10:00 offer', '2026-09-22T10:00:00Z')
          returning id`,
        [orgA, negotiationId, lamA],
      );
      return result.rows[0].id;
    });
    expect(await amountOf()).toBe('10000000.00');

    await asUser(pool, lamA, async (client) => {
      await client.query(
        `insert into public.negotiation_events (
            organization_id, negotiation_id, event_type, amount, actor_user_id, occurred_at
          ) values ($1, $2, 'counteroffer', 12000000, $3, '2026-09-22T11:00:00Z')`,
        [orgA, negotiationId, lamA],
      );
    });
    expect(await amountOf()).toBe('12000000.00');

    await asUser(pool, lamA, async (client) => {
      await client.query(
        `insert into public.negotiation_events (
            organization_id, negotiation_id, event_type, amount, actor_user_id, occurred_at
          ) values ($1, $2, 'offer', 13000000, $3, '2026-09-22T12:00:00Z')`,
        [orgA, negotiationId, lamA],
      );
    });
    expect(await amountOf()).toBe('13000000.00');

    await asUser(pool, lamA, async (client) => {
      await client.query(
        `insert into public.negotiation_events (
            organization_id, negotiation_id, event_type, amount, actor_user_id, contextual_note, occurred_at
          ) values ($1, $2, 'offer', 9000000, $3, 'backdated 09:00', '2026-09-22T09:00:00Z')`,
        [orgA, negotiationId, lamA],
      );
    });
    expect(await amountOf()).toBe('13000000.00');

    await asUser(pool, lamA, async (client) => {
      await client.query(
        `insert into public.negotiation_events (
            organization_id, negotiation_id, event_type, actor_user_id, contextual_note, occurred_at
          ) values ($1, $2, 'note', $3, 'non-offer event', '2026-09-22T12:30:00Z')`,
        [orgA, negotiationId, lamA],
      );
    });
    expect(await amountOf()).toBe('13000000.00');

    await asUser(pool, lamA, async (client) => {
      await client.query(
        `insert into public.negotiation_events (
            organization_id, negotiation_id, event_type, amount, actor_user_id, occurred_at
          ) values ($1, $2, 'counteroffer', 14000000, $3, '2026-09-22T13:00:00Z')`,
        [orgA, negotiationId, lamA],
      );
    });
    expect(await amountOf()).toBe('14000000.00');

    const preserved = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ note: string | null; amount: string }>(
        `select contextual_note as note, amount::text from public.negotiation_events where id = $1`,
        [offer10Id],
      );
      return result.rows[0];
    });
    expect(preserved.note).toBe('10:00 offer');
    expect(preserved.amount).toBe('10000000.00');

    const eventUpdateBlocked = await asUser(pool, lamA, async (client) => {
      try {
        const result = await client.query(
          `update public.negotiation_events set contextual_note = 'mutated' where id = $1`,
          [offer10Id],
        );
        return (result.rowCount ?? 0) > 0;
      } catch {
        return false;
      }
    });
    expect(eventUpdateBlocked).toBe(false);

    const eventDeleteBlocked = await asUser(pool, lamA, async (client) => {
      try {
        const result = await client.query(`delete from public.negotiation_events where id = $1`, [offer10Id]);
        return (result.rowCount ?? 0) > 0;
      } catch {
        return false;
      }
    });
    expect(eventDeleteBlocked).toBe(false);
  });

  it('aligns visibility with property access and keeps assignment and stage independent', async () => {
    const visibleToAssigned = await asUser(pool, negotiatorA, async (client) => {
      const result = await client.query(`select id from public.negotiations where id = $1`, [negotiationA]);
      return result.rowCount;
    });
    expect(visibleToAssigned).toBe(1);

    const hiddenFromUnassigned = await asUser(pool, negotiatorExtra, async (client) => {
      const result = await client.query(`select id from public.negotiations where id = $1`, [negotiationA]);
      return result.rowCount;
    });
    expect(hiddenFromUnassigned).toBe(0);

    const hiddenFromOrgB = await asUser(pool, adminB, async (client) => {
      const result = await client.query(`select id from public.negotiations where id = $1`, [negotiationA]);
      return result.rowCount;
    });
    expect(hiddenFromOrgB).toBe(0);

    await expectSqlError(
      () =>
        asUser(pool, adminB, (client) =>
          client.query(
            `insert into public.negotiation_events (organization_id, negotiation_id, event_type, actor_user_id)
             values ($1, $2, 'note', $3)`,
            [orgA, negotiationA, adminB],
          ),
        ),
      '42501',
    );

    const stageBefore = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ acquisition_stage: string }>(
        `select acquisition_stage from public.properties where id = $1`,
        [propertyA],
      );
      return result.rows[0].acquisition_stage;
    });
    expect(stageBefore).toBe('negotiation');

    await asUser(pool, lamA, async (client) => {
      await client.query(`update public.properties set assigned_negotiator_id = $2 where id = $1`, [
        propertyA,
        negotiatorExtra,
      ]);
    });

    const assignment = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{
        negotiation_assignee: string | null;
        property_assignee: string | null;
        stage: string;
      }>(
        `select n.assigned_negotiator_id as negotiation_assignee,
                p.assigned_negotiator_id as property_assignee,
                p.acquisition_stage as stage
           from public.negotiations n
           join public.properties p on p.id = n.property_id
          where n.id = $1`,
        [negotiationA],
      );
      return result.rows[0];
    });
    expect(assignment.negotiation_assignee).toBe(negotiatorA);
    expect(assignment.property_assignee).toBe(negotiatorExtra);
    expect(assignment.stage).toBe('negotiation');
  });
});
