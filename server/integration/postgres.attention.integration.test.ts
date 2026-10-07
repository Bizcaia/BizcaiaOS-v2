import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import '../loadEnv.js';
import { runMigrations } from '../migrate.js';
import type { Attention } from '../operationsRoutes.js';
import { addMember, asUser, bootstrapOrg, createAppPool, insertPropertyFixture, requireDatabaseEnv, syncUser } from './postgresHarness.js';

// GET /ops/attention against real PostgreSQL: what each role sees is decided
// by the existing row-level security, and "overdue" by the organization's
// calendar day. The lists are read with a fixed instant so the expected rows
// do not depend on the day the suite runs.

process.env.NODE_ENV = 'test';
process.env.AUTH_JWKS_URL ??= 'https://example.invalid/.well-known/jwks.json';
process.env.AUTH_ISSUER ??= 'https://example.invalid';
process.env.AUTH_AUDIENCE ??= 'bizcaiaos-api';

const tag = randomUUID().slice(0, 8);
const subject = (who: string) => `test|att-${who}-${tag}`;
const tokens: Record<string, string> = Object.fromEntries(
  ['adminA', 'negAssigned', 'adminB', 'adminC'].map((who) => [`token-${who}`, subject(who)]),
);

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async (token: string) => {
    const sub = tokens[token];
    if (!sub) throw new Error('invalid token');
    return { payload: { sub, email: `${sub.replace('|', '.')}@example.com`, name: sub } };
  }),
}));

const { app } = await import('../index.js');
const { ATTENTION_LIST_LIMIT, loadAttention } = await import('../operationsRoutes.js');

// 00:30 on 2026-03-11 in Asia/Manila (UTC+8); still 2026-03-10 in UTC.
const AT = new Date('2026-03-10T16:30:00Z');
// One hour earlier: 23:30 on 2026-03-10 in Asia/Manila.
const BEFORE_MIDNIGHT = new Date('2026-03-10T15:30:00Z');

describe('attention view against real PostgreSQL', () => {
  const pool = createAppPool();
  let server: http.Server;
  let base: string;
  let orgA: string;
  let orgB: string;
  let orgC: string;
  let adminA: string;
  let adminB: string;
  let adminC: string;
  let lamA: string;
  let supervisorScoped: string;
  let supervisorOther: string;
  let negotiatorAssigned: string;
  let negotiatorOther: string;
  let legalA: string;
  let financeA: string;
  let viewerA: string;
  let outsider: string;
  const property: Record<string, string> = {};
  const task: Record<string, string> = {};

  const attention = (userId: string, organizationId = orgA, at: Date = AT) =>
    asUser(pool, userId, (client) => loadAttention(client, userId, organizationId, at));
  const titles = (list: Attention['my_tasks']) => list.items.map((item) => item.title);
  const references = (list: Attention['properties']) => list.items.map((item) => item.property_reference);

  async function call(who: string | null, path: string) {
    const response = await fetch(`${base}/api/v1${path}`, { headers: who ? { Authorization: `Bearer token-${who}` } : {} });
    return { status: response.status, body: await response.json() };
  }

  /** Fixture rows are written as the table owner, so any stage, status or archive state can be set directly. */
  async function insertProperty(
    organizationId: string,
    projectId: string,
    reference: string,
    values: { risk?: string; legal?: string; acquisitionStatus?: string; status?: string; negotiator?: string; manager?: string },
  ) {
    return insertPropertyFixture(
      lamA,
      `insert into public.properties (
          organization_id, project_id, property_reference, risk, legal_status, acquisition_status, status,
          assigned_negotiator_id, assigned_manager_id
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        organizationId,
        projectId,
        reference,
        values.risk ?? 'medium',
        values.legal ?? 'unknown',
        values.acquisitionStatus ?? 'active',
        values.status ?? 'active',
        values.negotiator ?? null,
        values.manager ?? null,
      ],
    );
  }

  async function insertTask(
    organizationId: string,
    propertyId: string,
    title: string,
    values: { assignee?: string; status?: string; priority?: string; dueOn?: string; archived?: boolean; createdBy?: string },
  ) {
    return insertPropertyFixture(
      lamA,
      `insert into public.tasks (
          organization_id, property_id, title, status, priority, assigned_user_id, due_on, created_by_user_id, archived_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, case when $9 then timezone('utc', now()) end) returning id`,
      [
        organizationId,
        propertyId,
        title,
        values.status ?? 'open',
        values.priority ?? 'normal',
        values.assignee ?? null,
        values.dueOn ?? null,
        values.createdBy ?? lamA,
        values.archived ?? false,
      ],
    );
  }

  const setTimezone = (organizationId: string, timezone: string) =>
    insertPropertyFixture(adminC, `update public.organizations set timezone = $2 where id = $1 returning id`, [organizationId, timezone]);

  const insertProject = (organizationId: string, actor: string, code: string) =>
    asUser(pool, actor, async (client) =>
      (
        await client.query<{ id: string }>(
          `insert into public.projects (organization_id, code, name, status) values ($1, $2, 'Attention Program', 'active') returning id`,
          [organizationId, code],
        )
      ).rows[0].id,
    );

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const org = (key: string) =>
      bootstrapOrg(pool, `Att ${key} ${tag}`, `att-${key.toLowerCase()}-${tag}`, subject(`admin${key}`), `Att Admin ${key}`, `att-admin-${key.toLowerCase()}-${tag}@example.com`);
    ({ organization_id: orgA, user_id: adminA } = await org('A'));
    ({ organization_id: orgB, user_id: adminB } = await org('B'));
    ({ organization_id: orgC, user_id: adminC } = await org('C'));

    const user = (key: string, name: string) => syncUser(pool, subject(key), name, `att-${key.toLowerCase()}-${tag}@example.com`);
    lamA = await user('lam', 'Att LAM');
    supervisorScoped = await user('supScoped', 'Att Supervisor Scoped');
    supervisorOther = await user('supOther', 'Att Supervisor Other');
    negotiatorAssigned = await user('negAssigned', 'Att Negotiator Assigned');
    negotiatorOther = await user('negOther', 'Att Negotiator Other');
    legalA = await user('legal', 'Att Legal');
    financeA = await user('finance', 'Att Finance');
    viewerA = await user('viewer', 'Att Viewer');
    outsider = await user('outsider', 'Att Outsider');
    await addMember(pool, adminA, orgA, lamA, 'land_acquisition_manager');
    await addMember(pool, adminA, orgA, supervisorScoped, 'supervisor');
    await addMember(pool, adminA, orgA, supervisorOther, 'supervisor');
    await addMember(pool, adminA, orgA, negotiatorAssigned, 'negotiator');
    await addMember(pool, adminA, orgA, negotiatorOther, 'negotiator');
    await addMember(pool, adminA, orgA, legalA, 'legal_documentation');
    await addMember(pool, adminA, orgA, financeA, 'finance');
    await addMember(pool, adminA, orgA, viewerA, 'viewer');

    const projectA = await insertProject(orgA, lamA, 'ATT-A');
    const projectB = await insertProject(orgB, adminB, 'ATT-B');
    const projectC = await insertProject(orgC, adminC, 'ATT-C');

    // ATT-001 is the only property the scoped supervisor and the assigned negotiator can see.
    property.one = await insertProperty(orgA, projectA, 'ATT-001', { risk: 'high', legal: 'clear', negotiator: negotiatorAssigned, manager: supervisorScoped });
    property.two = await insertProperty(orgA, projectA, 'ATT-002', { risk: 'low', legal: 'blocked', acquisitionStatus: 'on_hold' });
    property.three = await insertProperty(orgA, projectA, 'ATT-003', { risk: 'high', legal: 'blocked' });
    // Not listed: closed, archived, or neither blocked nor high risk.
    property.withdrawn = await insertProperty(orgA, projectA, 'ATT-004', { risk: 'high', acquisitionStatus: 'withdrawn' });
    property.complete = await insertProperty(orgA, projectA, 'ATT-005', { risk: 'high', legal: 'blocked', acquisitionStatus: 'complete' });
    property.archived = await insertProperty(orgA, projectA, 'ATT-006', { risk: 'high', status: 'archived' });
    property.ordinary = await insertProperty(orgA, projectA, 'ATT-007', { risk: 'medium', legal: 'under_review' });
    // Lower case sorts after upper case in the byte order the list uses.
    property.lower = await insertProperty(orgA, projectA, 'att-000', { risk: 'high' });
    property.orgB = await insertProperty(orgB, projectB, 'ATT-001', { risk: 'high', legal: 'blocked' });

    task.overdue = await insertTask(orgA, property.one, 'Mine, due yesterday', { assignee: negotiatorAssigned, dueOn: '2026-03-10' });
    task.today = await insertTask(orgA, property.one, 'Mine, due today', { assignee: negotiatorAssigned, dueOn: '2026-03-11', status: 'in_progress', priority: 'high' });
    task.undated = await insertTask(orgA, property.one, 'Mine, no due date', { assignee: negotiatorAssigned, priority: 'urgent' });
    task.done = await insertTask(orgA, property.one, 'Mine, done', { assignee: negotiatorAssigned, dueOn: '2026-03-01', status: 'done' });
    task.cancelled = await insertTask(orgA, property.one, 'Mine, cancelled', { assignee: negotiatorAssigned, dueOn: '2026-03-01', status: 'cancelled' });
    task.archived = await insertTask(orgA, property.one, 'Mine, archived', { assignee: negotiatorAssigned, dueOn: '2026-03-01', archived: true });
    task.unassigned = await insertTask(orgA, property.two, 'Unassigned, late', { dueOn: '2026-03-05', priority: 'low' });
    task.legal = await insertTask(orgA, property.two, 'Legal, late', { assignee: legalA, dueOn: '2026-03-05', priority: 'urgent' });
    // Assigned to the negotiator on a property the negotiator cannot see.
    task.hidden = await insertTask(orgA, property.two, 'Negotiator, hidden property', { assignee: negotiatorAssigned, dueOn: '2026-03-02' });
    task.future = await insertTask(orgA, property.one, 'LAM, due later', { assignee: lamA, dueOn: '2026-03-20' });
    task.viewer = await insertTask(orgA, property.one, 'Viewer, late', { assignee: viewerA, dueOn: '2026-03-09' });
    task.orgB = await insertTask(orgB, property.orgB, 'Other organization, late', { assignee: adminB, dueOn: '2026-03-01', createdBy: adminB });

    // Organization C: more rows than one list returns.
    await insertPropertyFixture(
      adminC,
      `insert into public.properties (organization_id, project_id, property_reference, risk)
       select $1, $2, 'LIM-' || lpad(g::text, 3, '0'), 'high' from generate_series(1, 53) g returning id`,
      [orgC, projectC],
    );
    property.limit = await asUser(pool, adminC, async (client) =>
      (await client.query<{ id: string }>(`select id from public.properties where organization_id = $1 and property_reference = 'LIM-001'`, [orgC])).rows[0].id,
    );
    await insertPropertyFixture(
      adminC,
      `insert into public.tasks (organization_id, property_id, title, due_on, created_by_user_id)
       select $1, $2, 'Late ' || lpad(g::text, 3, '0'), date '2025-12-01' + g, $3 from generate_series(1, 52) g returning id`,
      [orgC, property.limit, adminC],
    );
    await insertPropertyFixture(
      adminC,
      `insert into public.tasks (organization_id, property_id, title, assigned_user_id, created_by_user_id)
       select $1, $2, 'Mine ' || lpad(g::text, 3, '0'), $3, $3 from generate_series(1, 51) g returning id`,
      [orgC, property.limit, adminC],
    );
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  it('lists my open tasks: assigned to me, open or in progress, not archived, earliest due date first and undated last', async () => {
    const result = await attention(negotiatorAssigned);
    expect(result.today).toBe('2026-03-11');
    expect(result.my_tasks.total).toBe(3);
    expect(result.my_tasks.items).toEqual([
      {
        id: task.overdue,
        property_id: property.one,
        property_reference: 'ATT-001',
        title: 'Mine, due yesterday',
        status: 'open',
        priority: 'normal',
        assigned_user_id: negotiatorAssigned,
        assigned_user_name: 'Att Negotiator Assigned',
        due_on: '2026-03-10',
        overdue: true,
      },
      {
        id: task.today,
        property_id: property.one,
        property_reference: 'ATT-001',
        title: 'Mine, due today',
        status: 'in_progress',
        priority: 'high',
        assigned_user_id: negotiatorAssigned,
        assigned_user_name: 'Att Negotiator Assigned',
        due_on: '2026-03-11',
        overdue: false,
      },
      {
        id: task.undated,
        property_id: property.one,
        property_reference: 'ATT-001',
        title: 'Mine, no due date',
        status: 'open',
        priority: 'urgent',
        assigned_user_id: negotiatorAssigned,
        assigned_user_name: 'Att Negotiator Assigned',
        due_on: null,
        overdue: false,
      },
    ]);
  });

  it('leaves out a task assigned to me on a property I cannot see', async () => {
    const result = await attention(negotiatorAssigned);
    expect(titles(result.my_tasks)).not.toContain('Negotiator, hidden property');
    // The same task is an overdue task of someone else for a user who can see the property.
    expect(titles((await attention(adminA)).overdue_tasks)).toContain('Negotiator, hidden property');
  });

  it('lists overdue tasks of other people and unassigned ones, never my own, with the most urgent first on the same day', async () => {
    const result = await attention(adminA);
    expect(result.my_tasks).toEqual({ total: 0, items: [] });
    expect(result.overdue_tasks.total).toBe(5);
    expect(result.overdue_tasks.items.map((item) => [item.title, item.due_on, item.assigned_user_id, item.assigned_user_name, item.overdue])).toEqual([
      ['Negotiator, hidden property', '2026-03-02', negotiatorAssigned, 'Att Negotiator Assigned', true],
      ['Legal, late', '2026-03-05', legalA, 'Att Legal', true],
      ['Unassigned, late', '2026-03-05', null, null, true],
      ['Viewer, late', '2026-03-09', viewerA, 'Att Viewer', true],
      ['Mine, due yesterday', '2026-03-10', negotiatorAssigned, 'Att Negotiator Assigned', true],
    ]);

    const legal = await attention(legalA);
    expect(titles(legal.my_tasks)).toEqual(['Legal, late']);
    expect(legal.my_tasks.items[0].overdue).toBe(true);
    expect(titles(legal.overdue_tasks)).toEqual(['Negotiator, hidden property', 'Unassigned, late', 'Viewer, late', 'Mine, due yesterday']);
    // No task is in both lists, for any role.
    for (const actor of [adminA, lamA, supervisorScoped, negotiatorAssigned, legalA, financeA, viewerA]) {
      const lists = await attention(actor);
      const mine = new Set(lists.my_tasks.items.map((item) => item.id));
      expect(lists.overdue_tasks.items.filter((item) => mine.has(item.id))).toEqual([]);
    }
  });

  it('never lists a task that is due today, undated, done, cancelled or archived as overdue', async () => {
    const result = await attention(adminA);
    const listed = titles(result.overdue_tasks);
    for (const title of ['Mine, due today', 'Mine, no due date', 'Mine, done', 'Mine, cancelled', 'Mine, archived', 'LAM, due later']) {
      expect(listed).not.toContain(title);
    }
    const mine = titles((await attention(negotiatorAssigned)).my_tasks);
    for (const title of ['Mine, done', 'Mine, cancelled', 'Mine, archived']) expect(mine).not.toContain(title);
  });

  it('decides overdue by the calendar day of the organization, on both sides of its midnight', async () => {
    const before = await attention(negotiatorAssigned, orgA, BEFORE_MIDNIGHT);
    expect(before.today).toBe('2026-03-10');
    expect(before.my_tasks.items.map((item) => [item.title, item.overdue])).toEqual([
      ['Mine, due yesterday', false],
      ['Mine, due today', false],
      ['Mine, no due date', false],
    ]);
    expect(titles((await attention(supervisorScoped, orgA, BEFORE_MIDNIGHT)).overdue_tasks)).toEqual(['Viewer, late']);

    const after = await attention(negotiatorAssigned, orgA, AT);
    expect(after.today).toBe('2026-03-11');
    expect(after.my_tasks.items[0]).toMatchObject({ title: 'Mine, due yesterday', overdue: true });
    expect(titles((await attention(supervisorScoped, orgA, AT)).overdue_tasks)).toEqual(['Viewer, late', 'Mine, due yesterday']);
  });

  it('lists blocked or high-risk properties still being acquired, in reference order, and no closed or archived one', async () => {
    const result = await attention(adminA);
    expect(result.properties.total).toBe(4);
    expect(result.properties.items).toEqual([
      { id: property.one, property_reference: 'ATT-001', acquisition_stage: 'identified', acquisition_status: 'active', risk: 'high', legal_status: 'clear' },
      { id: property.two, property_reference: 'ATT-002', acquisition_stage: 'identified', acquisition_status: 'on_hold', risk: 'low', legal_status: 'blocked' },
      { id: property.three, property_reference: 'ATT-003', acquisition_stage: 'identified', acquisition_status: 'active', risk: 'high', legal_status: 'blocked' },
      { id: property.lower, property_reference: 'att-000', acquisition_stage: 'identified', acquisition_status: 'active', risk: 'high', legal_status: 'unknown' },
    ]);
  });

  it('shows each role exactly what it can already see', async () => {
    const everything = { mine: [] as string[], overdue: ['Negotiator, hidden property', 'Legal, late', 'Unassigned, late', 'Viewer, late', 'Mine, due yesterday'], properties: ['ATT-001', 'ATT-002', 'ATT-003', 'att-000'] };
    const nothing = { mine: [], overdue: [], properties: [] };
    const expected: Array<[string, string, { mine: string[]; overdue: string[]; properties: string[] }]> = [
      ['system_admin', adminA, everything],
      ['land_acquisition_manager', lamA, { ...everything, mine: ['LAM, due later'] }],
      ['finance', financeA, everything],
      ['legal_documentation', legalA, { ...everything, mine: ['Legal, late'], overdue: everything.overdue.filter((title) => title !== 'Legal, late') }],
      ['viewer', viewerA, { ...everything, mine: ['Viewer, late'], overdue: everything.overdue.filter((title) => title !== 'Viewer, late') }],
      ['supervisor of the property', supervisorScoped, { mine: [], overdue: ['Viewer, late', 'Mine, due yesterday'], properties: ['ATT-001'] }],
      ['assigned negotiator', negotiatorAssigned, { mine: ['Mine, due yesterday', 'Mine, due today', 'Mine, no due date'], overdue: ['Viewer, late'], properties: ['ATT-001'] }],
      ['supervisor of nothing', supervisorOther, nothing],
      ['negotiator of nothing', negotiatorOther, nothing],
    ];
    for (const [label, actor, lists] of expected) {
      const result = await attention(actor);
      expect([label, titles(result.my_tasks), titles(result.overdue_tasks), references(result.properties)]).toEqual([label, lists.mine, lists.overdue, lists.properties]);
      expect([result.my_tasks.total, result.overdue_tasks.total, result.properties.total]).toEqual([lists.mine.length, lists.overdue.length, lists.properties.length]);
    }
    // Someone outside the organization cannot even read the organization row.
    for (const actor of [adminB, outsider]) {
      await expect(attention(actor)).rejects.toMatchObject({ status: 404, message: 'Organization not found' });
    }
  });

  it('keeps organizations apart', async () => {
    const result = await attention(adminB, orgB);
    expect(titles(result.my_tasks)).toEqual(['Other organization, late']);
    expect(result.overdue_tasks).toEqual({ total: 0, items: [] });
    expect(result.properties.items.map((item) => item.id)).toEqual([property.orgB]);
    await expect(attention(adminA, orgB)).rejects.toMatchObject({ status: 404 });
  });

  it('returns at most the list limit and the full count of each list', async () => {
    const result = await attention(adminC, orgC);
    expect(ATTENTION_LIST_LIMIT).toBe(50);
    expect(result.properties.total).toBe(53);
    expect(references(result.properties)).toEqual(Array.from({ length: 50 }, (_, index) => `LIM-${String(index + 1).padStart(3, '0')}`));
    expect(result.overdue_tasks.total).toBe(52);
    expect(titles(result.overdue_tasks)).toEqual(Array.from({ length: 50 }, (_, index) => `Late ${String(index + 1).padStart(3, '0')}`));
    expect(result.my_tasks.total).toBe(51);
    expect(result.my_tasks.items).toHaveLength(50);
    // Same due date and priority: ordered by id.
    const ids = result.my_tasks.items.map((item) => item.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('uses the organization timezone for today, and UTC when PostgreSQL does not recognize it', async () => {
    try {
      await setTimezone(orgC, 'America/New_York');
      // 03:00 UTC on 2026-03-10 is still 2026-03-09 in New York.
      expect((await attention(adminC, orgC, new Date('2026-03-10T03:00:00Z'))).today).toBe('2026-03-09');

      await setTimezone(orgC, 'Not/AZone');
      const fallback = await attention(adminC, orgC, AT);
      // 16:30 UTC on 2026-03-10: Manila would already be on the 11th.
      expect(fallback.today).toBe('2026-03-10');
      // The lists are still read in the same transaction after the fallback.
      expect(fallback.properties.total).toBe(53);
      expect((await call('adminC', `/ops/attention?organizationId=${orgC}`)).status).toBe(200);
    } finally {
      await setTimezone(orgC, 'Asia/Manila');
    }
  });

  it('changes nothing', async () => {
    const snapshot = async () =>
      asUser(pool, adminA, async (client) =>
        (
          await client.query(
            `select (select count(*) from public.tasks where organization_id = $1) as tasks,
                    (select max(updated_at) from public.tasks where organization_id = $1) as task_change,
                    (select max(updated_at) from public.properties where organization_id = $1) as property_change,
                    (select count(*) from public.property_lifecycle_history where organization_id = $1) as history`,
            [orgA],
          )
        ).rows[0],
      );
    const before = await snapshot();
    await attention(adminA);
    expect((await call('adminA', `/ops/attention?organizationId=${orgA}`)).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  describe('GET /ops/attention', () => {
    it('returns the lists of the caller with today in the organization timezone', async () => {
      const days = async () =>
        (await pool.query<{ today: string }>(`select to_char((now() at time zone 'Asia/Manila')::date, 'YYYY-MM-DD') as today`)).rows[0].today;
      const earliest = await days();
      const response = await call('negAssigned', `/ops/attention?organizationId=${orgA}`);
      const latest = await days();
      expect(response.status).toBe(200);
      const data = response.body.data as Attention;
      expect(Object.keys(data).sort()).toEqual(['my_tasks', 'overdue_tasks', 'properties', 'today']);
      expect([earliest, latest]).toContain(data.today);
      expect(data.my_tasks.total).toBe(3);
      expect(data.my_tasks.items.map((item) => item.id)).toEqual([task.overdue, task.today, task.undated]);
      // Every dated fixture task is in the past by now.
      expect(data.my_tasks.items.map((item) => item.overdue)).toEqual([true, true, false]);
      expect(data.overdue_tasks.items.map((item) => item.id)).toEqual([task.viewer, task.future]);
      expect(data.properties).toEqual({
        total: 1,
        items: [{ id: property.one, property_reference: 'ATT-001', acquisition_stage: 'identified', acquisition_status: 'active', risk: 'high', legal_status: 'clear' }],
      });
    });

    it('refuses a caller who is not a member of the organization, and a request without one', async () => {
      const outside = await call('adminB', `/ops/attention?organizationId=${orgA}`);
      expect(outside.status).toBe(403);
      expect(outside.body.data).toBeUndefined();
      expect((await call('adminA', '/ops/attention')).status).toBe(400);
      expect((await call('adminA', '/ops/attention?organizationId=not-a-uuid')).status).toBe(400);
      expect((await call(null, `/ops/attention?organizationId=${orgA}`)).status).toBe(401);
    });
  });
});
