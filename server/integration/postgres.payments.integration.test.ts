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

describe('PostgreSQL payments security', () => {
  const pool = createAppPool();
  let orgA: string;
  let orgB: string;
  let adminA: string;
  let adminB: string;
  let lamA: string;
  let financeA: string;
  let supervisorA: string;
  let negotiatorAssigned: string;
  let negotiatorUnassigned: string;
  let legalA: string;
  let viewerA: string;
  let projectA: string;
  let projectB: string;
  let propertyA: string;
  let propertyOther: string;
  let propertyB: string;
  let negotiationA: string;
  let negotiationOther: string;

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    // Re-apply 009 under the same advisory lock as migrate so concurrent suites
    // do not race CREATE OR REPLACE / GRANT, and so function text matches the
    // repo even when schema_migrations already recorded an earlier revision.
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    try {
      await admin.query('select pg_advisory_lock(87236401)');
      const sql = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', '009_payments.sql'),
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
      `Pay North ${suffix}`,
      `pay-north-${suffix}`,
      `auth0|pay-admin-a-${suffix}`,
      'Pay Admin A',
      `pay-admin-a-${suffix}@example.com`,
    );
    const orgTwo = await bootstrapOrg(
      pool,
      `Pay South ${suffix}`,
      `pay-south-${suffix}`,
      `auth0|pay-admin-b-${suffix}`,
      'Pay Admin B',
      `pay-admin-b-${suffix}@example.com`,
    );
    orgA = orgOne.organization_id;
    adminA = orgOne.user_id;
    orgB = orgTwo.organization_id;
    adminB = orgTwo.user_id;
    lamA = await syncUser(pool, `auth0|pay-lam-${suffix}`, 'Pay LAM', `pay-lam-${suffix}@example.com`);
    financeA = await syncUser(pool, `auth0|pay-finance-${suffix}`, 'Pay Finance', `pay-finance-${suffix}@example.com`);
    supervisorA = await syncUser(pool, `auth0|pay-sup-${suffix}`, 'Pay Supervisor', `pay-sup-${suffix}@example.com`);
    negotiatorAssigned = await syncUser(pool, `auth0|pay-neg-1-${suffix}`, 'Pay Neg 1', `pay-neg-1-${suffix}@example.com`);
    negotiatorUnassigned = await syncUser(pool, `auth0|pay-neg-2-${suffix}`, 'Pay Neg 2', `pay-neg-2-${suffix}@example.com`);
    legalA = await syncUser(pool, `auth0|pay-legal-${suffix}`, 'Pay Legal', `pay-legal-${suffix}@example.com`);
    viewerA = await syncUser(pool, `auth0|pay-view-${suffix}`, 'Pay Viewer', `pay-view-${suffix}@example.com`);
    await addMember(pool, adminA, orgA, lamA, 'land_acquisition_manager');
    await addMember(pool, adminA, orgA, financeA, 'finance');
    await addMember(pool, adminA, orgA, supervisorA, 'supervisor');
    await addMember(pool, adminA, orgA, negotiatorAssigned, 'negotiator');
    await addMember(pool, adminA, orgA, negotiatorUnassigned, 'negotiator');
    await addMember(pool, adminA, orgA, legalA, 'legal_documentation');
    await addMember(pool, adminA, orgA, viewerA, 'viewer');

    projectA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status)
         values ($1, 'PAY-01', 'Payment Program', 'active') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
    projectB = await asUser(pool, adminB, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status)
         values ($1, 'PAY-B', 'South Program', 'active') returning id`,
        [orgB],
      );
      return result.rows[0].id;
    });

    propertyA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id
          ) values ($1, $2, 'PAY-001', 'negotiation', $3) returning id`,
        [orgA, projectA, negotiatorAssigned],
      );
      return result.rows[0].id;
    });
    propertyOther = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, acquisition_stage
          ) values ($1, $2, 'PAY-002', 'negotiation') returning id`,
        [orgA, projectA],
      );
      return result.rows[0].id;
    });
    propertyB = await asUser(pool, adminB, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, acquisition_stage
          ) values ($1, $2, 'PAY-B-001', 'identified') returning id`,
        [orgB, projectB],
      );
      return result.rows[0].id;
    });
    negotiationA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.negotiations (organization_id, property_id, assigned_negotiator_id)
         values ($1, $2, $3) returning id`,
        [orgA, propertyA, negotiatorAssigned],
      );
      return result.rows[0].id;
    });
    negotiationOther = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.negotiations (organization_id, property_id)
         values ($1, $2) returning id`,
        [orgA, propertyOther],
      );
      return result.rows[0].id;
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it('applies migration 009 once and remains rerunnable', async () => {
    await runMigrations();
    await runMigrations();
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    try {
      const rows = await admin.query<{ id: string }>('select id from public.schema_migrations where id = $1', [
        '009_payments.sql',
      ]);
      expect(rows.rows).toHaveLength(1);
    } finally {
      await admin.end();
    }
  });

  it('allows system_admin, land_acquisition_manager, and finance to write payments organization-wide', async () => {
    const byAdmin = await asUser(pool, adminA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.payments (organization_id, property_id, negotiation_id, amount, payment_type, recorded_by_user_id)
         values ($1, $2, $3, 500000, 'deposit', $4) returning id`,
        [orgA, propertyA, negotiationA, adminA],
      );
      return result.rows[0].id;
    });
    expect(byAdmin).toBeTruthy();

    const byLam = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.payments (organization_id, property_id, amount, payment_type, recorded_by_user_id)
         values ($1, $2, 750000, 'installment', $3) returning id`,
        [orgA, propertyA, lamA],
      );
      return result.rows[0].id;
    });
    expect(byLam).toBeTruthy();

    const byFinance = await asUser(pool, financeA, async (client) => {
      const result = await client.query<{ id: string; status: string }>(
        `insert into public.payments (organization_id, property_id, amount, payment_type, recorded_by_user_id)
         values ($1, $2, 250000, 'final_payment', $3) returning id, status`,
        [orgA, propertyA, financeA],
      );
      return result.rows[0];
    });
    expect(byFinance.status).toBe('pending');

    const updatedByFinance = await asUser(pool, financeA, async (client) => {
      const result = await client.query<{ status: string; paid_on: string | null }>(
        `update public.payments set status = 'paid', paid_on = '2026-10-01' where id = $1 returning status, paid_on`,
        [byFinance.id],
      );
      return result.rows[0];
    });
    expect(updatedByFinance.status).toBe('paid');

    const archivedByLam = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ archived_at: string | null }>(
        `update public.payments set archived_at = timezone('utc', now()) where id = $1 returning archived_at`,
        [byLam],
      );
      return result.rows[0].archived_at;
    });
    expect(archivedByLam).not.toBeNull();
  });

  it('denies supervisor, negotiator, legal_documentation, and viewer from writing payments', async () => {
    const denied: Array<{ actor: string; label: string }> = [
      { actor: supervisorA, label: 'supervisor' },
      { actor: negotiatorAssigned, label: 'negotiator' },
      { actor: legalA, label: 'legal_documentation' },
      { actor: viewerA, label: 'viewer' },
    ];
    for (const { actor } of denied) {
      await expectSqlError(
        () =>
          asUser(pool, actor, (client) =>
            client.query(
              `insert into public.payments (organization_id, property_id, amount, payment_type, recorded_by_user_id)
               values ($1, $2, 100000, 'deposit', $3)`,
              [orgA, propertyA, actor],
            ),
          ),
        '42501',
      );
    }
  });

  it('aligns payment read visibility with property visibility', async () => {
    const paymentOnA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.payments (organization_id, property_id, amount, payment_type, recorded_by_user_id)
         values ($1, $2, 400000, 'deposit', $3) returning id`,
        [orgA, propertyA, lamA],
      );
      return result.rows[0].id;
    });

    const visibleToAssignedNegotiator = await asUser(pool, negotiatorAssigned, async (client) => {
      const result = await client.query(`select id from public.payments where id = $1`, [paymentOnA]);
      return result.rowCount;
    });
    expect(visibleToAssignedNegotiator).toBe(1);

    const hiddenFromUnassignedNegotiator = await asUser(pool, negotiatorUnassigned, async (client) => {
      const result = await client.query(`select id from public.payments where id = $1`, [paymentOnA]);
      return result.rowCount;
    });
    expect(hiddenFromUnassignedNegotiator).toBe(0);

    const visibleToViewer = await asUser(pool, viewerA, async (client) => {
      const result = await client.query(`select id from public.payments where id = $1`, [paymentOnA]);
      return result.rowCount;
    });
    expect(visibleToViewer).toBe(1);

    const visibleToLegal = await asUser(pool, legalA, async (client) => {
      const result = await client.query(`select id from public.payments where id = $1`, [paymentOnA]);
      return result.rowCount;
    });
    expect(visibleToLegal).toBe(1);
  });

  it('isolates payments across tenants and rejects invalid organization/property relationships', async () => {
    const propertyAPayment = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.payments (organization_id, property_id, amount, payment_type, recorded_by_user_id)
         values ($1, $2, 600000, 'deposit', $3) returning id`,
        [orgA, propertyA, lamA],
      );
      return result.rows[0].id;
    });

    const hiddenFromOrgB = await asUser(pool, adminB, async (client) => {
      const result = await client.query(`select id from public.payments where id = $1`, [propertyAPayment]);
      return result.rowCount;
    });
    expect(hiddenFromOrgB).toBe(0);

    // organization_id claims org B, but the property belongs to org A.
    await expectSqlError(
      () =>
        asUser(pool, adminB, (client) =>
          client.query(
            `insert into public.payments (organization_id, property_id, amount, payment_type, recorded_by_user_id)
             values ($1, $2, 100000, 'deposit', $3)`,
            [orgB, propertyA, adminB],
          ),
        ),
      '23514',
    );

    // Correctly scoped to org A's own property, but the actor has no
    // membership in org A at all.
    await expectSqlError(
      () =>
        asUser(pool, adminB, (client) =>
          client.query(
            `insert into public.payments (organization_id, property_id, amount, payment_type, recorded_by_user_id)
             values ($1, $2, 100000, 'deposit', $3)`,
            [orgA, propertyA, adminB],
          ),
        ),
      '42501',
    );
  });

  it('requires a payment negotiation to belong to the same property', async () => {
    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(
            `insert into public.payments (organization_id, property_id, negotiation_id, amount, payment_type, recorded_by_user_id)
             values ($1, $2, $3, 100000, 'deposit', $4)`,
            [orgA, propertyA, negotiationOther, lamA],
          ),
        ),
      '23514',
    );

    const linked = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string; negotiation_id: string }>(
        `insert into public.payments (organization_id, property_id, negotiation_id, amount, payment_type, recorded_by_user_id)
         values ($1, $2, $3, 100000, 'deposit', $4) returning id, negotiation_id`,
        [orgA, propertyA, negotiationA, lamA],
      );
      return result.rows[0];
    });
    expect(linked.negotiation_id).toBe(negotiationA);
  });

  it('keeps organization_id, property_id, and recorded_by_user_id immutable after creation', async () => {
    const payment = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.payments (organization_id, property_id, amount, payment_type, recorded_by_user_id)
         values ($1, $2, 300000, 'deposit', $3) returning id`,
        [orgA, propertyA, lamA],
      );
      return result.rows[0].id;
    });

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(`update public.payments set property_id = $2 where id = $1`, [payment, propertyOther]),
        ),
      '42501',
    );

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(`update public.payments set recorded_by_user_id = $2 where id = $1`, [payment, financeA]),
        ),
      '42501',
    );

    const preserved = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ property_id: string; recorded_by_user_id: string }>(
        `select property_id, recorded_by_user_id from public.payments where id = $1`,
        [payment],
      );
      return result.rows[0];
    });
    expect(preserved.property_id).toBe(propertyA);
    expect(preserved.recorded_by_user_id).toBe(lamA);
  });

  it('rejects a non-positive payment amount', async () => {
    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(
            `insert into public.payments (organization_id, property_id, amount, payment_type, recorded_by_user_id)
             values ($1, $2, 0, 'deposit', $3)`,
            [orgA, propertyA, lamA],
          ),
        ),
      '23514',
    );

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(
            `insert into public.payments (organization_id, property_id, amount, payment_type, recorded_by_user_id)
             values ($1, $2, -100, 'deposit', $3)`,
            [orgA, propertyA, lamA],
          ),
        ),
      '23514',
    );
  });

  it('has no DELETE policy: a delete statement matches zero rows for any writer', async () => {
    const payment = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.payments (organization_id, property_id, amount, payment_type, recorded_by_user_id)
         values ($1, $2, 150000, 'deposit', $3) returning id`,
        [orgA, propertyA, lamA],
      );
      return result.rows[0].id;
    });

    const deletedByAdmin = await asUser(pool, adminA, async (client) => {
      const result = await client.query(`delete from public.payments where id = $1`, [payment]);
      return result.rowCount;
    });
    expect(deletedByAdmin).toBe(0);

    const stillThere = await asUser(pool, lamA, async (client) => {
      const result = await client.query(`select id from public.payments where id = $1`, [payment]);
      return result.rowCount;
    });
    expect(stillThere).toBe(1);
  });

  it('leaves properties.payment_status behavior completely intact', async () => {
    // Same regression already covered in postgres.rls.integration.test.ts,
    // re-asserted here to prove the payments migration did not touch it:
    // legal_documentation is still denied, finance is still allowed, and
    // recording a structured payment does not itself change the field.
    await expectSqlError(
      () =>
        asUser(pool, legalA, (client) =>
          client.query(`update public.properties set payment_status = 'paid' where id = $1`, [propertyA]),
        ),
      '42501',
    );

    const beforePayment = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ payment_status: string }>(
        `select payment_status from public.properties where id = $1`,
        [propertyA],
      );
      return result.rows[0].payment_status;
    });

    await asUser(pool, financeA, async (client) => {
      await client.query(
        `insert into public.payments (organization_id, property_id, amount, payment_type, status, recorded_by_user_id)
         values ($1, $2, 999999, 'final_payment', 'paid', $3)`,
        [orgA, propertyA, financeA],
      );
    });

    const afterPayment = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ payment_status: string }>(
        `select payment_status from public.properties where id = $1`,
        [propertyA],
      );
      return result.rows[0].payment_status;
    });
    expect(afterPayment).toBe(beforePayment);

    const financeCanStillSetIt = await asUser(pool, financeA, async (client) => {
      const result = await client.query<{ payment_status: string }>(
        `update public.properties set payment_status = 'in_progress' where id = $1 returning payment_status`,
        [propertyA],
      );
      return result.rows[0].payment_status;
    });
    expect(financeCanStillSetIt).toBe('in_progress');
  });
});
