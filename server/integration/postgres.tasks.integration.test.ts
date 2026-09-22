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

describe('PostgreSQL tasks security', () => {
  const pool = createAppPool();
  let orgA: string;
  let orgB: string;
  let adminA: string;
  let adminB: string;
  let lamA: string;
  let supervisorScoped: string;
  let supervisorUnscoped: string;
  let negotiatorAssigned: string;
  let negotiatorUnassigned: string;
  let legalA: string;
  let financeA: string;
  let viewerA: string;
  let inactiveMember: string;
  let projectA: string;
  let projectOther: string;
  let projectB: string;
  let propertyA: string;
  let propertyOther: string;
  let propertyB: string;

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    // Re-apply 008 under the same advisory lock as migrate so concurrent suites
    // do not race CREATE OR REPLACE / GRANT, and so function text matches the
    // repo even when schema_migrations already recorded an earlier revision.
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    try {
      await admin.query('select pg_advisory_lock(87236401)');
      const sql = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', '008_tasks.sql'),
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
      `Task North ${suffix}`,
      `task-north-${suffix}`,
      `auth0|task-admin-a-${suffix}`,
      'Task Admin A',
      `task-admin-a-${suffix}@example.com`,
    );
    const orgTwo = await bootstrapOrg(
      pool,
      `Task South ${suffix}`,
      `task-south-${suffix}`,
      `auth0|task-admin-b-${suffix}`,
      'Task Admin B',
      `task-admin-b-${suffix}@example.com`,
    );
    orgA = orgOne.organization_id;
    adminA = orgOne.user_id;
    orgB = orgTwo.organization_id;
    adminB = orgTwo.user_id;
    lamA = await syncUser(pool, `auth0|task-lam-${suffix}`, 'Task LAM', `task-lam-${suffix}@example.com`);
    supervisorScoped = await syncUser(pool, `auth0|task-sup-1-${suffix}`, 'Task Sup 1', `task-sup-1-${suffix}@example.com`);
    supervisorUnscoped = await syncUser(pool, `auth0|task-sup-2-${suffix}`, 'Task Sup 2', `task-sup-2-${suffix}@example.com`);
    negotiatorAssigned = await syncUser(pool, `auth0|task-neg-1-${suffix}`, 'Task Neg 1', `task-neg-1-${suffix}@example.com`);
    negotiatorUnassigned = await syncUser(pool, `auth0|task-neg-2-${suffix}`, 'Task Neg 2', `task-neg-2-${suffix}@example.com`);
    legalA = await syncUser(pool, `auth0|task-legal-${suffix}`, 'Task Legal', `task-legal-${suffix}@example.com`);
    financeA = await syncUser(pool, `auth0|task-finance-${suffix}`, 'Task Finance', `task-finance-${suffix}@example.com`);
    viewerA = await syncUser(pool, `auth0|task-view-${suffix}`, 'Task Viewer', `task-view-${suffix}@example.com`);
    inactiveMember = await syncUser(pool, `auth0|task-inactive-${suffix}`, 'Task Inactive', `task-inactive-${suffix}@example.com`);
    await addMember(pool, adminA, orgA, lamA, 'land_acquisition_manager');
    await addMember(pool, adminA, orgA, supervisorScoped, 'supervisor');
    await addMember(pool, adminA, orgA, supervisorUnscoped, 'supervisor');
    await addMember(pool, adminA, orgA, negotiatorAssigned, 'negotiator');
    await addMember(pool, adminA, orgA, negotiatorUnassigned, 'negotiator');
    await addMember(pool, adminA, orgA, legalA, 'legal_documentation');
    await addMember(pool, adminA, orgA, financeA, 'finance');
    await addMember(pool, adminA, orgA, viewerA, 'viewer');
    await addMember(pool, adminA, orgA, inactiveMember, 'negotiator');
    await asUser(pool, adminA, (client) =>
      client.query(
        `update public.organization_memberships set is_active = false where organization_id = $1 and user_id = $2`,
        [orgA, inactiveMember],
      ),
    );

    projectA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status)
         values ($1, 'TSK-01', 'Task Program', 'active') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
    projectOther = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status, manager_user_id)
         values ($1, 'TSK-02', 'Other Program', 'active', $2) returning id`,
        [orgA, lamA],
      );
      return result.rows[0].id;
    });
    projectB = await asUser(pool, adminB, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status)
         values ($1, 'TSK-B', 'South Program', 'active') returning id`,
        [orgB],
      );
      return result.rows[0].id;
    });

    propertyA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, acquisition_stage,
            assigned_negotiator_id, assigned_manager_id
          ) values ($1, $2, 'TSK-001', 'negotiation', $3, $4) returning id`,
        [orgA, projectA, negotiatorAssigned, supervisorScoped],
      );
      return result.rows[0].id;
    });
    // Belongs to a different project (managed by lamA, not supervisorScoped),
    // and carries no negotiator/manager assignment -- used to prove
    // supervisor out-of-scope denial and negotiator no-assignment denial,
    // while legal_documentation/finance can still self-assign here since
    // their grant needs no property-assignment.
    propertyOther = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, acquisition_stage
          ) values ($1, $2, 'TSK-002', 'identified') returning id`,
        [orgA, projectOther],
      );
      return result.rows[0].id;
    });
    propertyB = await asUser(pool, adminB, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.properties (
            organization_id, project_id, property_reference, acquisition_stage
          ) values ($1, $2, 'TSK-B-001', 'identified') returning id`,
        [orgB, projectB],
      );
      return result.rows[0].id;
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it('applies migration 008 once and remains rerunnable', async () => {
    await runMigrations();
    await runMigrations();
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: requireDatabaseEnv().migrateUrl });
    await admin.connect();
    try {
      const rows = await admin.query<{ id: string }>('select id from public.schema_migrations where id = $1', [
        '008_tasks.sql',
      ]);
      expect(rows.rows).toHaveLength(1);
    } finally {
      await admin.end();
    }
  });

  it('allows system_admin and land_acquisition_manager to manage tasks organization-wide', async () => {
    const created = await asUser(pool, adminA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.tasks (organization_id, property_id, title, priority, assigned_user_id, created_by_user_id)
         values ($1, $2, 'Admin-created task', 'high', $3, $4) returning id`,
        [orgA, propertyA, negotiatorAssigned, adminA],
      );
      return result.rows[0].id;
    });
    expect(created).toBeTruthy();

    const unassigned = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string; assigned_user_id: string | null }>(
        `insert into public.tasks (organization_id, property_id, title, created_by_user_id)
         values ($1, $2, 'LAM-created unassigned task', $3) returning id, assigned_user_id`,
        [orgA, propertyA, lamA],
      );
      return result.rows[0];
    });
    expect(unassigned.assigned_user_id).toBeNull();

    const reassigned = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ assigned_user_id: string | null }>(
        `update public.tasks set assigned_user_id = $2 where id = $1 returning assigned_user_id`,
        [unassigned.id, legalA],
      );
      return result.rows[0].assigned_user_id;
    });
    expect(reassigned).toBe(legalA);

    const archived = await asUser(pool, adminA, async (client) => {
      const result = await client.query<{ archived_at: string | null }>(
        `update public.tasks set archived_at = timezone('utc', now()) where id = $1 returning archived_at`,
        [unassigned.id],
      );
      return result.rows[0].archived_at;
    });
    expect(archived).not.toBeNull();
  });

  it('rejects task creation by roles without a grant on this property', async () => {
    await expectSqlError(
      () =>
        asUser(pool, negotiatorUnassigned, (client) =>
          client.query(
            `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
             values ($1, $2, 'Not my property', $3, $4)`,
            [orgA, propertyA, negotiatorUnassigned, negotiatorUnassigned],
          ),
        ),
      '42501',
    );

    await expectSqlError(
      () =>
        asUser(pool, viewerA, (client) =>
          client.query(
            `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
             values ($1, $2, 'Viewer attempt', $3, $4)`,
            [orgA, propertyA, viewerA, viewerA],
          ),
        ),
      '42501',
    );

    await expectSqlError(
      () =>
        asUser(pool, supervisorUnscoped, (client) =>
          client.query(
            `insert into public.tasks (organization_id, property_id, title, created_by_user_id)
             values ($1, $2, 'Out of scope', $3)`,
            [orgA, propertyA, supervisorUnscoped],
          ),
        ),
      '42501',
    );
  });

  it('lets a property-assigned negotiator create only a self-assigned task, and rejects assigning to a third party', async () => {
    const selfAssigned = await asUser(pool, negotiatorAssigned, async (client) => {
      const result = await client.query<{ id: string; assigned_user_id: string | null }>(
        `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
         values ($1, $2, 'Call the owner back', $3, $4) returning id, assigned_user_id`,
        [orgA, propertyA, negotiatorAssigned, negotiatorAssigned],
      );
      return result.rows[0];
    });
    expect(selfAssigned.assigned_user_id).toBe(negotiatorAssigned);

    await expectSqlError(
      () =>
        asUser(pool, negotiatorAssigned, (client) =>
          client.query(
            `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
             values ($1, $2, 'Assign to someone else', $3, $4)`,
            [orgA, propertyA, legalA, negotiatorAssigned],
          ),
        ),
      '42501',
    );
  });

  it('lets legal_documentation and finance create only a self-assigned task on any property, no assignment required', async () => {
    const legalTask = await asUser(pool, legalA, async (client) => {
      const result = await client.query<{ id: string; assigned_user_id: string | null }>(
        `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
         values ($1, $2, 'Review title documents', $3, $4) returning id, assigned_user_id`,
        [orgA, propertyOther, legalA, legalA],
      );
      return result.rows[0];
    });
    expect(legalTask.assigned_user_id).toBe(legalA);

    await expectSqlError(
      () =>
        asUser(pool, legalA, (client) =>
          client.query(
            `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
             values ($1, $2, 'Assign to someone else', $3, $4)`,
            [orgA, propertyOther, financeA, legalA],
          ),
        ),
      '42501',
    );

    const financeTask = await asUser(pool, financeA, async (client) => {
      const result = await client.query<{ id: string; assigned_user_id: string | null }>(
        `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
         values ($1, $2, 'Confirm payment schedule', $3, $4) returning id, assigned_user_id`,
        [orgA, propertyA, financeA, financeA],
      );
      return result.rows[0];
    });
    expect(financeTask.assigned_user_id).toBe(financeA);

    await expectSqlError(
      () =>
        asUser(pool, financeA, (client) =>
          client.query(
            `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
             values ($1, $2, 'Assign to someone else', $3, $4)`,
            [orgA, propertyA, legalA, financeA],
          ),
        ),
      '42501',
    );
  });

  it('lets a supervisor manage tasks within a managed property but not outside it', async () => {
    const managed = await asUser(pool, supervisorScoped, async (client) => {
      const result = await client.query<{ id: string; assigned_user_id: string | null }>(
        `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
         values ($1, $2, 'Supervisor in scope', $3, $4) returning id, assigned_user_id`,
        [orgA, propertyA, negotiatorAssigned, supervisorScoped],
      );
      return result.rows[0];
    });
    expect(managed.assigned_user_id).toBe(negotiatorAssigned);

    const reassigned = await asUser(pool, supervisorScoped, async (client) => {
      const result = await client.query<{ assigned_user_id: string | null }>(
        `update public.tasks set assigned_user_id = $2 where id = $1 returning assigned_user_id`,
        [managed.id, legalA],
      );
      return result.rows[0].assigned_user_id;
    });
    expect(reassigned).toBe(legalA);

    await expectSqlError(
      () =>
        asUser(pool, supervisorScoped, (client) =>
          client.query(
            `insert into public.tasks (organization_id, property_id, title, created_by_user_id)
             values ($1, $2, 'Not managed by this supervisor', $3)`,
            [orgA, propertyOther, supervisorScoped],
          ),
        ),
      '42501',
    );
  });

  it('lets any assignee edit and complete their own task but denies reassignment', async () => {
    const task = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
         values ($1, $2, 'Assignee self-service', $3, $4) returning id`,
        [orgA, propertyA, legalA, lamA],
      );
      return result.rows[0].id;
    });

    const edited = await asUser(pool, legalA, async (client) => {
      const result = await client.query<{ status: string; priority: string }>(
        `update public.tasks set status = 'done', priority = 'urgent' where id = $1 returning status, priority`,
        [task],
      );
      return result.rows[0];
    });
    expect(edited).toEqual({ status: 'done', priority: 'urgent' });

    await expectSqlError(
      () =>
        asUser(pool, legalA, (client) =>
          client.query(`update public.tasks set assigned_user_id = $2 where id = $1`, [task, financeA]),
        ),
      '42501',
    );

    const preserved = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ assigned_user_id: string | null }>(
        `select assigned_user_id from public.tasks where id = $1`,
        [task],
      );
      return result.rows[0].assigned_user_id;
    });
    expect(preserved).toBe(legalA);
  });

  it('denies a viewer from writing to their own assigned task -- assignment must not elevate permissions', async () => {
    const task = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
         values ($1, $2, 'Assigned to a viewer', $3, $4) returning id`,
        [orgA, propertyA, viewerA, lamA],
      );
      return result.rows[0].id;
    });

    // RLS's USING clause fails for viewer (can_write_own_task excludes the
    // viewer role), so the UPDATE simply matches zero rows rather than
    // raising -- same shape as the negotiator-cannot-reassign-negotiation
    // precedent in postgres.negotiations.integration.test.ts.
    const deniedUpdate = await asUser(pool, viewerA, async (client) => {
      const result = await client.query(`update public.tasks set status = 'done' where id = $1`, [task]);
      return result.rowCount;
    });
    expect(deniedUpdate).toBe(0);

    const deniedArchive = await asUser(pool, viewerA, async (client) => {
      const result = await client.query(`update public.tasks set archived_at = timezone('utc', now()) where id = $1`, [
        task,
      ]);
      return result.rowCount;
    });
    expect(deniedArchive).toBe(0);

    const untouched = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ status: string; archived_at: string | null }>(
        `select status, archived_at from public.tasks where id = $1`,
        [task],
      );
      return result.rows[0];
    });
    expect(untouched).toEqual({ status: 'open', archived_at: null });
  });

  it('lets an assignee read their own task without general property visibility, without exposing other tasks on that property', async () => {
    const assignedToUnrelatedNegotiator = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
         values ($1, $2, 'Assigned outside normal visibility', $3, $4) returning id`,
        [orgA, propertyA, negotiatorUnassigned, lamA],
      );
      return result.rows[0].id;
    });

    // negotiatorUnassigned is not assigned to propertyA, so can_read_property
    // returns false for them on this property -- but they should still see
    // exactly the one task assigned to them.
    const visibleOwnTask = await asUser(pool, negotiatorUnassigned, async (client) => {
      const result = await client.query(`select id from public.tasks where id = $1`, [assignedToUnrelatedNegotiator]);
      return result.rowCount;
    });
    expect(visibleOwnTask).toBe(1);

    const hiddenOtherTasks = await asUser(pool, negotiatorUnassigned, async (client) => {
      const result = await client.query(
        `select id from public.tasks where property_id = $1 and id != $2`,
        [propertyA, assignedToUnrelatedNegotiator],
      );
      return result.rowCount;
    });
    expect(hiddenOtherTasks).toBe(0);
  });

  it('isolates tasks across tenants', async () => {
    const propertyATask = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.tasks (organization_id, property_id, title, created_by_user_id)
         values ($1, $2, 'Org A task', $3) returning id`,
        [orgA, propertyA, lamA],
      );
      return result.rows[0].id;
    });

    const hiddenFromOrgB = await asUser(pool, adminB, async (client) => {
      const result = await client.query(`select id from public.tasks where id = $1`, [propertyATask]);
      return result.rowCount;
    });
    expect(hiddenFromOrgB).toBe(0);

    // Correctly scoped organization_id, but the property belongs to org A.
    await expectSqlError(
      () =>
        asUser(pool, adminB, (client) =>
          client.query(
            `insert into public.tasks (organization_id, property_id, title, created_by_user_id)
             values ($1, $2, 'Cross tenant property', $3)`,
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
            `insert into public.tasks (organization_id, property_id, title, created_by_user_id)
             values ($1, $2, 'Non-member', $3)`,
            [orgA, propertyA, adminB],
          ),
        ),
      '42501',
    );
  });

  it('rejects assigning a user who is not an active member of the task organization', async () => {
    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(
            `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
             values ($1, $2, 'Cross-org assignee', $3, $4)`,
            [orgA, propertyA, adminB, lamA],
          ),
        ),
      '23514',
    );

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(
            `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
             values ($1, $2, 'Inactive assignee', $3, $4)`,
            [orgA, propertyA, inactiveMember, lamA],
          ),
        ),
      '23514',
    );
  });

  it('keeps organization_id and property_id immutable after creation', async () => {
    const task = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.tasks (organization_id, property_id, title, created_by_user_id)
         values ($1, $2, 'Immutable scope', $3) returning id`,
        [orgA, propertyA, lamA],
      );
      return result.rows[0].id;
    });

    await expectSqlError(
      () =>
        asUser(pool, lamA, (client) =>
          client.query(`update public.tasks set property_id = $2 where id = $1`, [task, propertyOther]),
        ),
      '42501',
    );

    const preserved = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ property_id: string }>(`select property_id from public.tasks where id = $1`, [
        task,
      ]);
      return result.rows[0].property_id;
    });
    expect(preserved).toBe(propertyA);
  });
});
