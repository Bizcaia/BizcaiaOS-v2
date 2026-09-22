import { randomUUID } from 'node:crypto';
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

describe('PostgreSQL property workflow security', () => {
  const pool = createAppPool();
  let orgA: string;
  let orgB: string;
  let adminA: string;
  let adminB: string;
  let lamA: string;
  let supervisorA: string;
  let negotiatorA: string;
  let legalA: string;
  let financeA: string;
  let viewerA: string;
  let projectA: string;
  let projectB: string;
  let propertyA: string;
  let ownerA: string;

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    const orgOne = await bootstrapOrg(
      pool,
      `North ${suffix}`,
      `north-${suffix}`,
      `auth0|admin-a-${suffix}`,
      'Admin A',
      `admin-a-${suffix}@example.com`,
    );
    const orgTwo = await bootstrapOrg(
      pool,
      `South ${suffix}`,
      `south-${suffix}`,
      `auth0|admin-b-${suffix}`,
      'Admin B',
      `admin-b-${suffix}@example.com`,
    );
    orgA = orgOne.organization_id;
    adminA = orgOne.user_id;
    orgB = orgTwo.organization_id;
    adminB = orgTwo.user_id;

    lamA = await syncUser(pool, `auth0|lam-a-${suffix}`, 'LAM A', `lam-a-${suffix}@example.com`);
    supervisorA = await syncUser(pool, `auth0|sup-a-${suffix}`, 'Supervisor A', `sup-a-${suffix}@example.com`);
    negotiatorA = await syncUser(pool, `auth0|neg-a-${suffix}`, 'Negotiator A', `neg-a-${suffix}@example.com`);
    legalA = await syncUser(pool, `auth0|legal-a-${suffix}`, 'Legal A', `legal-a-${suffix}@example.com`);
    financeA = await syncUser(pool, `auth0|fin-a-${suffix}`, 'Finance A', `fin-a-${suffix}@example.com`);
    viewerA = await syncUser(pool, `auth0|view-a-${suffix}`, 'Viewer A', `view-a-${suffix}@example.com`);

    await addMember(pool, adminA, orgA, lamA, 'land_acquisition_manager');
    await addMember(pool, adminA, orgA, supervisorA, 'supervisor');
    await addMember(pool, adminA, orgA, negotiatorA, 'negotiator');
    await addMember(pool, adminA, orgA, legalA, 'legal_documentation');
    await addMember(pool, adminA, orgA, financeA, 'finance');
    await addMember(pool, adminA, orgA, viewerA, 'viewer');
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it('applies numbered migrations once and is idempotent', async () => {
    await runMigrations();
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    try {
      const rows = await admin.query<{ id: string }>('select id from public.schema_migrations order by id');
      expect(rows.rows.map((row) => row.id)).toEqual([
        '001_core_schema.sql',
        '002_rbac_rls.sql',
        '003_organization_onboarding.sql',
        '004_property_workflow_rls.sql',
        '005_projects_write_rls.sql',
        '006_negotiations_rls.sql',
        '007_documents.sql',
        '008_tasks.sql',
        '009_payments.sql',
      ]);
    } finally {
      await admin.end();
    }
    const flags = await pool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `select rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
    );
    expect(flags.rows[0]).toMatchObject({ rolbypassrls: false, rolsuper: false });
  });

  it('creates a project for an authorized organization role', async () => {
    projectA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status)
         values ($1, 'NCP-01', 'North Corridor', 'active') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
    expect(projectA).toBeTruthy();
  });

  it('creates a property under the same-organization project', async () => {
    propertyA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, municipality, province, barangay,
            assigned_negotiator_id, assigned_manager_id
          ) values ($1, $2, 'NCP-00101', 'Calamba', 'Laguna', 'Canlubang', $3, $4)
          returning id`,
        [orgA, projectA, negotiatorA, supervisorA],
      );
      return result.rows[0].id;
    });
    expect(propertyA).toBeTruthy();
  });

  it('rejects a property whose project belongs to another organization', async () => {
    projectB = await asUser(pool, adminB, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status)
         values ($1, 'OTH-01', 'Other Program', 'active') returning id`,
        [orgB],
      );
      return result.rows[0].id;
    });
    await expectSqlError(
      () =>
        asUser(pool, lamA, async (client) => {
          await client.query(
            `insert into public.properties (organization_id, project_id, property_reference)
             values ($1, $2, 'CROSS-ORG')`,
            [orgA, projectB],
          );
        }),
      '23514',
    );
  });

  it('creates an owner for an authorized role and rejects unauthorized owner creation', async () => {
    ownerA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.owners (organization_id, owner_type, display_name)
         values ($1, 'individual', 'Rosa Mendoza') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
    await expectSqlError(
      () =>
        asUser(pool, negotiatorA, async (client) => {
          await client.query(
            `insert into public.owners (organization_id, owner_type, display_name)
             values ($1, 'individual', 'Blocked Owner')`,
            [orgA],
          );
        }),
      '42501',
    );
  });

  it('links an owner within the organization and rejects a cross-organization owner link', async () => {
    const ownerB = await asUser(pool, adminB, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.owners (organization_id, owner_type, display_name)
         values ($1, 'individual', 'Foreign Owner') returning id`,
        [orgB],
      );
      return result.rows[0].id;
    });
    await asUser(pool, lamA, async (client) => {
      await client.query(
        `insert into public.property_owners (property_id, owner_id, ownership_percent, is_primary)
         values ($1, $2, 100, true)`,
        [propertyA, ownerA],
      );
    });
    await expectSqlError(
      () =>
        asUser(pool, lamA, async (client) => {
          await client.query(
            `insert into public.property_owners (property_id, owner_id, is_primary)
             values ($1, $2, false)`,
            [propertyA, ownerB],
          );
        }),
      '23514',
    );
  });

  it('rejects a second primary owner on the same property', async () => {
    const secondOwner = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.owners (organization_id, owner_type, display_name)
         values ($1, 'corporate', 'Second Owner') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
    await expectSqlError(
      () =>
        asUser(pool, lamA, async (client) => {
          await client.query(
            `insert into public.property_owners (property_id, owner_id, is_primary)
             values ($1, $2, true)`,
            [propertyA, secondOwner],
          );
        }),
      '23505',
    );
  });

  it('accepts valid negotiator and manager assignments and rejects invalid roles', async () => {
    await asUser(pool, lamA, async (client) => {
      await client.query(
        `update public.properties
            set assigned_negotiator_id = $2, assigned_manager_id = $3
          where id = $1`,
        [propertyA, negotiatorA, supervisorA],
      );
    });
    await expectSqlError(
      () =>
        asUser(pool, lamA, async (client) => {
          await client.query(`update public.properties set assigned_negotiator_id = $2 where id = $1`, [
            propertyA,
            adminA,
          ]);
        }),
      '23514',
    );
    await expectSqlError(
      () =>
        asUser(pool, lamA, async (client) => {
          await client.query(`update public.properties set assigned_manager_id = $2 where id = $1`, [
            propertyA,
            negotiatorA,
          ]);
        }),
      '23514',
    );
  });

  it('enforces property field permissions by role', async () => {
    await asUser(pool, supervisorA, async (client) => {
      await client.query(`update public.properties set readiness_percent = 40, risk = 'high' where id = $1`, [
        propertyA,
      ]);
    });
    await expectSqlError(
      () =>
        asUser(pool, supervisorA, async (client) => {
          await client.query(`update public.properties set acquisition_stage = 'negotiation' where id = $1`, [
            propertyA,
          ]);
        }),
      '42501',
    );
    await asUser(pool, legalA, async (client) => {
      await client.query(
        `update public.properties set legal_status = 'clear', documentation_status = 'complete' where id = $1`,
        [propertyA],
      );
    });
    await expectSqlError(
      () =>
        asUser(pool, legalA, async (client) => {
          await client.query(`update public.properties set payment_status = 'paid' where id = $1`, [propertyA]);
        }),
      '42501',
    );
    await asUser(pool, financeA, async (client) => {
      await client.query(`update public.properties set payment_status = 'in_progress' where id = $1`, [propertyA]);
    });
    const negotiatorUpdate = await asUser(pool, negotiatorA, async (client) =>
      client.query(`update public.properties set readiness_percent = 99 where id = $1 returning readiness_percent`, [
        propertyA,
      ]),
    );
    expect(negotiatorUpdate.rowCount).toBe(0);
    const viewerUpdate = await asUser(pool, viewerA, async (client) =>
      client.query(`update public.properties set risk = 'low' where id = $1 returning risk`, [propertyA]),
    );
    expect(viewerUpdate.rowCount).toBe(0);
  });

  it('isolates properties, owners, and property_owners by organization', async () => {
    const visible = await asUser(pool, adminA, async (client) => {
      const properties = await client.query(`select id from public.properties`);
      const owners = await client.query(`select organization_id from public.owners`);
      return {
        propertyIds: properties.rows.map((row) => row.id),
        ownerOrgs: [...new Set(owners.rows.map((row) => row.organization_id))],
      };
    });
    expect(visible.propertyIds).toContain(propertyA);
    expect(visible.ownerOrgs).toEqual([orgA]);

    const foreign = await asUser(pool, adminB, async (client) => {
      const properties = await client.query(`select id from public.properties where id = $1`, [propertyA]);
      const owners = await client.query(`select id from public.owners where id = $1`, [ownerA]);
      const links = await client.query(`select owner_id from public.property_owners where property_id = $1`, [
        propertyA,
      ]);
      return { properties: properties.rows, owners: owners.rows, links: links.rows };
    });
    expect(foreign.properties).toEqual([]);
    expect(foreign.owners).toEqual([]);
    expect(foreign.links).toEqual([]);
  });

  it('resolves current_app_user_id from SET LOCAL app.user_id', async () => {
    const resolved = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ current_app_user_id: string }>('select public.current_app_user_id()');
      return result.rows[0].current_app_user_id;
    });
    expect(resolved).toBe(lamA);
  });
});
