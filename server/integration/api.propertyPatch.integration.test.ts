import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import '../loadEnv.js';
import { runMigrations } from '../migrate.js';
import { addMember, createAppPool, requireDatabaseEnv, syncUser } from './postgresHarness.js';

// PATCH /ops/properties/:id through the real Express app and PostgreSQL: a
// field the request omits keeps its stored value. In particular an omitted
// risk is never reset to the creation default, and roles that may not change
// risk (legal_documentation, finance) can still update their own fields.

process.env.NODE_ENV = 'test';
process.env.AUTH_JWKS_URL ??= 'https://example.invalid/.well-known/jwks.json';
process.env.AUTH_ISSUER ??= 'https://example.invalid';
process.env.AUTH_AUDIENCE ??= 'bizcaiaos-api';

const tag = randomUUID().slice(0, 8);
const subjects: Record<string, string> = Object.fromEntries(
  ['adminA', 'lam', 'sup', 'legal', 'finance', 'neg', 'adminB'].map((who) => [`token-${who}`, `test|patch-${who}-${tag}`]),
);

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async (token: string) => {
    const sub = subjects[token];
    if (!sub) throw new Error('invalid token');
    return { payload: { sub, email: `${sub.replace('|', '.')}@example.com`, name: sub } };
  }),
}));

const { app } = await import('../index.js');

type Who = 'adminA' | 'lam' | 'sup' | 'legal' | 'finance' | 'neg' | 'adminB';

describe('property PATCH against real PostgreSQL', () => {
  let server: http.Server;
  let base: string;
  let owner: pg.Pool;
  let appPool: pg.Pool;
  const ids: Record<string, string> = {};

  async function call(who: Who, method: string, path: string, body?: unknown) {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer token-${who}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  const patch = (who: Who, body: unknown) => call(who, 'PATCH', `/ops/properties/${ids.property}`, body);

  async function stored() {
    const result = await owner.query(
      `select organization_id, project_id, property_reference, risk, readiness_percent, municipality,
              legal_status, documentation_status, payment_status, updated_at
         from public.properties where id = $1`,
      [ids.property],
    );
    return result.rows[0];
  }

  /** Sets a known risk through the API (as the land acquisition manager) before each case. */
  async function resetRisk(risk: 'low' | 'medium' | 'high') {
    expect((await patch('lam', { risk })).status).toBe(200);
    expect((await stored()).risk).toBe(risk);
  }

  beforeAll(async () => {
    const { migrateUrl } = requireDatabaseEnv();
    await runMigrations();
    owner = new pg.Pool({ connectionString: migrateUrl, max: 2 });
    appPool = createAppPool();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const who of ['adminA', 'adminB'] as const) {
      const onboard = await call(who, 'POST', '/organizations/onboard', {
        name: `Patch Org ${who} ${tag}`,
        slug: `patch-${who.toLowerCase()}-${tag}`,
        timezone: 'Asia/Manila',
      });
      expect(onboard.status).toBe(201);
      ids[`org-${who}`] = onboard.body.organizationId ?? onboard.body.data?.organizationId;
    }
    ids.adminA = (await call('adminA', 'GET', `/organizations/${ids['org-adminA']}/members`)).body.data[0].user_id;
    const roles = { lam: 'land_acquisition_manager', sup: 'supervisor', legal: 'legal_documentation', finance: 'finance', neg: 'negotiator' };
    for (const [who, role] of Object.entries(roles)) {
      ids[who] = await syncUser(appPool, subjects[`token-${who}`], who, `${who}-${tag}@example.com`);
      await addMember(appPool, ids.adminA, ids['org-adminA'], ids[who], role);
    }
    const project = await call('adminA', 'POST', '/ops/projects', {
      organizationId: ids['org-adminA'],
      code: `PATCH-${tag}`,
      name: 'Patch Project',
      managerUserId: ids.sup,
    });
    expect(project.status).toBe(201);
    ids.project = project.body.data.id;
    const property = await call('adminA', 'POST', '/ops/properties', {
      organizationId: ids['org-adminA'],
      projectId: ids.project,
      propertyReference: `PATCH-${tag}`,
      risk: 'high',
    });
    expect(property.status).toBe(201);
    expect(property.body.data.risk).toBe('high');
    ids.property = property.body.data.id;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await owner.end();
    await appPool.end();
  });

  it.each([
    ['land_acquisition_manager', 'lam', { readinessPercent: 30 }, { readiness_percent: 30 }],
    ['system_admin', 'adminA', { municipality: 'Calamba' }, { municipality: 'Calamba' }],
    ['supervisor (project manager)', 'sup', { readinessPercent: 40 }, { readiness_percent: 40 }],
  ] as const)('a %s update of another field keeps the stored risk', async (_label, who, body, expected) => {
    await resetRisk('high');
    const response = await patch(who, body);
    expect(response.status).toBe(200);
    expect(response.body.data.risk).toBe('high');
    expect(await stored()).toMatchObject({ ...expected, risk: 'high' });
  });

  it('legal_documentation updates legal and documentation status; risk is kept', async () => {
    await resetRisk('low');
    const response = await patch('legal', { legalStatus: 'clear', documentationStatus: 'in_review' });
    expect(response.status).toBe(200);
    expect(await stored()).toMatchObject({ legal_status: 'clear', documentation_status: 'in_review', risk: 'low' });
  });

  it('finance updates payment status; risk is kept', async () => {
    await resetRisk('high');
    const response = await patch('finance', { paymentStatus: 'in_progress' });
    expect(response.status).toBe(200);
    expect(await stored()).toMatchObject({ payment_status: 'in_progress', risk: 'high' });
  });

  it('an explicit risk is written', async () => {
    await resetRisk('high');
    const response = await patch('lam', { risk: 'low' });
    expect(response.status).toBe(200);
    expect((await stored()).risk).toBe('low');
  });

  it.each([
    ['legal_documentation', 'legal'],
    ['finance', 'finance'],
  ] as const)('%s still cannot change risk', async (_label, who) => {
    await resetRisk('high');
    const before = await stored();
    expect((await patch(who, { risk: 'low' })).status).toBe(403);
    expect(await stored()).toEqual(before);
  });

  it.each([null, 0, 'critical'])('rejects risk %j with 400 and changes nothing', async (risk) => {
    await resetRisk('high');
    const before = await stored();
    expect((await patch('lam', { risk })).status).toBe(400);
    expect(await stored()).toEqual(before);
  });

  it('an empty body, or only ignored keys, changes nothing', async () => {
    await resetRisk('high');
    const before = await stored();
    expect((await patch('lam', {})).status).toBe(200);
    expect(
      (await patch('lam', { organizationId: ids['org-adminB'], projectId: randomUUID(), propertyReference: 'MOVED', unknownField: 1 })).status,
    ).toBe(200);
    expect(await stored()).toEqual(before);
  });

  it.each([
    ['an unassigned negotiator', 'neg'],
    ['another organization', 'adminB'],
  ] as const)('%s cannot see or change the property', async (_label, who) => {
    await resetRisk('high');
    const before = await stored();
    expect((await patch(who, { risk: 'low' })).status).toBe(404);
    expect((await patch(who, { readinessPercent: 99 })).status).toBe(404);
    expect(await stored()).toEqual(before);
  });
});
