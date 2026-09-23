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

describe('PostgreSQL agreement signatures security', () => {
  const pool = createAppPool();
  let orgA: string;
  let orgB: string;
  let adminA: string;
  let adminB: string;
  let lamA: string;
  let legalA: string;
  let financeA: string;
  let supervisorA: string;
  let supervisorScoped: string;
  let negotiatorAssigned: string;
  let negotiatorUnassigned: string;
  let viewerA: string;
  let propertyA: string;
  let propertyOther: string;
  let propertyB: string;
  let ownerOne: string;
  let ownerTwo: string;
  let ownerStranger: string;
  let ownerB: string;
  let executedOne: string;
  let executedTwo: string;
  let draftDocument: string;
  let executedOther: string;
  let executedB: string;
  let firstSignature: string;

  async function insertDocument(
    actor: string,
    organizationId: string,
    propertyId: string,
    category: string,
    title: string,
  ) {
    return asUser(pool, actor, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.documents (
            organization_id, property_id, category, title, original_filename,
            content_type, size_bytes, storage_key, uploaded_by_user_id
          ) values ($1,$2,$3,$4,'agreement.pdf','application/pdf',1024,$5,$6) returning id`,
        [organizationId, propertyId, category, title, `sig/${randomUUID()}.pdf`, actor],
      );
      return result.rows[0].id;
    });
  }

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

  function insertSignature(
    client: PoolClient,
    organizationId: string,
    propertyId: string,
    documentId: string,
    ownerId: string,
    recordedBy: string,
    signedOn = '2026-09-20',
  ) {
    return client.query<{ id: string }>(
      `insert into public.agreement_signatures (
          organization_id, property_id, document_id, owner_id, signed_on, recorded_by_user_id
        ) values ($1,$2,$3,$4,$5,$6) returning id`,
      [organizationId, propertyId, documentId, ownerId, signedOn, recordedBy],
    );
  }

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    // Re-apply 010 under the migration advisory lock so function text always
    // matches the repo even when schema_migrations already recorded it.
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    try {
      await admin.query('select pg_advisory_lock(87236401)');
      const sql = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', '010_agreement_signatures.sql'),
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
      `Sig North ${suffix}`,
      `sig-north-${suffix}`,
      `auth0|sig-admin-a-${suffix}`,
      'Sig Admin A',
      `sig-admin-a-${suffix}@example.com`,
    );
    const orgTwo = await bootstrapOrg(
      pool,
      `Sig South ${suffix}`,
      `sig-south-${suffix}`,
      `auth0|sig-admin-b-${suffix}`,
      'Sig Admin B',
      `sig-admin-b-${suffix}@example.com`,
    );
    orgA = orgOne.organization_id;
    adminA = orgOne.user_id;
    orgB = orgTwo.organization_id;
    adminB = orgTwo.user_id;
    lamA = await syncUser(pool, `auth0|sig-lam-${suffix}`, 'Sig LAM', `sig-lam-${suffix}@example.com`);
    legalA = await syncUser(pool, `auth0|sig-legal-${suffix}`, 'Sig Legal', `sig-legal-${suffix}@example.com`);
    financeA = await syncUser(pool, `auth0|sig-finance-${suffix}`, 'Sig Finance', `sig-finance-${suffix}@example.com`);
    supervisorA = await syncUser(pool, `auth0|sig-sup-${suffix}`, 'Sig Supervisor', `sig-sup-${suffix}@example.com`);
    supervisorScoped = await syncUser(pool, `auth0|sig-sup-2-${suffix}`, 'Sig Supervisor Scoped', `sig-sup-2-${suffix}@example.com`);
    negotiatorAssigned = await syncUser(pool, `auth0|sig-neg-1-${suffix}`, 'Sig Neg 1', `sig-neg-1-${suffix}@example.com`);
    negotiatorUnassigned = await syncUser(pool, `auth0|sig-neg-2-${suffix}`, 'Sig Neg 2', `sig-neg-2-${suffix}@example.com`);
    viewerA = await syncUser(pool, `auth0|sig-view-${suffix}`, 'Sig Viewer', `sig-view-${suffix}@example.com`);
    await addMember(pool, adminA, orgA, lamA, 'land_acquisition_manager');
    await addMember(pool, adminA, orgA, legalA, 'legal_documentation');
    await addMember(pool, adminA, orgA, financeA, 'finance');
    await addMember(pool, adminA, orgA, supervisorA, 'supervisor');
    await addMember(pool, adminA, orgA, supervisorScoped, 'supervisor');
    await addMember(pool, adminA, orgA, negotiatorAssigned, 'negotiator');
    await addMember(pool, adminA, orgA, negotiatorUnassigned, 'negotiator');
    await addMember(pool, adminA, orgA, viewerA, 'viewer');

    const projectA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status) values ($1, 'SIG-01', 'Signature Program', 'active') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
    const projectB = await asUser(pool, adminB, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status) values ($1, 'SIG-B', 'South Program', 'active') returning id`,
        [orgB],
      );
      return result.rows[0].id;
    });
    propertyA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id, assigned_manager_id
          ) values ($1, $2, 'SIG-001', 'signing', $3, $4) returning id`,
        [orgA, projectA, negotiatorAssigned, supervisorScoped],
      );
      return result.rows[0].id;
    });
    propertyOther = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (organization_id, project_id, property_reference, acquisition_stage)
         values ($1, $2, 'SIG-002', 'signing') returning id`,
        [orgA, projectA],
      );
      return result.rows[0].id;
    });
    propertyB = await asUser(pool, adminB, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (organization_id, project_id, property_reference, acquisition_stage)
         values ($1, $2, 'SIG-B-001', 'signing') returning id`,
        [orgB, projectB],
      );
      return result.rows[0].id;
    });

    // Two owners on propertyA (multiple signatories), one owner linked only to
    // propertyOther, and one owner in the other tenant.
    ownerOne = await insertOwner(lamA, orgA, 'Owner One');
    ownerTwo = await insertOwner(lamA, orgA, 'Owner Two');
    ownerStranger = await insertOwner(lamA, orgA, 'Owner Stranger');
    ownerB = await insertOwner(adminB, orgB, 'Owner South');
    await linkOwner(lamA, propertyA, ownerOne);
    await linkOwner(lamA, propertyA, ownerTwo);
    await linkOwner(lamA, propertyOther, ownerStranger);
    await linkOwner(adminB, propertyB, ownerB);

    // Two executed agreements on propertyA (multiple executed documents).
    executedOne = await insertDocument(lamA, orgA, propertyA, 'agreement_executed', 'Deed of Sale A');
    executedTwo = await insertDocument(lamA, orgA, propertyA, 'agreement_executed', 'Deed of Sale A (supplement)');
    draftDocument = await insertDocument(lamA, orgA, propertyA, 'agreement_draft', 'Draft agreement');
    executedOther = await insertDocument(lamA, orgA, propertyOther, 'agreement_executed', 'Deed of Sale Other');
    executedB = await insertDocument(adminB, orgB, propertyB, 'agreement_executed', 'Deed of Sale South');
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it('applies migration 010 once and remains rerunnable', async () => {
    await runMigrations();
    await runMigrations();
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    try {
      const rows = await admin.query<{ id: string }>('select id from public.schema_migrations where id = $1', [
        '010_agreement_signatures.sql',
      ]);
      expect(rows.rows).toHaveLength(1);
    } finally {
      await admin.end();
    }
  });

  it('lets system_admin, land_acquisition_manager, and legal_documentation record signatures across multiple owners and executed documents', async () => {
    firstSignature = await asUser(pool, adminA, async (client) =>
      (await insertSignature(client, orgA, propertyA, executedOne, ownerOne, adminA)).rows[0].id,
    );
    const byLam = await asUser(pool, lamA, async (client) =>
      (await insertSignature(client, orgA, propertyA, executedOne, ownerTwo, lamA)).rows[0].id,
    );
    const byLegal = await asUser(pool, legalA, async (client) =>
      (await insertSignature(client, orgA, propertyA, executedTwo, ownerOne, legalA)).rows[0].id,
    );
    expect(firstSignature).toBeTruthy();
    expect(byLam).toBeTruthy();
    expect(byLegal).toBeTruthy();

    const perDocument = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ document_id: string; signers: string }>(
        `select document_id, count(*)::text as signers
           from public.agreement_signatures
          where property_id = $1 and archived_at is null
          group by document_id`,
        [propertyA],
      );
      return Object.fromEntries(result.rows.map((row) => [row.document_id, Number(row.signers)]));
    });
    expect(perDocument[executedOne]).toBe(2);
    expect(perDocument[executedTwo]).toBe(1);
  });

  it('denies supervisor, negotiator, finance, and viewer from recording or archiving signatures', async () => {
    for (const actor of [supervisorA, negotiatorAssigned, financeA, viewerA]) {
      await expectSqlError(
        () => asUser(pool, actor, (client) => insertSignature(client, orgA, propertyA, executedTwo, ownerTwo, actor)),
        '42501',
      );
      const archived = await asUser(pool, actor, async (client) => {
        const result = await client.query(
          `update public.agreement_signatures set archived_at = timezone('utc', now()) where id = $1`,
          [firstSignature],
        );
        return result.rowCount;
      });
      expect(archived).toBe(0);
    }
  });

  it('aligns signature visibility with property visibility', async () => {
    const countFor = (actor: string) =>
      asUser(pool, actor, async (client) => {
        const result = await client.query(`select id from public.agreement_signatures where id = $1`, [firstSignature]);
        return result.rowCount;
      });
    expect(await countFor(negotiatorAssigned)).toBe(1);
    expect(await countFor(negotiatorUnassigned)).toBe(0);
    expect(await countFor(viewerA)).toBe(1);
    expect(await countFor(financeA)).toBe(1);
    expect(await countFor(supervisorA)).toBe(0);
    expect(await countFor(adminB)).toBe(0);
  });

  it('lets an in-scope supervisor read a signature but not record or archive one', async () => {
    const visible = await asUser(pool, supervisorScoped, async (client) => {
      const result = await client.query(`select id from public.agreement_signatures where id = $1`, [firstSignature]);
      return result.rowCount;
    });
    expect(visible).toBe(1);

    await expectSqlError(
      () =>
        asUser(pool, supervisorScoped, (client) =>
          insertSignature(client, orgA, propertyA, executedTwo, ownerTwo, supervisorScoped),
        ),
      '42501',
    );

    const archived = await asUser(pool, supervisorScoped, async (client) => {
      const result = await client.query(
        `update public.agreement_signatures set archived_at = timezone('utc', now()) where id = $1`,
        [firstSignature],
      );
      return result.rowCount;
    });
    expect(archived).toBe(0);
  });

  it('isolates signatures across tenants', async () => {
    // Claims org B, but the property belongs to org A.
    await expectSqlError(
      () => asUser(pool, adminB, (client) => insertSignature(client, orgB, propertyA, executedOne, ownerTwo, adminB)),
      '23514',
    );
    // Correctly scoped to org A, but the actor has no membership there.
    await expectSqlError(
      () => asUser(pool, adminB, (client) => insertSignature(client, orgA, propertyA, executedTwo, ownerTwo, adminB)),
      '42501',
    );
    // An org A writer cannot sign org B's document or with org B's owner.
    await expectSqlError(
      () => asUser(pool, lamA, (client) => insertSignature(client, orgA, propertyA, executedB, ownerTwo, lamA)),
      '23514',
    );
    await expectSqlError(
      () => asUser(pool, lamA, (client) => insertSignature(client, orgA, propertyA, executedTwo, ownerB, lamA)),
      '23514',
    );
  });

  it('requires the signatory to be an existing owner of the property', async () => {
    await expectSqlError(
      () => asUser(pool, lamA, (client) => insertSignature(client, orgA, propertyA, executedTwo, ownerStranger, lamA)),
      '23514',
    );
  });

  it('requires a same-property agreement_executed document', async () => {
    await expectSqlError(
      () => asUser(pool, lamA, (client) => insertSignature(client, orgA, propertyA, draftDocument, ownerTwo, lamA)),
      '23514',
    );
    await expectSqlError(
      () => asUser(pool, lamA, (client) => insertSignature(client, orgA, propertyA, executedOther, ownerTwo, lamA)),
      '23514',
    );
    const valid = await asUser(pool, lamA, async (client) =>
      (await insertSignature(client, orgA, propertyOther, executedOther, ownerStranger, lamA)).rows[0].id,
    );
    expect(valid).toBeTruthy();
  });

  it('rejects a duplicate active signature and permits a replacement after archiving', async () => {
    await expectSqlError(
      () => asUser(pool, legalA, (client) => insertSignature(client, orgA, propertyA, executedOne, ownerOne, legalA)),
      '23505',
    );

    const archivedAt = await asUser(pool, legalA, async (client) => {
      const result = await client.query<{ archived_at: string | null }>(
        `update public.agreement_signatures set archived_at = timezone('utc', now()) where id = $1 returning archived_at`,
        [firstSignature],
      );
      return result.rows[0].archived_at;
    });
    expect(archivedAt).not.toBeNull();

    const replacement = await asUser(pool, legalA, async (client) =>
      (await insertSignature(client, orgA, propertyA, executedOne, ownerOne, legalA, '2026-09-21')).rows[0].id,
    );
    expect(replacement).not.toBe(firstSignature);

    const pair = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ active: string; archived: string }>(
        `select count(*) filter (where archived_at is null)::text as active,
                count(*) filter (where archived_at is not null)::text as archived
           from public.agreement_signatures
          where document_id = $1 and owner_id = $2`,
        [executedOne, ownerOne],
      );
      return result.rows[0];
    });
    expect(pair).toEqual({ active: '1', archived: '1' });

    // Re-activating the archived row would create a second active signature.
    await expectSqlError(
      () =>
        asUser(pool, legalA, (client) =>
          client.query(`update public.agreement_signatures set archived_at = null where id = $1`, [firstSignature]),
        ),
      '23505',
    );
  });

  it('makes every field except archived_at immutable', async () => {
    const signature = await asUser(pool, lamA, async (client) =>
      (await insertSignature(client, orgA, propertyA, executedTwo, ownerTwo, lamA)).rows[0].id,
    );
    const attempts: Array<[string, unknown]> = [
      ['signed_on', '2020-01-01'],
      ['owner_id', ownerOne],
      ['document_id', executedOne],
      ['property_id', propertyOther],
      ['recorded_by_user_id', legalA],
    ];
    for (const [column, value] of attempts) {
      await expectSqlError(
        () =>
          asUser(pool, lamA, (client) =>
            client.query(`update public.agreement_signatures set ${column} = $2 where id = $1`, [signature, value]),
          ),
        '42501',
      );
    }
    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(`update public.agreement_signatures set organization_id = $2 where id = $1`, [signature, orgB]),
        ),
      '42501',
    );

    const unchanged = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ signed_on: string; owner_id: string; document_id: string }>(
        `select to_char(signed_on, 'YYYY-MM-DD') as signed_on, owner_id, document_id from public.agreement_signatures where id = $1`,
        [signature],
      );
      return result.rows[0];
    });
    expect(unchanged).toEqual({ signed_on: '2026-09-20', owner_id: ownerTwo, document_id: executedTwo });
  });

  async function archiveSignature(signatureId: string) {
    await asUser(pool, legalA, (client) =>
      client.query(`update public.agreement_signatures set archived_at = timezone('utc', now()) where id = $1`, [
        signatureId,
      ]),
    );
  }

  function reactivateSignature(signatureId: string) {
    return asUser(pool, legalA, (client) =>
      client.query(`update public.agreement_signatures set archived_at = null where id = $1`, [signatureId]),
    );
  }

  function unlink(propertyId: string, ownerId: string) {
    return asUser(pool, lamA, async (client) => {
      const result = await client.query(`delete from public.property_owners where property_id = $1 and owner_id = $2`, [
        propertyId,
        ownerId,
      ]);
      return result.rowCount;
    });
  }

  function recategorize(documentId: string, category: string) {
    return asUser(pool, legalA, async (client) => {
      const result = await client.query(`update public.documents set category = $2 where id = $1`, [documentId, category]);
      return result.rowCount;
    });
  }

  it('blocks unlinking an owner with an active signature, allows it after archiving, and refuses re-activation afterwards', async () => {
    const owner = await insertOwner(lamA, orgA, 'Owner Guard Unlink');
    await linkOwner(lamA, propertyA, owner);
    const document = await insertDocument(lamA, orgA, propertyA, 'agreement_executed', 'Deed Guard Unlink');
    const signature = await asUser(pool, lamA, async (client) =>
      (await insertSignature(client, orgA, propertyA, document, owner, lamA)).rows[0].id,
    );

    await expectSqlError(() => unlink(propertyA, owner), '23514');

    await archiveSignature(signature);
    expect(await unlink(propertyA, owner)).toBe(1);

    // Re-activating would create an active signature for a non-owner.
    await expectSqlError(() => reactivateSignature(signature), '23514');
  });

  it('blocks re-pointing owner_id or property_id of a link with an active signature, but allows unrelated link edits', async () => {
    const owner = await insertOwner(lamA, orgA, 'Owner Guard Repoint');
    const replacementOwner = await insertOwner(lamA, orgA, 'Owner Guard Replacement');
    await linkOwner(lamA, propertyA, owner);
    const document = await insertDocument(lamA, orgA, propertyA, 'agreement_executed', 'Deed Guard Repoint');
    await asUser(pool, lamA, (client) => insertSignature(client, orgA, propertyA, document, owner, lamA));

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(`update public.property_owners set owner_id = $3 where property_id = $1 and owner_id = $2`, [
            propertyA,
            owner,
            replacementOwner,
          ]),
        ),
      '23514',
    );
    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(`update public.property_owners set property_id = $3 where property_id = $1 and owner_id = $2`, [
            propertyA,
            owner,
            propertyOther,
          ]),
        ),
      '23514',
    );

    const unrelatedEdit = await asUser(pool, lamA, async (client) => {
      const result = await client.query(
        `update public.property_owners set ownership_percent = 40 where property_id = $1 and owner_id = $2`,
        [propertyA, owner],
      );
      return result.rowCount;
    });
    expect(unrelatedEdit).toBe(1);
  });

  it('blocks recategorizing an executed document with active signatures, allows unrelated edits, and allows it after archiving', async () => {
    const document = await insertDocument(lamA, orgA, propertyA, 'agreement_executed', 'Deed Guard Category');
    const signature = await asUser(pool, lamA, async (client) =>
      (await insertSignature(client, orgA, propertyA, document, ownerOne, lamA)).rows[0].id,
    );

    await expectSqlError(() => recategorize(document, 'other'), '23514');

    const unrelatedEdit = await asUser(pool, legalA, async (client) => {
      const result = await client.query(
        `update public.documents set title = 'Deed Guard Category (renamed)', status = 'verified' where id = $1`,
        [document],
      );
      return result.rowCount;
    });
    expect(unrelatedEdit).toBe(1);

    // Re-activation is allowed while the signature would still be valid.
    await archiveSignature(signature);
    expect((await reactivateSignature(signature)).rowCount).toBe(1);

    await archiveSignature(signature);
    expect(await recategorize(document, 'other')).toBe(1);

    // Re-activating now would reference a document that is not agreement_executed.
    await expectSqlError(() => reactivateSignature(signature), '23514');
  });

  it('leaves owner unlink and document recategorization unaffected when no active signature depends on them', async () => {
    const owner = await insertOwner(lamA, orgA, 'Owner Guard Free');
    await linkOwner(lamA, propertyA, owner);
    expect(await unlink(propertyA, owner)).toBe(1);

    const unsignedExecuted = await insertDocument(lamA, orgA, propertyA, 'agreement_executed', 'Deed Guard Unsigned');
    expect(await recategorize(unsignedExecuted, 'agreement_draft')).toBe(1);

    const otherDocument = await insertDocument(lamA, orgA, propertyA, 'survey_plan', 'Survey Guard');
    expect(await recategorize(otherDocument, 'agreement_executed')).toBe(1);
  });

  it('leaves existing task, negotiation, and payment records unchanged when signatures are recorded', async () => {
    const propertyLife = await asUser(pool, lamA, async (client) => {
      const project = await client.query<{ project_id: string }>(`select project_id from public.properties where id = $1`, [
        propertyA,
      ]);
      const result = await client.query<{ id: string }>(
        `insert into public.properties (organization_id, project_id, property_reference, acquisition_stage)
         values ($1, $2, 'SIG-LIFE', 'negotiation') returning id`,
        [orgA, project.rows[0].project_id],
      );
      return result.rows[0].id;
    });
    await linkOwner(lamA, propertyLife, ownerOne);
    await linkOwner(lamA, propertyLife, ownerTwo);
    const document = await insertDocument(lamA, orgA, propertyLife, 'agreement_executed', 'Deed Life');

    const { negotiationId, taskId, paymentId } = await asUser(pool, lamA, async (client) => {
      const negotiation = await client.query<{ id: string }>(
        `insert into public.negotiations (organization_id, property_id, opening_amount) values ($1, $2, 1000000) returning id`,
        [orgA, propertyLife],
      );
      const task = await client.query<{ id: string }>(
        `insert into public.tasks (organization_id, property_id, title, created_by_user_id)
         values ($1, $2, 'Collect signatures', $3) returning id`,
        [orgA, propertyLife, lamA],
      );
      const payment = await client.query<{ id: string }>(
        `insert into public.payments (organization_id, property_id, negotiation_id, amount, payment_type, recorded_by_user_id)
         values ($1, $2, $3, 250000, 'deposit', $4) returning id`,
        [orgA, propertyLife, negotiation.rows[0].id, lamA],
      );
      return { negotiationId: negotiation.rows[0].id, taskId: task.rows[0].id, paymentId: payment.rows[0].id };
    });

    const snapshot = () =>
      asUser(pool, lamA, async (client) => {
        const rows = await client.query<{ property: unknown; negotiation: unknown; task: unknown; payment: unknown }>(
          `select (select to_jsonb(p) from public.properties p where p.id = $1) as property,
                  (select to_jsonb(n) from public.negotiations n where n.id = $2) as negotiation,
                  (select to_jsonb(t) from public.tasks t where t.id = $3) as task,
                  (select to_jsonb(pm) from public.payments pm where pm.id = $4) as payment`,
          [propertyLife, negotiationId, taskId, paymentId],
        );
        return rows.rows[0];
      });

    const before = await snapshot();
    expect(before.negotiation).not.toBeNull();
    expect(before.task).not.toBeNull();
    expect(before.payment).not.toBeNull();

    await asUser(pool, legalA, async (client) => {
      await insertSignature(client, orgA, propertyLife, document, ownerOne, legalA);
      await insertSignature(client, orgA, propertyLife, document, ownerTwo, legalA);
    });

    expect(await snapshot()).toEqual(before);
  });

  it('has no DELETE policy: a delete matches zero rows even for system_admin', async () => {
    const executedDelete = await insertDocument(lamA, orgA, propertyOther, 'agreement_executed', 'Deed of Sale Delete');
    const signature = await asUser(pool, lamA, async (client) =>
      (await insertSignature(client, orgA, propertyOther, executedDelete, ownerStranger, lamA)).rows[0].id,
    );

    const deleted = await asUser(pool, adminA, async (client) => {
      const result = await client.query(`delete from public.agreement_signatures where id = $1`, [signature]);
      return result.rowCount;
    });
    expect(deleted).toBe(0);

    const stillThere = await asUser(pool, lamA, async (client) => {
      const result = await client.query(`select id from public.agreement_signatures where id = $1`, [signature]);
      return result.rowCount;
    });
    expect(stillThere).toBe(1);
  });

  it('leaves property lifecycle fields and other verticals unchanged when every owner signs', async () => {
    const snapshot = () =>
      asUser(pool, lamA, async (client) => {
        const property = await client.query(
          `select acquisition_stage, acquisition_status, legal_status, documentation_status, payment_status
             from public.properties where id = $1`,
          [propertyA],
        );
        const counts = await client.query<{ tasks: string; negotiations: string; payments: string }>(
          `select (select count(*) from public.tasks where property_id = $1)::text as tasks,
                  (select count(*) from public.negotiations where property_id = $1)::text as negotiations,
                  (select count(*) from public.payments where property_id = $1)::text as payments`,
          [propertyA],
        );
        return { property: property.rows[0], counts: counts.rows[0] };
      });

    const before = await snapshot();
    const executedFinal = await insertDocument(lamA, orgA, propertyA, 'agreement_executed', 'Deed of Sale Final');
    await asUser(pool, legalA, async (client) => {
      await insertSignature(client, orgA, propertyA, executedFinal, ownerOne, legalA);
      await insertSignature(client, orgA, propertyA, executedFinal, ownerTwo, legalA);
    });
    const after = await snapshot();
    expect(after).toEqual(before);
  });
});
