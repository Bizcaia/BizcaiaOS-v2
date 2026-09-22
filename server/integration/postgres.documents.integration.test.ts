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

describe('PostgreSQL documents security', () => {
  const pool = createAppPool();
  let orgA: string;
  let orgB: string;
  let adminA: string;
  let adminB: string;
  let lamA: string;
  let legalA: string;
  let negotiatorAssigned: string;
  let negotiatorUnassigned: string;
  let viewerA: string;
  let projectA: string;
  let projectB: string;
  let propertyA: string;
  let propertyOther: string;
  let propertyB: string;
  let negotiationOnA: string;
  let negotiationOnOther: string;
  let documentId: string;

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    // Re-apply 007 under the same advisory lock as migrate so concurrent suites
    // do not race CREATE OR REPLACE / GRANT, and so function text matches the
    // repo even when schema_migrations already recorded an earlier revision.
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    try {
      await admin.query('select pg_advisory_lock(87236401)');
      const sql = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', '007_documents.sql'),
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
      `Doc North ${suffix}`,
      `doc-north-${suffix}`,
      `auth0|doc-admin-a-${suffix}`,
      'Doc Admin A',
      `doc-admin-a-${suffix}@example.com`,
    );
    const orgTwo = await bootstrapOrg(
      pool,
      `Doc South ${suffix}`,
      `doc-south-${suffix}`,
      `auth0|doc-admin-b-${suffix}`,
      'Doc Admin B',
      `doc-admin-b-${suffix}@example.com`,
    );
    orgA = orgOne.organization_id;
    adminA = orgOne.user_id;
    orgB = orgTwo.organization_id;
    adminB = orgTwo.user_id;
    lamA = await syncUser(pool, `auth0|doc-lam-${suffix}`, 'Doc LAM', `doc-lam-${suffix}@example.com`);
    legalA = await syncUser(pool, `auth0|doc-legal-${suffix}`, 'Doc Legal', `doc-legal-${suffix}@example.com`);
    negotiatorAssigned = await syncUser(pool, `auth0|doc-neg-1-${suffix}`, 'Doc Neg 1', `doc-neg-1-${suffix}@example.com`);
    negotiatorUnassigned = await syncUser(pool, `auth0|doc-neg-2-${suffix}`, 'Doc Neg 2', `doc-neg-2-${suffix}@example.com`);
    viewerA = await syncUser(pool, `auth0|doc-view-${suffix}`, 'Doc Viewer', `doc-view-${suffix}@example.com`);
    await addMember(pool, adminA, orgA, lamA, 'land_acquisition_manager');
    await addMember(pool, adminA, orgA, legalA, 'legal_documentation');
    await addMember(pool, adminA, orgA, negotiatorAssigned, 'negotiator');
    await addMember(pool, adminA, orgA, negotiatorUnassigned, 'negotiator');
    await addMember(pool, adminA, orgA, viewerA, 'viewer');

    projectA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status)
         values ($1, 'DOC-01', 'Document Program', 'active') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
    projectB = await asUser(pool, adminB, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status)
         values ($1, 'DOC-B', 'South Program', 'active') returning id`,
        [orgB],
      );
      return result.rows[0].id;
    });
    propertyA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id
          ) values ($1, $2, 'DOC-001', 'negotiation', $3) returning id`,
        [orgA, projectA, negotiatorAssigned],
      );
      return result.rows[0].id;
    });
    propertyOther = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, acquisition_stage, assigned_negotiator_id
          ) values ($1, $2, 'DOC-002', 'negotiation', $3) returning id`,
        [orgA, projectA, negotiatorAssigned],
      );
      return result.rows[0].id;
    });
    propertyB = await asUser(pool, adminB, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, acquisition_stage
          ) values ($1, $2, 'DOC-B-001', 'identified') returning id`,
        [orgB, projectB],
      );
      return result.rows[0].id;
    });
    negotiationOnA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.negotiations (organization_id, property_id, assigned_negotiator_id)
         values ($1, $2, $3) returning id`,
        [orgA, propertyA, negotiatorAssigned],
      );
      return result.rows[0].id;
    });
    negotiationOnOther = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.negotiations (organization_id, property_id, assigned_negotiator_id)
         values ($1, $2, $3) returning id`,
        [orgA, propertyOther, negotiatorAssigned],
      );
      return result.rows[0].id;
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it('applies migration 007 once and remains rerunnable', async () => {
    await runMigrations();
    await runMigrations();
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    try {
      const rows = await admin.query<{ id: string }>('select id from public.schema_migrations where id = $1', [
        '007_documents.sql',
      ]);
      expect(rows.rows).toHaveLength(1);
    } finally {
      await admin.end();
    }
  });

  it('allows system_admin, land_acquisition_manager, and legal_documentation to create documents', async () => {
    const byAdmin = await asUser(pool, adminA, async (client) => {
      const result = await client.query<{ id: string; storage_provider: string }>(
        `insert into public.documents (
            organization_id, property_id, category, title, original_filename,
            content_type, size_bytes, storage_key, uploaded_by_user_id
          ) values ($1,$2,'title_deed','Title Deed','deed.pdf','application/pdf',1024,$3,$4)
          returning id, storage_provider`,
        [orgA, propertyA, `docs/${randomUUID()}.pdf`, adminA],
      );
      return result.rows[0];
    });
    expect(byAdmin.storage_provider).toBe('local');
    documentId = byAdmin.id;

    const byLam = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.documents (
            organization_id, property_id, category, title, original_filename,
            content_type, size_bytes, storage_key, uploaded_by_user_id
          ) values ($1,$2,'tax_declaration','Tax Dec','tax.pdf','application/pdf',2048,$3,$4)
          returning id`,
        [orgA, propertyA, `docs/${randomUUID()}.pdf`, lamA],
      );
      return result.rows[0].id;
    });
    expect(byLam).toBeTruthy();

    const byLegal = await asUser(pool, legalA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.documents (
            organization_id, property_id, category, title, original_filename,
            content_type, size_bytes, storage_key, uploaded_by_user_id
          ) values ($1,$2,'legal_opinion','Legal Opinion','opinion.pdf','application/pdf',512,$3,$4)
          returning id`,
        [orgA, propertyA, `docs/${randomUUID()}.pdf`, legalA],
      );
      return result.rows[0].id;
    });
    expect(byLegal).toBeTruthy();
  });

  it('rejects document creation by negotiators, viewers, and cross-tenant actors', async () => {
    await expectSqlError(
      () =>
        asUser(pool, negotiatorAssigned, (client) =>
          client.query(
            `insert into public.documents (
                organization_id, property_id, category, title, original_filename,
                content_type, size_bytes, storage_key, uploaded_by_user_id
              ) values ($1,$2,'other','Blocked','x.pdf','application/pdf',10,$3,$4)`,
            [orgA, propertyA, `docs/${randomUUID()}.pdf`, negotiatorAssigned],
          ),
        ),
      '42501',
    );

    await expectSqlError(
      () =>
        asUser(pool, viewerA, (client) =>
          client.query(
            `insert into public.documents (
                organization_id, property_id, category, title, original_filename,
                content_type, size_bytes, storage_key, uploaded_by_user_id
              ) values ($1,$2,'other','Blocked','x.pdf','application/pdf',10,$3,$4)`,
            [orgA, propertyA, `docs/${randomUUID()}.pdf`, viewerA],
          ),
        ),
      '42501',
    );

    // Property belongs to a different organization than the one being claimed.
    await expectSqlError(
      () =>
        asUser(pool, adminB, (client) =>
          client.query(
            `insert into public.documents (
                organization_id, property_id, category, title, original_filename,
                content_type, size_bytes, storage_key, uploaded_by_user_id
              ) values ($1,$2,'other','Cross tenant','x.pdf','application/pdf',10,$3,$4)`,
            [orgB, propertyA, `docs/${randomUUID()}.pdf`, adminB],
          ),
        ),
      '23514',
    );

    // Correctly scoped to org A, but the actor has no membership in org A at all.
    await expectSqlError(
      () =>
        asUser(pool, adminB, (client) =>
          client.query(
            `insert into public.documents (
                organization_id, property_id, category, title, original_filename,
                content_type, size_bytes, storage_key, uploaded_by_user_id
              ) values ($1,$2,'other','Non-member','x.pdf','application/pdf',10,$3,$4)`,
            [orgA, propertyA, `docs/${randomUUID()}.pdf`, adminB],
          ),
        ),
      '42501',
    );
  });

  it('requires a document negotiation to belong to the same property', async () => {
    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(
            `insert into public.documents (
                organization_id, property_id, negotiation_id, category, title, original_filename,
                content_type, size_bytes, storage_key, uploaded_by_user_id
              ) values ($1,$2,$3,'other','Mismatched','x.pdf','application/pdf',10,$4,$5)`,
            [orgA, propertyA, negotiationOnOther, `docs/${randomUUID()}.pdf`, lamA],
          ),
        ),
      '23514',
    );

    const linked = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string; negotiation_id: string }>(
        `insert into public.documents (
            organization_id, property_id, negotiation_id, category, title, original_filename,
            content_type, size_bytes, storage_key, uploaded_by_user_id
          ) values ($1,$2,$3,'other','Matched','x.pdf','application/pdf',10,$4,$5)
          returning id, negotiation_id`,
        [orgA, propertyA, negotiationOnA, `docs/${randomUUID()}.pdf`, lamA],
      );
      return result.rows[0];
    });
    expect(linked.negotiation_id).toBe(negotiationOnA);
  });

  it('aligns read visibility with property visibility', async () => {
    const visibleToAssignedNegotiator = await asUser(pool, negotiatorAssigned, async (client) => {
      const result = await client.query(`select id from public.documents where property_id = $1`, [propertyA]);
      return result.rowCount;
    });
    expect(visibleToAssignedNegotiator).toBeGreaterThan(0);

    const hiddenFromUnassignedNegotiator = await asUser(pool, negotiatorUnassigned, async (client) => {
      const result = await client.query(`select id from public.documents where property_id = $1`, [propertyA]);
      return result.rowCount;
    });
    expect(hiddenFromUnassignedNegotiator).toBe(0);

    const visibleToViewer = await asUser(pool, viewerA, async (client) => {
      const result = await client.query(`select id from public.documents where property_id = $1`, [propertyA]);
      return result.rowCount;
    });
    expect(visibleToViewer).toBeGreaterThan(0);

    const hiddenFromOrgB = await asUser(pool, adminB, async (client) => {
      const result = await client.query(`select id from public.documents where property_id = $1`, [propertyA]);
      return result.rowCount;
    });
    expect(hiddenFromOrgB).toBe(0);
  });

  it('allows authorized field updates but blocks unauthorized writers', async () => {
    const updated = await asUser(pool, legalA, async (client) => {
      const result = await client.query<{ status: string; archived_at: string | null }>(
        `update public.documents set status = 'verified', archived_at = timezone('utc', now())
          where id = $1
          returning status, archived_at`,
        [documentId],
      );
      return result.rows[0];
    });
    expect(updated.status).toBe('verified');
    expect(updated.archived_at).not.toBeNull();

    const deniedUpdate = await asUser(pool, negotiatorAssigned, async (client) => {
      const result = await client.query(`update public.documents set title = 'Hijacked' where id = $1`, [
        documentId,
      ]);
      return result.rowCount;
    });
    expect(deniedUpdate).toBe(0);
  });

  it('makes file identity fields immutable after insert, including storage_provider', async () => {
    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(`update public.documents set storage_provider = 's3' where id = $1`, [documentId]),
        ),
      '42501',
    );

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(`update public.documents set storage_key = 'attacker-controlled-key' where id = $1`, [
            documentId,
          ]),
        ),
      '42501',
    );

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(`update public.documents set content_type = 'application/octet-stream' where id = $1`, [
            documentId,
          ]),
        ),
      '42501',
    );

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(`update public.documents set property_id = $2 where id = $1`, [documentId, propertyOther]),
        ),
      '42501',
    );

    const preserved = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ storage_provider: string; storage_key: string }>(
        `select storage_provider, storage_key from public.documents where id = $1`,
        [documentId],
      );
      return result.rows[0];
    });
    expect(preserved.storage_provider).toBe('local');
    expect(preserved.storage_key).not.toBe('attacker-controlled-key');
  });
});
