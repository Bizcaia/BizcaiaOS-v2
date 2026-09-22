import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import '../loadEnv.js';
import { runMigrations } from '../migrate.js';
import { requireDatabaseEnv } from './postgresHarness.js';

process.env.NODE_ENV = 'test';
process.env.AUTH_JWKS_URL ??= 'https://example.invalid/.well-known/jwks.json';
process.env.AUTH_ISSUER ??= 'https://example.invalid';
process.env.AUTH_AUDIENCE ??= 'bizcaiaos-api';

const subject = `auth0|http-${randomUUID().slice(0, 8)}`;

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async (token: string) => {
    if (token !== 'valid-test-token') throw new Error('invalid token');
    return {
      payload: {
        sub: subject,
        email: `${subject.replace('|', '.')}@example.com`,
        name: 'HTTP Admin',
      },
    };
  }),
}));

const { app } = await import('../index.js');

async function withApi(run: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const auth = { Authorization: 'Bearer valid-test-token', 'Content-Type': 'application/json' };

describe('Express against real PostgreSQL', () => {
  beforeAll(async () => {
    requireDatabaseEnv();
    await runMigrations();
  }, 60_000);

  it('serves health, onboarding, projects, properties, owners, and assignments', async () => {
    await withApi(async (baseUrl) => {
      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({ status: 'ok' });

      const meBefore = await fetch(`${baseUrl}/api/v1/me`, { headers: auth });
      expect(meBefore.status).toBe(200);
      const meBeforeBody = await meBefore.json();
      expect(meBeforeBody.data.organizations).toEqual([]);

      const onboard = await fetch(`${baseUrl}/api/v1/organizations/onboard`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          name: `HTTP Org ${randomUUID().slice(0, 8)}`,
          slug: `http-org-${randomUUID().slice(0, 8)}`,
          timezone: 'Asia/Manila',
        }),
      });
      const onboardBody = await onboard.json();
      expect(onboard.status).toBe(201);
      const organizationId = onboardBody.organizationId ?? onboardBody.data?.organizationId;
      expect(organizationId).toBeTruthy();

      const me = await fetch(`${baseUrl}/api/v1/me`, { headers: auth });
      const meBody = await me.json();
      expect(me.status).toBe(200);
      expect(meBody.data.organizations[0].id).toBe(organizationId);

      const members = await fetch(`${baseUrl}/api/v1/organizations/${organizationId}/members`, { headers: auth });
      const membersBody = await members.json();
      const adminUserId = membersBody.data[0].user_id;

      const project = await fetch(`${baseUrl}/api/v1/ops/projects`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ organizationId, code: 'HTTP-01', name: 'HTTP Project' }),
      });
      const projectBody = await project.json();
      expect(project.status).toBe(201);
      const projectId = projectBody.data.id;

      const property = await fetch(`${baseUrl}/api/v1/ops/properties`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          organizationId,
          projectId,
          propertyReference: 'HTTP-001',
          municipality: 'Calamba',
          assignedManagerId: adminUserId,
        }),
      });
      const propertyBody = await property.json();
      expect(property.status).toBe(201);
      const propertyId = propertyBody.data.id;

      const owner = await fetch(`${baseUrl}/api/v1/ops/owners`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          organizationId,
          ownerType: 'individual',
          displayName: 'HTTP Owner',
        }),
      });
      const ownerBody = await owner.json();
      expect(owner.status).toBe(201);

      const link = await fetch(`${baseUrl}/api/v1/ops/properties/${propertyId}/owners`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ownerId: ownerBody.data.id, isPrimary: true, ownershipPercent: 100 }),
      });
      expect(link.status).toBe(201);

      const patch = await fetch(`${baseUrl}/api/v1/ops/properties/${propertyId}`, {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ assignedManagerId: adminUserId, readinessPercent: 25 }),
      });
      expect(patch.status).toBe(200);

      const detail = await fetch(`${baseUrl}/api/v1/ops/properties/${propertyId}`, { headers: auth });
      const detailBody = await detail.json();
      expect(detail.status).toBe(200);
      expect(detailBody.data.owners[0].display_name).toBe('HTTP Owner');
      expect(detailBody.data.assigned_manager_id).toBe(adminUserId);

      const stage = await fetch(`${baseUrl}/api/v1/ops/properties/${propertyId}`, {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ acquisitionStage: 'negotiation' }),
      });
      expect(stage.status).toBe(200);

      const negotiation = await fetch(`${baseUrl}/api/v1/ops/negotiations`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          organizationId,
          propertyId,
          openingAmount: 9000000,
          targetAmount: 12000000,
        }),
      });
      const negotiationBody = await negotiation.json();
      expect(negotiation.status).toBe(201);
      expect(negotiationBody.data.status).toBe('open');
      expect(negotiationBody.data.current_amount).toBeNull();

      const event = await fetch(`${baseUrl}/api/v1/ops/negotiations/${negotiationBody.data.id}/events`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ eventType: 'offer', amount: 9500000, contextualNote: 'HTTP offer' }),
      });
      const eventBody = await event.json();
      expect(event.status).toBe(201);
      expect(Number(eventBody.data.amount)).toBe(9500000);

      const negotiationDetail = await fetch(`${baseUrl}/api/v1/ops/negotiations/${negotiationBody.data.id}`, {
        headers: auth,
      });
      const negotiationDetailBody = await negotiationDetail.json();
      expect(negotiationDetail.status).toBe(200);
      expect(Number(negotiationDetailBody.data.current_amount)).toBe(9500000);
    });
  });
});
