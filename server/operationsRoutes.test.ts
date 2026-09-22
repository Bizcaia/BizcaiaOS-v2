import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.AUTH_JWKS_URL = 'https://example.invalid/.well-known/jwks.json';
process.env.AUTH_ISSUER = 'https://example.invalid';
process.env.AUTH_AUDIENCE = 'bizcaiaos-api';

const poolQuery = vi.fn();
const transactionQuery = vi.fn();
const actorQuery = vi.fn();

type Role = 'system_admin' | 'land_acquisition_manager' | 'supervisor' | 'negotiator' | 'legal_documentation' | 'finance' | 'viewer';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_A = '44444444-4444-4444-8444-444444444444';
const PROJECT_B = '55555555-5555-4555-8555-555555555555';
const PROPERTY_A = '66666666-6666-4666-8666-666666666666';
const PROPERTY_B = '99999999-9999-4999-8999-999999999999';
const OWNER_A = '77777777-7777-4777-8777-777777777777';
const OWNER_B = '88888888-8888-4888-8888-888888888888';
const NEGOTIATOR_ID = '22222222-2222-4222-8222-222222222222';
const NEGOTIATION_A = '33333333-3333-4333-8333-333333333333';
const AUTH = { Authorization: 'Bearer valid-test-token', 'Content-Type': 'application/json' };

type Store = {
  role: Role;
  projects: Array<{ id: string; organization_id: string; code: string; name: string; manager_user_id: string | null }>;
  properties: Array<Record<string, unknown>>;
  owners: Array<Record<string, unknown>>;
  links: Array<{ property_id: string; owner_id: string; ownership_percent: number | null; is_primary: boolean; created_at: string }>;
  negotiations: Array<Record<string, unknown>>;
  negotiationEvents: Array<Record<string, unknown>>;
};

let store: Store;

function seedStore(role: Role = 'system_admin'): Store {
  return {
    role,
    projects: [
      { id: PROJECT_A, organization_id: ORG_A, code: 'NCP-01', name: 'North Corridor', manager_user_id: USER_ID },
      { id: PROJECT_B, organization_id: ORG_B, code: 'OTHER', name: 'Other Org Project', manager_user_id: null },
    ],
    properties: [
      {
        id: PROPERTY_A,
        organization_id: ORG_A,
        project_id: PROJECT_A,
        property_reference: 'NCP-00102',
        acquisition_stage: 'identified',
        acquisition_status: 'active',
        assigned_negotiator_id: null,
        assigned_manager_id: USER_ID,
        legal_status: 'unknown',
        documentation_status: 'not_started',
        payment_status: 'not_started',
        readiness_percent: 10,
        risk: 'medium',
        municipality: 'Calamba',
        province: 'Laguna',
        barangay: 'Canlubang',
      },
      {
        id: PROPERTY_B,
        organization_id: ORG_B,
        project_id: PROJECT_B,
        property_reference: 'OTHER-1',
        acquisition_stage: 'identified',
        acquisition_status: 'active',
        assigned_negotiator_id: null,
        assigned_manager_id: null,
        legal_status: 'unknown',
        documentation_status: 'not_started',
        payment_status: 'not_started',
        readiness_percent: 0,
        risk: 'low',
      },
    ],
    owners: [
      { id: OWNER_A, organization_id: ORG_A, owner_type: 'individual', display_name: 'Rosa Mendoza', contact_details: {} },
      { id: OWNER_B, organization_id: ORG_B, owner_type: 'individual', display_name: 'Foreign Owner', contact_details: {} },
    ],
    links: [],
    negotiations: [],
    negotiationEvents: [],
  };
}

function decorate(property: Record<string, unknown>): Record<string, unknown> {
  const project = store.projects.find((entry) => entry.id === property.project_id);
  return {
    ...property,
    project_code: project?.code,
    project_name: project?.name,
    negotiator_name: null,
    manager_name: property.assigned_manager_id === USER_ID ? 'Test User' : null,
  };
}

vi.mock('./database.js', () => ({
  pool: { query: poolQuery },
  withTransaction: vi.fn(async (operation: (client: { query: typeof transactionQuery }) => Promise<unknown>) =>
    operation({ query: transactionQuery }),
  ),
  withActorTransaction: vi.fn(async (_userId: string, operation: (client: { query: typeof actorQuery }) => Promise<unknown>) =>
    operation({ query: actorQuery }),
  ),
  firstRow: (rows: unknown[], message = 'Record not found') => {
    const row = rows[0];
    if (!row) {
      const error = new Error(message) as Error & { status?: number };
      error.status = 404;
      throw error;
    }
    return row;
  },
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async (token: string) => {
    if (token !== 'valid-test-token') throw new Error('invalid token');
    return { payload: { sub: 'auth0|test-user', email: 'test@example.com', name: 'Test User' } };
  }),
}));

const { app } = await import('./index.js');

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

function handleActorQuery(sql: string, params: unknown[] = []) {
  const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized.includes('from public.organization_memberships')) {
    const orgId = params[0];
    if (orgId === ORG_A) return { rows: [{ role: store.role }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
  if (normalized.startsWith('insert into public.projects')) {
    const row = {
      id: crypto.randomUUID(),
      organization_id: String(params[0]),
      code: String(params[1]),
      name: String(params[2]),
      manager_user_id: null,
    };
    store.projects.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (normalized.startsWith('insert into public.owners')) {
    const row = {
      id: crypto.randomUUID(),
      organization_id: params[0],
      owner_type: params[1],
      display_name: params[2],
      organization_name: params[3],
      contact_details: params[4],
    };
    store.owners.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (normalized.startsWith('insert into public.properties')) {
    const row = {
      id: crypto.randomUUID(),
      organization_id: params[0],
      project_id: params[1],
      property_reference: params[2],
      municipality: params[7],
      province: params[8],
      barangay: params[9],
      acquisition_stage: params[10],
      assigned_negotiator_id: params[11],
      assigned_manager_id: params[12],
    };
    store.properties.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (normalized.startsWith('insert into public.property_owners')) {
    const row = {
      property_id: params[0] as string,
      owner_id: params[1] as string,
      ownership_percent: (params[2] as number | null) ?? null,
      is_primary: Boolean(params[3]),
      created_at: new Date().toISOString(),
    };
    store.links.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (normalized.includes('update public.property_owners set is_primary')) {
    store.links = store.links.map((link) =>
      link.property_id === params[0] ? { ...link, is_primary: false } : link,
    );
    return { rows: [], rowCount: 1 };
  }
  if (normalized.startsWith('delete from public.property_owners')) {
    const before = store.links.length;
    store.links = store.links.filter((link) => !(link.property_id === params[0] && link.owner_id === params[1]));
    return { rows: [], rowCount: before === store.links.length ? 0 : 1 };
  }
  if (normalized.startsWith('update public.properties')) {
    const id = params[params.length - 1];
    const index = store.properties.findIndex((property) => property.id === id);
    if (index < 0) return { rows: [], rowCount: 0 };
    if (normalized.includes('readiness_percent')) store.properties[index].readiness_percent = params[0];
    if (normalized.includes('acquisition_stage')) store.properties[index].acquisition_stage = params[0];
    return { rows: [store.properties[index]], rowCount: 1 };
  }
  if (normalized.includes('from public.property_owners po')) {
    const propertyId = params[0];
    const rows = store.links
      .filter((link) => link.property_id === propertyId)
      .map((link) => {
        const owner = store.owners.find((entry) => entry.id === link.owner_id)!;
        return {
          owner_id: owner.id,
          display_name: owner.display_name,
          owner_type: owner.owner_type,
          ownership_percent: link.ownership_percent,
          is_primary: link.is_primary,
          contact_details: owner.contact_details,
        };
      });
    return { rows, rowCount: rows.length };
  }
  if (normalized.includes('from public.properties p')) {
    let rows = store.properties.map(decorate);
    if (normalized.includes('where p.id=$1')) {
      rows = rows.filter((property) => property.id === params[0]);
    } else if (normalized.includes('p.organization_id=$1')) {
      rows = rows.filter((property) => property.organization_id === params[0]);
    }
    return { rows, rowCount: rows.length };
  }
  if (normalized.includes('from public.projects where id=$1')) {
    const project = store.projects.find((entry) => entry.id === params[0]);
    return { rows: project ? [project] : [], rowCount: project ? 1 : 0 };
  }
  if (normalized.includes('from public.projects where organization_id=$1')) {
    const rows = store.projects.filter((entry) => entry.organization_id === params[0]);
    return { rows, rowCount: rows.length };
  }
  if (normalized.includes('from public.owners where organization_id=$1')) {
    const rows = store.owners.filter((entry) => entry.organization_id === params[0]);
    return { rows, rowCount: rows.length };
  }
  if (normalized.includes('from public.owners where id=$1')) {
    const owner = store.owners.find((entry) => entry.id === params[0]);
    return { rows: owner ? [owner] : [], rowCount: owner ? 1 : 0 };
  }
  if (normalized.includes('from public.properties where id=$1')) {
    const property = store.properties.find((entry) => entry.id === params[0]);
    return { rows: property ? [property] : [], rowCount: property ? 1 : 0 };
  }
  if (normalized.startsWith('insert into public.negotiations')) {
    const row = {
      id: crypto.randomUUID(),
      organization_id: params[0],
      property_id: params[1],
      status: 'open',
      assigned_negotiator_id: params[2],
      opening_amount: params[3],
      target_amount: params[4],
      current_amount: null,
      currency_code: params[5],
      started_at: params[6] ?? new Date().toISOString(),
      closed_at: null,
      archived_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      assigned_negotiator_name: null,
    };
    store.negotiations.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (normalized.startsWith('update public.negotiations')) {
    const id = params[params.length - 1];
    const index = store.negotiations.findIndex((entry) => entry.id === id);
    if (index < 0) return { rows: [], rowCount: 0 };
    if (normalized.includes('status')) store.negotiations[index].status = params[0];
    if (normalized.includes('assigned_negotiator_id')) {
      store.negotiations[index].assigned_negotiator_id = params[normalized.includes('status') ? 1 : 0];
    }
    if (normalized.includes('current_amount')) store.negotiations[index].current_amount = params[0];
    return { rows: [store.negotiations[index]], rowCount: 1 };
  }
  if (normalized.startsWith('insert into public.negotiation_events')) {
    const row = {
      id: crypto.randomUUID(),
      organization_id: params[0],
      negotiation_id: params[1],
      event_type: params[2],
      amount: params[3],
      actor_user_id: params[4],
      contextual_note: params[5],
      occurred_at: params[6] ?? new Date().toISOString(),
      metadata: params[7],
      created_at: new Date().toISOString(),
      actor_name: 'Test User',
    };
    store.negotiationEvents.push(row);
    const negotiation = store.negotiations.find((entry) => entry.id === params[1]);
    if (negotiation && (params[2] === 'offer' || params[2] === 'counteroffer')) {
      negotiation.current_amount = params[3];
    }
    return { rows: [row], rowCount: 1 };
  }
  if (normalized.includes('from public.negotiations n')) {
    let rows = store.negotiations.map((entry) => ({ ...entry }));
    if (normalized.includes('where n.id=$1')) {
      rows = rows.filter((entry) => entry.id === params[0]);
    } else if (normalized.includes('n.organization_id=$1')) {
      rows = rows.filter((entry) => entry.organization_id === params[0]);
      if (normalized.includes('n.property_id=')) {
        rows = rows.filter((entry) => entry.property_id === params[1]);
      }
    }
    return { rows, rowCount: rows.length };
  }
  if (normalized.includes('from public.negotiations where id=$1')) {
    const negotiation = store.negotiations.find((entry) => entry.id === params[0]);
    return { rows: negotiation ? [negotiation] : [], rowCount: negotiation ? 1 : 0 };
  }
  if (normalized.includes('from public.negotiation_events e')) {
    const rows = store.negotiationEvents
      .filter((entry) => entry.negotiation_id === params[0])
      .map((entry) => ({ ...entry, actor_name: 'Test User' }));
    return { rows, rowCount: rows.length };
  }
  return { rows: [], rowCount: 0 };
}

describe('property workflow API', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test';
  });

  beforeEach(() => {
    store = seedStore();
    poolQuery.mockReset();
    transactionQuery.mockReset();
    actorQuery.mockReset();
    transactionQuery.mockResolvedValue({ rows: [{ user_id: USER_ID }] });
    actorQuery.mockImplementation(async (sql: string, params?: unknown[]) => handleActorQuery(sql, params));
  });

  afterAll(() => {
    poolQuery.mockReset();
    transactionQuery.mockReset();
    actorQuery.mockReset();
  });

  it('creates a project', async () => {
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/projects`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ organizationId: ORG_A, code: 'NCP-02', name: 'Extension' }),
      });
      const body = await response.json();
      expect(response.status).toBe(201);
      expect(body.data).toMatchObject({ code: 'NCP-02', name: 'Extension', organization_id: ORG_A });
    });
  });

  it('creates a property', async () => {
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          organizationId: ORG_A,
          projectId: PROJECT_A,
          propertyReference: 'NCP-00999',
          municipality: 'Calamba',
          province: 'Laguna',
          barangay: 'Pansol',
        }),
      });
      const body = await response.json();
      expect(response.status).toBe(201);
      expect(body.data).toMatchObject({ property_reference: 'NCP-00999', organization_id: ORG_A, project_id: PROJECT_A });
    });
  });

  it('rejects a property whose project belongs to another organization', async () => {
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          organizationId: ORG_A,
          projectId: PROJECT_B,
          propertyReference: 'CROSS-ORG',
        }),
      });
      const body = await response.json();
      expect(response.status).toBe(422);
      expect(body.error.message).toMatch(/same organization/i);
    });
  });

  it('gets a property', async () => {
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}`, { headers: AUTH });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({
        id: PROPERTY_A,
        project_code: 'NCP-01',
        project_name: 'North Corridor',
        manager_name: 'Test User',
        owners: [],
      });
    });
  });

  it('gets a property including owners', async () => {
    store.links.push({
      property_id: PROPERTY_A,
      owner_id: OWNER_A,
      ownership_percent: 100,
      is_primary: true,
      created_at: '2026-01-01T00:00:00Z',
    });
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}`, { headers: AUTH });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.data.owners).toEqual([
        expect.objectContaining({ owner_id: OWNER_A, display_name: 'Rosa Mendoza', is_primary: true, ownership_percent: 100 }),
      ]);
    });
  });

  it('patches a property as land_acquisition_manager', async () => {
    store.role = 'land_acquisition_manager';
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}`, {
        method: 'PATCH',
        headers: AUTH,
        body: JSON.stringify({ acquisitionStage: 'negotiation' }),
      });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.data.acquisition_stage).toBe('negotiation');
    });
  });

  it('rejects a supervisor attempting a forbidden property field update', async () => {
    store.role = 'supervisor';
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}`, {
        method: 'PATCH',
        headers: AUTH,
        body: JSON.stringify({ acquisitionStage: 'negotiation' }),
      });
      const body = await response.json();
      expect(response.status).toBe(403);
      expect(body.error.code).toBe('forbidden');
    });
  });

  it('creates an owner as an allowed role', async () => {
    store.role = 'land_acquisition_manager';
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/owners`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ organizationId: ORG_A, ownerType: 'corporate', displayName: 'Acme Holdings' }),
      });
      const body = await response.json();
      expect(response.status).toBe(201);
      expect(body.data).toMatchObject({ display_name: 'Acme Holdings', owner_type: 'corporate' });
    });
  });

  it('rejects owner creation as an unauthorized role', async () => {
    store.role = 'negotiator';
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/owners`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ organizationId: ORG_A, ownerType: 'individual', displayName: 'Blocked Owner' }),
      });
      expect(response.status).toBe(403);
    });
  });

  it('links an owner to a property', async () => {
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/owners`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ ownerId: OWNER_A, ownershipPercent: 60, isPrimary: true }),
      });
      const body = await response.json();
      expect(response.status).toBe(201);
      expect(body.data).toMatchObject({ owner_id: OWNER_A, ownership_percent: 60, is_primary: true });
    });
  });

  it('rejects linking an owner from another organization', async () => {
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/owners`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ ownerId: OWNER_B }),
      });
      const body = await response.json();
      expect(response.status).toBe(422);
      expect(body.error.message).toMatch(/same organization/i);
    });
  });

  it('unlinks an owner', async () => {
    store.links.push({
      property_id: PROPERTY_A,
      owner_id: OWNER_A,
      ownership_percent: 100,
      is_primary: true,
      created_at: '2026-01-01T00:00:00Z',
    });
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/owners/${OWNER_A}`, {
        method: 'DELETE',
        headers: AUTH,
      });
      expect(response.status).toBe(204);
      expect(store.links).toHaveLength(0);
    });
  });

  it('isolates property list and detail by organization', async () => {
    await withApi(async (baseUrl) => {
      const list = await fetch(`${baseUrl}/api/v1/ops/properties?organizationId=${ORG_A}`, { headers: AUTH });
      const listBody = await list.json();
      expect(list.status).toBe(200);
      expect(listBody.data.map((row: { id: string }) => row.id)).toEqual([PROPERTY_A]);
      expect(listBody.data[0].manager_name).toBe('Test User');

      const foreign = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_B}`, { headers: AUTH });
      const foreignBody = await foreign.json();
      expect(foreign.status).toBe(404);
      expect(foreignBody.error.message).toBe('Property not found');
    });
  });

  it('returns 404 when patching a foreign property', async () => {
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_B}`, {
        method: 'PATCH',
        headers: AUTH,
        body: JSON.stringify({ readinessPercent: 50 }),
      });
      const body = await response.json();
      expect(response.status).toBe(404);
      expect(body.error.message).toBe('Property not found');
    });
  });

  it('returns 404 when linking an owner to a foreign property', async () => {
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_B}/owners`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ ownerId: OWNER_A }),
      });
      const body = await response.json();
      expect(response.status).toBe(404);
      expect(body.error.message).toBe('Property not found');
    });
  });

  it('creates a negotiation only when the property is in negotiation stage', async () => {
    await withApi(async (baseUrl) => {
      const rejected = await fetch(`${baseUrl}/api/v1/ops/negotiations`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          organizationId: ORG_A,
          propertyId: PROPERTY_A,
          openingAmount: 10000000,
        }),
      });
      expect(rejected.status).toBe(422);

      store.properties[0].acquisition_stage = 'negotiation';
      store.properties[0].assigned_negotiator_id = NEGOTIATOR_ID;
      const created = await fetch(`${baseUrl}/api/v1/ops/negotiations`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          organizationId: ORG_A,
          propertyId: PROPERTY_A,
          openingAmount: 10000000,
          targetAmount: 14000000,
        }),
      });
      const body = await created.json();
      expect(created.status).toBe(201);
      expect(body.data).toMatchObject({
        organization_id: ORG_A,
        property_id: PROPERTY_A,
        status: 'open',
        assigned_negotiator_id: NEGOTIATOR_ID,
        opening_amount: 10000000,
        current_amount: null,
      });
    });
  });

  it('appends offer events and updates current_amount', async () => {
    store.properties[0].acquisition_stage = 'negotiation';
    store.negotiations.push({
      id: NEGOTIATION_A,
      organization_id: ORG_A,
      property_id: PROPERTY_A,
      status: 'open',
      assigned_negotiator_id: NEGOTIATOR_ID,
      opening_amount: 10000000,
      target_amount: 14000000,
      current_amount: null,
      currency_code: 'PHP',
      started_at: '2026-01-01T00:00:00.000Z',
      closed_at: null,
      archived_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    await withApi(async (baseUrl) => {
      const missingAmount = await fetch(`${baseUrl}/api/v1/ops/negotiations/${NEGOTIATION_A}/events`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ eventType: 'offer' }),
      });
      expect(missingAmount.status).toBe(400);

      const offer = await fetch(`${baseUrl}/api/v1/ops/negotiations/${NEGOTIATION_A}/events`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ eventType: 'offer', amount: 11000000, contextualNote: 'Opening offer' }),
      });
      const offerBody = await offer.json();
      expect(offer.status).toBe(201);
      expect(offerBody.data).toMatchObject({
        negotiation_id: NEGOTIATION_A,
        event_type: 'offer',
        amount: 11000000,
        actor_user_id: USER_ID,
      });
      expect(store.negotiations[0].current_amount).toBe(11000000);

      const events = await fetch(`${baseUrl}/api/v1/ops/negotiations/${NEGOTIATION_A}/events`, { headers: AUTH });
      const eventsBody = await events.json();
      expect(events.status).toBe(200);
      expect(eventsBody.data).toHaveLength(1);
    });
  });

  it('rejects negotiation writes for unauthorized roles', async () => {
    store.role = 'viewer';
    store.properties[0].acquisition_stage = 'negotiation';
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/negotiations`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ organizationId: ORG_A, propertyId: PROPERTY_A }),
      });
      expect(response.status).toBe(403);
    });
  });
});
