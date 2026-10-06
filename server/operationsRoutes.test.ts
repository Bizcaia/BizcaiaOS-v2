import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
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
const AUTH_NO_CONTENT_TYPE = { Authorization: 'Bearer valid-test-token' };

type Store = {
  role: Role;
  projects: Array<{ id: string; organization_id: string; code: string; name: string; manager_user_id: string | null }>;
  properties: Array<Record<string, unknown>>;
  owners: Array<Record<string, unknown>>;
  links: Array<{ property_id: string; owner_id: string; ownership_percent: number | null; is_primary: boolean; created_at: string }>;
  negotiations: Array<Record<string, unknown>>;
  negotiationEvents: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  agreementSignatures: Array<Record<string, unknown>>;
  timezone: string;
  timelineRows: Array<Record<string, unknown>>;
  interactions: Array<Record<string, unknown>>;
  stageTransitionError: { code: string; message: string } | null;
  statusTransitionError: { code: string; message: string } | null;
  remediationError: { code: string; message: string } | null;
};

const EXECUTED_DOC_A = 'e0000000-0000-4000-8000-00000000000a';
const EXECUTED_DOC_A2 = 'e0000000-0000-4000-8000-0000000000a2';
const DRAFT_DOC_A = 'e0000000-0000-4000-8000-00000000000d';
const EXECUTED_DOC_B = 'e0000000-0000-4000-8000-00000000000b';
const OWNER_A2 = '77777777-7777-4777-8777-7777777777a2';
const OWNER_A_UNLINKED = '77777777-7777-4777-8777-7777777777a3';

function sqlError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

const TASK_USER_NAMES: Record<string, string> = {
  [USER_ID]: 'Test User',
  [NEGOTIATOR_ID]: 'Negotiator User',
};

const fakeFiles = new Map<string, Buffer>();
const storagePutMock = vi.fn(
  async (params: {
    organizationId: string;
    propertyId: string;
    documentId: string;
    filename: string;
    contentType: string;
    data: Buffer;
  }) => {
    const key = `${params.organizationId}/${params.propertyId}/${params.documentId}/${params.filename}`;
    fakeFiles.set(key, params.data);
    return { key, size: params.data.byteLength };
  },
);
const storageRemoveMock = vi.fn(async (key: string) => {
  fakeFiles.delete(key);
});
const storageGetReadStreamMock = vi.fn(async (key: string) => {
  const data = fakeFiles.get(key);
  if (!data) throw new Error('Stored file not found');
  return Readable.from(data);
});

vi.mock('./storage/documentStorage.js', async () => {
  const actual = await vi.importActual<typeof import('./storage/documentStorage.js')>('./storage/documentStorage.js');
  return {
    ...actual,
    getDocumentStorage: vi.fn(async () => ({
      put: storagePutMock,
      remove: storageRemoveMock,
      getReadStream: storageGetReadStreamMock,
    })),
  };
});

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
    documents: [],
    tasks: [],
    payments: [],
    agreementSignatures: [],
    timezone: 'Asia/Manila',
    timelineRows: [],
    interactions: [],
    stageTransitionError: null,
    statusTransitionError: null,
    remediationError: null,
  };
}

/** Seeds executed/draft documents and a second linked owner for signature tests. */
function seedSignatureFixtures() {
  const base = {
    negotiation_id: null,
    status: 'verified',
    original_filename: 'agreement.pdf',
    content_type: 'application/pdf',
    size_bytes: 10,
    storage_provider: 'local',
    uploaded_by_user_id: USER_ID,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    archived_at: null,
  };
  store.documents.push(
    { ...base, id: EXECUTED_DOC_A, organization_id: ORG_A, property_id: PROPERTY_A, category: 'agreement_executed', title: 'Deed of Sale', storage_key: 'k-a' },
    { ...base, id: EXECUTED_DOC_A2, organization_id: ORG_A, property_id: PROPERTY_A, category: 'agreement_executed', title: 'Deed Supplement', storage_key: 'k-a2' },
    { ...base, id: DRAFT_DOC_A, organization_id: ORG_A, property_id: PROPERTY_A, category: 'agreement_draft', title: 'Draft', storage_key: 'k-d' },
    { ...base, id: EXECUTED_DOC_B, organization_id: ORG_B, property_id: PROPERTY_B, category: 'agreement_executed', title: 'Foreign Deed', storage_key: 'k-b' },
  );
  store.owners.push(
    { id: OWNER_A2, organization_id: ORG_A, owner_type: 'individual', display_name: 'Second Owner', contact_details: {} },
    { id: OWNER_A_UNLINKED, organization_id: ORG_A, owner_type: 'individual', display_name: 'Unlinked Owner', contact_details: {} },
  );
  store.links.push(
    { property_id: PROPERTY_A, owner_id: OWNER_A, ownership_percent: 50, is_primary: true, created_at: '2026-01-01T00:00:00Z' },
    { property_id: PROPERTY_A, owner_id: OWNER_A2, ownership_percent: 50, is_primary: false, created_at: '2026-01-01T00:00:00Z' },
  );
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
  // Timeline branches come first: the UNION ALL text would otherwise match
  // the per-table branches below.
  if (normalized.startsWith('select * from public.transition_property_stage')) {
    // The stage rules are proven against real PostgreSQL; here the function's
    // result or error is simulated so the route's validation and mapping can
    // be exercised.
    if (store.stageTransitionError) throw sqlError(store.stageTransitionError.code, store.stageTransitionError.message);
    const property = store.properties.find((entry) => entry.id === params[0]);
    if (!property) throw sqlError('P0002', 'Property not found');
    property.acquisition_stage = params[1];
    return { rows: [property], rowCount: 1 };
  }
  if (/^select \* from public\.(start|escalate|return|resolve|reopen)_property_stage_remediation/.test(normalized)) {
    // The remediation rules are proven against real PostgreSQL; here the
    // function's result or error is simulated for the routes.
    if (store.remediationError) throw sqlError(store.remediationError.code, store.remediationError.message);
    return { rows: [{ id: 'rem-1', property_id: params[0], state: 'UNDER_REVIEW', cycle: 1 }], rowCount: 1 };
  }
  if (normalized.startsWith('select * from public.transition_property_status')) {
    // The status rules are proven against real PostgreSQL; simulated here the
    // same way as the stage function.
    if (store.statusTransitionError) throw sqlError(store.statusTransitionError.code, store.statusTransitionError.message);
    const property = store.properties.find((entry) => entry.id === params[0]);
    if (!property) throw sqlError('P0002', 'Property not found');
    property.acquisition_status = params[1];
    return { rows: [property], rowCount: 1 };
  }
  if (normalized.startsWith('with entries as')) {
    // Timeline semantics are proven against real PostgreSQL; here the rows
    // are supplied directly so the route's gate, validation, and mapping can
    // be exercised.
    return { rows: store.timelineRows, rowCount: store.timelineRows.length };
  }
  if (normalized.startsWith('insert into public.interactions')) {
    const [organizationId, propertyId, ownerId, interactionType, notes, occurredAt, recordedBy] = params as Array<string | null>;
    // Simulates enforce_interaction_scope(): owner linked at recording time,
    // and a supplied occurred_at not in the future (zero tolerance).
    if (ownerId && !store.links.some((link) => link.property_id === propertyId && link.owner_id === ownerId)) {
      throw sqlError('23514', 'Interaction owner must be an existing owner of the property');
    }
    if (occurredAt && new Date(occurredAt).getTime() > Date.now()) {
      throw sqlError('23514', 'Interactions must record something that already happened; occurred_at is in the future');
    }
    const timestamp = new Date().toISOString();
    const row = {
      id: crypto.randomUUID(),
      organization_id: organizationId,
      property_id: propertyId,
      owner_id: ownerId,
      interaction_type: interactionType,
      notes,
      occurred_at: occurredAt ?? timestamp,
      recorded_by_user_id: recordedBy,
      created_at: timestamp,
      updated_at: timestamp,
      archived_at: null,
    };
    store.interactions.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (normalized.includes('from public.interactions i')) {
    let rows: Array<Record<string, unknown>> = store.interactions.map((interaction) => ({
      ...interaction,
      owner_name: store.owners.find((owner) => owner.id === interaction.owner_id)?.display_name ?? null,
      recorded_by_name: TASK_USER_NAMES[interaction.recorded_by_user_id as string] ?? null,
    }));
    if (normalized.includes('where i.id=$1')) {
      rows = rows.filter((interaction) => interaction.id === params[0]);
    } else if (normalized.includes('i.property_id=$1')) {
      rows = rows.filter((interaction) => interaction.property_id === params[0] && interaction.archived_at == null);
    }
    return { rows, rowCount: rows.length };
  }
  if (normalized.startsWith('select property_id from public.interactions where id=$1')) {
    const interaction = store.interactions.find((entry) => entry.id === params[0]);
    return { rows: interaction ? [interaction] : [], rowCount: interaction ? 1 : 0 };
  }
  if (normalized.startsWith('update public.interactions')) {
    const interaction = store.interactions.find((entry) => entry.id === params[0]);
    if (!interaction) return { rows: [], rowCount: 0 };
    interaction.archived_at = interaction.archived_at ?? new Date().toISOString();
    return { rows: [interaction], rowCount: 1 };
  }
  if (normalized.startsWith('select o.timezone')) {
    // Simulates PostgreSQL rejecting an unrecognized time zone name.
    if (!store.timezone.includes('/') && store.timezone !== 'UTC') {
      throw sqlError('22023', `time zone "${store.timezone}" not recognized`);
    }
    return { rows: [{ timezone: store.timezone, today: '2026-09-23' }], rowCount: 1 };
  }
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
    // Simulates property_owners_agreement_signature_guard.
    if (
      store.agreementSignatures.some(
        (signature) => signature.property_id === params[0] && signature.owner_id === params[1] && !signature.archived_at,
      )
    ) {
      throw sqlError(
        '23514',
        'This property owner has active agreement signatures; archive them before unlinking or changing the owner link',
      );
    }
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
  if (normalized.startsWith('insert into public.documents')) {
    const row = {
      id: params[0],
      organization_id: params[1],
      property_id: params[2],
      negotiation_id: params[3] ?? null,
      category: params[4],
      status: 'draft',
      title: params[5],
      original_filename: params[6],
      content_type: params[7],
      size_bytes: params[8],
      storage_provider: 'local',
      storage_key: params[9],
      uploaded_by_user_id: params[10],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
    };
    store.documents.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (normalized.includes('from public.documents d')) {
    let rows: Array<Record<string, unknown>> = store.documents.map((doc) => ({ ...doc, uploaded_by_name: 'Test User' }));
    if (normalized.includes('where d.id=$1')) {
      rows = rows.filter((doc) => doc.id === params[0]);
    } else if (normalized.includes('d.property_id=$1')) {
      rows = rows.filter((doc) => doc.property_id === params[0]);
      let paramIndex = 1;
      if (normalized.includes('d.category=$')) {
        rows = rows.filter((doc) => doc.category === params[paramIndex]);
        paramIndex += 1;
      }
      if (normalized.includes('d.status=$')) {
        rows = rows.filter((doc) => doc.status === params[paramIndex]);
        paramIndex += 1;
      }
      if (normalized.includes('d.archived_at is null')) {
        rows = rows.filter((doc) => doc.archived_at == null);
      }
    }
    return { rows, rowCount: rows.length };
  }
  if (normalized.startsWith('select organization_id, original_filename, content_type, storage_key from public.documents')) {
    const doc = store.documents.find((entry) => entry.id === params[0]);
    return { rows: doc ? [doc] : [], rowCount: doc ? 1 : 0 };
  }
  if (normalized.startsWith('select * from public.documents where id=$1')) {
    const doc = store.documents.find((entry) => entry.id === params[0]);
    return { rows: doc ? [doc] : [], rowCount: doc ? 1 : 0 };
  }
  if (normalized.startsWith('update public.documents')) {
    const id = params[params.length - 1];
    const index = store.documents.findIndex((entry) => entry.id === id);
    if (index < 0) return { rows: [], rowCount: 0 };
    let paramIndex = 0;
    if (normalized.includes('category=$')) {
      // Simulates documents_agreement_signature_guard.
      if (
        store.documents[index].category === 'agreement_executed' &&
        params[paramIndex] !== 'agreement_executed' &&
        store.agreementSignatures.some((signature) => signature.document_id === id && !signature.archived_at)
      ) {
        throw sqlError('23514', 'This document has active agreement signatures; archive them before changing its category');
      }
      store.documents[index].category = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('status=$')) {
      store.documents[index].status = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('title=$')) {
      store.documents[index].title = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('negotiation_id=$')) {
      store.documents[index].negotiation_id = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('archived_at=$')) {
      store.documents[index].archived_at = params[paramIndex];
      paramIndex += 1;
    }
    return { rows: [store.documents[index]], rowCount: 1 };
  }
  if (normalized.startsWith('insert into public.tasks')) {
    const row = {
      id: crypto.randomUUID(),
      organization_id: params[0],
      property_id: params[1],
      title: params[2],
      description: params[3] ?? null,
      status: 'open',
      priority: params[4],
      assigned_user_id: params[5] ?? null,
      due_on: params[6] ?? null,
      created_by_user_id: params[7],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
    };
    store.tasks.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (normalized.includes('from public.tasks t')) {
    let rows: Array<Record<string, unknown>> = store.tasks.map((task) => ({
      ...task,
      assigned_user_name: task.assigned_user_id ? TASK_USER_NAMES[task.assigned_user_id as string] ?? null : null,
      created_by_name: TASK_USER_NAMES[task.created_by_user_id as string] ?? null,
    }));
    if (normalized.includes('where t.id=$1')) {
      rows = rows.filter((task) => task.id === params[0]);
    } else if (normalized.includes('t.property_id=$1')) {
      rows = rows.filter((task) => task.property_id === params[0]);
      let paramIndex = 1;
      if (normalized.includes('t.status=$')) {
        rows = rows.filter((task) => task.status === params[paramIndex]);
        paramIndex += 1;
      }
      if (normalized.includes('t.priority=$')) {
        rows = rows.filter((task) => task.priority === params[paramIndex]);
        paramIndex += 1;
      }
      if (normalized.includes('t.archived_at is null')) {
        rows = rows.filter((task) => task.archived_at == null);
      }
    }
    return { rows, rowCount: rows.length };
  }
  if (normalized.startsWith('select * from public.tasks where id=$1')) {
    const task = store.tasks.find((entry) => entry.id === params[0]);
    return { rows: task ? [task] : [], rowCount: task ? 1 : 0 };
  }
  if (normalized.startsWith('update public.tasks')) {
    const id = params[params.length - 1];
    const index = store.tasks.findIndex((entry) => entry.id === id);
    if (index < 0) return { rows: [], rowCount: 0 };
    let paramIndex = 0;
    if (normalized.includes('title=$')) {
      store.tasks[index].title = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('description=$')) {
      store.tasks[index].description = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('status=$')) {
      store.tasks[index].status = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('priority=$')) {
      store.tasks[index].priority = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('assigned_user_id=$')) {
      store.tasks[index].assigned_user_id = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('due_on=$')) {
      store.tasks[index].due_on = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('archived_at=$')) {
      store.tasks[index].archived_at = params[paramIndex];
      paramIndex += 1;
    }
    return { rows: [store.tasks[index]], rowCount: 1 };
  }
  if (normalized.startsWith('insert into public.payments')) {
    const row = {
      id: crypto.randomUUID(),
      organization_id: params[0],
      property_id: params[1],
      negotiation_id: params[2] ?? null,
      amount: params[3],
      currency_code: params[4],
      payment_type: params[5],
      status: 'pending',
      scheduled_on: params[6] ?? null,
      paid_on: params[7] ?? null,
      reference_number: params[8] ?? null,
      recorded_by_user_id: params[9],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
    };
    store.payments.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (normalized.includes('from public.payments pm')) {
    let rows: Array<Record<string, unknown>> = store.payments.map((payment) => ({
      ...payment,
      recorded_by_name: TASK_USER_NAMES[payment.recorded_by_user_id as string] ?? null,
    }));
    if (normalized.includes('where pm.id=$1')) {
      rows = rows.filter((payment) => payment.id === params[0]);
    } else if (normalized.includes('pm.property_id=$1')) {
      rows = rows.filter((payment) => payment.property_id === params[0]);
      let paramIndex = 1;
      if (normalized.includes('pm.status=$')) {
        rows = rows.filter((payment) => payment.status === params[paramIndex]);
        paramIndex += 1;
      }
      if (normalized.includes('pm.payment_type=$')) {
        rows = rows.filter((payment) => payment.payment_type === params[paramIndex]);
        paramIndex += 1;
      }
      if (normalized.includes('pm.archived_at is null')) {
        rows = rows.filter((payment) => payment.archived_at == null);
      }
    }
    return { rows, rowCount: rows.length };
  }
  if (normalized.startsWith('select * from public.payments where id=$1')) {
    const payment = store.payments.find((entry) => entry.id === params[0]);
    return { rows: payment ? [payment] : [], rowCount: payment ? 1 : 0 };
  }
  if (normalized.startsWith('update public.payments')) {
    const id = params[params.length - 1];
    const index = store.payments.findIndex((entry) => entry.id === id);
    if (index < 0) return { rows: [], rowCount: 0 };
    let paramIndex = 0;
    if (normalized.includes('amount=$')) {
      store.payments[index].amount = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('currency_code=$')) {
      store.payments[index].currency_code = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('payment_type=$')) {
      store.payments[index].payment_type = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('negotiation_id=$')) {
      store.payments[index].negotiation_id = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('status=$')) {
      store.payments[index].status = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('scheduled_on=$')) {
      store.payments[index].scheduled_on = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('paid_on=$')) {
      store.payments[index].paid_on = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('reference_number=$')) {
      store.payments[index].reference_number = params[paramIndex];
      paramIndex += 1;
    }
    if (normalized.includes('archived_at=$')) {
      store.payments[index].archived_at = params[paramIndex];
      paramIndex += 1;
    }
    return { rows: [store.payments[index]], rowCount: 1 };
  }
  if (normalized.startsWith('insert into public.agreement_signatures')) {
    const [organizationId, propertyId, documentId, ownerId, signedOn, recordedBy] = params;
    // Mirrors enforce_agreement_signature_scope() and the partial unique index.
    const document = store.documents.find((entry) => entry.id === documentId);
    if (!document) throw sqlError('P0002', 'Document not found for agreement signature');
    if (document.property_id !== propertyId) {
      throw sqlError('23514', 'Agreement signature document must belong to the same property');
    }
    if (document.category !== 'agreement_executed') {
      throw sqlError('23514', 'Agreement signatures may only reference an agreement_executed document');
    }
    if (!store.links.some((link) => link.property_id === propertyId && link.owner_id === ownerId)) {
      throw sqlError('23514', 'Signatory must be an existing owner of the property');
    }
    const duplicate = store.agreementSignatures.some(
      (entry) => entry.document_id === documentId && entry.owner_id === ownerId && entry.archived_at == null,
    );
    if (duplicate) throw sqlError('23505', 'duplicate key value violates unique constraint');
    const row = {
      id: crypto.randomUUID(),
      organization_id: organizationId,
      property_id: propertyId,
      document_id: documentId,
      owner_id: ownerId,
      signed_on: signedOn,
      recorded_by_user_id: recordedBy,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
    };
    store.agreementSignatures.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (normalized.includes('from public.agreement_signatures s')) {
    let rows: Array<Record<string, unknown>> = store.agreementSignatures.map((signature) => ({
      ...signature,
      owner_name: store.owners.find((owner) => owner.id === signature.owner_id)?.display_name ?? null,
      document_title: store.documents.find((document) => document.id === signature.document_id)?.title ?? null,
      recorded_by_name: TASK_USER_NAMES[signature.recorded_by_user_id as string] ?? null,
    }));
    if (normalized.includes('where s.id=$1')) {
      rows = rows.filter((signature) => signature.id === params[0]);
    } else if (normalized.includes('s.property_id=$1')) {
      rows = rows.filter((signature) => signature.property_id === params[0]);
      if (normalized.includes('s.document_id=$')) {
        rows = rows.filter((signature) => signature.document_id === params[1]);
      }
      if (normalized.includes('s.archived_at is null')) {
        rows = rows.filter((signature) => signature.archived_at == null);
      }
    }
    return { rows, rowCount: rows.length };
  }
  if (normalized.startsWith('select organization_id from public.agreement_signatures where id=$1')) {
    const signature = store.agreementSignatures.find((entry) => entry.id === params[0]);
    return { rows: signature ? [signature] : [], rowCount: signature ? 1 : 0 };
  }
  if (normalized.startsWith('update public.agreement_signatures')) {
    const signature = store.agreementSignatures.find((entry) => entry.id === params[0]);
    if (!signature) return { rows: [], rowCount: 0 };
    signature.archived_at = signature.archived_at ?? new Date().toISOString();
    return { rows: [signature], rowCount: 1 };
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
    fakeFiles.clear();
    storagePutMock.mockClear();
    storageRemoveMock.mockClear();
    storageGetReadStreamMock.mockClear();
    delete process.env.DOCUMENT_MAX_SIZE_BYTES;
    delete process.env.DOCUMENT_ACCEPTED_MIME_TYPES;
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

  describe('creation rules (L-05)', () => {
    function postProperty(baseUrl: string, body: Record<string, unknown>, headers: Record<string, string> = AUTH) {
      return fetch(`${baseUrl}/api/v1/ops/properties`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ organizationId: ORG_A, projectId: PROJECT_A, propertyReference: 'NCP-L05', ...body }),
      });
    }

    function propertyInserts() {
      return actorQuery.mock.calls.filter(([sql]) => /insert into public\.properties/i.test(String(sql)));
    }

    it('creates in identified, whether the stage is omitted or given as identified, and never sends a status', async () => {
      await withApi(async (baseUrl) => {
        expect((await postProperty(baseUrl, {})).status).toBe(201);
        expect((await postProperty(baseUrl, { propertyReference: 'NCP-L05B', acquisitionStage: 'identified' })).status).toBe(201);
        // A status field is not part of the creation contract: it is refused, never sent.
        const withStatus = await postProperty(baseUrl, { propertyReference: 'NCP-L05C', acquisitionStatus: 'complete' });
        expect(withStatus.status).toBe(400);
        expect((await withStatus.json()).error).toMatchObject({
          code: 'validation_error',
          details: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['acquisitionStatus'] })],
        });
      });
      const inserts = propertyInserts();
      expect(inserts).toHaveLength(2);
      expect(inserts.map(([, params]) => (params as unknown[])[10])).toEqual(['identified', 'identified']);
      expect(inserts.every(([sql]) => !/acquisition_status/.test(String(sql)))).toBe(true);
    });

    it.each(['initial_contact', 'negotiation', 'payment_closing', 'on_hold', 'withdrawn', 'acquisition_complete', 'complete'])(
      'refuses the creation stage %s with 400 before any insert',
      async (stage) => {
        await withApi(async (baseUrl) => {
          const response = await postProperty(baseUrl, { acquisitionStage: stage });
          expect(response.status).toBe(400);
          expect((await response.json()).error.code).toBe('validation_error');
        });
        expect(propertyInserts()).toHaveLength(0);
      },
    );

    it.each(['supervisor', 'negotiator', 'legal_documentation', 'finance', 'viewer'] as const)(
      'refuses creation for %s with 403 before any insert',
      async (role) => {
        store.role = role;
        await withApi(async (baseUrl) => {
          expect((await postProperty(baseUrl, {})).status).toBe(403);
        });
        expect(propertyInserts()).toHaveLength(0);
      },
    );

    it('allows land_acquisition_manager and system_admin', async () => {
      for (const role of ['land_acquisition_manager', 'system_admin'] as const) {
        store.role = role;
        await withApi(async (baseUrl) => {
          expect((await postProperty(baseUrl, { propertyReference: `NCP-${role}` })).status).toBe(201);
        });
      }
      expect(propertyInserts()).toHaveLength(2);
    });

    it('requires authentication', async () => {
      await withApi(async (baseUrl) => {
        const response = await postProperty(baseUrl, {}, { 'Content-Type': 'application/json' });
        expect(response.status).toBe(401);
      });
      expect(propertyInserts()).toHaveLength(0);
    });

    it('validates required fields before any insert', async () => {
      await withApi(async (baseUrl) => {
        for (const body of [{ propertyReference: '' }, { propertyReference: '   ' }, { propertyReference: null }, { projectId: 'not-a-uuid' }]) {
          expect((await postProperty(baseUrl, body)).status).toBe(400);
        }
      });
      expect(propertyInserts()).toHaveLength(0);
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
        body: JSON.stringify({ risk: 'high' }),
      });
      const body = await response.json();
      expect(response.status).toBe(200);
      // PATCH no longer supplies or changes the stage (L-02).
      expect(body.data.acquisition_stage).toBe('identified');
    });
    const updates = actorQuery.mock.calls.map(([sql]) => String(sql)).filter((sql) => /update public\.properties/i.test(sql));
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toMatch(/acquisition_stage/);
  });

  it('refuses acquisitionStage on PATCH for every role, before any update', async () => {
    for (const role of ['system_admin', 'land_acquisition_manager', 'supervisor', 'negotiator'] as const) {
      store.role = role;
      actorQuery.mockClear();
      await withApi(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}`, {
          method: 'PATCH',
          headers: AUTH,
          body: JSON.stringify({ acquisitionStage: 'negotiation' }),
        });
        expect(response.status).toBe(400);
      });
      expect(actorQuery.mock.calls.some(([sql]) => /update public\.properties/i.test(String(sql)))).toBe(false);
    }
    expect(store.properties[0].acquisition_stage).toBe('identified');
  });

  it('rejects a supervisor attempting a forbidden property field update', async () => {
    store.role = 'supervisor';
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}`, {
        method: 'PATCH',
        headers: AUTH,
        body: JSON.stringify({ legalStatus: 'clear' }),
      });
      const body = await response.json();
      expect(response.status).toBe(403);
      expect(body.error.code).toBe('forbidden');
    });
  });

  describe('property PATCH leaves an omitted risk unchanged', () => {
    const propertyUpdates = () =>
      actorQuery.mock.calls.filter(([sql]) => /update public\.properties/i.test(String(sql)));
    const patchProperty = (baseUrl: string, body: unknown) =>
      fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}`, { method: 'PATCH', headers: AUTH, body: JSON.stringify(body) });

    it('does not supply a risk the request did not send', async () => {
      const { updatePropertySchema } = await import('./operationsSchemas.js');
      expect(updatePropertySchema.parse({})).toEqual({});
      expect(updatePropertySchema.parse({ legalStatus: 'clear' })).toEqual({ legalStatus: 'clear' });
      expect(updatePropertySchema.parse({ risk: 'high' })).toEqual({ risk: 'high' });
    });

    it.each(['system_admin', 'land_acquisition_manager', 'supervisor'] as const)(
      'a %s update of another field does not write risk',
      async (role) => {
        store.role = role;
        await withApi(async (baseUrl) => {
          expect((await patchProperty(baseUrl, { readinessPercent: 55 })).status).toBe(200);
        });
        expect(propertyUpdates()).toHaveLength(1);
        expect(String(propertyUpdates()[0][0])).toMatch(/readiness_percent/);
        expect(String(propertyUpdates()[0][0])).not.toMatch(/risk/);
      },
    );

    it.each([
      ['legal_documentation', { legalStatus: 'clear', documentationStatus: 'in_review' }, /legal_status/],
      ['finance', { paymentStatus: 'in_progress' }, /payment_status/],
    ] as const)('lets %s update its own fields without touching risk', async (role, body, column) => {
      store.role = role;
      await withApi(async (baseUrl) => {
        expect((await patchProperty(baseUrl, body)).status).toBe(200);
      });
      expect(propertyUpdates()).toHaveLength(1);
      expect(String(propertyUpdates()[0][0])).toMatch(column);
      expect(String(propertyUpdates()[0][0])).not.toMatch(/risk/);
    });

    it.each(['legal_documentation', 'finance', 'negotiator', 'viewer'] as const)('still refuses an explicit risk from %s', async (role) => {
      store.role = role;
      await withApi(async (baseUrl) => {
        expect((await patchProperty(baseUrl, { risk: 'high' })).status).toBe(403);
      });
      expect(propertyUpdates()).toHaveLength(0);
    });

    it('still writes an explicit risk', async () => {
      store.role = 'land_acquisition_manager';
      await withApi(async (baseUrl) => {
        expect((await patchProperty(baseUrl, { risk: 'low' })).status).toBe(200);
      });
      expect(propertyUpdates()).toHaveLength(1);
      expect(String(propertyUpdates()[0][0])).toMatch(/set risk=\$1 where/);
      expect(propertyUpdates()[0][1]).toEqual(['low', PROPERTY_A]);
    });

    it.each([null, 0, '', 'critical', 'HIGH'])('rejects risk %j with 400 before any update', async (risk) => {
      store.role = 'land_acquisition_manager';
      await withApi(async (baseUrl) => {
        expect((await patchProperty(baseUrl, { risk })).status).toBe(400);
      });
      expect(propertyUpdates()).toHaveLength(0);
    });

    it('treats an empty body as no change', async () => {
      store.role = 'land_acquisition_manager';
      await withApi(async (baseUrl) => {
        expect((await patchProperty(baseUrl, {})).status).toBe(200);
      });
      expect(propertyUpdates()).toHaveLength(0);
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

  it('returns configured document upload limits', async () => {
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/config`, { headers: AUTH_NO_CONTENT_TYPE });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.data.documentUpload.maxSizeBytes).toBeGreaterThan(0);
      expect(body.data.documentUpload.acceptedMimeTypes).toContain('application/pdf');
    });
  });

  it('uploads a document as an allowed role and stores server-set metadata only', async () => {
    store.role = 'land_acquisition_manager';
    await withApi(async (baseUrl) => {
      const form = new FormData();
      form.set('category', 'title_deed');
      form.set('title', 'Original Title');
      form.set('file', new File(['title deed contents'], 'title.pdf', { type: 'application/pdf' }));

      // A client-supplied storage field is not part of the contract: refused before anything is stored.
      const withStorageField = new FormData();
      for (const [key, value] of form.entries()) withStorageField.set(key, value);
      withStorageField.set('storageProvider', 's3');
      const refused = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/documents`, {
        method: 'POST',
        headers: AUTH_NO_CONTENT_TYPE,
        body: withStorageField,
      });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toMatchObject({
        code: 'validation_error',
        details: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['storageProvider'] })],
      });
      expect(storagePutMock).not.toHaveBeenCalled();
      expect(store.documents).toHaveLength(0);

      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/documents`, {
        method: 'POST',
        headers: AUTH_NO_CONTENT_TYPE,
        body: form,
      });
      const body = await response.json();
      expect(response.status).toBe(201);
      expect(body.data).toMatchObject({
        property_id: PROPERTY_A,
        organization_id: ORG_A,
        category: 'title_deed',
        title: 'Original Title',
        status: 'draft',
        storage_provider: 'local',
        original_filename: 'title.pdf',
        content_type: 'application/pdf',
        uploaded_by_user_id: USER_ID,
        uploaded_by_name: 'Test User',
      });
      expect(storagePutMock).toHaveBeenCalledTimes(1);
      expect(store.documents).toHaveLength(1);
    });
  });

  it('rejects document upload for an unauthorized role', async () => {
    store.role = 'negotiator';
    await withApi(async (baseUrl) => {
      const form = new FormData();
      form.set('category', 'title_deed');
      form.set('title', 'Blocked Upload');
      form.set('file', new File(['blocked'], 'blocked.pdf', { type: 'application/pdf' }));

      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/documents`, {
        method: 'POST',
        headers: AUTH_NO_CONTENT_TYPE,
        body: form,
      });
      expect(response.status).toBe(403);
      expect(store.documents).toHaveLength(0);
      expect(storagePutMock).not.toHaveBeenCalled();
    });
  });

  it('rejects document upload for an unsupported file type', async () => {
    store.role = 'system_admin';
    await withApi(async (baseUrl) => {
      const form = new FormData();
      form.set('category', 'other');
      form.set('title', 'Bad Type');
      form.set('file', new File(['not allowed'], 'script.exe', { type: 'application/x-msdownload' }));

      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/documents`, {
        method: 'POST',
        headers: AUTH_NO_CONTENT_TYPE,
        body: form,
      });
      const body = await response.json();
      expect(response.status).toBe(422);
      expect(body.error.code).toBe('unsupported_file_type');
      expect(storagePutMock).not.toHaveBeenCalled();
    });
  });

  it('rejects document upload that exceeds the configured size limit', async () => {
    process.env.DOCUMENT_MAX_SIZE_BYTES = '10';
    store.role = 'system_admin';
    await withApi(async (baseUrl) => {
      const form = new FormData();
      form.set('category', 'other');
      form.set('title', 'Too Big');
      form.set('file', new File(['this file is definitely longer than ten bytes'], 'big.pdf', { type: 'application/pdf' }));

      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/documents`, {
        method: 'POST',
        headers: AUTH_NO_CONTENT_TYPE,
        body: form,
      });
      expect(response.status).toBe(422);
      expect(storagePutMock).not.toHaveBeenCalled();
    });
  });

  it('returns 404 when uploading to a foreign property', async () => {
    store.role = 'system_admin';
    await withApi(async (baseUrl) => {
      const form = new FormData();
      form.set('category', 'other');
      form.set('title', 'Cross tenant');
      form.set('file', new File(['data'], 'file.pdf', { type: 'application/pdf' }));

      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_B}/documents`, {
        method: 'POST',
        headers: AUTH_NO_CONTENT_TYPE,
        body: form,
      });
      const body = await response.json();
      expect(response.status).toBe(404);
      expect(body.error.message).toBe('Property not found');
    });
  });

  it('lists documents for a property, excluding archived by default', async () => {
    store.documents.push(
      {
        id: 'aaaa1111-1111-4111-8111-111111111111',
        organization_id: ORG_A,
        property_id: PROPERTY_A,
        negotiation_id: null,
        category: 'title_deed',
        status: 'draft',
        title: 'Active Doc',
        original_filename: 'a.pdf',
        content_type: 'application/pdf',
        size_bytes: 10,
        storage_provider: 'local',
        storage_key: 'k1',
        uploaded_by_user_id: USER_ID,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        archived_at: null,
      },
      {
        id: 'aaaa2222-2222-4222-8222-222222222222',
        organization_id: ORG_A,
        property_id: PROPERTY_A,
        negotiation_id: null,
        category: 'other',
        status: 'superseded',
        title: 'Archived Doc',
        original_filename: 'b.pdf',
        content_type: 'application/pdf',
        size_bytes: 10,
        storage_provider: 'local',
        storage_key: 'k2',
        uploaded_by_user_id: USER_ID,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        archived_at: '2026-02-01T00:00:00Z',
      },
    );
    await withApi(async (baseUrl) => {
      const defaultList = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/documents`, { headers: AUTH });
      const defaultBody = await defaultList.json();
      expect(defaultBody.data.map((doc: { title: string }) => doc.title)).toEqual(['Active Doc']);

      const withArchived = await fetch(
        `${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/documents?includeArchived=true`,
        { headers: AUTH },
      );
      const withArchivedBody = await withArchived.json();
      expect(withArchivedBody.data).toHaveLength(2);
    });
  });

  it('returns 404 for a document on a foreign property', async () => {
    store.documents.push({
      id: 'bbbb1111-1111-4111-8111-111111111111',
      organization_id: ORG_B,
      property_id: PROPERTY_B,
      negotiation_id: null,
      category: 'other',
      status: 'draft',
      title: 'Foreign Doc',
      original_filename: 'c.pdf',
      content_type: 'application/pdf',
      size_bytes: 10,
      storage_provider: 'local',
      storage_key: 'k3',
      uploaded_by_user_id: USER_ID,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      archived_at: null,
    });
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/documents/bbbb1111-1111-4111-8111-111111111111`, {
        headers: AUTH,
      });
      const body = await response.json();
      expect(response.status).toBe(404);
      expect(body.error.message).toBe('Document not found');
    });
  });

  it('streams document content with the correct headers', async () => {
    const key = `${ORG_A}/${PROPERTY_A}/cccc1111-1111-4111-8111-111111111111/note.txt`;
    fakeFiles.set(key, Buffer.from('hello from storage'));
    store.documents.push({
      id: 'cccc1111-1111-4111-8111-111111111111',
      organization_id: ORG_A,
      property_id: PROPERTY_A,
      negotiation_id: null,
      category: 'other',
      status: 'draft',
      title: 'Streamed Doc',
      original_filename: 'note.txt',
      content_type: 'text/plain',
      size_bytes: 19,
      storage_provider: 'local',
      storage_key: key,
      uploaded_by_user_id: USER_ID,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      archived_at: null,
    });
    await withApi(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/v1/ops/documents/cccc1111-1111-4111-8111-111111111111/content`,
        { headers: AUTH },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/plain');
      expect(response.headers.get('content-disposition')).toContain('note.txt');
      expect(await response.text()).toBe('hello from storage');
    });
  });

  it('patches document category, status, and archive state as an allowed role', async () => {
    store.role = 'legal_documentation';
    store.documents.push({
      id: 'dddd1111-1111-4111-8111-111111111111',
      organization_id: ORG_A,
      property_id: PROPERTY_A,
      negotiation_id: null,
      category: 'other',
      status: 'draft',
      title: 'Patchable Doc',
      original_filename: 'd.pdf',
      content_type: 'application/pdf',
      size_bytes: 10,
      storage_provider: 'local',
      storage_key: 'k4',
      uploaded_by_user_id: USER_ID,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      archived_at: null,
    });
    await withApi(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/v1/ops/documents/dddd1111-1111-4111-8111-111111111111`,
        {
          method: 'PATCH',
          headers: AUTH,
          body: JSON.stringify({ status: 'verified', archived: true }),
        },
      );
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.data.status).toBe('verified');
      expect(body.data.archived_at).not.toBeNull();
    });
  });

  it('rejects a document patch for an unauthorized role', async () => {
    store.role = 'negotiator';
    store.documents.push({
      id: 'eeee1111-1111-4111-8111-111111111111',
      organization_id: ORG_A,
      property_id: PROPERTY_A,
      negotiation_id: null,
      category: 'other',
      status: 'draft',
      title: 'Locked Doc',
      original_filename: 'e.pdf',
      content_type: 'application/pdf',
      size_bytes: 10,
      storage_provider: 'local',
      storage_key: 'k5',
      uploaded_by_user_id: USER_ID,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      archived_at: null,
    });
    await withApi(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/v1/ops/documents/eeee1111-1111-4111-8111-111111111111`,
        {
          method: 'PATCH',
          headers: AUTH,
          body: JSON.stringify({ status: 'verified' }),
        },
      );
      expect(response.status).toBe(403);
    });
  });

  function seedTask(overrides: Partial<Record<string, unknown>> = {}) {
    const task = {
      id: crypto.randomUUID(),
      organization_id: ORG_A,
      property_id: PROPERTY_A,
      title: 'Seeded task',
      description: null,
      status: 'open',
      priority: 'normal',
      assigned_user_id: null,
      due_on: null,
      created_by_user_id: USER_ID,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      archived_at: null,
      ...overrides,
    };
    store.tasks.push(task);
    return task;
  }

  it('creates a task as an elevated manager, assigned to another active member', async () => {
    store.role = 'system_admin';
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/tasks`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ title: 'Follow up with owner', priority: 'high', assignedUserId: NEGOTIATOR_ID }),
      });
      const body = await response.json();
      expect(response.status).toBe(201);
      expect(body.data).toMatchObject({
        title: 'Follow up with owner',
        priority: 'high',
        status: 'open',
        assigned_user_id: NEGOTIATOR_ID,
        assigned_user_name: 'Negotiator User',
        created_by_user_id: USER_ID,
      });
    });
  });

  it('creates an unassigned task as an elevated manager', async () => {
    store.role = 'land_acquisition_manager';
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/tasks`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ title: 'Unassigned follow-up' }),
      });
      const body = await response.json();
      expect(response.status).toBe(201);
      expect(body.data.assigned_user_id).toBeNull();
    });
  });

  it('lets a negotiator create only a self-assigned task on their assigned property', async () => {
    store.role = 'negotiator';
    store.properties[0].assigned_negotiator_id = USER_ID;
    await withApi(async (baseUrl) => {
      const selfAssigned = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/tasks`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ title: 'Call the owner back', assignedUserId: USER_ID }),
      });
      expect(selfAssigned.status).toBe(201);

      const forOther = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/tasks`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ title: 'Assign to someone else', assignedUserId: NEGOTIATOR_ID }),
      });
      expect(forOther.status).toBe(403);
    });
  });

  it('denies a negotiator not assigned to the property from creating a task', async () => {
    store.role = 'negotiator';
    store.properties[0].assigned_negotiator_id = NEGOTIATOR_ID; // not USER_ID
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/tasks`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ title: 'Not my property', assignedUserId: USER_ID }),
      });
      expect(response.status).toBe(403);
    });
  });

  it('lets legal_documentation create only a self-assigned task, on any property in the org', async () => {
    store.role = 'legal_documentation';
    await withApi(async (baseUrl) => {
      const selfAssigned = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/tasks`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ title: 'Review title documents', assignedUserId: USER_ID }),
      });
      expect(selfAssigned.status).toBe(201);

      const forOther = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/tasks`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ title: 'Assign to someone else', assignedUserId: NEGOTIATOR_ID }),
      });
      expect(forOther.status).toBe(403);
    });
  });

  it('lets finance create only a self-assigned task', async () => {
    store.role = 'finance';
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/tasks`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ title: 'Confirm payment schedule', assignedUserId: USER_ID }),
      });
      expect(response.status).toBe(201);
    });
  });

  it('denies a viewer from creating any task', async () => {
    store.role = 'viewer';
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/tasks`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ title: 'Viewer attempt', assignedUserId: USER_ID }),
      });
      expect(response.status).toBe(403);
    });
  });

  it('lets a supervisor manage tasks within their managed property/project scope', async () => {
    store.role = 'supervisor';
    // PROPERTY_A.assigned_manager_id and PROJECT_A.manager_user_id both default to USER_ID.
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/tasks`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ title: 'Supervisor in scope', assignedUserId: NEGOTIATOR_ID }),
      });
      expect(response.status).toBe(201);
    });
  });

  it('denies a supervisor outside their managed property/project scope', async () => {
    store.role = 'supervisor';
    store.properties[0].assigned_manager_id = NEGOTIATOR_ID;
    store.projects[0].manager_user_id = NEGOTIATOR_ID;
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/tasks`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ title: 'Out of scope', assignedUserId: USER_ID }),
      });
      expect(response.status).toBe(403);
    });
  });

  it('returns 404 creating a task on a foreign property', async () => {
    store.role = 'system_admin';
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_B}/tasks`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ title: 'Cross tenant' }),
      });
      const body = await response.json();
      expect(response.status).toBe(404);
      expect(body.error.message).toBe('Property not found');
    });
  });

  it('lists tasks for a property, excluding archived by default', async () => {
    seedTask({ title: 'Active task', archived_at: null });
    seedTask({ title: 'Archived task', archived_at: '2026-02-01T00:00:00Z' });
    await withApi(async (baseUrl) => {
      const defaultList = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/tasks`, { headers: AUTH });
      const defaultBody = await defaultList.json();
      expect(defaultBody.data.map((task: { title: string }) => task.title)).toEqual(['Active task']);

      const withArchived = await fetch(
        `${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/tasks?includeArchived=true`,
        { headers: AUTH },
      );
      const withArchivedBody = await withArchived.json();
      expect(withArchivedBody.data).toHaveLength(2);
    });
  });

  it('lets an elevated manager edit, reassign, and archive any task', async () => {
    store.role = 'system_admin';
    const task = seedTask({ assigned_user_id: NEGOTIATOR_ID });
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/tasks/${task.id}`, {
        method: 'PATCH',
        headers: AUTH,
        body: JSON.stringify({ status: 'in_progress', assignedUserId: USER_ID, archived: true }),
      });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({ status: 'in_progress', assigned_user_id: USER_ID });
      expect(body.data.archived_at).not.toBeNull();
    });
  });

  it('lets an assignee edit and complete their own task but not reassign it', async () => {
    store.role = 'negotiator';
    const task = seedTask({ assigned_user_id: USER_ID });
    await withApi(async (baseUrl) => {
      const edit = await fetch(`${baseUrl}/api/v1/ops/tasks/${task.id}`, {
        method: 'PATCH',
        headers: AUTH,
        body: JSON.stringify({ status: 'done', priority: 'urgent' }),
      });
      const editBody = await edit.json();
      expect(edit.status).toBe(200);
      expect(editBody.data).toMatchObject({ status: 'done', priority: 'urgent' });

      const reassign = await fetch(`${baseUrl}/api/v1/ops/tasks/${task.id}`, {
        method: 'PATCH',
        headers: AUTH,
        body: JSON.stringify({ assignedUserId: NEGOTIATOR_ID }),
      });
      expect(reassign.status).toBe(403);
    });
  });

  it('denies a viewer from editing or archiving even their own assigned task', async () => {
    store.role = 'viewer';
    const task = seedTask({ assigned_user_id: USER_ID });
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/tasks/${task.id}`, {
        method: 'PATCH',
        headers: AUTH,
        body: JSON.stringify({ status: 'done' }),
      });
      expect(response.status).toBe(403);
    });
  });

  it('denies a user who is neither manager nor assignee from editing a task', async () => {
    store.role = 'negotiator';
    const task = seedTask({ assigned_user_id: NEGOTIATOR_ID });
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/tasks/${task.id}`, {
        method: 'PATCH',
        headers: AUTH,
        body: JSON.stringify({ status: 'done' }),
      });
      expect(response.status).toBe(403);
    });
  });

  function seedPayment(overrides: Partial<Record<string, unknown>> = {}) {
    const payment = {
      id: crypto.randomUUID(),
      organization_id: ORG_A,
      property_id: PROPERTY_A,
      negotiation_id: null,
      amount: 500000,
      currency_code: 'PHP',
      payment_type: 'deposit',
      status: 'pending',
      scheduled_on: null,
      paid_on: null,
      reference_number: null,
      recorded_by_user_id: USER_ID,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      archived_at: null,
      ...overrides,
    };
    store.payments.push(payment);
    return payment;
  }

  it.each(['system_admin', 'land_acquisition_manager', 'finance'] as const)(
    'lets %s create a payment',
    async (role) => {
      store.role = role;
      await withApi(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/payments`, {
          method: 'POST',
          headers: AUTH,
          body: JSON.stringify({ amount: 750000, paymentType: 'installment', referenceNumber: 'REF-1' }),
        });
        const body = await response.json();
        expect(response.status).toBe(201);
        expect(body.data).toMatchObject({
          property_id: PROPERTY_A,
          organization_id: ORG_A,
          amount: 750000,
          currency_code: 'PHP',
          payment_type: 'installment',
          status: 'pending',
          reference_number: 'REF-1',
          recorded_by_user_id: USER_ID,
          recorded_by_name: 'Test User',
        });
      });
    },
  );

  it.each(['supervisor', 'negotiator', 'legal_documentation', 'viewer'] as const)(
    'denies %s from creating a payment',
    async (role) => {
      store.role = role;
      await withApi(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/payments`, {
          method: 'POST',
          headers: AUTH,
          body: JSON.stringify({ amount: 100000, paymentType: 'deposit' }),
        });
        expect(response.status).toBe(403);
      });
    },
  );

  it('rejects a non-positive payment amount', async () => {
    store.role = 'finance';
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/payments`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ amount: 0, paymentType: 'deposit' }),
      });
      expect(response.status).toBe(400);
    });
  });

  it('returns 404 creating a payment on a foreign property', async () => {
    store.role = 'finance';
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_B}/payments`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ amount: 100000, paymentType: 'deposit' }),
      });
      const body = await response.json();
      expect(response.status).toBe(404);
      expect(body.error.message).toBe('Property not found');
    });
  });

  it('lists payments for a property, excluding archived by default', async () => {
    seedPayment({ amount: 200000, archived_at: null });
    seedPayment({ amount: 300000, archived_at: '2026-02-01T00:00:00Z' });
    await withApi(async (baseUrl) => {
      const defaultList = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/payments`, { headers: AUTH });
      const defaultBody = await defaultList.json();
      expect(defaultBody.data.map((payment: { amount: number }) => payment.amount)).toEqual([200000]);

      const withArchived = await fetch(
        `${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/payments?includeArchived=true`,
        { headers: AUTH },
      );
      const withArchivedBody = await withArchived.json();
      expect(withArchivedBody.data).toHaveLength(2);
    });
  });

  it('lets finance and admin update and archive a payment', async () => {
    store.role = 'finance';
    const payment = seedPayment();
    await withApi(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ops/payments/${payment.id}`, {
        method: 'PATCH',
        headers: AUTH,
        body: JSON.stringify({ status: 'paid', paidOn: '2026-03-01', archived: true }),
      });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({ status: 'paid', paid_on: '2026-03-01' });
      expect(body.data.archived_at).not.toBeNull();
    });
  });

  it.each(['supervisor', 'negotiator', 'legal_documentation', 'viewer'] as const)(
    'denies %s from updating a payment',
    async (role) => {
      store.role = role;
      const payment = seedPayment();
      await withApi(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/v1/ops/payments/${payment.id}`, {
          method: 'PATCH',
          headers: AUTH,
          body: JSON.stringify({ status: 'paid' }),
        });
        expect(response.status).toBe(403);
      });
    },
  );

  function postSignature(baseUrl: string, body: Record<string, unknown>, propertyId = PROPERTY_A) {
    return fetch(`${baseUrl}/api/v1/ops/properties/${propertyId}/agreement-signatures`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(body),
    });
  }

  it.each(['system_admin', 'land_acquisition_manager', 'legal_documentation'] as const)(
    'lets %s record an agreement signature',
    async (role) => {
      store.role = role;
      seedSignatureFixtures();
      await withApi(async (baseUrl) => {
        const response = await postSignature(baseUrl, {
          documentId: EXECUTED_DOC_A,
          ownerId: OWNER_A,
          signedOn: '2026-09-20',
        });
        const body = await response.json();
        expect(response.status).toBe(201);
        expect(body.data).toMatchObject({
          organization_id: ORG_A,
          property_id: PROPERTY_A,
          document_id: EXECUTED_DOC_A,
          owner_id: OWNER_A,
          signed_on: '2026-09-20',
          recorded_by_user_id: USER_ID,
          owner_name: 'Rosa Mendoza',
          document_title: 'Deed of Sale',
          archived_at: null,
        });
      });
    },
  );

  it.each(['supervisor', 'negotiator', 'finance', 'viewer'] as const)(
    'denies %s from recording or archiving an agreement signature',
    async (role) => {
      seedSignatureFixtures();
      store.agreementSignatures.push({
        id: 'f0000000-0000-4000-8000-000000000001',
        organization_id: ORG_A,
        property_id: PROPERTY_A,
        document_id: EXECUTED_DOC_A,
        owner_id: OWNER_A,
        signed_on: '2026-09-20',
        recorded_by_user_id: USER_ID,
        created_at: '2026-09-20T00:00:00Z',
        updated_at: '2026-09-20T00:00:00Z',
        archived_at: null,
      });
      store.role = role;
      await withApi(async (baseUrl) => {
        const create = await postSignature(baseUrl, {
          documentId: EXECUTED_DOC_A2,
          ownerId: OWNER_A2,
          signedOn: '2026-09-20',
        });
        expect(create.status).toBe(403);

        const archive = await fetch(`${baseUrl}/api/v1/ops/agreement-signatures/f0000000-0000-4000-8000-000000000001`, {
          method: 'PATCH',
          headers: AUTH,
          body: JSON.stringify({ archived: true }),
        });
        expect(archive.status).toBe(403);
        expect(store.agreementSignatures[0].archived_at).toBeNull();

        const list = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/agreement-signatures`, { headers: AUTH });
        expect(list.status).toBe(200);
      });
    },
  );

  it('rejects a document that is not agreement_executed, and one on another property', async () => {
    seedSignatureFixtures();
    await withApi(async (baseUrl) => {
      const draft = await postSignature(baseUrl, { documentId: DRAFT_DOC_A, ownerId: OWNER_A, signedOn: '2026-09-20' });
      expect(draft.status).toBe(422);
      expect((await draft.json()).error.message).toMatch(/agreement_executed/);

      const foreign = await postSignature(baseUrl, { documentId: EXECUTED_DOC_B, ownerId: OWNER_A, signedOn: '2026-09-20' });
      expect(foreign.status).toBe(422);
      expect((await foreign.json()).error.message).toMatch(/same property/);
    });
  });

  it('rejects a signatory who is not an owner of the property', async () => {
    seedSignatureFixtures();
    await withApi(async (baseUrl) => {
      const response = await postSignature(baseUrl, {
        documentId: EXECUTED_DOC_A,
        ownerId: OWNER_A_UNLINKED,
        signedOn: '2026-09-20',
      });
      expect(response.status).toBe(422);
      expect((await response.json()).error.message).toMatch(/existing owner/);
    });
  });

  it('returns 404 recording a signature on a foreign property', async () => {
    seedSignatureFixtures();
    await withApi(async (baseUrl) => {
      const response = await postSignature(
        baseUrl,
        { documentId: EXECUTED_DOC_B, ownerId: OWNER_B, signedOn: '2026-09-20' },
        PROPERTY_B,
      );
      expect(response.status).toBe(404);
    });
  });

  it('rejects a duplicate active signature with 409 and allows a replacement after archiving', async () => {
    seedSignatureFixtures();
    await withApi(async (baseUrl) => {
      const first = await postSignature(baseUrl, { documentId: EXECUTED_DOC_A, ownerId: OWNER_A, signedOn: '2026-09-20' });
      const firstBody = await first.json();
      expect(first.status).toBe(201);

      const duplicate = await postSignature(baseUrl, { documentId: EXECUTED_DOC_A, ownerId: OWNER_A, signedOn: '2026-09-21' });
      expect(duplicate.status).toBe(409);

      const archive = await fetch(`${baseUrl}/api/v1/ops/agreement-signatures/${firstBody.data.id}`, {
        method: 'PATCH',
        headers: AUTH,
        body: JSON.stringify({ archived: true }),
      });
      const archiveBody = await archive.json();
      expect(archive.status).toBe(200);
      expect(archiveBody.data.archived_at).not.toBeNull();

      const replacement = await postSignature(baseUrl, { documentId: EXECUTED_DOC_A, ownerId: OWNER_A, signedOn: '2026-09-21' });
      expect(replacement.status).toBe(201);
    });
  });

  it('supports multiple owners and multiple executed documents, filtered per document', async () => {
    seedSignatureFixtures();
    await withApi(async (baseUrl) => {
      for (const [documentId, ownerId] of [
        [EXECUTED_DOC_A, OWNER_A],
        [EXECUTED_DOC_A, OWNER_A2],
        [EXECUTED_DOC_A2, OWNER_A],
      ]) {
        expect((await postSignature(baseUrl, { documentId, ownerId, signedOn: '2026-09-20' })).status).toBe(201);
      }
      const all = await (await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/agreement-signatures`, { headers: AUTH })).json();
      expect(all.data).toHaveLength(3);

      const forSupplement = await (
        await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/agreement-signatures?documentId=${EXECUTED_DOC_A2}`, {
          headers: AUTH,
        })
      ).json();
      expect(forSupplement.data.map((row: { owner_id: string }) => row.owner_id)).toEqual([OWNER_A]);
    });
  });

  it('excludes archived signatures from the default list', async () => {
    seedSignatureFixtures();
    store.agreementSignatures.push(
      { id: crypto.randomUUID(), organization_id: ORG_A, property_id: PROPERTY_A, document_id: EXECUTED_DOC_A, owner_id: OWNER_A, signed_on: '2026-09-20', recorded_by_user_id: USER_ID, created_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-20T00:00:00Z', archived_at: '2026-09-21T00:00:00Z' },
      { id: crypto.randomUUID(), organization_id: ORG_A, property_id: PROPERTY_A, document_id: EXECUTED_DOC_A, owner_id: OWNER_A, signed_on: '2026-09-21', recorded_by_user_id: USER_ID, created_at: '2026-09-21T00:00:00Z', updated_at: '2026-09-21T00:00:00Z', archived_at: null },
    );
    await withApi(async (baseUrl) => {
      const active = await (await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/agreement-signatures`, { headers: AUTH })).json();
      expect(active.data).toHaveLength(1);
      const all = await (
        await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/agreement-signatures?includeArchived=true`, { headers: AUTH })
      ).json();
      expect(all.data).toHaveLength(2);
    });
  });

  it('only accepts archiving on PATCH; immutable fields are never client-writable', async () => {
    seedSignatureFixtures();
    await withApi(async (baseUrl) => {
      const created = await (
        await postSignature(baseUrl, { documentId: EXECUTED_DOC_A, ownerId: OWNER_A, signedOn: '2026-09-20' })
      ).json();
      const url = `${baseUrl}/api/v1/ops/agreement-signatures/${created.data.id}`;

      const editOnly = await fetch(url, { method: 'PATCH', headers: AUTH, body: JSON.stringify({ signedOn: '2020-01-01' }) });
      expect(editOnly.status).toBe(400);

      const unarchive = await fetch(url, { method: 'PATCH', headers: AUTH, body: JSON.stringify({ archived: false }) });
      expect(unarchive.status).toBe(400);

      // Immutable fields sent alongside the archive are refused, and nothing changes, not even the archive.
      const archiveWithExtras = await fetch(url, {
        method: 'PATCH',
        headers: AUTH,
        body: JSON.stringify({ archived: true, ownerId: OWNER_A2, signedOn: '2020-01-01', documentId: EXECUTED_DOC_A2 }),
      });
      expect(archiveWithExtras.status).toBe(400);
      expect((await archiveWithExtras.json()).error).toMatchObject({
        code: 'validation_error',
        details: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['ownerId', 'signedOn', 'documentId'] })],
      });
      expect(store.agreementSignatures.find((signature) => signature.id === created.data.id)).toMatchObject({
        owner_id: OWNER_A, signed_on: '2026-09-20', document_id: EXECUTED_DOC_A, archived_at: null,
      });

      const archived = await fetch(url, { method: 'PATCH', headers: AUTH, body: JSON.stringify({ archived: true }) });
      const body = await archived.json();
      expect(archived.status).toBe(200);
      expect(body.data).toMatchObject({ owner_id: OWNER_A, signed_on: '2026-09-20', document_id: EXECUTED_DOC_A });
      expect(body.data.archived_at).not.toBeNull();
    });
  });

  it('exposes no DELETE route for agreement signatures', async () => {
    seedSignatureFixtures();
    await withApi(async (baseUrl) => {
      const created = await (
        await postSignature(baseUrl, { documentId: EXECUTED_DOC_A, ownerId: OWNER_A, signedOn: '2026-09-20' })
      ).json();
      const response = await fetch(`${baseUrl}/api/v1/ops/agreement-signatures/${created.data.id}`, {
        method: 'DELETE',
        headers: AUTH,
      });
      expect(response.status).toBe(404);
      expect(store.agreementSignatures).toHaveLength(1);
    });
  });

  function archiveSignatureRequest(baseUrl: string, id: string) {
    return fetch(`${baseUrl}/api/v1/ops/agreement-signatures/${id}`, {
      method: 'PATCH',
      headers: AUTH,
      body: JSON.stringify({ archived: true }),
    });
  }

  function patchDocument(baseUrl: string, id: string, body: Record<string, unknown>) {
    return fetch(`${baseUrl}/api/v1/ops/documents/${id}`, { method: 'PATCH', headers: AUTH, body: JSON.stringify(body) });
  }

  it('returns 422 when unlinking an owner with an active signature, and 204 once it is archived', async () => {
    seedSignatureFixtures();
    await withApi(async (baseUrl) => {
      const created = await (
        await postSignature(baseUrl, { documentId: EXECUTED_DOC_A, ownerId: OWNER_A2, signedOn: '2026-09-20' })
      ).json();
      const unlinkUrl = `${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/owners/${OWNER_A2}`;

      const blocked = await fetch(unlinkUrl, { method: 'DELETE', headers: AUTH });
      expect(blocked.status).toBe(422);
      expect((await blocked.json()).error.message).toMatch(/active agreement signatures/);
      expect(store.links.some((link) => link.owner_id === OWNER_A2)).toBe(true);

      expect((await archiveSignatureRequest(baseUrl, created.data.id)).status).toBe(200);
      expect((await fetch(unlinkUrl, { method: 'DELETE', headers: AUTH })).status).toBe(204);
    });
  });

  it('allows unlinking an owner who has no active signature', async () => {
    seedSignatureFixtures();
    await withApi(async (baseUrl) => {
      await postSignature(baseUrl, { documentId: EXECUTED_DOC_A, ownerId: OWNER_A, signedOn: '2026-09-20' });
      const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/owners/${OWNER_A2}`, {
        method: 'DELETE',
        headers: AUTH,
      });
      expect(response.status).toBe(204);
    });
  });

  it('returns 422 when recategorizing a signed executed document, and 200 once signatures are archived', async () => {
    seedSignatureFixtures();
    await withApi(async (baseUrl) => {
      const created = await (
        await postSignature(baseUrl, { documentId: EXECUTED_DOC_A, ownerId: OWNER_A, signedOn: '2026-09-20' })
      ).json();

      const blocked = await patchDocument(baseUrl, EXECUTED_DOC_A, { category: 'other' });
      expect(blocked.status).toBe(422);
      expect((await blocked.json()).error.message).toMatch(/active agreement signatures/);
      expect(store.documents.find((doc) => doc.id === EXECUTED_DOC_A)?.category).toBe('agreement_executed');

      const retitled = await patchDocument(baseUrl, EXECUTED_DOC_A, { title: 'Deed of Sale (final)', status: 'verified' });
      expect(retitled.status).toBe(200);

      expect((await archiveSignatureRequest(baseUrl, created.data.id)).status).toBe(200);
      const allowed = await patchDocument(baseUrl, EXECUTED_DOC_A, { category: 'other' });
      expect(allowed.status).toBe(200);
      expect((await allowed.json()).data.category).toBe('other');
    });
  });

  it('allows recategorizing an executed document with no active signatures', async () => {
    seedSignatureFixtures();
    await withApi(async (baseUrl) => {
      const response = await patchDocument(baseUrl, EXECUTED_DOC_A2, { category: 'agreement_draft' });
      expect(response.status).toBe(200);
    });
  });

  it('does not touch property lifecycle fields when recording signatures', async () => {
    seedSignatureFixtures();
    const before = { ...store.properties[0] };
    await withApi(async (baseUrl) => {
      await postSignature(baseUrl, { documentId: EXECUTED_DOC_A, ownerId: OWNER_A, signedOn: '2026-09-20' });
      await postSignature(baseUrl, { documentId: EXECUTED_DOC_A, ownerId: OWNER_A2, signedOn: '2026-09-20' });
    });
    expect(store.properties[0]).toEqual(before);
    expect(store.tasks).toHaveLength(0);
    expect(store.negotiations).toHaveLength(0);
    expect(store.payments).toHaveLength(0);
    const statements = actorQuery.mock.calls.map(([sql]) => String(sql).toLowerCase());
    expect(statements.some((sql) => /update public\.(properties|tasks|negotiations|payments)/.test(sql))).toBe(false);
  });

  const TIMELINE_ROW_BASE = {
    actor_id: null,
    actor_name: null,
    code: null,
    status: null,
    amount: null,
    currency: null,
    title: null,
    secondary: null,
    event_ts: null,
    event_date: null,
  };

  function seedTimelineRows() {
    store.timelineRows = [
      { ...TIMELINE_ROW_BASE, source_type: 'agreement_signature', source_id: 'sig-1', kind: 'agreement_signed', basis: 'occurrence', actor_id: USER_ID, actor_name: 'Test User', title: 'Rosa Mendoza', secondary: 'Deed of Sale', event_date: '2026-09-20' },
      { ...TIMELINE_ROW_BASE, source_type: 'payment', source_id: 'pay-1', kind: 'payment_paid', basis: 'occurrence', code: 'deposit', status: 'paid', amount: '500000.00', currency: 'PHP', event_date: '2026-09-19' },
      { ...TIMELINE_ROW_BASE, source_type: 'payment', source_id: 'pay-1', kind: 'payment_recorded', basis: 'recorded', actor_id: USER_ID, actor_name: 'Test User', code: 'deposit', status: 'paid', amount: '500000.00', currency: 'PHP', event_ts: new Date('2026-09-19T02:00:00Z') },
      { ...TIMELINE_ROW_BASE, source_type: 'task', source_id: 'task-1', kind: 'task_created', basis: 'recorded', actor_id: NEGOTIATOR_ID, actor_name: null, title: 'Collect signatures', event_ts: new Date('2026-09-18T02:00:00Z') },
      { ...TIMELINE_ROW_BASE, source_type: 'document', source_id: 'doc-1', kind: 'document_uploaded', basis: 'recorded', actor_id: USER_ID, actor_name: 'Test User', code: 'title_deed', title: 'Transfer Certificate', event_ts: new Date('2026-09-17T02:00:00Z') },
      { ...TIMELINE_ROW_BASE, source_type: 'negotiation_event', source_id: 'event-1', kind: 'negotiation_event', basis: 'occurrence', actor_id: USER_ID, actor_name: 'Test User', code: 'counteroffer', amount: '1250000.50', currency: 'PHP', event_ts: new Date('2026-09-16T02:00:00Z') },
      { ...TIMELINE_ROW_BASE, source_type: 'negotiation_event', source_id: 'event-2', kind: 'negotiation_event', basis: 'occurrence', actor_id: USER_ID, actor_name: 'Test User', code: 'meeting', currency: 'PHP', event_ts: new Date('2026-09-15T02:00:00Z') },
      { ...TIMELINE_ROW_BASE, source_type: 'negotiation', source_id: 'neg-1', kind: 'negotiation_recorded', basis: 'recorded', amount: '1000000.00', currency: 'PHP', event_ts: new Date('2026-09-14T02:00:00Z') },
    ];
  }

  function getTimeline(baseUrl: string, query = '', propertyId = PROPERTY_A) {
    return fetch(`${baseUrl}/api/v1/ops/properties/${propertyId}/timeline${query}`, { headers: AUTH });
  }

  function timelineQueryCalls() {
    return actorQuery.mock.calls.filter(([sql]) => String(sql).replace(/\s+/g, ' ').trim().toLowerCase().startsWith('with entries as'));
  }

  it('returns the normalized timeline with locked summaries, precision, basis, and actors', async () => {
    seedTimelineRows();
    await withApi(async (baseUrl) => {
      const response = await getTimeline(baseUrl);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.data).toEqual([
        {
          id: 'agreement_signature:sig-1:agreement_signed',
          kind: 'agreement_signed',
          source_type: 'agreement_signature',
          source_id: 'sig-1',
          occurred_at: '2026-09-20',
          precision: 'date',
          basis: 'occurrence',
          actor: { id: USER_ID, display_name: 'Test User' },
          summary: 'Rosa Mendoza signed Deed of Sale',
          archived: false,
        },
        {
          id: 'payment:pay-1:payment_paid',
          kind: 'payment_paid',
          source_type: 'payment',
          source_id: 'pay-1',
          occurred_at: '2026-09-19',
          precision: 'date',
          basis: 'occurrence',
          actor: null,
          summary: 'Deposit paid: PHP 500,000',
          archived: false,
        },
        expect.objectContaining({
          id: 'payment:pay-1:payment_recorded',
          occurred_at: '2026-09-19T02:00:00.000Z',
          precision: 'timestamp',
          basis: 'recorded',
          actor: { id: USER_ID, display_name: 'Test User' },
          summary: 'Deposit recorded: PHP 500,000 · Paid',
        }),
        expect.objectContaining({
          kind: 'task_created',
          actor: { id: NEGOTIATOR_ID, display_name: null },
          summary: 'Task created: Collect signatures',
        }),
        expect.objectContaining({ kind: 'document_uploaded', summary: 'Title deed: Transfer Certificate' }),
        expect.objectContaining({ kind: 'negotiation_event', summary: 'Counteroffer: PHP 1,250,000.5' }),
        expect.objectContaining({ kind: 'negotiation_event', summary: 'Meeting logged' }),
        expect.objectContaining({
          kind: 'negotiation_recorded',
          source_type: 'negotiation',
          basis: 'recorded',
          actor: null,
          summary: 'Negotiation recorded · opening PHP 1,000,000',
        }),
      ]);
    });
  });

  it('pages with limit 50 and offset 0 by default, passes limit/offset through, and ignores includeArchived', async () => {
    await withApi(async (baseUrl) => {
      expect((await getTimeline(baseUrl)).status).toBe(200);
      expect((await getTimeline(baseUrl, '?limit=200&offset=40')).status).toBe(200);
      expect((await getTimeline(baseUrl, '?includeArchived=true')).status).toBe(200);
    });
    const params = timelineQueryCalls().map(([, values]) => values);
    expect(params).toEqual([
      [PROPERTY_A, 'Asia/Manila', '2026-09-23', 50, 0],
      [PROPERTY_A, 'Asia/Manila', '2026-09-23', 200, 40],
      [PROPERTY_A, 'Asia/Manila', '2026-09-23', 50, 0],
    ]);
  });

  it.each(['?limit=0', '?limit=201', '?limit=abc', '?limit=2.5', '?offset=-1', '?offset=abc'])(
    'rejects invalid paging %s with 400',
    async (query) => {
      await withApi(async (baseUrl) => {
        expect((await getTimeline(baseUrl, query)).status).toBe(400);
      });
      expect(timelineQueryCalls()).toHaveLength(0);
    },
  );

  it('rejects a malformed property id with 400 and an unauthenticated request with 401', async () => {
    await withApi(async (baseUrl) => {
      expect((await getTimeline(baseUrl, '', 'not-a-uuid')).status).toBe(400);
      const anonymous = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/timeline`);
      expect(anonymous.status).toBe(401);
    });
  });

  it('returns 404 for a foreign or unknown property before reading any timeline source', async () => {
    seedTimelineRows();
    await withApi(async (baseUrl) => {
      expect((await getTimeline(baseUrl, '', PROPERTY_B)).status).toBe(404);
      expect((await getTimeline(baseUrl, '', crypto.randomUUID())).status).toBe(404);
    });
    expect(timelineQueryCalls()).toHaveLength(0);
  });

  it('returns 422 when the organization timezone is not recognized', async () => {
    store.timezone = 'Not a zone';
    await withApi(async (baseUrl) => {
      const response = await getTimeline(baseUrl);
      expect(response.status).toBe(422);
      expect((await response.json()).error.message).toMatch(/time zone/);
    });
    expect(timelineQueryCalls()).toHaveLength(0);
  });

  it.each(['system_admin', 'land_acquisition_manager', 'supervisor', 'negotiator', 'legal_documentation', 'finance', 'viewer'] as const)(
    'lets %s read the timeline of a visible property',
    async (role) => {
      store.role = role;
      seedTimelineRows();
      await withApi(async (baseUrl) => {
        const response = await getTimeline(baseUrl);
        expect(response.status).toBe(200);
        expect((await response.json()).data).toHaveLength(8);
      });
    },
  );

  it('exposes no write routes and issues no writes', async () => {
    seedTimelineRows();
    await withApi(async (baseUrl) => {
      await getTimeline(baseUrl);
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/timeline`, {
          method,
          headers: AUTH,
          body: method === 'DELETE' ? undefined : JSON.stringify({}),
        });
        expect(response.status).toBe(404);
      }
    });
    const statements = actorQuery.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => /\b(insert|update|delete)\b/i.test(sql))).toBe(false);
  });

  // Interactions (Gate A). Scope and tenant rules are proven against real
  // PostgreSQL; these cover the route gate, validation, and mapping.
  function interactionsUrl(baseUrl: string, propertyId = PROPERTY_A) {
    return `${baseUrl}/api/v1/ops/properties/${propertyId}/interactions`;
  }

  function postInteraction(baseUrl: string, body: Record<string, unknown>, propertyId = PROPERTY_A) {
    return fetch(interactionsUrl(baseUrl, propertyId), { method: 'POST', headers: AUTH, body: JSON.stringify(body) });
  }

  function archiveInteraction(baseUrl: string, id: string, body: Record<string, unknown> = { archived: true }) {
    return fetch(`${baseUrl}/api/v1/ops/interactions/${id}`, { method: 'PATCH', headers: AUTH, body: JSON.stringify(body) });
  }

  function linkOwnerA() {
    store.links.push({ property_id: PROPERTY_A, owner_id: OWNER_A, ownership_percent: 100, is_primary: true, created_at: '2026-01-01T00:00:00Z' });
  }

  it.each(['system_admin', 'land_acquisition_manager', 'supervisor', 'negotiator'] as const)(
    'lets %s record, list, and archive an interaction',
    async (role) => {
      store.role = role;
      linkOwnerA();
      await withApi(async (baseUrl) => {
        const created = await postInteraction(baseUrl, {
          interactionType: 'site_visit',
          notes: '  Walked the boundary with the owner.  ',
          ownerId: OWNER_A,
        });
        const body = await created.json();
        expect(created.status).toBe(201);
        expect(body.data).toMatchObject({
          organization_id: ORG_A,
          property_id: PROPERTY_A,
          owner_id: OWNER_A,
          owner_name: 'Rosa Mendoza',
          interaction_type: 'site_visit',
          notes: 'Walked the boundary with the owner.',
          recorded_by_user_id: USER_ID,
          recorded_by_name: 'Test User',
          archived_at: null,
        });

        const listed = await fetch(interactionsUrl(baseUrl), { headers: AUTH });
        expect(listed.status).toBe(200);
        expect((await listed.json()).data.map((row: { id: string }) => row.id)).toEqual([body.data.id]);

        const archived = await archiveInteraction(baseUrl, body.data.id);
        expect(archived.status).toBe(200);
        expect((await archived.json()).data.archived_at).not.toBeNull();
        expect((await (await fetch(interactionsUrl(baseUrl), { headers: AUTH })).json()).data).toEqual([]);
      });
    },
  );

  it.each(['legal_documentation', 'finance', 'viewer'] as const)(
    'returns 403 to %s for listing, recording, and archiving',
    async (role) => {
      // The mock has no RLS, so the route's own role check is what answers
      // PATCH here. Against PostgreSQL these roles cannot read the row, so a
      // live PATCH returns 404 before the role check is reached.
      store.interactions.push({
        id: 'c0000000-0000-4000-8000-000000000001',
        organization_id: ORG_A,
        property_id: PROPERTY_A,
        owner_id: null,
        interaction_type: 'call',
        notes: 'Existing call',
        occurred_at: '2026-09-01T00:00:00.000Z',
        recorded_by_user_id: USER_ID,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
        archived_at: null,
      });
      store.role = role;
      await withApi(async (baseUrl) => {
        expect((await fetch(interactionsUrl(baseUrl), { headers: AUTH })).status).toBe(403);
        expect((await postInteraction(baseUrl, { interactionType: 'call', notes: 'Denied' })).status).toBe(403);
        expect((await archiveInteraction(baseUrl, 'c0000000-0000-4000-8000-000000000001')).status).toBe(403);
      });
      expect(store.interactions).toHaveLength(1);
      expect(store.interactions[0].archived_at).toBeNull();
    },
  );

  it('returns 404 for a foreign or unknown property and an unknown interaction', async () => {
    await withApi(async (baseUrl) => {
      expect((await fetch(interactionsUrl(baseUrl, PROPERTY_B), { headers: AUTH })).status).toBe(404);
      expect((await postInteraction(baseUrl, { interactionType: 'call', notes: 'x' }, PROPERTY_B)).status).toBe(404);
      expect((await postInteraction(baseUrl, { interactionType: 'call', notes: 'x' }, crypto.randomUUID())).status).toBe(404);
      expect((await archiveInteraction(baseUrl, crypto.randomUUID())).status).toBe(404);
    });
    expect(store.interactions).toHaveLength(0);
  });

  it.each([
    ['type note', { interactionType: 'note', notes: 'x' }],
    ['type follow_up', { interactionType: 'follow_up', notes: 'x' }],
    ['a missing type', { notes: 'x' }],
    ['missing notes', { interactionType: 'call' }],
    ['empty notes', { interactionType: 'call', notes: '' }],
    ['whitespace-only notes', { interactionType: 'call', notes: ' \n\t ' }],
    ['notes over 4000 characters', { interactionType: 'call', notes: 'x'.repeat(4001) }],
    ['a non-ISO occurredAt', { interactionType: 'call', notes: 'x', occurredAt: '2026-09-01 10:00' }],
    ['a malformed ownerId', { interactionType: 'call', notes: 'x', ownerId: 'not-a-uuid' }],
  ])('rejects %s with 400', async (_label, body) => {
    await withApi(async (baseUrl) => {
      expect((await postInteraction(baseUrl, body)).status).toBe(400);
    });
    expect(store.interactions).toHaveLength(0);
  });

  it('accepts all five locked types and 4000-character notes', async () => {
    await withApi(async (baseUrl) => {
      for (const interactionType of ['call', 'meeting', 'site_visit', 'message', 'other']) {
        expect((await postInteraction(baseUrl, { interactionType, notes: 'x'.repeat(4000) })).status).toBe(201);
      }
    });
    expect(store.interactions.map((row) => row.interaction_type)).toEqual(['call', 'meeting', 'site_visit', 'message', 'other']);
  });

  it('derives organization, property, and recorder on the server and defaults occurredAt to the server clock', async () => {
    await withApi(async (baseUrl) => {
      // Client-supplied server-derived fields are refused before anything is written.
      const refused = await postInteraction(baseUrl, {
        interactionType: 'call',
        notes: 'Server derives the rest',
        organizationId: ORG_B,
        propertyId: PROPERTY_B,
        recordedByUserId: NEGOTIATOR_ID,
      });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toMatchObject({
        code: 'validation_error',
        details: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['organizationId', 'propertyId', 'recordedByUserId'] })],
      });
      expect(store.interactions).toHaveLength(0);

      const response = await postInteraction(baseUrl, { interactionType: 'call', notes: 'Server derives the rest' });
      expect(response.status).toBe(201);
    });
    expect(store.interactions[0]).toMatchObject({ organization_id: ORG_A, property_id: PROPERTY_A, recorded_by_user_id: USER_ID });
    const insert = actorQuery.mock.calls.find(([sql]) => String(sql).includes('insert into public.interactions'))!;
    expect(String(insert[0])).toContain(`coalesce($6::timestamptz, timezone('utc', now()))`);
    expect((insert[1] as unknown[])[5]).toBeNull();
  });

  it('returns 422 for an owner not linked to the property and for a future occurredAt', async () => {
    await withApi(async (baseUrl) => {
      const unlinked = await postInteraction(baseUrl, { interactionType: 'call', notes: 'x', ownerId: OWNER_A });
      expect(unlinked.status).toBe(422);
      expect((await unlinked.json()).error.message).toMatch(/existing owner/);

      const future = await postInteraction(baseUrl, {
        interactionType: 'call',
        notes: 'x',
        occurredAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(future.status).toBe(422);
      expect((await future.json()).error.message).toMatch(/future/);

      const past = await postInteraction(baseUrl, { interactionType: 'call', notes: 'x', occurredAt: '2026-01-15T09:30:00.000Z' });
      expect(past.status).toBe(201);
    });
  });

  it('only accepts archiving on PATCH, keeps the first archive time, and exposes no DELETE route', async () => {
    await withApi(async (baseUrl) => {
      const created = await (await postInteraction(baseUrl, { interactionType: 'meeting', notes: 'Original' })).json();
      const id = created.data.id;
      expect((await archiveInteraction(baseUrl, id, { archived: false })).status).toBe(400);
      expect((await archiveInteraction(baseUrl, id, { notes: 'Rewritten' })).status).toBe(400);

      // Immutable fields sent alongside the archive are refused, and the interaction is neither archived nor rewritten.
      const withExtras = await archiveInteraction(baseUrl, id, { archived: true, notes: 'Rewritten', interactionType: 'call' });
      expect(withExtras.status).toBe(400);
      expect((await withExtras.json()).error).toMatchObject({
        code: 'validation_error',
        details: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['notes', 'interactionType'] })],
      });
      expect(store.interactions[0]).toMatchObject({ notes: 'Original', interaction_type: 'meeting', archived_at: null });

      const first = await (await archiveInteraction(baseUrl, id)).json();
      expect(first.data).toMatchObject({ notes: 'Original', interaction_type: 'meeting' });
      const again = await (await archiveInteraction(baseUrl, id)).json();
      expect(again.data.archived_at).toBe(first.data.archived_at);

      const deleted = await fetch(`${baseUrl}/api/v1/ops/interactions/${id}`, { method: 'DELETE', headers: AUTH });
      expect(deleted.status).toBe(404);
    });
    expect(store.interactions).toHaveLength(1);
  });

  it('ignores includeArchived on the interaction list', async () => {
    await withApi(async (baseUrl) => {
      const created = await (await postInteraction(baseUrl, { interactionType: 'call', notes: 'x' })).json();
      await archiveInteraction(baseUrl, created.data.id);
      const listed = await (await fetch(`${interactionsUrl(baseUrl)}?includeArchived=true`, { headers: AUTH })).json();
      expect(listed.data).toEqual([]);
    });
  });

  it('writes nothing outside the interactions table when recording and archiving', async () => {
    linkOwnerA();
    const before = { ...store.properties[0] };
    await withApi(async (baseUrl) => {
      const created = await (await postInteraction(baseUrl, { interactionType: 'call', notes: 'x', ownerId: OWNER_A })).json();
      await archiveInteraction(baseUrl, created.data.id);
    });
    expect(store.properties[0]).toEqual(before);
    const writes = actorQuery.mock.calls
      .map(([sql]) => String(sql).replace(/\s+/g, ' ').trim().toLowerCase())
      .filter((sql) => /^(insert|update|delete)\b/.test(sql));
    expect(writes.length).toBe(2);
    expect(writes.every((sql) => /^(insert into|update) public\.interactions\b/.test(sql))).toBe(true);
  });

  it('maps interaction rows into Timeline entries without notes', async () => {
    store.timelineRows = [
      { ...TIMELINE_ROW_BASE, source_type: 'interaction', source_id: 'int-1', kind: 'interaction', basis: 'occurrence', actor_id: NEGOTIATOR_ID, actor_name: 'Negotiator User', code: 'call', title: 'Rosa Mendoza', event_ts: new Date('2026-09-20T03:00:00Z') },
      { ...TIMELINE_ROW_BASE, source_type: 'interaction', source_id: 'int-2', kind: 'interaction', basis: 'occurrence', actor_id: USER_ID, actor_name: 'Test User', code: 'site_visit', event_ts: new Date('2026-09-19T03:00:00Z') },
      { ...TIMELINE_ROW_BASE, source_type: 'interaction', source_id: 'int-3', kind: 'interaction', basis: 'occurrence', actor_id: USER_ID, actor_name: 'Test User', code: 'other', event_ts: new Date('2026-09-18T03:00:00Z') },
    ];
    await withApi(async (baseUrl) => {
      const body = await (await getTimeline(baseUrl)).json();
      expect(body.data).toEqual([
        {
          id: 'interaction:int-1:interaction',
          kind: 'interaction',
          source_type: 'interaction',
          source_id: 'int-1',
          occurred_at: '2026-09-20T03:00:00.000Z',
          precision: 'timestamp',
          basis: 'occurrence',
          actor: { id: NEGOTIATOR_ID, display_name: 'Negotiator User' },
          summary: 'Call with Rosa Mendoza',
          archived: false,
        },
        expect.objectContaining({ summary: 'Site visit' }),
        expect.objectContaining({ summary: 'Other interaction' }),
      ]);
    });
    const timelineSql = String(timelineQueryCalls()[0][0]);
    expect(timelineSql).toContain(`'interaction', 7`);
    expect(timelineSql).not.toMatch(/\bi\.notes\b/);
  });

  it('maps a risk history row into a risk_changed Timeline entry', async () => {
    store.timelineRows = [
      { ...TIMELINE_ROW_BASE, source_type: 'lifecycle', source_id: 'lh-9', kind: 'risk_changed', basis: 'occurrence', actor_id: USER_ID, actor_name: 'Test User', code: 'risk', title: 'medium', secondary: 'high', event_ts: new Date('2026-09-21T03:00:00Z') },
      { ...TIMELINE_ROW_BASE, source_type: 'lifecycle', source_id: 'lh-8', kind: 'risk_changed', basis: 'occurrence', code: 'risk', title: 'high', secondary: 'low', event_ts: new Date('2026-09-20T03:00:00Z') },
    ];
    await withApi(async (baseUrl) => {
      const body = await (await getTimeline(baseUrl)).json();
      expect(body.data).toEqual([
        {
          id: 'lifecycle:lh-9:risk_changed',
          kind: 'risk_changed',
          source_type: 'lifecycle',
          source_id: 'lh-9',
          occurred_at: '2026-09-21T03:00:00.000Z',
          precision: 'timestamp',
          basis: 'occurrence',
          actor: { id: USER_ID, display_name: 'Test User' },
          summary: 'Risk changed from Medium to High',
          archived: false,
        },
        {
          id: 'lifecycle:lh-8:risk_changed',
          kind: 'risk_changed',
          source_type: 'lifecycle',
          source_id: 'lh-8',
          occurred_at: '2026-09-20T03:00:00.000Z',
          precision: 'timestamp',
          basis: 'occurrence',
          actor: null,
          summary: 'Risk changed from High to Low',
          archived: false,
        },
      ]);
    });
    const timelineSql = String(timelineQueryCalls()[0][0]);
    expect(timelineSql).toContain("when 'acquisition_stage' then 'stage_changed' when 'acquisition_status' then 'status_changed' else 'risk_changed'");
  });

  it('maps lifecycle history rows into stage and status Timeline entries without the reason', async () => {
    store.timelineRows = [
      { ...TIMELINE_ROW_BASE, source_type: 'lifecycle', source_id: 'lh-4', kind: 'status_changed', basis: 'occurrence', actor_id: USER_ID, actor_name: 'Test User', code: 'acquisition_status', title: 'active', secondary: 'on_hold', event_ts: new Date('2026-09-21T03:00:00Z') },
      { ...TIMELINE_ROW_BASE, source_type: 'lifecycle', source_id: 'lh-3', kind: 'stage_changed', basis: 'occurrence', actor_id: USER_ID, actor_name: 'Test User', code: 'acquisition_stage', title: 'signing', secondary: 'payment_closing', event_ts: new Date('2026-09-20T03:00:00Z') },
      { ...TIMELINE_ROW_BASE, source_type: 'lifecycle', source_id: 'lh-2', kind: 'status_changed', basis: 'occurrence', code: 'acquisition_status', secondary: 'active', event_ts: new Date('2026-09-19T03:00:00Z') },
      { ...TIMELINE_ROW_BASE, source_type: 'lifecycle', source_id: 'lh-1', kind: 'stage_changed', basis: 'occurrence', code: 'acquisition_stage', secondary: 'withdrawn', event_ts: new Date('2026-09-19T03:00:00Z') },
    ];
    await withApi(async (baseUrl) => {
      const body = await (await getTimeline(baseUrl)).json();
      expect(body.data).toEqual([
        {
          id: 'lifecycle:lh-4:status_changed',
          kind: 'status_changed',
          source_type: 'lifecycle',
          source_id: 'lh-4',
          occurred_at: '2026-09-21T03:00:00.000Z',
          precision: 'timestamp',
          basis: 'occurrence',
          actor: { id: USER_ID, display_name: 'Test User' },
          summary: 'Acquisition status changed from Active to On hold',
          archived: false,
        },
        expect.objectContaining({ kind: 'stage_changed', summary: 'Acquisition stage changed from Signing to Payment / closing' }),
        expect.objectContaining({ actor: null, summary: 'Acquisition status set to Active' }),
        // A legacy stage value is shown as recorded, never converted.
        expect.objectContaining({ actor: null, summary: 'Acquisition stage set to Withdrawn' }),
      ]);
    });
    const timelineSql = String(timelineQueryCalls()[0][0]);
    expect(timelineSql).toContain(`'lifecycle', 8`);
    expect(timelineSql).toContain('public.property_lifecycle_history');
    expect(timelineSql).not.toMatch(/\bh\.reason\b/);
  });

  describe('stage transitions (L-02)', () => {
    function postTransition(baseUrl: string, body: Record<string, unknown>, propertyId = PROPERTY_A) {
      return fetch(`${baseUrl}/api/v1/ops/properties/${propertyId}/stage-transitions`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ expectedStage: 'identified', ...body }),
      });
    }

    function transitionCalls() {
      return actorQuery.mock.calls.filter(([sql]) => String(sql).includes('transition_property_stage'));
    }

    it('calls the transition function with the target stage and reason and returns the property', async () => {
      store.role = 'negotiator';
      await withApi(async (baseUrl) => {
        const response = await postTransition(baseUrl, { targetStage: 'initial_contact' });
        expect(response.status).toBe(200);
        expect((await response.json()).data).toMatchObject({ id: PROPERTY_A, acquisition_stage: 'initial_contact' });
        const withReason = await postTransition(baseUrl, { targetStage: 'identified', reason: 'Owner details were wrong' });
        expect(withReason.status).toBe(200);
        const withOverride = await postTransition(baseUrl, {
          targetStage: 'commercial_review',
          reason: 'Terms agreed verbally',
          override: true,
        });
        expect(withOverride.status).toBe(200);
      });
      expect(transitionCalls().map(([, params]) => params)).toEqual([
        [PROPERTY_A, 'initial_contact', null, false, 'identified'],
        [PROPERTY_A, 'identified', 'Owner details were wrong', false, 'identified'],
        [PROPERTY_A, 'commercial_review', 'Terms agreed verbally', true, 'identified'],
      ]);
    });

    it('validates the body before calling the function', async () => {
      await withApi(async (baseUrl) => {
        for (const body of [
          {},
          { targetStage: 'complete' },
          { targetStage: 'signing', reason: 'x'.repeat(2001) },
          { targetStage: 'signing', override: 'yes' },
        ]) {
          expect((await postTransition(baseUrl, body)).status).toBe(400);
        }
        expect((await postTransition(baseUrl, { targetStage: 'signing' }, 'not-a-uuid')).status).toBe(400);
      });
      expect(transitionCalls()).toHaveLength(0);
    });

    it.each([
      ['42501', 403, 'You do not have permission to move this property to an earlier stage'],
      ['22023', 422, 'A reason is required to move a property to an earlier stage'],
      ['22023', 422, 'The stage withdrawn is a legacy value and cannot be selected'],
      ['42501', 403, 'You do not have permission to leave negotiation while a negotiation is open or paused'],
      ['22023', 422, 'Leaving negotiation while a negotiation is open or paused requires an override (negotiation_unresolved_exit)'],
      ['22023', 422, 'No override applies to moving this property from identified to signing'],
      ['P0002', 404, 'Property not found'],
    ])('maps a %s refusal from the function to %i', async (code, status, message) => {
      store.stageTransitionError = { code, message };
      await withApi(async (baseUrl) => {
        const response = await postTransition(baseUrl, { targetStage: 'identified' });
        expect(response.status).toBe(status);
        expect((await response.json()).error.message).toBe(message);
      });
      expect(store.properties[0].acquisition_stage).toBe('identified');
    });

    it('requires authentication', async () => {
      await withApi(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/stage-transitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetStage: 'signing' }),
        });
        expect(response.status).toBe(401);
      });
      expect(transitionCalls()).toHaveLength(0);
    });
  });

  describe('status transitions (L-03)', () => {
    function postStatus(baseUrl: string, body: Record<string, unknown>, propertyId = PROPERTY_A) {
      return fetch(`${baseUrl}/api/v1/ops/properties/${propertyId}/status-transitions`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ expectedStatus: 'active', ...body }),
      });
    }

    function statusCalls() {
      return actorQuery.mock.calls.filter(([sql]) => String(sql).includes('transition_property_status'));
    }

    it('calls the status function with the target, reason, and override flag and returns the property', async () => {
      store.role = 'land_acquisition_manager';
      await withApi(async (baseUrl) => {
        const paused = await postStatus(baseUrl, { targetStatus: 'on_hold' });
        expect(paused.status).toBe(200);
        expect((await paused.json()).data).toMatchObject({ id: PROPERTY_A, acquisition_status: 'on_hold', acquisition_stage: 'identified' });
        const completed = await postStatus(baseUrl, { targetStatus: 'complete', reason: 'Resolved while paused', override: true });
        expect(completed.status).toBe(200);
      });
      expect(statusCalls().map(([, params]) => params)).toEqual([
        [PROPERTY_A, 'on_hold', null, false, 'active'],
        [PROPERTY_A, 'complete', 'Resolved while paused', true, 'active'],
      ]);
    });

    it('validates the body before calling the function', async () => {
      await withApi(async (baseUrl) => {
        for (const body of [
          {},
          { targetStatus: 'completed' },
          { targetStatus: 'paused' },
          { targetStatus: 'complete', override: 'yes' },
          { targetStatus: 'withdrawn', reason: 'x'.repeat(2001) },
        ]) {
          expect((await postStatus(baseUrl, body)).status).toBe(400);
        }
        expect((await postStatus(baseUrl, { targetStatus: 'on_hold' }, 'not-a-uuid')).status).toBe(400);
      });
      expect(statusCalls()).toHaveLength(0);
    });

    it.each([
      ['42501', 403, 'You do not have permission to change this property from complete to active'],
      ['22023', 422, 'A reason is required to change this property from active to withdrawn'],
      ['22023', 422, 'Changing this property from active to complete requires an override (completion_stage_condition)'],
      ['22023', 422, 'No override applies to changing this property from active to on_hold'],
      ['P0002', 404, 'Property not found'],
    ])('maps a %s refusal from the function to %i', async (code, status, message) => {
      store.statusTransitionError = { code, message };
      await withApi(async (baseUrl) => {
        const response = await postStatus(baseUrl, { targetStatus: 'complete' });
        expect(response.status).toBe(status);
        expect((await response.json()).error.message).toBe(message);
      });
      expect(store.properties[0].acquisition_status).toBe('active');
    });

    it('requires authentication', async () => {
      await withApi(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/status-transitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetStatus: 'on_hold' }),
        });
        expect(response.status).toBe(401);
      });
      expect(statusCalls()).toHaveLength(0);
    });

    it('refuses acquisitionStatus on PATCH for every role, before any update, and keeps other fields working', async () => {
      for (const role of ['system_admin', 'land_acquisition_manager', 'supervisor', 'negotiator'] as const) {
        store.role = role;
        actorQuery.mockClear();
        await withApi(async (baseUrl) => {
          const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}`, {
            method: 'PATCH',
            headers: AUTH,
            body: JSON.stringify({ acquisitionStatus: 'complete' }),
          });
          expect(response.status).toBe(400);
        });
        expect(actorQuery.mock.calls.some(([sql]) => /update public\.properties/i.test(String(sql)))).toBe(false);
      }
      store.role = 'land_acquisition_manager';
      actorQuery.mockClear();
      await withApi(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}`, {
          method: 'PATCH',
          headers: AUTH,
          body: JSON.stringify({ risk: 'high' }),
        });
        expect(response.status).toBe(200);
      });
      const updates = actorQuery.mock.calls.map(([sql]) => String(sql)).filter((sql) => /update public\.properties/i.test(sql));
      expect(updates).toHaveLength(1);
      expect(updates[0]).not.toMatch(/acquisition_status/);
      expect(store.properties[0].acquisition_status).toBe('active');
    });

    it('marks override status entries in the Timeline without rules or reasons', async () => {
      store.timelineRows = [
        { ...TIMELINE_ROW_BASE, source_type: 'lifecycle', source_id: 'lh-2', kind: 'status_changed', basis: 'occurrence', actor_id: USER_ID, actor_name: 'Test User', code: 'acquisition_status', status: 'override', title: 'complete', secondary: 'active', event_ts: new Date('2026-09-21T03:00:00Z') },
        { ...TIMELINE_ROW_BASE, source_type: 'lifecycle', source_id: 'lh-1', kind: 'status_changed', basis: 'occurrence', actor_id: USER_ID, actor_name: 'Test User', code: 'acquisition_status', title: 'active', secondary: 'complete', event_ts: new Date('2026-09-20T03:00:00Z') },
      ];
      await withApi(async (baseUrl) => {
        const body = await (await getTimeline(baseUrl)).json();
        expect(body.data.map((entry: { summary: string }) => entry.summary)).toEqual([
          'Acquisition status changed from Complete to Active (override)',
          'Acquisition status changed from Active to Complete',
        ]);
      });
      const timelineSql = String(timelineQueryCalls()[0][0]);
      expect(timelineSql).toContain('h.is_override');
      expect(timelineSql).not.toMatch(/\bh\.(reason|overridden_rules)\b/);
    });
  });

  describe('negotiation exception (L-04)', () => {
    it('marks a stage override (the negotiation exception) in the Timeline without rules or reasons', async () => {
      store.timelineRows = [
        { ...TIMELINE_ROW_BASE, source_type: 'lifecycle', source_id: 'lh-2', kind: 'stage_changed', basis: 'occurrence', actor_id: USER_ID, actor_name: 'Test User', code: 'acquisition_stage', status: 'override', title: 'negotiation', secondary: 'commercial_review', event_ts: new Date('2026-09-21T03:00:00Z') },
        { ...TIMELINE_ROW_BASE, source_type: 'lifecycle', source_id: 'lh-1', kind: 'stage_changed', basis: 'occurrence', actor_id: USER_ID, actor_name: 'Test User', code: 'acquisition_stage', title: 'documentation', secondary: 'negotiation', event_ts: new Date('2026-09-20T03:00:00Z') },
      ];
      await withApi(async (baseUrl) => {
        const body = await (await getTimeline(baseUrl)).json();
        expect(body.data.map((entry: { summary: string }) => entry.summary)).toEqual([
          'Acquisition stage changed from Negotiation to Commercial review (override)',
          'Acquisition stage changed from Documentation to Negotiation',
        ]);
        expect(JSON.stringify(body.data)).not.toContain('negotiation_unresolved_exit');
      });
    });
  });

  describe('legacy remediation (L-06)', () => {
    function post(baseUrl: string, step: string, body: unknown, headers: Record<string, string> = AUTH) {
      return fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/remediation/${step}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    }

    function remediationCalls() {
      return actorQuery.mock.calls.filter(([sql]) => /_property_stage_remediation/.test(String(sql)));
    }

    it('calls each remediation function with its parameters', async () => {
      await withApi(async (baseUrl) => {
        expect((await post(baseUrl, 'start', {})).status).toBe(201);
        expect((await post(baseUrl, 'escalate', { reason: 'Survey missing' })).status).toBe(200);
        expect((await post(baseUrl, 'return-to-review', { reason: 'Survey found' })).status).toBe(200);
        expect(
          (
            await post(baseUrl, 'resolve', {
              resultingStage: 'documentation',
              expectedStage: 'withdrawn',
              reason: 'Survey decides',
              evidence: 'Survey 2024',
              evidenceDocumentId: EXECUTED_DOC_A,
            })
          ).status,
        ).toBe(200);
        expect((await post(baseUrl, 'reopen', { reason: 'Owner disputes' })).status).toBe(200);
      });
      expect(remediationCalls().map(([sql, params]) => [String(sql).match(/public\.(\w+)/)?.[1], params])).toEqual([
        ['start_property_stage_remediation', [PROPERTY_A]],
        ['escalate_property_stage_remediation', [PROPERTY_A, 'Survey missing']],
        ['return_property_stage_remediation_to_review', [PROPERTY_A, 'Survey found']],
        ['resolve_property_stage_remediation', [PROPERTY_A, 'documentation', 'Survey decides', 'Survey 2024', EXECUTED_DOC_A, null, 'withdrawn']],
        ['reopen_property_stage_remediation', [PROPERTY_A, 'Owner disputes']],
      ]);
    });

    it('validates requests before calling any function and knows only the defined steps', async () => {
      await withApi(async (baseUrl) => {
        expect((await post(baseUrl, 'resolve', { reason: 'x', evidence: 'y' })).status).toBe(400);
        // L-07: the stage the screen showed is required.
        expect((await post(baseUrl, 'resolve', { resultingStage: 'documentation', reason: 'x', evidence: 'y' })).status).toBe(400);
        expect((await post(baseUrl, 'resolve', { resultingStage: 'resolved', reason: 'x', evidence: 'y' })).status).toBe(400);
        expect((await post(baseUrl, 'resolve', { resultingStage: 'documentation', evidenceDocumentId: 'nope' })).status).toBe(400);
        expect((await post(baseUrl, 'escalate', { reason: 'x'.repeat(2001) })).status).toBe(400);
        expect((await post(baseUrl, 'override', { reason: 'x' })).status).toBe(404);
        expect((await post(baseUrl, 'convert', { reason: 'x' })).status).toBe(404);
      });
      expect(remediationCalls()).toHaveLength(0);
    });

    it.each([
      ['42501', 403, "You do not have permission to remediate this property's legacy stage"],
      ['22023', 422, 'Supporting evidence is required to resolve a legacy stage'],
      ['22023', 422, 'No remediation cycle of this property is UNDER_REVIEW'],
      ['P0002', 404, 'Property not found'],
    ])('maps a %s refusal from the function to %i', async (code, status, message) => {
      store.remediationError = { code, message };
      await withApi(async (baseUrl) => {
        const response = await post(baseUrl, 'resolve', { resultingStage: 'documentation', expectedStage: 'withdrawn', reason: 'x', evidence: 'y' });
        expect(response.status).toBe(status);
        expect((await response.json()).error.message).toBe(message);
      });
    });

    it('requires authentication', async () => {
      await withApi(async (baseUrl) => {
        expect((await post(baseUrl, 'start', {}, { 'Content-Type': 'application/json' })).status).toBe(401);
      });
      expect(remediationCalls()).toHaveLength(0);
    });

    it('lists the queue only for an organization member', async () => {
      await withApi(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/v1/ops/remediations?organizationId=${ORG_B}`, { headers: AUTH });
        expect(response.status).toBe(403);
        expect((await fetch(`${baseUrl}/api/v1/ops/remediations`, { headers: AUTH })).status).toBe(400);
      });
    });
  });

  describe('lifecycle concurrency (L-07)', () => {
    function post(baseUrl: string, path: string, body: Record<string, unknown>) {
      return fetch(`${baseUrl}/api/v1/ops/properties/${PROPERTY_A}/${path}`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify(body),
      });
    }

    function lifecycleCalls() {
      return actorQuery.mock.calls.filter(([sql]) => /transition_property_(stage|status)|resolve_property_stage_remediation/.test(String(sql)));
    }

    it('Q-L07-API = A: requires the value the screen showed, for stage, status, and resolve, before calling any function', async () => {
      await withApi(async (baseUrl) => {
        expect((await post(baseUrl, 'stage-transitions', { targetStage: 'initial_contact' })).status).toBe(400);
        expect((await post(baseUrl, 'stage-transitions', { targetStage: 'initial_contact', expectedStage: null })).status).toBe(400);
        expect((await post(baseUrl, 'remediation/resolve', { resultingStage: 'documentation', reason: 'x', evidence: 'y' })).status).toBe(400);
        expect(
          (await post(baseUrl, 'remediation/resolve', { resultingStage: 'documentation', expectedStage: '', reason: 'x', evidence: 'y' })).status,
        ).toBe(400);
        expect((await post(baseUrl, 'stage-transitions', { targetStage: 'initial_contact', expectedStage: 'nope' })).status).toBe(400);
        expect((await post(baseUrl, 'status-transitions', { targetStatus: 'on_hold' })).status).toBe(400);
        expect((await post(baseUrl, 'status-transitions', { targetStatus: 'on_hold', expectedStatus: 'paused' })).status).toBe(400);
      });
      expect(lifecycleCalls()).toHaveLength(0);
    });

    it.each([
      ['stage-transitions', { targetStage: 'initial_contact', expectedStage: 'identified' }, 'acquisition_stage', 'documentation', 'identified'],
      ['status-transitions', { targetStatus: 'on_hold', expectedStatus: 'active' }, 'acquisition_status', 'withdrawn', 'active'],
      ['remediation/resolve', { resultingStage: 'documentation', expectedStage: 'withdrawn', reason: 'x', evidence: 'y' }, 'acquisition_stage', 'documentation', 'withdrawn'],
    ] as const)('returns a stale %s as 409 lifecycle_conflict naming the field and the current and stale values', async (path, body, field, current, expected) => {
      const conflict = Object.assign(new Error(`The value is now ${current} (this screen showed ${expected}); reload before retrying`), {
        code: '40001',
        detail: JSON.stringify({ conflict: 'lifecycle', field, current, expected }),
      });
      actorQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (/transition_property_(stage|status)|resolve_property_stage_remediation/.test(sql)) throw conflict;
        return handleActorQuery(sql, params);
      });
      await withApi(async (baseUrl) => {
        const response = await post(baseUrl, path, body);
        expect(response.status).toBe(409);
        expect((await response.json()).error).toEqual({
          code: 'lifecycle_conflict',
          message: conflict.message,
          details: { conflict: 'lifecycle', field, current, expected },
        });
      });
      expect(store.properties[0]).toMatchObject({ acquisition_stage: 'identified', acquisition_status: 'active' });
    });

    it('keeps validation, authority, and not-found refusals distinct from a conflict', async () => {
      for (const [code, status] of [
        ['22023', 422],
        ['42501', 403],
        ['P0002', 404],
      ] as const) {
        store.stageTransitionError = { code, message: `refused ${code}` };
        await withApi(async (baseUrl) => {
          const response = await post(baseUrl, 'stage-transitions', { targetStage: 'initial_contact', expectedStage: 'identified' });
          expect(response.status).toBe(status);
          expect((await response.json()).error.code).not.toBe('lifecycle_conflict');
        });
      }
    });
  });
});
