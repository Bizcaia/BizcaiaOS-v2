import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import '../loadEnv.js';
import { runMigrations } from '../migrate.js';
import { addMember, bootstrapOrg, createAppPool, requireDatabaseEnv, syncUser } from './postgresHarness.js';

// What the live application reads, through the real Express app and PostgreSQL:
// date-only fields come back as the stored day whatever the server timezone,
// the Dashboard counts cover every property the caller can see, and the
// property list can be read to its end in pages that never repeat or skip a row.

process.env.NODE_ENV = 'test';
process.env.AUTH_JWKS_URL ??= 'https://example.invalid/.well-known/jwks.json';
process.env.AUTH_ISSUER ??= 'https://example.invalid';
process.env.AUTH_AUDIENCE ??= 'bizcaiaos-api';

const tag = randomUUID().slice(0, 8);
const subject = (who: string) => `test|live-${who}-${tag}`;
const WHO = ['adminA', 'lam', 'sup', 'supOther', 'neg', 'negOther', 'legal', 'finance', 'viewer', 'adminB', 'outsider'] as const;
type Who = (typeof WHO)[number];
const tokens: Record<string, string> = Object.fromEntries(WHO.map((who) => [`token-${who}`, subject(who)]));

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async (token: string) => {
    const sub = tokens[token];
    if (!sub) throw new Error('invalid token');
    return { payload: { sub, email: `${sub.replace('|', '.')}@example.com`, name: sub } };
  }),
}));

const { app } = await import('../index.js');

const STAGES = [
  'identified', 'initial_contact', 'owner_validation', 'property_validation', 'documentation', 'negotiation', 'commercial_review',
  'legal_review', 'agreement_preparation', 'signing', 'payment_closing', 'acquisition_complete', 'on_hold', 'withdrawn',
];
const PROPERTY_COUNT = 120;

type Row = {
  id: string;
  project_id: string;
  property_reference: string;
  lot_number: string | null;
  municipality: string | null;
  barangay: string | null;
  acquisition_stage: string;
  acquisition_status: string;
  legal_status: string;
  risk: string;
  readiness_percent: number;
  status: string;
  assigned_negotiator_id: string | null;
  assigned_manager_id: string | null;
  changed: string;
};

/** Small seeded generator, so the same properties are built on every run. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('live-mode correctness against real PostgreSQL', () => {
  const originalTimezone = process.env.TZ;
  const pool = createAppPool();
  let owner: pg.Client;
  let server: http.Server;
  let base: string;
  let orgA: string;
  let orgB: string;
  const users = {} as Record<Who, string>;
  let projectOne: string;
  let projectTwo: string;
  let rows: Row[] = [];
  const dated: Record<string, string> = {};

  async function call(who: Who | null, method: string, path: string, body?: unknown) {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { ...(who ? { Authorization: `Bearer token-${who}` } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const get = (who: Who | null, path: string) => call(who, 'GET', path);

  /** The properties a role can see, by the same rule the row-level security applies. */
  function visible(who: Who): Row[] {
    switch (who) {
      case 'adminA':
      case 'lam':
      case 'legal':
      case 'finance':
      case 'viewer':
        return rows;
      case 'sup':
        return rows.filter((row) => row.assigned_manager_id === users.sup || row.project_id === projectTwo);
      case 'supOther':
        return rows.filter((row) => row.assigned_manager_id === users.supOther);
      case 'neg':
      case 'negOther':
        return rows.filter((row) => row.assigned_negotiator_id === users[who]);
      default:
        return [];
    }
  }

  /** The list order: most recently changed first, then by id. */
  const ordered = (list: Row[]) => [...list].sort((a, b) => (a.changed !== b.changed ? (a.changed < b.changed ? 1 : -1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  /** The counts GET /ops/dashboard defines, computed here from the rows. */
  function expectedDashboard(list: Row[]) {
    const active = list.filter((row) => row.acquisition_status === 'active');
    return {
      total: String(list.filter((row) => row.status === 'active').length),
      active: String(active.length),
      negotiation: String(list.filter((row) => row.acquisition_stage === 'negotiation').length),
      blocked: String(list.filter((row) => row.legal_status === 'blocked' || row.risk === 'high').length),
      ready: String(active.filter((row) => row.readiness_percent >= 80).length),
      stages: STAGES.map((stage) => ({ acquisition_stage: stage, count: String(active.filter((row) => row.acquisition_stage === stage).length) })).filter(
        (entry) => entry.count !== '0',
      ),
    };
  }

  /** Reads the whole list in pages of `limit`, as the screen's "Load more" does. */
  async function readAll(who: Who, filters: Record<string, string>, limit: number) {
    const pages: string[][] = [];
    for (let offset = 0; ; offset += limit) {
      const query = new URLSearchParams({ organizationId: orgA, ...filters, limit: String(limit), offset: String(offset) });
      const response = await get(who, `/ops/properties?${query}`);
      expect(response.status).toBe(200);
      const ids = (response.body.data as Array<{ id: string }>).map((property) => property.id);
      pages.push(ids);
      if (ids.length < limit) return pages;
      expect(pages.length).toBeLessThan(40);
    }
  }

  async function loadRows() {
    rows = (
      await owner.query<Row>(
        `select id, project_id, property_reference, lot_number, municipality, barangay, acquisition_stage::text, acquisition_status::text,
                legal_status::text, risk::text, readiness_percent, status::text, assigned_negotiator_id, assigned_manager_id,
                to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') as changed
           from public.properties where organization_id = $1`,
        [orgA],
      )
    ).rows;
  }

  beforeAll(async () => {
    const { migrateUrl } = requireDatabaseEnv();
    await runMigrations();
    owner = new pg.Client({ connectionString: migrateUrl });
    await owner.connect();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const org = (who: 'adminA' | 'adminB') => bootstrapOrg(pool, `Live ${who} ${tag}`, `live-${who.toLowerCase()}-${tag}`, subject(who), `Live ${who}`, `live-${who.toLowerCase()}-${tag}@example.com`);
    ({ organization_id: orgA, user_id: users.adminA } = await org('adminA'));
    ({ organization_id: orgB, user_id: users.adminB } = await org('adminB'));
    const roles: Array<[Who, string]> = [
      ['lam', 'land_acquisition_manager'],
      ['sup', 'supervisor'],
      ['supOther', 'supervisor'],
      ['neg', 'negotiator'],
      ['negOther', 'negotiator'],
      ['legal', 'legal_documentation'],
      ['finance', 'finance'],
      ['viewer', 'viewer'],
    ];
    for (const [who, role] of roles) {
      users[who] = await syncUser(pool, subject(who), `Live ${who}`, `live-${who.toLowerCase()}-${tag}@example.com`);
      await addMember(pool, users.adminA, orgA, users[who], role);
    }
    users.outsider = await syncUser(pool, subject('outsider'), 'Live outsider', `live-outsider-${tag}@example.com`);

    // Projects are created through the API with their dates.
    const one = await call('adminA', 'POST', '/ops/projects', { organizationId: orgA, code: `LIVE-1-${tag}`, name: 'Live One', startsOn: '2026-09-26', targetCompletionOn: '2027-01-31' });
    const two = await call('adminA', 'POST', '/ops/projects', { organizationId: orgA, code: `LIVE-2-${tag}`, name: 'Live Two', managerUserId: users.sup });
    expect([one.status, two.status]).toEqual([201, 201]);
    projectOne = one.body.data.id;
    projectTwo = two.body.data.id;
    dated.projectCreated = JSON.stringify([one.body.data.starts_on, one.body.data.target_completion_on, two.body.data.starts_on, two.body.data.target_completion_on]);

    // 120 properties written in one transaction, so they all share one change time and only the id orders them.
    const random = mulberry32(20261007);
    const pick = <T,>(values: T[]) => values[Math.floor(random() * values.length)];
    await owner.query('begin');
    await owner.query("select set_config('app.user_id', $1, true)", [users.lam]);
    for (let index = 0; index < PROPERTY_COUNT; index += 1) {
      await owner.query(
        `insert into public.properties (
            organization_id, project_id, property_reference, lot_number, municipality, barangay, acquisition_stage, acquisition_status,
            legal_status, risk, readiness_percent, status, assigned_negotiator_id, assigned_manager_id
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          orgA,
          pick([projectOne, projectOne, projectTwo]),
          `LIVE-${String(index).padStart(3, '0')}`,
          pick([null, `Lot ${index}`, 'Lot Calamba']),
          pick([null, 'Calamba', 'Santa Rosa', 'Biñan']),
          pick([null, 'Pansol', 'calamba east']),
          pick(STAGES),
          pick(['active', 'active', 'active', 'on_hold', 'withdrawn', 'complete']),
          pick(['unknown', 'clear', 'under_review', 'blocked']),
          pick(['low', 'medium', 'high']),
          pick([0, 35, 79, 80, 81, 100]),
          pick(['active', 'active', 'active', 'active', 'archived']),
          pick([null, users.neg, users.negOther]),
          pick([null, null, users.sup, users.supOther]),
        ],
      );
    }
    await owner.query('commit');
    // A few are changed afterwards, one by one, so they lead the list in the order they were changed.
    await loadRows();
    for (const row of rows.slice(0, 7)) {
      await owner.query(`update public.properties set readiness_percent = readiness_percent where id = $1`, [row.id]);
    }
    await loadRows();

    const projectB = await owner.query<{ id: string }>(`insert into public.projects (organization_id, code, name, status) values ($1, 'LIVE-B', 'Live B', 'active') returning id`, [orgB]);
    const propertyB = await owner.query<{ id: string }>(
      `insert into public.properties (organization_id, project_id, property_reference, risk, legal_status) values ($1, $2, 'LIVE-B', 'high', 'blocked') returning id`,
      [orgB, projectB.rows[0].id],
    );
    dated.propertyB = propertyB.rows[0].id;

    // One property carries the dated records, written directly so the stored values are known.
    const property = rows.find((row) => row.assigned_negotiator_id === users.neg && row.status === 'active')!.id;
    dated.property = property;
    const insert = async (sql: string, params: unknown[]) => (await owner.query<{ id: string }>(sql, params)).rows[0].id;
    dated.task = await insert(`insert into public.tasks (organization_id, property_id, title, due_on, created_by_user_id) values ($1,$2,'Dated task','2026-09-26',$3) returning id`, [orgA, property, users.lam]);
    dated.undatedTask = await insert(`insert into public.tasks (organization_id, property_id, title, created_by_user_id) values ($1,$2,'Undated task',$3) returning id`, [orgA, property, users.lam]);
    dated.payment = await insert(
      `insert into public.payments (organization_id, property_id, amount, payment_type, status, scheduled_on, paid_on, recorded_by_user_id)
       values ($1,$2,1000,'deposit','paid','2026-09-26','2026-12-31',$3) returning id`,
      [orgA, property, users.lam],
    );
    const document = await insert(
      `insert into public.documents (organization_id, property_id, category, title, original_filename, content_type, size_bytes, storage_key, uploaded_by_user_id)
       values ($1,$2,'agreement_executed','Signed agreement','agreement.pdf','application/pdf',1024,$3,$4) returning id`,
      [orgA, property, `live/${randomUUID()}.pdf`, users.lam],
    );
    const ownerId = await insert(`insert into public.owners (organization_id, owner_type, display_name) values ($1,'individual','Live Owner') returning id`, [orgA]);
    await owner.query(`insert into public.property_owners (property_id, owner_id, is_primary) values ($1, $2, true)`, [property, ownerId]);
    dated.signature = await insert(
      `insert into public.agreement_signatures (organization_id, property_id, document_id, owner_id, signed_on, recorded_by_user_id)
       values ($1,$2,$3,$4,'2026-01-01',$5) returning id`,
      [orgA, property, document, ownerId, users.lam],
    );
  }, 180_000);

  afterAll(async () => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await owner.end();
    await pool.end();
  });

  describe('date-only fields', () => {
    async function readDates() {
      const tasks = (await get('adminA', `/ops/properties/${dated.property}/tasks`)).body.data as Array<{ id: string; due_on: string | null }>;
      const payments = (await get('adminA', `/ops/properties/${dated.property}/payments`)).body.data as Array<{ id: string; scheduled_on: string | null; paid_on: string | null }>;
      const signatures = (await get('adminA', `/ops/properties/${dated.property}/agreement-signatures`)).body.data as Array<{ id: string; signed_on: string }>;
      const projects = (await get('adminA', `/ops/projects?organizationId=${orgA}`)).body.data as Array<{ id: string; starts_on: string | null; target_completion_on: string | null }>;
      const payment = payments.find((entry) => entry.id === dated.payment)!;
      const project = projects.find((entry) => entry.id === projectOne)!;
      const undatedProject = projects.find((entry) => entry.id === projectTwo)!;
      return {
        task: tasks.find((entry) => entry.id === dated.task)!.due_on,
        undatedTask: tasks.find((entry) => entry.id === dated.undatedTask)!.due_on,
        scheduled: payment.scheduled_on,
        paid: payment.paid_on,
        signed: signatures.find((entry) => entry.id === dated.signature)!.signed_on,
        projectStart: project.starts_on,
        projectTarget: project.target_completion_on,
        undatedProject: [undatedProject.starts_on, undatedProject.target_completion_on],
      };
    }
    const stored = {
      task: '2026-09-26',
      undatedTask: null,
      scheduled: '2026-09-26',
      paid: '2026-12-31',
      signed: '2026-01-01',
      projectStart: '2026-09-26',
      projectTarget: '2027-01-31',
      undatedProject: [null, null],
    };

    it('returns each stored day exactly, with the server in UTC and in zones east and west of it', async () => {
      const offsets = new Set<number>();
      try {
        for (const zone of ['UTC', 'Asia/Manila', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
          process.env.TZ = zone;
          offsets.add(new Date(2026, 8, 26).getTimezoneOffset());
          expect([zone, await readDates()]).toEqual([zone, stored]);
        }
      } finally {
        if (originalTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = originalTimezone;
      }
      // The server really ran in more than one timezone, at least one of them not UTC.
      expect(offsets.size).toBeGreaterThan(1);
      expect([...offsets].some((offset) => offset !== 0)).toBe(true);
    });

    it('returns the day that was sent when a dated record is created or changed through the API', async () => {
      expect(dated.projectCreated).toBe(JSON.stringify(['2026-09-26', '2027-01-31', null, null]));

      const created = await call('lam', 'POST', `/ops/properties/${dated.property}/tasks`, { title: 'Created with a date', dueOn: '2026-03-01' });
      expect(created.status).toBe(201);
      expect(created.body.data.due_on).toBe('2026-03-01');
      const moved = await call('lam', 'PATCH', `/ops/tasks/${created.body.data.id}`, { dueOn: '2028-02-29' });
      expect([moved.status, moved.body.data.due_on]).toEqual([200, '2028-02-29']);
      const cleared = await call('lam', 'PATCH', `/ops/tasks/${created.body.data.id}`, { dueOn: null });
      expect([cleared.status, cleared.body.data.due_on]).toEqual([200, null]);

      const payment = await call('finance', 'POST', `/ops/properties/${dated.property}/payments`, { amount: 2500, paymentType: 'installment', scheduledOn: '2026-10-31' });
      expect(payment.status).toBe(201);
      expect([payment.body.data.scheduled_on, payment.body.data.paid_on]).toEqual(['2026-10-31', null]);
    });

    it('leaves timestamps as timestamps', async () => {
      const tasks = (await get('adminA', `/ops/properties/${dated.property}/tasks`)).body.data as Array<{ id: string; created_at: string }>;
      expect(tasks.find((entry) => entry.id === dated.task)!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe('Dashboard counts', () => {
    it.each(['adminA', 'lam', 'legal', 'finance', 'viewer', 'sup', 'neg', 'supOther', 'negOther'] as const)(
      'gives %s the counts of exactly the properties it can see',
      async (who) => {
        const response = await get(who, `/ops/dashboard?organizationId=${orgA}`);
        expect(response.status).toBe(200);
        expect(response.body.data).toEqual(expectedDashboard(visible(who)));
      },
    );

    it('counts more than one page of properties, and the fixture exercises every definition', async () => {
      const everything = expectedDashboard(rows);
      expect(rows).toHaveLength(PROPERTY_COUNT);
      // Archived records leave the total; closed properties leave active, ready and the stages.
      expect(Number(everything.total)).toBeGreaterThan(50);
      expect(Number(everything.total)).toBeLessThan(PROPERTY_COUNT);
      expect(Number(everything.active)).toBeLessThan(PROPERTY_COUNT);
      expect(Number(everything.ready)).toBeGreaterThan(0);
      expect(Number(everything.ready)).toBeLessThan(rows.filter((row) => row.readiness_percent >= 80).length);
      expect(everything.stages.reduce((sum, entry) => sum + Number(entry.count), 0)).toBe(Number(everything.active));
      // Scoped roles see a proper, non-empty part of it.
      for (const who of ['sup', 'neg'] as const) {
        expect(visible(who).length).toBeGreaterThan(0);
        expect(visible(who).length).toBeLessThan(PROPERTY_COUNT);
      }
    });

    it('is refused outside the organization', async () => {
      expect((await get('adminB', `/ops/dashboard?organizationId=${orgA}`)).status).toBe(403);
      expect((await get('outsider', `/ops/dashboard?organizationId=${orgA}`)).status).toBe(403);
      expect((await get(null, `/ops/dashboard?organizationId=${orgA}`)).status).toBe(401);
      expect((await get('adminB', `/ops/dashboard?organizationId=${orgB}`)).body.data).toMatchObject({ total: '1', active: '1', blocked: '1' });
    });
  });

  describe('property list', () => {
    it('reaches all 120 properties exactly once in pages of 50, in a fixed order', async () => {
      const pages = await readAll('adminA', {}, 50);
      expect(pages.map((page) => page.length)).toEqual([50, 50, 20]);
      const ids = pages.flat();
      expect(new Set(ids).size).toBe(PROPERTY_COUNT);
      expect(ids).toEqual(ordered(rows).map((row) => row.id));
      // Most of them share one change time, so only the id orders them.
      expect(new Set(rows.map((row) => row.changed)).size).toBeLessThan(10);
      // Reading again gives the same pages.
      expect(await readAll('adminA', {}, 50)).toEqual(pages);
    });

    it('returns 50 rows when no page size is sent, and the same rows for any page size', async () => {
      const first = await get('adminA', `/ops/properties?organizationId=${orgA}`);
      expect(first.status).toBe(200);
      const expected = ordered(rows).map((row) => row.id);
      expect((first.body.data as Array<{ id: string }>).map((property) => property.id)).toEqual(expected.slice(0, 50));
      for (const limit of [1, 7, 50, 119, 120, 200]) {
        if (limit === 1) {
          const single = await get('adminA', `/ops/properties?organizationId=${orgA}&limit=1&offset=57`);
          expect((single.body.data as Array<{ id: string }>).map((property) => property.id)).toEqual([expected[57]]);
        } else {
          expect((await readAll('adminA', {}, limit)).flat()).toEqual(expected);
        }
      }
    });

    it.each(['adminA', 'lam', 'legal', 'finance', 'viewer', 'sup', 'neg', 'supOther', 'negOther'] as const)(
      'pages %s through exactly the properties it can see',
      async (who) => {
        expect((await readAll(who, {}, 50)).flat()).toEqual(ordered(visible(who)).map((row) => row.id));
      },
    );

    it('restarts from the first page for each filter and reaches every match once', async () => {
      const matches = (row: Row, text: string) =>
        [row.property_reference, row.lot_number ?? '', row.municipality ?? '', row.barangay ?? ''].some((value) => value.toLowerCase().includes(text.toLowerCase()));
      const cases: Array<[Record<string, string>, (row: Row) => boolean]> = [
        [{ stage: 'negotiation' }, (row) => row.acquisition_stage === 'negotiation'],
        [{ projectId: projectTwo }, (row) => row.project_id === projectTwo],
        [{ search: 'calamba' }, (row) => matches(row, 'calamba')],
        [{ search: 'LIVE-1' }, (row) => matches(row, 'LIVE-1')],
        [{ projectId: projectOne, stage: 'identified', search: 'lot' }, (row) => row.project_id === projectOne && row.acquisition_stage === 'identified' && matches(row, 'lot')],
      ];
      for (const [filters, rule] of cases) {
        for (const who of ['adminA', 'sup', 'neg'] as const) {
          const expected = ordered(visible(who).filter(rule)).map((row) => row.id);
          expect([filters, who, (await readAll(who, filters, 50)).flat()]).toEqual([filters, who, expected]);
          expect([filters, who, (await readAll(who, filters, 9)).flat()]).toEqual([filters, who, expected]);
        }
      }
      expect(ordered(rows.filter((row) => matches(row, 'calamba'))).length).toBeGreaterThan(50);
    });

    it('moves a changed property to the front without losing or repeating any other', async () => {
      const before = (await readAll('adminA', {}, 50)).flat();
      const target = before[90];
      expect((await call('lam', 'PATCH', `/ops/properties/${target}`, { readinessPercent: 55 })).status).toBe(200);
      await loadRows();
      const after = (await readAll('adminA', {}, 50)).flat();
      expect(after[0]).toBe(target);
      expect(after.slice(1)).toEqual(before.filter((id) => id !== target));
      expect(after).toEqual(ordered(rows).map((row) => row.id));
    });

    it('accepts the request the screen sends and refuses an unset filter sent as text', async () => {
      const sent = await get('adminA', `/ops/properties?organizationId=${orgA}&limit=50&offset=0`);
      expect(sent.status).toBe(200);
      expect((await get('adminA', `/ops/properties?organizationId=${orgA}&search=&stage=undefined&projectId=undefined`)).status).toBe(400);
      expect((await get('adminA', `/ops/properties?organizationId=${orgA}&limit=201`)).status).toBe(400);
      expect((await get('adminA', `/ops/properties?organizationId=${orgA}&offset=-1`)).status).toBe(400);
      expect((await get('adminB', `/ops/properties?organizationId=${orgA}`)).status).toBe(403);
      expect(((await get('adminB', `/ops/properties?organizationId=${orgB}`)).body.data as Array<{ id: string }>).map((property) => property.id)).toEqual([dated.propertyB]);
    });
  });
});
