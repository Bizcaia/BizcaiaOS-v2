export type AcquisitionStage =
  | 'identified'
  | 'initial_contact'
  | 'owner_validation'
  | 'property_validation'
  | 'documentation'
  | 'negotiation'
  | 'commercial_review'
  | 'legal_review'
  | 'agreement_preparation'
  | 'signing'
  | 'payment_closing'
  | 'acquisition_complete'
  | 'on_hold'
  | 'withdrawn';

export type OwnerType = 'individual' | 'corporate' | 'estate' | 'government' | 'other';

export type PropertyOwner = {
  owner_id: string;
  display_name: string;
  owner_type: OwnerType;
  ownership_percent: number | null;
  is_primary: boolean;
  contact_details: Record<string, unknown>;
};

export type Property = {
  id: string;
  organization_id: string;
  project_id: string;
  property_reference: string;
  title_number: string | null;
  tax_declaration: string | null;
  lot_number: string | null;
  area_hectares: number | null;
  municipality: string | null;
  province: string | null;
  barangay: string | null;
  acquisition_stage: AcquisitionStage;
  acquisition_status: string;
  assigned_negotiator_id: string | null;
  assigned_manager_id: string | null;
  legal_status: string;
  documentation_status: string;
  payment_status: string;
  readiness_percent: number;
  risk: 'low' | 'medium' | 'high';
  project_code?: string;
  project_name?: string;
  negotiator_name?: string | null;
  manager_name?: string | null;
  owners?: PropertyOwner[];
};

export type Project = {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  acquisition_target: number | null;
  manager_user_id: string | null;
  starts_on: string | null;
  target_completion_on: string | null;
  created_at: string;
  updated_at: string;
};

export type Owner = {
  id: string;
  organization_id: string;
  owner_type: OwnerType;
  display_name: string;
  organization_name: string | null;
  contact_details: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type NegotiationStatus = 'open' | 'paused' | 'accepted' | 'rejected' | 'withdrawn' | 'closed';
export type NegotiationEventType = 'offer' | 'counteroffer' | 'meeting' | 'call' | 'message' | 'note' | 'other';

export type Negotiation = {
  id: string;
  organization_id: string;
  property_id: string;
  status: NegotiationStatus;
  assigned_negotiator_id: string | null;
  assigned_negotiator_name?: string | null;
  opening_amount: number | null;
  target_amount: number | null;
  current_amount: number | null;
  currency_code: string;
  started_at: string;
  closed_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type NegotiationEvent = {
  id: string;
  organization_id: string;
  negotiation_id: string;
  event_type: NegotiationEventType;
  amount: number | null;
  actor_user_id: string;
  actor_name?: string | null;
  contextual_note: string | null;
  occurred_at: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type DocumentCategory =
  | 'ownership_evidence'
  | 'title_deed'
  | 'tax_declaration'
  | 'legal_opinion'
  | 'survey_plan'
  | 'agreement_draft'
  | 'agreement_executed'
  | 'payment_proof'
  | 'other';

export type DocumentStatus = 'draft' | 'submitted' | 'under_review' | 'verified' | 'rejected' | 'superseded';

/** Named PropertyDocument, not Document, to avoid colliding with the DOM's global Document type. */
export type PropertyDocument = {
  id: string;
  organization_id: string;
  property_id: string;
  negotiation_id: string | null;
  category: DocumentCategory;
  status: DocumentStatus;
  title: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  storage_provider: string;
  uploaded_by_user_id: string;
  uploaded_by_name?: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type DocumentUploadConfig = {
  maxSizeBytes: number;
  acceptedMimeTypes: string[];
};

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export type PropertyTask = {
  id: string;
  organization_id: string;
  property_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_user_id: string | null;
  assigned_user_name?: string | null;
  due_on: string | null;
  created_by_user_id: string;
  created_by_name?: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type PaymentType = 'deposit' | 'installment' | 'final_payment';
export type PaymentStatus = 'pending' | 'scheduled' | 'paid' | 'failed' | 'cancelled';

export type PropertyPayment = {
  id: string;
  organization_id: string;
  property_id: string;
  negotiation_id: string | null;
  amount: number;
  currency_code: string;
  payment_type: PaymentType;
  status: PaymentStatus;
  scheduled_on: string | null;
  paid_on: string | null;
  reference_number: string | null;
  recorded_by_user_id: string;
  recorded_by_name?: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

/** Same VITE_API_BASE_URL as organizationApi (/api/v1). Live ops paths are prefixed with /ops. */
const apiBase = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '';
export const operationsApiMode = apiBase ? 'live' : 'demo';
export const DEMO_ORGANIZATION_ID = '2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f';

const demoUsers: Record<string, string> = {
  '758d5718-53d9-4ea2-b9d5-02828fcc0e2c': 'Alex Villanueva',
  '8714eff3-6be9-4cc8-bf5f-c4dbb62d90cb': 'Maria Santos',
  '5517eab7-57db-412f-b381-33844d31a64f': 'Luis Reyes',
  '419fa143-1d97-40cd-b47b-812cb364acfd': 'Celina Cruz',
  '884e9d32-aad1-42e5-8603-4f9846cff79d': 'Paolo Lim',
};

const demoMemberships: Array<{ user_id: string; organization_id: string; role: string; is_active: boolean }> = [
  { user_id: '758d5718-53d9-4ea2-b9d5-02828fcc0e2c', organization_id: DEMO_ORGANIZATION_ID, role: 'system_admin', is_active: true },
  { user_id: '8714eff3-6be9-4cc8-bf5f-c4dbb62d90cb', organization_id: DEMO_ORGANIZATION_ID, role: 'land_acquisition_manager', is_active: true },
  { user_id: '5517eab7-57db-412f-b381-33844d31a64f', organization_id: DEMO_ORGANIZATION_ID, role: 'negotiator', is_active: true },
  { user_id: '419fa143-1d97-40cd-b47b-812cb364acfd', organization_id: DEMO_ORGANIZATION_ID, role: 'legal_documentation', is_active: true },
  { user_id: '884e9d32-aad1-42e5-8603-4f9846cff79d', organization_id: DEMO_ORGANIZATION_ID, role: 'finance', is_active: false },
];

const managerAssignmentRoles = new Set(['system_admin', 'land_acquisition_manager', 'supervisor']);

function assertAssignmentRoles(
  organizationId: string,
  assignedNegotiatorId?: string | null,
  assignedManagerId?: string | null,
) {
  if (assignedNegotiatorId) {
    const member = demoMemberships.find(
      (entry) =>
        entry.user_id === assignedNegotiatorId &&
        entry.organization_id === organizationId &&
        entry.is_active &&
        entry.role === 'negotiator',
    );
    if (!member) {
      throw new Error('Assigned negotiator must be an active negotiator in the property organization');
    }
  }
  if (assignedManagerId) {
    const member = demoMemberships.find(
      (entry) =>
        entry.user_id === assignedManagerId &&
        entry.organization_id === organizationId &&
        entry.is_active &&
        managerAssignmentRoles.has(entry.role),
    );
    if (!member) {
      throw new Error('Assigned manager must be an active manager or supervisor in the property organization');
    }
  }
}

type AuthBridge = { getAccessToken: () => Promise<string> };
declare global {
  interface Window {
    __BIZCAIAOS_AUTH__?: AuthBridge;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!apiBase) throw new Error('Live API mode is not configured');
  const auth = window.__BIZCAIAOS_AUTH__;
  if (!auth) throw new Error('Authentication provider is not connected');
  const token = await auth.getAccessToken();
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? 'Request failed');
  return payload.data as T;
}

/** Like request(), but sends multipart/form-data without forcing a JSON Content-Type. */
async function uploadRequest<T>(path: string, formData: FormData): Promise<T> {
  if (!apiBase) throw new Error('Live API mode is not configured');
  const auth = window.__BIZCAIAOS_AUTH__;
  if (!auth) throw new Error('Authentication provider is not connected');
  const token = await auth.getAccessToken();
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? 'Request failed');
  return payload.data as T;
}

/**
 * A plain <a href> can't carry an Authorization header, so document downloads
 * are fetched as a blob and handed to the caller to save client-side.
 */
async function downloadRequest(path: string): Promise<{ blob: Blob; filename: string }> {
  if (!apiBase) throw new Error('Live API mode is not configured');
  const auth = window.__BIZCAIAOS_AUTH__;
  if (!auth) throw new Error('Authentication provider is not connected');
  const token = await auth.getAccessToken();
  const response = await fetch(`${apiBase}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error?.message ?? 'Request failed');
  }
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]*)"/.exec(disposition)?.[1] ?? 'document';
  const blob = await response.blob();
  return { blob, filename };
}

const propertyPatchColumns: Record<string, string> = {
  acquisitionStage: 'acquisition_stage',
  acquisitionStatus: 'acquisition_status',
  titleNumber: 'title_number',
  taxDeclaration: 'tax_declaration',
  lotNumber: 'lot_number',
  areaHectares: 'area_hectares',
  municipality: 'municipality',
  province: 'province',
  barangay: 'barangay',
  assignedNegotiatorId: 'assigned_negotiator_id',
  assignedManagerId: 'assigned_manager_id',
  legalStatus: 'legal_status',
  documentationStatus: 'documentation_status',
  paymentStatus: 'payment_status',
  readinessPercent: 'readiness_percent',
  risk: 'risk',
  metadata: 'metadata',
};

const DEMO_ACTOR_ID = '758d5718-53d9-4ea2-b9d5-02828fcc0e2c';
const negotiationManagerRoles = new Set(['system_admin', 'land_acquisition_manager']);

let demoProjects: Project[] = [];
let demoProperties: Property[] = [];
let demoOwners: Owner[] = [];
let demoPropertyOwners: Array<{
  property_id: string;
  owner_id: string;
  ownership_percent: number | null;
  is_primary: boolean;
}> = [];
let demoNegotiations: Negotiation[] = [];
let demoNegotiationEvents: NegotiationEvent[] = [];
let demoDocuments: PropertyDocument[] = [];
const demoDocumentBlobs = new Map<string, Blob>();

const DEMO_DOCUMENT_UPLOAD_CONFIG: DocumentUploadConfig = {
  maxSizeBytes: 26_214_400,
  acceptedMimeTypes: [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
};

const documentWriteRoles = new Set(['system_admin', 'land_acquisition_manager', 'legal_documentation']);

function demoCanWriteDocument() {
  const member = demoMemberships.find((entry) => entry.user_id === DEMO_ACTOR_ID && entry.is_active);
  return !!member && documentWriteRoles.has(member.role);
}

function decorateDocument(document: PropertyDocument): PropertyDocument {
  return { ...document, uploaded_by_name: demoUsers[document.uploaded_by_user_id] ?? null };
}

let demoTasks: PropertyTask[] = [];

const taskManagerRoles = new Set(['system_admin', 'land_acquisition_manager']);
const taskSelfAssignCreateRoles = new Set(['legal_documentation', 'finance']);

function demoActorMembership() {
  return demoMemberships.find((entry) => entry.user_id === DEMO_ACTOR_ID && entry.is_active);
}

/** Mirrors isTaskManager on the server: system_admin/LAM org-wide, supervisor only within a managed property/project. */
function demoIsTaskManager(property: Property): boolean {
  const member = demoActorMembership();
  if (!member) return false;
  if (taskManagerRoles.has(member.role)) return true;
  if (member.role !== 'supervisor') return false;
  if (property.assigned_manager_id === DEMO_ACTOR_ID) return true;
  const project = demoProjects.find((entry) => entry.id === property.project_id);
  return project?.manager_user_id === DEMO_ACTOR_ID;
}

function demoCanCreateTask(property: Property, assignedUserId: string | null): boolean {
  const member = demoActorMembership();
  if (!member) return false;
  if (demoIsTaskManager(property)) return true;
  if (member.role === 'negotiator' && property.assigned_negotiator_id === DEMO_ACTOR_ID) {
    return assignedUserId === DEMO_ACTOR_ID;
  }
  if (taskSelfAssignCreateRoles.has(member.role)) {
    return assignedUserId === DEMO_ACTOR_ID;
  }
  return false;
}

/** Viewer is excluded even when assigned: assignment must never grant write capability. */
function demoCanWriteOwnTask(task: PropertyTask): boolean {
  const member = demoActorMembership();
  if (!member || member.role === 'viewer') return false;
  return task.assigned_user_id === DEMO_ACTOR_ID;
}

function demoAssertActiveAssignee(organizationId: string, assignedUserId: string | null) {
  if (!assignedUserId) return;
  const member = demoMemberships.find(
    (entry) => entry.user_id === assignedUserId && entry.organization_id === organizationId && entry.is_active,
  );
  if (!member) {
    throw new Error('Assigned user must be an active member of the task organization');
  }
}

function decorateTask(task: PropertyTask): PropertyTask {
  return {
    ...task,
    assigned_user_name: task.assigned_user_id ? demoUsers[task.assigned_user_id] ?? null : null,
    created_by_name: demoUsers[task.created_by_user_id] ?? null,
  };
}

let demoPayments: PropertyPayment[] = [];

const paymentWriteRoles = new Set(['system_admin', 'land_acquisition_manager', 'finance']);

/** Fixed role set, organization-wide -- no property scoping and no assignee/self-service model, unlike tasks. */
function demoCanWritePayment(): boolean {
  const member = demoActorMembership();
  return !!member && paymentWriteRoles.has(member.role);
}

function decoratePayment(payment: PropertyPayment): PropertyPayment {
  return { ...payment, recorded_by_name: demoUsers[payment.recorded_by_user_id] ?? null };
}

function decorateNegotiation(negotiation: Negotiation): Negotiation {
  return {
    ...negotiation,
    assigned_negotiator_name: negotiation.assigned_negotiator_id
      ? demoUsers[negotiation.assigned_negotiator_id] ?? null
      : null,
  };
}

function decorateEvent(event: NegotiationEvent): NegotiationEvent {
  return { ...event, actor_name: demoUsers[event.actor_user_id] ?? null };
}

function assertNegotiatorAssignment(organizationId: string, assignedNegotiatorId: string | null) {
  if (!assignedNegotiatorId) return;
  assertAssignmentRoles(organizationId, assignedNegotiatorId, null);
}

function demoCanWriteNegotiation(assignedNegotiatorId: string | null) {
  const member = demoMemberships.find((entry) => entry.user_id === DEMO_ACTOR_ID && entry.is_active);
  if (!member) return false;
  if (negotiationManagerRoles.has(member.role)) return true;
  return member.role === 'negotiator' && assignedNegotiatorId === DEMO_ACTOR_ID;
}

function now() {
  return new Date().toISOString();
}

function decorateProperty(property: Property): Property {
  const project = demoProjects.find((entry) => entry.id === property.project_id);
  return {
    ...property,
    project_code: project?.code,
    project_name: project?.name,
    negotiator_name: property.assigned_negotiator_id ? demoUsers[property.assigned_negotiator_id] ?? null : null,
    manager_name: property.assigned_manager_id ? demoUsers[property.assigned_manager_id] ?? null : null,
  };
}

function ownersForProperty(propertyId: string): PropertyOwner[] {
  return demoPropertyOwners
    .filter((link) => link.property_id === propertyId)
    .map((link) => {
      const owner = demoOwners.find((entry) => entry.id === link.owner_id)!;
      return {
        owner_id: owner.id,
        display_name: owner.display_name,
        owner_type: owner.owner_type,
        ownership_percent: link.ownership_percent,
        is_primary: link.is_primary,
        contact_details: owner.contact_details,
      };
    })
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.display_name.localeCompare(b.display_name));
}

export function resetOperationsDemoState() {
  const demoOrg = DEMO_ORGANIZATION_ID;
  const projectId = '6c8e5a14-2b89-4d1d-a2f0-8f9b0a2f0001';
  demoProjects = [
    {
      id: projectId,
      organization_id: demoOrg,
      code: 'NCP-01',
      name: 'North Corridor Program',
      description: 'Primary acquisition program',
      status: 'active',
      acquisition_target: 125000000,
      manager_user_id: '8714eff3-6be9-4cc8-bf5f-c4dbb62d90cb',
      starts_on: '2026-01-01',
      target_completion_on: '2026-12-31',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-09-20T00:00:00Z',
    },
  ];
  demoProperties = [
    {
      id: '70000000-0000-4000-8000-000000000001',
      organization_id: demoOrg,
      project_id: projectId,
      property_reference: 'NCP-00102',
      title_number: 'TCT-102',
      tax_declaration: 'TD-102',
      lot_number: 'Lot 102',
      area_hectares: 2.4,
      municipality: 'Calamba',
      province: 'Laguna',
      barangay: 'Canlubang',
      acquisition_stage: 'negotiation',
      acquisition_status: 'active',
      assigned_negotiator_id: '5517eab7-57db-412f-b381-33844d31a64f',
      assigned_manager_id: '8714eff3-6be9-4cc8-bf5f-c4dbb62d90cb',
      legal_status: 'under_review',
      documentation_status: 'in_review',
      payment_status: 'not_started',
      readiness_percent: 68,
      risk: 'medium',
    },
    {
      id: '70000000-0000-4000-8000-000000000002',
      organization_id: demoOrg,
      project_id: projectId,
      property_reference: 'NCP-00118',
      title_number: 'TCT-118',
      tax_declaration: 'TD-118',
      lot_number: 'Lot 118',
      area_hectares: 1.8,
      municipality: 'Calamba',
      province: 'Laguna',
      barangay: 'Pansol',
      acquisition_stage: 'commercial_review',
      acquisition_status: 'active',
      assigned_negotiator_id: '5517eab7-57db-412f-b381-33844d31a64f',
      assigned_manager_id: null,
      legal_status: 'clear',
      documentation_status: 'complete',
      payment_status: 'not_started',
      readiness_percent: 84,
      risk: 'low',
    },
    {
      id: '70000000-0000-4000-8000-000000000003',
      organization_id: demoOrg,
      project_id: projectId,
      property_reference: 'NCP-00131',
      title_number: null,
      tax_declaration: 'TD-131',
      lot_number: 'Lot 131',
      area_hectares: 3.1,
      municipality: 'Calamba',
      province: 'Laguna',
      barangay: 'Bucal',
      acquisition_stage: 'documentation',
      acquisition_status: 'active',
      assigned_negotiator_id: null,
      assigned_manager_id: null,
      legal_status: 'blocked',
      documentation_status: 'missing',
      payment_status: 'not_started',
      readiness_percent: 42,
      risk: 'high',
    },
  ].map((property) => decorateProperty(property as Property));
  demoOwners = [
    {
      id: '80000000-0000-4000-8000-000000000001',
      organization_id: demoOrg,
      owner_type: 'individual',
      display_name: 'Rosa Mendoza',
      organization_name: null,
      contact_details: { phone: '+63 917 000 0102' },
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
    },
  ];
  demoPropertyOwners = [
    {
      property_id: '70000000-0000-4000-8000-000000000001',
      owner_id: '80000000-0000-4000-8000-000000000001',
      ownership_percent: 100,
      is_primary: true,
    },
  ];
  demoNegotiations = [
    decorateNegotiation({
      id: '90000000-0000-4000-8000-000000000001',
      organization_id: demoOrg,
      property_id: '70000000-0000-4000-8000-000000000001',
      status: 'open',
      assigned_negotiator_id: '5517eab7-57db-412f-b381-33844d31a64f',
      opening_amount: 12000000,
      target_amount: 15000000,
      current_amount: 12500000,
      currency_code: 'PHP',
      started_at: '2026-08-01T00:00:00.000Z',
      closed_at: null,
      archived_at: null,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-12T00:00:00.000Z',
    }),
  ];
  demoNegotiationEvents = [
    decorateEvent({
      id: '91000000-0000-4000-8000-000000000001',
      organization_id: demoOrg,
      negotiation_id: '90000000-0000-4000-8000-000000000001',
      event_type: 'offer',
      amount: 12500000,
      actor_user_id: DEMO_ACTOR_ID,
      contextual_note: 'Opening offer recorded',
      occurred_at: '2026-08-12T00:00:00.000Z',
      metadata: {},
      created_at: '2026-08-12T00:00:00.000Z',
    }),
  ];
  demoDocumentBlobs.clear();
  const seededDocumentId = '92000000-0000-4000-8000-000000000001';
  demoDocumentBlobs.set(seededDocumentId, new Blob(['Seeded demo title deed contents'], { type: 'application/pdf' }));
  demoDocuments = [
    decorateDocument({
      id: seededDocumentId,
      organization_id: demoOrg,
      property_id: '70000000-0000-4000-8000-000000000001',
      negotiation_id: '90000000-0000-4000-8000-000000000001',
      category: 'title_deed',
      status: 'submitted',
      title: 'Transfer Certificate of Title',
      original_filename: 'tct-102.pdf',
      content_type: 'application/pdf',
      size_bytes: 32,
      storage_provider: 'local',
      uploaded_by_user_id: '419fa143-1d97-40cd-b47b-812cb364acfd',
      created_at: '2026-08-05T00:00:00.000Z',
      updated_at: '2026-08-05T00:00:00.000Z',
      archived_at: null,
    }),
  ];
  demoTasks = [
    decorateTask({
      id: 'a1000000-0000-4000-8000-000000000001',
      organization_id: demoOrg,
      property_id: '70000000-0000-4000-8000-000000000001',
      title: 'Follow up on survey plan',
      description: 'Confirm the licensed geodetic engineer can deliver the updated survey plan this week.',
      status: 'open',
      priority: 'high',
      assigned_user_id: '5517eab7-57db-412f-b381-33844d31a64f',
      due_on: '2026-09-26',
      created_by_user_id: DEMO_ACTOR_ID,
      created_at: '2026-09-20T00:00:00.000Z',
      updated_at: '2026-09-20T00:00:00.000Z',
      archived_at: null,
    }),
    decorateTask({
      id: 'a1000000-0000-4000-8000-000000000002',
      organization_id: demoOrg,
      property_id: '70000000-0000-4000-8000-000000000001',
      title: 'Review title deed for encumbrances',
      description: null,
      status: 'done',
      priority: 'normal',
      assigned_user_id: '419fa143-1d97-40cd-b47b-812cb364acfd',
      due_on: '2026-09-10',
      created_by_user_id: '419fa143-1d97-40cd-b47b-812cb364acfd',
      created_at: '2026-09-05T00:00:00.000Z',
      updated_at: '2026-09-11T00:00:00.000Z',
      archived_at: null,
    }),
  ];
  demoPayments = [
    decoratePayment({
      id: 'b1000000-0000-4000-8000-000000000001',
      organization_id: demoOrg,
      property_id: '70000000-0000-4000-8000-000000000001',
      negotiation_id: '90000000-0000-4000-8000-000000000001',
      amount: 500000,
      currency_code: 'PHP',
      payment_type: 'deposit',
      status: 'paid',
      scheduled_on: '2026-08-15',
      paid_on: '2026-08-15',
      reference_number: 'WIRE-2026-0815',
      recorded_by_user_id: '8714eff3-6be9-4cc8-bf5f-c4dbb62d90cb',
      created_at: '2026-08-15T00:00:00.000Z',
      updated_at: '2026-08-15T00:00:00.000Z',
      archived_at: null,
    }),
    decoratePayment({
      id: 'b1000000-0000-4000-8000-000000000002',
      organization_id: demoOrg,
      property_id: '70000000-0000-4000-8000-000000000001',
      negotiation_id: '90000000-0000-4000-8000-000000000001',
      amount: 1200000,
      currency_code: 'PHP',
      payment_type: 'installment',
      status: 'scheduled',
      scheduled_on: '2026-10-01',
      paid_on: null,
      reference_number: null,
      recorded_by_user_id: '8714eff3-6be9-4cc8-bf5f-c4dbb62d90cb',
      created_at: '2026-09-20T00:00:00.000Z',
      updated_at: '2026-09-20T00:00:00.000Z',
      archived_at: null,
    }),
  ];
}

resetOperationsDemoState();

export type CreatePropertyInput = {
  organizationId: string;
  projectId: string;
  propertyReference: string;
  municipality?: string;
  province?: string;
  barangay?: string;
  areaHectares?: number;
  acquisitionStage?: AcquisitionStage;
  risk?: string;
  assignedNegotiatorId?: string | null;
  assignedManagerId?: string | null;
};

export type CreateOwnerInput = {
  organizationId: string;
  ownerType: OwnerType;
  displayName: string;
  organizationName?: string | null;
  contactDetails?: Record<string, unknown>;
};

export const operationsApi = {
  async listProjects(orgId: string) {
    if (operationsApiMode === 'live') return request<Project[]>(`/ops/projects?organizationId=${orgId}`);
    return demoProjects.filter((project) => project.organization_id === orgId);
  },

  async createProject(input: Partial<Project> & { organization_id: string; code: string; name: string }) {
    if (operationsApiMode === 'live') {
      return request<Project>('/ops/projects', {
        method: 'POST',
        body: JSON.stringify({
          organizationId: input.organization_id,
          code: input.code,
          name: input.name,
          description: input.description,
          status: input.status,
          acquisitionTarget: input.acquisition_target,
          managerUserId: input.manager_user_id,
          startsOn: input.starts_on,
          targetCompletionOn: input.target_completion_on,
        }),
      });
    }
    const project: Project = {
      id: crypto.randomUUID(),
      organization_id: input.organization_id,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      status: input.status ?? 'planning',
      acquisition_target: input.acquisition_target ?? null,
      manager_user_id: input.manager_user_id ?? null,
      starts_on: input.starts_on ?? null,
      target_completion_on: input.target_completion_on ?? null,
      created_at: now(),
      updated_at: now(),
    };
    demoProjects = [project, ...demoProjects];
    return project;
  },

  async listOwners(orgId: string) {
    if (operationsApiMode === 'live') return request<Owner[]>(`/ops/owners?organizationId=${orgId}`);
    return demoOwners.filter((owner) => owner.organization_id === orgId);
  },

  async createOwner(input: CreateOwnerInput) {
    if (operationsApiMode === 'live') {
      return request<Owner>('/ops/owners', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    }
    const owner: Owner = {
      id: crypto.randomUUID(),
      organization_id: input.organizationId,
      owner_type: input.ownerType,
      display_name: input.displayName,
      organization_name: input.organizationName ?? null,
      contact_details: input.contactDetails ?? {},
      created_at: now(),
      updated_at: now(),
    };
    demoOwners = [owner, ...demoOwners];
    return owner;
  },

  async listProperties(orgId: string, filters?: { projectId?: string; stage?: AcquisitionStage; search?: string }) {
    if (operationsApiMode === 'live') {
      const query = new URLSearchParams({ organizationId: orgId, ...filters });
      return request<Property[]>(`/ops/properties?${query}`);
    }
    return demoProperties
      .filter((property) => property.organization_id === orgId)
      .filter((property) => !filters?.projectId || property.project_id === filters.projectId)
      .filter((property) => !filters?.stage || property.acquisition_stage === filters.stage)
      .filter(
        (property) =>
          !filters?.search ||
          `${property.property_reference} ${property.lot_number ?? ''} ${property.municipality ?? ''} ${property.barangay ?? ''}`
            .toLowerCase()
            .includes(filters.search.toLowerCase()),
      )
      .map(decorateProperty);
  },

  async getProperty(id: string) {
    if (operationsApiMode === 'live') return request<Property>(`/ops/properties/${id}`);
    const property = demoProperties.find((entry) => entry.id === id);
    if (!property) throw new Error('Property not found');
    return { ...decorateProperty(property), owners: ownersForProperty(id) };
  },

  async createProperty(input: CreatePropertyInput) {
    if (operationsApiMode === 'live') return request<Property>('/ops/properties', { method: 'POST', body: JSON.stringify(input) });
    const project = demoProjects.find((entry) => entry.id === input.projectId);
    if (!project || project.organization_id !== input.organizationId) {
      throw new Error('Property project must belong to the same organization');
    }
    assertAssignmentRoles(input.organizationId, input.assignedNegotiatorId, input.assignedManagerId);
    const property = decorateProperty({
      id: crypto.randomUUID(),
      organization_id: input.organizationId,
      project_id: input.projectId,
      property_reference: input.propertyReference,
      title_number: null,
      tax_declaration: null,
      lot_number: null,
      area_hectares: input.areaHectares ?? null,
      municipality: input.municipality ?? null,
      province: input.province ?? null,
      barangay: input.barangay ?? null,
      acquisition_stage: input.acquisitionStage ?? 'identified',
      acquisition_status: 'active',
      assigned_negotiator_id: input.assignedNegotiatorId ?? null,
      assigned_manager_id: input.assignedManagerId ?? null,
      legal_status: 'unknown',
      documentation_status: 'not_started',
      payment_status: 'not_started',
      readiness_percent: 0,
      risk: (input.risk ?? 'medium') as 'low' | 'medium' | 'high',
    });
    demoProperties = [property, ...demoProperties];
    return property;
  },

  async updateProperty(id: string, input: Record<string, unknown>) {
    if (operationsApiMode === 'live') {
      return request<Property>(`/ops/properties/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
    }
    const index = demoProperties.findIndex((property) => property.id === id);
    if (index < 0) throw new Error('Property not found');
    const mapped = Object.fromEntries(
      Object.entries(input).map(([key, value]) => [propertyPatchColumns[key] ?? key, value]),
    );
    const next = { ...demoProperties[index], ...mapped } as Property;
    assertAssignmentRoles(next.organization_id, next.assigned_negotiator_id, next.assigned_manager_id);
    demoProperties[index] = decorateProperty(next);
    return demoProperties[index];
  },

  async listPropertyOwners(propertyId: string) {
    if (operationsApiMode === 'live') return request<PropertyOwner[]>(`/ops/properties/${propertyId}/owners`);
    return ownersForProperty(propertyId);
  },

  async linkPropertyOwner(
    propertyId: string,
    input: { ownerId: string; ownershipPercent?: number | null; isPrimary?: boolean },
  ) {
    if (operationsApiMode === 'live') {
      return request(`/ops/properties/${propertyId}/owners`, { method: 'POST', body: JSON.stringify(input) });
    }
    const property = demoProperties.find((entry) => entry.id === propertyId);
    const owner = demoOwners.find((entry) => entry.id === input.ownerId);
    if (!property) throw new Error('Property not found');
    if (!owner) throw new Error('Owner not found');
    if (owner.organization_id !== property.organization_id) {
      throw new Error('Owner must belong to the same organization as the property');
    }
    if (input.isPrimary) {
      demoPropertyOwners = demoPropertyOwners.map((link) =>
        link.property_id === propertyId ? { ...link, is_primary: false } : link,
      );
    }
    const link = {
      property_id: propertyId,
      owner_id: input.ownerId,
      ownership_percent: input.ownershipPercent ?? null,
      is_primary: input.isPrimary ?? false,
    };
    demoPropertyOwners = demoPropertyOwners.filter(
      (entry) => !(entry.property_id === propertyId && entry.owner_id === input.ownerId),
    );
    demoPropertyOwners.push(link);
    return link;
  },

  async unlinkPropertyOwner(propertyId: string, ownerId: string) {
    if (operationsApiMode === 'live') {
      await request(`/ops/properties/${propertyId}/owners/${ownerId}`, { method: 'DELETE' });
      return;
    }
    const before = demoPropertyOwners.length;
    demoPropertyOwners = demoPropertyOwners.filter(
      (link) => !(link.property_id === propertyId && link.owner_id === ownerId),
    );
    if (demoPropertyOwners.length === before) throw new Error('Property owner link not found');
  },

  async listNegotiations(orgId: string, filters?: { propertyId?: string; status?: NegotiationStatus }) {
    if (operationsApiMode === 'live') {
      const query = new URLSearchParams({ organizationId: orgId });
      if (filters?.propertyId) query.set('propertyId', filters.propertyId);
      if (filters?.status) query.set('status', filters.status);
      return request<Negotiation[]>(`/ops/negotiations?${query}`);
    }
    return demoNegotiations
      .filter((negotiation) => negotiation.organization_id === orgId)
      .filter((negotiation) => !filters?.propertyId || negotiation.property_id === filters.propertyId)
      .filter((negotiation) => !filters?.status || negotiation.status === filters.status)
      .map(decorateNegotiation);
  },

  async createNegotiation(input: {
    organizationId: string;
    propertyId: string;
    assignedNegotiatorId?: string | null;
    openingAmount?: number | null;
    targetAmount?: number | null;
    currencyCode?: string;
    startedAt?: string;
  }) {
    if (operationsApiMode === 'live') {
      return request<Negotiation>('/ops/negotiations', { method: 'POST', body: JSON.stringify(input) });
    }
    const property = demoProperties.find((entry) => entry.id === input.propertyId);
    if (!property) throw new Error('Property not found');
    if (property.organization_id !== input.organizationId) {
      throw new Error('Negotiation property must belong to the same organization');
    }
    if (property.acquisition_stage !== 'negotiation') {
      throw new Error('Negotiation can only be opened when the property is in negotiation stage');
    }
    const assignedNegotiatorId =
      input.assignedNegotiatorId === undefined ? property.assigned_negotiator_id : input.assignedNegotiatorId;
    assertNegotiatorAssignment(input.organizationId, assignedNegotiatorId);
    if (!demoCanWriteNegotiation(assignedNegotiatorId)) {
      throw new Error('You do not have permission for this operation');
    }
    if (demoNegotiations.some((entry) => entry.property_id === input.propertyId && (entry.status === 'open' || entry.status === 'paused'))) {
      throw new Error('A property may have only one open or paused negotiation');
    }
    const timestamp = now();
    const negotiation = decorateNegotiation({
      id: crypto.randomUUID(),
      organization_id: input.organizationId,
      property_id: input.propertyId,
      status: 'open',
      assigned_negotiator_id: assignedNegotiatorId ?? null,
      opening_amount: input.openingAmount ?? null,
      target_amount: input.targetAmount ?? null,
      current_amount: null,
      currency_code: (input.currencyCode ?? 'PHP').toUpperCase(),
      started_at: input.startedAt ?? timestamp,
      closed_at: null,
      archived_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    });
    demoNegotiations = [negotiation, ...demoNegotiations];
    return negotiation;
  },

  async getNegotiation(id: string) {
    if (operationsApiMode === 'live') return request<Negotiation>(`/ops/negotiations/${id}`);
    const negotiation = demoNegotiations.find((entry) => entry.id === id);
    if (!negotiation) throw new Error('Negotiation not found');
    return decorateNegotiation(negotiation);
  },

  async updateNegotiation(
    id: string,
    input: {
      status?: NegotiationStatus;
      assignedNegotiatorId?: string | null;
      openingAmount?: number | null;
      targetAmount?: number | null;
      currencyCode?: string;
      startedAt?: string;
      closedAt?: string | null;
      archivedAt?: string | null;
    },
  ) {
    if (operationsApiMode === 'live') {
      return request<Negotiation>(`/ops/negotiations/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
    }
    const index = demoNegotiations.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error('Negotiation not found');
    const existing = demoNegotiations[index];
    if (!demoCanWriteNegotiation(existing.assigned_negotiator_id)) {
      throw new Error('You do not have permission for this operation');
    }
    const assignedNegotiatorId =
      input.assignedNegotiatorId === undefined ? existing.assigned_negotiator_id : input.assignedNegotiatorId;
    assertNegotiatorAssignment(existing.organization_id, assignedNegotiatorId);
    const nextStatus = input.status ?? existing.status;
    if (nextStatus === 'open' || nextStatus === 'paused') {
      const property = demoProperties.find((entry) => entry.id === existing.property_id);
      if (!property || property.acquisition_stage !== 'negotiation') {
        throw new Error('Negotiation can only be opened when the property is in negotiation stage');
      }
      if (
        demoNegotiations.some(
          (entry) =>
            entry.id !== id &&
            entry.property_id === existing.property_id &&
            (entry.status === 'open' || entry.status === 'paused'),
        )
      ) {
        throw new Error('A property may have only one open or paused negotiation');
      }
    }
    const next = decorateNegotiation({
      ...existing,
      status: nextStatus,
      assigned_negotiator_id: assignedNegotiatorId,
      opening_amount: input.openingAmount === undefined ? existing.opening_amount : input.openingAmount,
      target_amount: input.targetAmount === undefined ? existing.target_amount : input.targetAmount,
      currency_code: input.currencyCode ? input.currencyCode.toUpperCase() : existing.currency_code,
      started_at: input.startedAt ?? existing.started_at,
      closed_at: input.closedAt === undefined ? existing.closed_at : input.closedAt,
      archived_at: input.archivedAt === undefined ? existing.archived_at : input.archivedAt,
      updated_at: now(),
    });
    demoNegotiations[index] = next;
    return next;
  },

  async listNegotiationEvents(negotiationId: string) {
    if (operationsApiMode === 'live') return request<NegotiationEvent[]>(`/ops/negotiations/${negotiationId}/events`);
    if (!demoNegotiations.some((entry) => entry.id === negotiationId)) throw new Error('Negotiation not found');
    return demoNegotiationEvents
      .filter((event) => event.negotiation_id === negotiationId)
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
      .map(decorateEvent);
  },

  async createNegotiationEvent(
    negotiationId: string,
    input: {
      eventType: NegotiationEventType;
      amount?: number | null;
      contextualNote?: string | null;
      occurredAt?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    if (operationsApiMode === 'live') {
      return request<NegotiationEvent>(`/ops/negotiations/${negotiationId}/events`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    }
    const negotiation = demoNegotiations.find((entry) => entry.id === negotiationId);
    if (!negotiation) throw new Error('Negotiation not found');
    if (!demoCanWriteNegotiation(negotiation.assigned_negotiator_id)) {
      throw new Error('You do not have permission for this operation');
    }
    if ((input.eventType === 'offer' || input.eventType === 'counteroffer') && input.amount == null) {
      throw new Error('Offer and counteroffer events require an amount');
    }
    const timestamp = now();
    const event = decorateEvent({
      id: crypto.randomUUID(),
      organization_id: negotiation.organization_id,
      negotiation_id: negotiationId,
      event_type: input.eventType,
      amount: input.amount ?? null,
      actor_user_id: DEMO_ACTOR_ID,
      contextual_note: input.contextualNote ?? null,
      occurred_at: input.occurredAt ?? timestamp,
      metadata: input.metadata ?? {},
      created_at: timestamp,
    });
    demoNegotiationEvents = [event, ...demoNegotiationEvents];
    if (input.eventType === 'offer' || input.eventType === 'counteroffer') {
      const index = demoNegotiations.findIndex((entry) => entry.id === negotiationId);
      demoNegotiations[index] = decorateNegotiation({
        ...demoNegotiations[index],
        current_amount: input.amount ?? null,
        updated_at: timestamp,
      });
    }
    return event;
  },

  async getConfig() {
    if (operationsApiMode === 'live') return request<{ documentUpload: DocumentUploadConfig }>('/ops/config');
    return { documentUpload: DEMO_DOCUMENT_UPLOAD_CONFIG };
  },

  async listDocuments(
    propertyId: string,
    filters?: { category?: DocumentCategory; status?: DocumentStatus; includeArchived?: boolean },
  ) {
    if (operationsApiMode === 'live') {
      const query = new URLSearchParams();
      if (filters?.category) query.set('category', filters.category);
      if (filters?.status) query.set('status', filters.status);
      if (filters?.includeArchived) query.set('includeArchived', 'true');
      const qs = query.toString();
      return request<PropertyDocument[]>(`/ops/properties/${propertyId}/documents${qs ? `?${qs}` : ''}`);
    }
    return demoDocuments
      .filter((document) => document.property_id === propertyId)
      .filter((document) => !filters?.category || document.category === filters.category)
      .filter((document) => !filters?.status || document.status === filters.status)
      .filter((document) => filters?.includeArchived || !document.archived_at)
      .map(decorateDocument)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async uploadDocument(
    propertyId: string,
    input: { category: DocumentCategory; title: string; negotiationId?: string | null; file: File },
  ) {
    const config = await operationsApi.getConfig();
    if (input.file.size > config.documentUpload.maxSizeBytes) {
      throw new Error(`File exceeds the maximum allowed size of ${config.documentUpload.maxSizeBytes} bytes`);
    }
    if (!config.documentUpload.acceptedMimeTypes.includes(input.file.type)) {
      throw new Error(`File type ${input.file.type} is not accepted`);
    }
    if (operationsApiMode === 'live') {
      const form = new FormData();
      form.set('category', input.category);
      form.set('title', input.title);
      if (input.negotiationId) form.set('negotiationId', input.negotiationId);
      form.set('file', input.file);
      return uploadRequest<PropertyDocument>(`/ops/properties/${propertyId}/documents`, form);
    }
    if (!demoCanWriteDocument()) throw new Error('You do not have permission for this operation');
    const property = demoProperties.find((entry) => entry.id === propertyId);
    if (!property) throw new Error('Property not found');
    if (input.negotiationId) {
      const negotiation = demoNegotiations.find((entry) => entry.id === input.negotiationId);
      if (!negotiation || negotiation.property_id !== propertyId) {
        throw new Error('Document negotiation must belong to the same property');
      }
    }
    const timestamp = now();
    const id = crypto.randomUUID();
    demoDocumentBlobs.set(id, input.file);
    const document = decorateDocument({
      id,
      organization_id: property.organization_id,
      property_id: propertyId,
      negotiation_id: input.negotiationId ?? null,
      category: input.category,
      status: 'draft',
      title: input.title,
      original_filename: input.file.name,
      content_type: input.file.type,
      size_bytes: input.file.size,
      storage_provider: 'local',
      uploaded_by_user_id: DEMO_ACTOR_ID,
      created_at: timestamp,
      updated_at: timestamp,
      archived_at: null,
    });
    demoDocuments = [document, ...demoDocuments];
    return document;
  },

  async getDocument(id: string) {
    if (operationsApiMode === 'live') return request<PropertyDocument>(`/ops/documents/${id}`);
    const document = demoDocuments.find((entry) => entry.id === id);
    if (!document) throw new Error('Document not found');
    return decorateDocument(document);
  },

  async updateDocument(
    id: string,
    input: {
      category?: DocumentCategory;
      status?: DocumentStatus;
      title?: string;
      negotiationId?: string | null;
      archived?: boolean;
    },
  ) {
    if (operationsApiMode === 'live') {
      return request<PropertyDocument>(`/ops/documents/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
    }
    if (!demoCanWriteDocument()) throw new Error('You do not have permission for this operation');
    const index = demoDocuments.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error('Document not found');
    const existing = demoDocuments[index];
    if (input.negotiationId) {
      const negotiation = demoNegotiations.find((entry) => entry.id === input.negotiationId);
      if (!negotiation || negotiation.property_id !== existing.property_id) {
        throw new Error('Document negotiation must belong to the same property');
      }
    }
    const next = decorateDocument({
      ...existing,
      category: input.category ?? existing.category,
      status: input.status ?? existing.status,
      title: input.title ?? existing.title,
      negotiation_id: input.negotiationId === undefined ? existing.negotiation_id : input.negotiationId,
      archived_at: input.archived === undefined ? existing.archived_at : input.archived ? now() : null,
      updated_at: now(),
    });
    demoDocuments[index] = next;
    return next;
  },

  async downloadDocument(id: string): Promise<{ blob: Blob; filename: string }> {
    if (operationsApiMode === 'live') return downloadRequest(`/ops/documents/${id}/content`);
    const document = demoDocuments.find((entry) => entry.id === id);
    if (!document) throw new Error('Document not found');
    const blob = demoDocumentBlobs.get(id);
    if (!blob) throw new Error('Stored file not found');
    return { blob, filename: document.original_filename };
  },

  async listTasks(
    propertyId: string,
    filters?: { status?: TaskStatus; priority?: TaskPriority; includeArchived?: boolean },
  ) {
    if (operationsApiMode === 'live') {
      const query = new URLSearchParams();
      if (filters?.status) query.set('status', filters.status);
      if (filters?.priority) query.set('priority', filters.priority);
      if (filters?.includeArchived) query.set('includeArchived', 'true');
      const qs = query.toString();
      return request<PropertyTask[]>(`/ops/properties/${propertyId}/tasks${qs ? `?${qs}` : ''}`);
    }
    return demoTasks
      .filter((task) => task.property_id === propertyId)
      .filter((task) => !filters?.status || task.status === filters.status)
      .filter((task) => !filters?.priority || task.priority === filters.priority)
      .filter((task) => filters?.includeArchived || !task.archived_at)
      .map(decorateTask)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async createTask(
    propertyId: string,
    input: {
      title: string;
      description?: string | null;
      priority?: TaskPriority;
      assignedUserId?: string | null;
      dueOn?: string | null;
    },
  ) {
    if (operationsApiMode === 'live') {
      return request<PropertyTask>(`/ops/properties/${propertyId}/tasks`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    }
    const property = demoProperties.find((entry) => entry.id === propertyId);
    if (!property) throw new Error('Property not found');
    const assignedUserId = input.assignedUserId ?? null;
    if (!demoCanCreateTask(property, assignedUserId)) {
      throw new Error('You do not have permission for this operation');
    }
    demoAssertActiveAssignee(property.organization_id, assignedUserId);
    const timestamp = now();
    const task = decorateTask({
      id: crypto.randomUUID(),
      organization_id: property.organization_id,
      property_id: propertyId,
      title: input.title,
      description: input.description ?? null,
      status: 'open',
      priority: input.priority ?? 'normal',
      assigned_user_id: assignedUserId,
      due_on: input.dueOn ?? null,
      created_by_user_id: DEMO_ACTOR_ID,
      created_at: timestamp,
      updated_at: timestamp,
      archived_at: null,
    });
    demoTasks = [task, ...demoTasks];
    return task;
  },

  async updateTask(
    id: string,
    input: {
      title?: string;
      description?: string | null;
      status?: TaskStatus;
      priority?: TaskPriority;
      assignedUserId?: string | null;
      dueOn?: string | null;
      archived?: boolean;
    },
  ) {
    if (operationsApiMode === 'live') {
      return request<PropertyTask>(`/ops/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
    }
    const index = demoTasks.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error('Task not found');
    const existing = demoTasks[index];
    const property = demoProperties.find((entry) => entry.id === existing.property_id);
    if (!property) throw new Error('Property not found');
    const manager = demoIsTaskManager(property);
    const selfService = demoCanWriteOwnTask(existing);
    if (!manager && !selfService) {
      throw new Error('You do not have permission for this operation');
    }
    if (!manager && input.assignedUserId !== undefined) {
      throw new Error('Only elevated task managers may reassign a task');
    }
    if (input.assignedUserId !== undefined) {
      demoAssertActiveAssignee(existing.organization_id, input.assignedUserId);
    }
    const next = decorateTask({
      ...existing,
      title: input.title ?? existing.title,
      description: input.description === undefined ? existing.description : input.description,
      status: input.status ?? existing.status,
      priority: input.priority ?? existing.priority,
      assigned_user_id: input.assignedUserId === undefined ? existing.assigned_user_id : input.assignedUserId,
      due_on: input.dueOn === undefined ? existing.due_on : input.dueOn,
      archived_at: input.archived === undefined ? existing.archived_at : input.archived ? now() : null,
      updated_at: now(),
    });
    demoTasks[index] = next;
    return next;
  },

  async listPayments(
    propertyId: string,
    filters?: { status?: PaymentStatus; paymentType?: PaymentType; includeArchived?: boolean },
  ) {
    if (operationsApiMode === 'live') {
      const query = new URLSearchParams();
      if (filters?.status) query.set('status', filters.status);
      if (filters?.paymentType) query.set('paymentType', filters.paymentType);
      if (filters?.includeArchived) query.set('includeArchived', 'true');
      const qs = query.toString();
      return request<PropertyPayment[]>(`/ops/properties/${propertyId}/payments${qs ? `?${qs}` : ''}`);
    }
    return demoPayments
      .filter((payment) => payment.property_id === propertyId)
      .filter((payment) => !filters?.status || payment.status === filters.status)
      .filter((payment) => !filters?.paymentType || payment.payment_type === filters.paymentType)
      .filter((payment) => filters?.includeArchived || !payment.archived_at)
      .map(decoratePayment)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async createPayment(
    propertyId: string,
    input: {
      amount: number;
      currencyCode?: string;
      paymentType: PaymentType;
      negotiationId?: string | null;
      scheduledOn?: string | null;
      paidOn?: string | null;
      referenceNumber?: string | null;
    },
  ) {
    if (operationsApiMode === 'live') {
      return request<PropertyPayment>(`/ops/properties/${propertyId}/payments`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    }
    if (!demoCanWritePayment()) throw new Error('You do not have permission for this operation');
    if (!(input.amount > 0)) throw new Error('Payment amount must be greater than zero');
    const property = demoProperties.find((entry) => entry.id === propertyId);
    if (!property) throw new Error('Property not found');
    if (input.negotiationId) {
      const negotiation = demoNegotiations.find((entry) => entry.id === input.negotiationId);
      if (!negotiation || negotiation.property_id !== propertyId) {
        throw new Error('Payment negotiation must belong to the same property');
      }
    }
    const timestamp = now();
    const payment = decoratePayment({
      id: crypto.randomUUID(),
      organization_id: property.organization_id,
      property_id: propertyId,
      negotiation_id: input.negotiationId ?? null,
      amount: input.amount,
      currency_code: (input.currencyCode ?? 'PHP').toUpperCase(),
      payment_type: input.paymentType,
      status: 'pending',
      scheduled_on: input.scheduledOn ?? null,
      paid_on: input.paidOn ?? null,
      reference_number: input.referenceNumber ?? null,
      recorded_by_user_id: DEMO_ACTOR_ID,
      created_at: timestamp,
      updated_at: timestamp,
      archived_at: null,
    });
    demoPayments = [payment, ...demoPayments];
    return payment;
  },

  async updatePayment(
    id: string,
    input: {
      amount?: number;
      currencyCode?: string;
      paymentType?: PaymentType;
      negotiationId?: string | null;
      status?: PaymentStatus;
      scheduledOn?: string | null;
      paidOn?: string | null;
      referenceNumber?: string | null;
      archived?: boolean;
    },
  ) {
    if (operationsApiMode === 'live') {
      return request<PropertyPayment>(`/ops/payments/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
    }
    if (!demoCanWritePayment()) throw new Error('You do not have permission for this operation');
    if (input.amount !== undefined && !(input.amount > 0)) {
      throw new Error('Payment amount must be greater than zero');
    }
    const index = demoPayments.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error('Payment not found');
    const existing = demoPayments[index];
    if (input.negotiationId) {
      const negotiation = demoNegotiations.find((entry) => entry.id === input.negotiationId);
      if (!negotiation || negotiation.property_id !== existing.property_id) {
        throw new Error('Payment negotiation must belong to the same property');
      }
    }
    const next = decoratePayment({
      ...existing,
      amount: input.amount ?? existing.amount,
      currency_code: input.currencyCode ? input.currencyCode.toUpperCase() : existing.currency_code,
      payment_type: input.paymentType ?? existing.payment_type,
      negotiation_id: input.negotiationId === undefined ? existing.negotiation_id : input.negotiationId,
      status: input.status ?? existing.status,
      scheduled_on: input.scheduledOn === undefined ? existing.scheduled_on : input.scheduledOn,
      paid_on: input.paidOn === undefined ? existing.paid_on : input.paidOn,
      reference_number: input.referenceNumber === undefined ? existing.reference_number : input.referenceNumber,
      archived_at: input.archived === undefined ? existing.archived_at : input.archived ? now() : null,
      updated_at: now(),
    });
    demoPayments[index] = next;
    return next;
  },

  async dashboard(orgId: string) {
    if (operationsApiMode === 'live') return request<Record<string, unknown>>(`/ops/dashboard?organizationId=${orgId}`);
    const properties = demoProperties.filter((property) => property.organization_id === orgId);
    return {
      total: String(properties.length),
      active: String(properties.filter((property) => property.acquisition_status === 'active').length),
      negotiation: String(properties.filter((property) => property.acquisition_stage === 'negotiation').length),
      blocked: String(properties.filter((property) => property.legal_status === 'blocked' || property.risk === 'high').length),
      ready: String(
        properties.filter((property) => property.readiness_percent >= 80 && property.acquisition_status === 'active').length,
      ),
      stages: [],
    };
  },
};
