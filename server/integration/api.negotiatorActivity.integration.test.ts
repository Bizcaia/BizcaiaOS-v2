import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import '../loadEnv.js';
import { runMigrations } from '../migrate.js';
import { addMember, asUser, bootstrapOrg, createAppPool, insertPropertyFixture, requireDatabaseEnv, syncUser } from './postgresHarness.js';

process.env.NODE_ENV = 'test';
process.env.AUTH_JWKS_URL ??= 'https://example.invalid/.well-known/jwks.json';
process.env.AUTH_ISSUER ??= 'https://example.invalid';
process.env.AUTH_AUDIENCE ??= 'bizcaiaos-api';

const tag = randomUUID().slice(0, 8);
const subject = (who: string) => `test|kpi-${who}-${tag}`;
const tokens: Record<string, string> = Object.fromEntries(
  ['adminA', 'lamA', 'negA', 'negB', 'viewerA', 'adminB'].map((who) => [`token-${who}`, subject(who)]),
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

describe('negotiator activity KPI against real PostgreSQL', () => {
  const pool = createAppPool();
  let server: http.Server;
  let base: string;
  let orgA: string;
  let orgB: string;
  let adminA: string;
  let adminB: string;
  let lamA: string;
  let negA: string;
  let negB: string;
  let viewerA: string;
  let propertyA: string;
  let ownerJuan: string;
  let ownerMaria: string;

  async function call(who: string, path: string) {
    const response = await fetch(`${base}/api/v1${path}`, {
      headers: { Authorization: `Bearer token-${who}` },
    });
    return { status: response.status, body: await response.json() };
  }

  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    ({ organization_id: orgA, user_id: adminA } = await bootstrapOrg(
      pool,
      `KPI A ${tag}`,
      `kpi-a-${tag}`,
      subject('adminA'),
      'KPI Admin A',
      `kpi-admin-a-${tag}@example.com`,
    ));
    ({ organization_id: orgB, user_id: adminB } = await bootstrapOrg(
      pool,
      `KPI B ${tag}`,
      `kpi-b-${tag}`,
      subject('adminB'),
      'KPI Admin B',
      `kpi-admin-b-${tag}@example.com`,
    ));

    lamA = await syncUser(pool, subject('lamA'), 'KPI LAM', `kpi-lam-${tag}@example.com`);
    negA = await syncUser(pool, subject('negA'), 'Negotiator A', `kpi-neg-a-${tag}@example.com`);
    negB = await syncUser(pool, subject('negB'), 'Negotiator B', `kpi-neg-b-${tag}@example.com`);
    viewerA = await syncUser(pool, subject('viewerA'), 'Viewer A', `kpi-viewer-${tag}@example.com`);
    await addMember(pool, adminA, orgA, lamA, 'land_acquisition_manager');
    await addMember(pool, adminA, orgA, negA, 'negotiator');
    await addMember(pool, adminA, orgA, negB, 'negotiator');
    await addMember(pool, adminA, orgA, viewerA, 'viewer');

    await insertPropertyFixture(adminA, `update public.organizations set timezone = 'Asia/Manila' where id = $1 returning id`, [orgA]);

    const projectA = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.projects (organization_id, code, name, status)
         values ($1, $2, 'KPI Program', 'active') returning id`,
        [orgA, `KPI-${tag}`],
      );
      return result.rows[0].id;
    });

    propertyA = await insertPropertyFixture(
      lamA,
      `insert into public.properties (
          organization_id, project_id, property_reference, assigned_negotiator_id
        ) values ($1, $2, $3, $4) returning id`,
      [orgA, projectA, `KPI-PROP-${tag}`, negA],
    );

    ownerJuan = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.owners (organization_id, owner_type, display_name)
         values ($1, 'individual', 'Juan') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
    ownerMaria = await asUser(pool, lamA, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into public.owners (organization_id, owner_type, display_name)
         values ($1, 'individual', 'Maria') returning id`,
        [orgA],
      );
      return result.rows[0].id;
    });
    await asUser(pool, lamA, async (client) => {
      await client.query(
        `insert into public.property_owners (property_id, owner_id, is_primary) values ($1,$2,true), ($1,$3,false)`,
        [propertyA, ownerJuan, ownerMaria],
      );
    });

    // Relative org-local timestamps so period=this_week / today match wall-clock now.
    // manilaNearMidnightUtc: 00:30 Asia/Manila today = previous calendar day 16:30 UTC.
    const fixtureTimes = await asUser(pool, adminA, async (client) => {
      const result = await client.query<{
        manila_near_midnight_utc: Date;
        manila_afternoon_utc: Date;
      }>(
        `select
           ((date_trunc('day', now() at time zone 'Asia/Manila') + interval '30 minutes')
             at time zone 'Asia/Manila') as manila_near_midnight_utc,
           ((date_trunc('day', now() at time zone 'Asia/Manila') + interval '14 hours')
             at time zone 'Asia/Manila') as manila_afternoon_utc`,
      );
      return result.rows[0];
    });
    const manilaNearMidnightUtc = fixtureTimes.manila_near_midnight_utc;
    const manilaAfternoonUtc = fixtureTimes.manila_afternoon_utc;

    await asUser(pool, negA, async (client) => {
      await client.query(
        `insert into public.interactions
           (organization_id, property_id, owner_id, interaction_type, notes, occurred_at, recorded_by_user_id)
         values
           ($1,$2,$3,'call','Juan call',$4,$5),
           ($1,$2,$3,'message','Juan message',$6,$5),
           ($1,$2,$7,'meeting','Maria meeting',$6,$5),
           ($1,$2,null,'call','No owner',$6,$5)`,
        [orgA, propertyA, ownerJuan, manilaNearMidnightUtc, negA, manilaAfternoonUtc, ownerMaria],
      );
      const archived = await client.query<{ id: string }>(
        `insert into public.interactions
           (organization_id, property_id, owner_id, interaction_type, notes, occurred_at, recorded_by_user_id)
         values ($1,$2,$3,'call','Archived',$4,$5) returning id`,
        [orgA, propertyA, ownerJuan, manilaAfternoonUtc, negA],
      );
      await client.query(`update public.interactions set archived_at = timezone('utc', now()) where id = $1`, [
        archived.rows[0].id,
      ]);
    });

    await asUser(pool, lamA, async (client) => {
      await client.query(
        `insert into public.interactions
           (organization_id, property_id, owner_id, interaction_type, notes, occurred_at, recorded_by_user_id)
         values ($1,$2,$3,'call','Manager recorded',$4,$5)`,
        [orgA, propertyA, ownerJuan, manilaAfternoonUtc, lamA],
      );
    });

    await insertPropertyFixture(
      lamA,
      `update public.properties set assigned_negotiator_id = $1 where id = $2 returning id`,
      [negB, propertyA],
    );
    await asUser(pool, negB, async (client) => {
      await client.query(
        `insert into public.interactions
           (organization_id, property_id, owner_id, interaction_type, notes, occurred_at, recorded_by_user_id)
         values ($1,$2,$3,'call','Neg B',$4,$5)`,
        [orgA, propertyA, ownerMaria, manilaAfternoonUtc, negB],
      );
    });
    await insertPropertyFixture(
      lamA,
      `update public.properties set assigned_negotiator_id = $1 where id = $2 returning id`,
      [negA, propertyA],
    );
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await pool.end();
  });

  it('credits the recorder and counts distinct landowners vs total activities', async () => {
    const response = await call(
      'lamA',
      `/ops/negotiator-activity?organizationId=${orgA}&period=this_week&negotiatorId=${negA}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.data.summary).toMatchObject({
      negotiatorId: negA,
      uniqueLandowners: 2,
      totalActivities: 3,
    });
    expect(response.body.data.timezone).toBe('Asia/Manila');
  });

  it('does not credit the assigned negotiator for manager-recorded interactions', async () => {
    const response = await call(
      'lamA',
      `/ops/negotiator-activity?organizationId=${orgA}&period=this_week&negotiatorId=${lamA}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.data.summary.uniqueLandowners).toBe(1);
    expect(response.body.data.summary.totalActivities).toBe(1);
  });

  it('rejects negotiator access to another negotiator KPI and rejects viewer', async () => {
    expect(
      (
        await call(
          'negA',
          `/ops/negotiator-activity?organizationId=${orgA}&period=this_week&negotiatorId=${negB}`,
        )
      ).status,
    ).toBe(403);
    expect((await call('viewerA', `/ops/negotiator-activity?organizationId=${orgA}&period=this_week`)).status).toBe(
      403,
    );
  });

  it('isolates organizations and supports landowner drill-down', async () => {
    expect((await call('adminB', `/ops/negotiator-activity?organizationId=${orgA}&period=this_week`)).status).toBe(
      403,
    );
    const drill = await call(
      'lamA',
      `/ops/negotiator-activity/landowners?organizationId=${orgA}&period=this_week&negotiatorId=${negA}`,
    );
    expect(drill.status).toBe(200);
    expect(drill.body.data.landowners).toHaveLength(2);
    expect(drill.body.data.landowners.map((row: { ownerId: string }) => row.ownerId).sort()).toEqual(
      [ownerJuan, ownerMaria].sort(),
    );
  });

  it('keeps Manila near-midnight interactions on the local calendar day', async () => {
    // Fixture at 00:30 Asia/Manila today is still the previous UTC calendar day — must count for today.
    const today = await call(
      'lamA',
      `/ops/negotiator-activity?organizationId=${orgA}&period=today&negotiatorId=${negA}`,
    );
    expect(today.status).toBe(200);
    expect(today.body.data.timezone).toBe('Asia/Manila');
    expect(today.body.data.summary.uniqueLandowners).toBe(2);
    expect(today.body.data.summary.totalActivities).toBe(3);
    void adminB;
  });
});
