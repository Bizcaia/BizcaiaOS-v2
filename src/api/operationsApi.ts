import { organizationApi } from './organizationApi';
import { unknownBigIntKeys, unknownRequestKeys, type RequestBodyOperation } from './requestKeys';

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
  acquisition_status: AcquisitionStatus;
  assigned_negotiator_id: string | null;
  assigned_manager_id: string | null;
  legal_status: string;
  documentation_status: string;
  payment_status: string;
  readiness_percent: number;
  risk: 'low' | 'medium' | 'high';
  created_at?: string;
  updated_at?: string;
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

/** A row is the signing event itself; unsigned owners are derived, never stored. */
export type AgreementSignature = {
  id: string;
  organization_id: string;
  property_id: string;
  document_id: string;
  owner_id: string;
  signed_on: string;
  recorded_by_user_id: string;
  owner_name?: string | null;
  document_title?: string | null;
  recorded_by_name?: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type TimelineKind =
  | 'negotiation_event'
  | 'negotiation_recorded'
  | 'document_uploaded'
  | 'task_created'
  | 'payment_recorded'
  | 'payment_paid'
  | 'agreement_signed'
  | 'interaction'
  | 'stage_changed'
  | 'status_changed'
  | 'risk_changed';

export type TimelineSourceType =
  | 'negotiation_event'
  | 'negotiation'
  | 'document'
  | 'task'
  | 'payment'
  | 'agreement_signature'
  | 'interaction'
  | 'lifecycle';

export type InteractionType = 'call' | 'meeting' | 'site_visit' | 'message' | 'other';

/** An actual contact involving a property and optionally one of its owners; immutable except archiving. */
export type Interaction = {
  id: string;
  organization_id: string;
  property_id: string;
  owner_id: string | null;
  owner_name?: string | null;
  interaction_type: InteractionType;
  notes: string;
  occurred_at: string;
  recorded_by_user_id: string;
  recorded_by_name?: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

/** A read-model entry built from an existing record; never stored. */
export type TimelineEntry = {
  id: string;
  kind: TimelineKind;
  source_type: TimelineSourceType;
  source_id: string;
  /** ISO timestamp when precision is 'timestamp'; YYYY-MM-DD when 'date'. */
  occurred_at: string;
  precision: 'timestamp' | 'date';
  basis: 'occurrence' | 'recorded';
  actor: { id: string; display_name: string | null } | null;
  summary: string;
  archived: boolean;
};

/** Rows the Properties tab reads per request. */
export const PROPERTY_PAGE_SIZE = 50;

/**
 * Portfolio counts as the server defines them, over the properties the caller
 * can see: `total` properties (not archived), `active` and `ready` (readiness
 * of 80% or more) among those being acquired, `negotiation` by stage, and the
 * active properties of each stage that has any.
 */
export type DashboardSummary = {
  total: number;
  active: number;
  negotiation: number;
  blocked: number;
  ready: number;
  stages: Array<{ acquisition_stage: AcquisitionStage; count: number }>;
};

/** One row of an attention task list; `overdue` is decided against the organization's calendar day. */
export type AttentionTask = {
  id: string;
  property_id: string;
  property_reference: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  due_on: string | null;
  overdue: boolean;
};

export type AttentionProperty = {
  id: string;
  property_reference: string;
  acquisition_stage: AcquisitionStage;
  acquisition_status: AcquisitionStatus;
  risk: 'low' | 'medium' | 'high';
  legal_status: string;
};

/** Each list holds at most ATTENTION_LIST_LIMIT rows; `total` is the full count. */
export type Attention = {
  today: string;
  my_tasks: { total: number; items: AttentionTask[] };
  overdue_tasks: { total: number; items: AttentionTask[] };
  properties: { total: number; items: AttentionProperty[] };
};

export const ATTENTION_LIST_LIMIT = 50;

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

/** The details of a D-X1 lifecycle conflict (S-25): the field and its current and stale values. */
export type LifecycleConflictDetails = {
  conflict: 'lifecycle';
  field: 'acquisition_stage' | 'acquisition_status';
  current: string;
  expected: string;
};

/** An API refusal with its HTTP status and error code (and details for a lifecycle conflict). */
export class OperationsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: LifecycleConflictDetails,
  ) {
    super(message);
    this.name = 'OperationsApiError';
  }
}

/** True when an operation was refused because the screen was stale (409 lifecycle_conflict). */
export function isLifecycleConflict(error: unknown): error is OperationsApiError & { details: LifecycleConflictDetails } {
  return error instanceof OperationsApiError && error.code === 'lifecycle_conflict' && !!error.details;
}

/** Mirrors the 40001 conflict the lifecycle functions raise for a stale expected value. */
function demoLifecycleConflict(field: LifecycleConflictDetails['field'], current: string, expected: string): never {
  const label = field === 'acquisition_stage' ? 'acquisition stage' : 'acquisition status';
  throw new OperationsApiError(
    `The ${label} is now ${current} (this screen showed ${expected}); reload before retrying`,
    409,
    'lifecycle_conflict',
    { conflict: 'lifecycle', field, current, expected },
  );
}

/**
 * The live JSON request body. An unknown key holding a BigInt cannot be serialized; it is
 * refused with the API's 400 validation_error, as demo mode does, instead of a TypeError.
 * Any other serialization failure is left unchanged.
 */
function jsonRequestBody(input: object, operation: RequestBodyOperation): string {
  try {
    return JSON.stringify(input);
  } catch (error) {
    if (unknownBigIntKeys(input, operation).length) throw new OperationsApiError('Request validation failed', 400, 'validation_error');
    throw error;
  }
}

/** Mirrors the API's 400 validation_error for a request-body key it does not accept. */
function rejectUnknownDemoKeys(input: object, operation: RequestBodyOperation, notInBody: readonly string[] = []) {
  if (unknownRequestKeys(input, operation).some((key) => !notInBody.includes(key))) {
    throw new OperationsApiError('Request validation failed', 400, 'validation_error');
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
  if (!response.ok) {
    throw new OperationsApiError(
      payload.error?.message ?? 'Request failed',
      response.status,
      payload.error?.code ?? 'request_failed',
      payload.error?.details,
    );
  }
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

// acquisition_stage and acquisition_status are absent: they change only through
// transitionPropertyStage (L-02) and transitionPropertyStatus (L-03).
const propertyPatchColumns: Record<string, string> = {
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

let demoAgreementSignatures: AgreementSignature[] = [];

let demoInteractions: Interaction[] = [];

/** Mirrors public.property_lifecycle_history: one row per stage or status change, append-only. */
type DemoLifecycleHistory = {
  id: string;
  organization_id: string;
  property_id: string;
  field: 'acquisition_stage' | 'acquisition_status' | 'risk';
  from_value: string | null;
  to_value: string;
  reason: string | null;
  actor_user_id: string | null;
  changed_at: string;
  is_override: boolean;
  overridden_rules: string[] | null;
  remediation_id: string | null;
};

let demoLifecycleHistory: DemoLifecycleHistory[] = [];

/** Mirrors acquisition_stage_position(): normal stages in workflow order; legacy values have none. */
export const stageOrder: AcquisitionStage[] = [
  'identified',
  'initial_contact',
  'owner_validation',
  'property_validation',
  'documentation',
  'negotiation',
  'commercial_review',
  'legal_review',
  'agreement_preparation',
  'signing',
  'payment_closing',
];

/** Every stage value in the order the database lists them, the legacy values last. */
const acquisitionStageOrder: AcquisitionStage[] = [...stageOrder, 'acquisition_complete', 'on_hold', 'withdrawn'];

export const forwardStageRoles = new Set(['negotiator', 'supervisor', 'land_acquisition_manager', 'system_admin']);
export const backwardStageRoles = new Set(['supervisor', 'land_acquisition_manager', 'system_admin']);
const negotiationExceptionRoles = new Set(['supervisor', 'land_acquisition_manager', 'system_admin']);

/** Mirrors can_read_property() for the demo actor. */
function demoCanReadProperty(property: Property): boolean {
  const member = demoActorMembership();
  if (!member || member.organization_id !== property.organization_id) return false;
  if (member.role === 'supervisor') {
    const project = demoProjects.find((entry) => entry.id === property.project_id);
    return property.assigned_manager_id === DEMO_ACTOR_ID || project?.manager_user_id === DEMO_ACTOR_ID;
  }
  if (member.role === 'negotiator') return property.assigned_negotiator_id === DEMO_ACTOR_ID;
  return true;
}

/** Mirrors record_property_lifecycle_history(): initial stage and status on create; each changed stage, status and risk on update. */
function recordDemoLifecycleHistory(
  previous: Property | null,
  next: Property,
  reason: string | null = null,
  overrideRules: string[] | null = null,
  remediationId: string | null = null,
) {
  const changedAt = new Date().toISOString();
  for (const field of ['acquisition_stage', 'acquisition_status'] as const) {
    const fromValue = previous ? previous[field] : null;
    if (previous && fromValue === next[field]) continue;
    // Only the field a transition changes carries its override rules; creation never does.
    const rules = previous ? overrideRules : null;
    demoLifecycleHistory.push({
      id: crypto.randomUUID(),
      organization_id: next.organization_id,
      property_id: next.id,
      field,
      from_value: fromValue,
      to_value: next[field],
      reason,
      actor_user_id: DEMO_ACTOR_ID,
      changed_at: changedAt,
      is_override: rules != null,
      overridden_rules: rules,
      remediation_id: previous && field === 'acquisition_stage' ? remediationId : null,
    });
  }
  // A risk change carries no reason and is never an override; creation records no risk row.
  if (previous && previous.risk !== next.risk) {
    demoLifecycleHistory.push({
      id: crypto.randomUUID(),
      organization_id: next.organization_id,
      property_id: next.id,
      field: 'risk',
      from_value: previous.risk,
      to_value: next.risk,
      reason: null,
      actor_user_id: DEMO_ACTOR_ID,
      changed_at: changedAt,
      is_override: false,
      overridden_rules: null,
      remediation_id: null,
    });
  }
}

/** Legacy stage remediation (L-06): one row per review cycle. Mirrors property_stage_remediations. */
export type RemediationState = 'UNDER_REVIEW' | 'REQUIRES_ESCALATION' | 'RESOLVED';

export type RemediationEvent = {
  id: string;
  remediation_id: string;
  action: 'review_started' | 'escalated' | 'returned_to_review' | 'resolved' | 'reopened';
  from_state: string | null;
  to_state: string;
  reason: string | null;
  actor_user_id: string;
  occurred_at: string;
};

export type PropertyRemediation = {
  id: string;
  organization_id: string;
  property_id: string;
  cycle: number;
  legacy_value: 'on_hold' | 'withdrawn' | 'acquisition_complete';
  stage_at_open: string;
  state: RemediationState;
  opened_by_user_id: string;
  opened_at: string;
  resolved_by_user_id: string | null;
  resolved_at: string | null;
  resulting_stage: string | null;
  resolution_reason: string | null;
  evidence: string | null;
  evidence_document_id: string | null;
  evidence_interaction_id: string | null;
  events?: RemediationEvent[];
};

export type RemediationQueueItem = {
  property_id: string;
  property_reference: string;
  acquisition_stage: AcquisitionStage;
  acquisition_status: AcquisitionStatus;
  remediation_id: string | null;
  cycle: number | null;
  legacy_value: string | null;
  state: RemediationState | 'NOT_REVIEWED';
};

export type ResolveRemediationInput = {
  resultingStage: AcquisitionStage;
  /** The stage the caller's screen showed (D-X1). */
  expectedStage: AcquisitionStage;
  reason?: string | null;
  evidence?: string | null;
  evidenceDocumentId?: string | null;
  evidenceInteractionId?: string | null;
};

export const legacyStages: AcquisitionStage[] = ['on_hold', 'withdrawn', 'acquisition_complete'];

let demoRemediations: PropertyRemediation[] = [];
let demoRemediationEvents: RemediationEvent[] = [];

const remediationRoles = new Set(['supervisor', 'land_acquisition_manager', 'system_admin']);

/** Mirrors authorize_property_stage_remediation(): visibility (not found), then the N-1 remediation roles. */
function demoAuthorizeRemediation(propertyId: string): Property {
  const property = demoProperties.find((entry) => entry.id === propertyId);
  if (!property || !demoCanReadProperty(property)) throw new Error('Property not found');
  if (!remediationRoles.has(demoActorMembership()?.role ?? '')) {
    throw new Error("You do not have permission to remediate this property's legacy stage");
  }
  return property;
}

function demoLatestRemediation(propertyId: string, expectedState: RemediationState) {
  const latest = demoRemediations
    .filter((entry) => entry.property_id === propertyId)
    .sort((a, b) => b.cycle - a.cycle)[0];
  if (!latest || latest.state !== expectedState) throw new Error(`No remediation cycle of this property is ${expectedState}`);
  return latest;
}

function demoRemediationEvent(
  remediation: PropertyRemediation,
  action: RemediationEvent['action'],
  fromState: string | null,
  toState: string,
  reason: string | null,
) {
  demoRemediationEvents.push({
    id: crypto.randomUUID(),
    remediation_id: remediation.id,
    action,
    from_state: fromState,
    to_state: toState,
    reason,
    actor_user_id: DEMO_ACTOR_ID,
    occurred_at: new Date().toISOString(),
  });
}

function demoMoveRemediation(
  propertyId: string,
  fromState: RemediationState,
  toState: RemediationState,
  action: RemediationEvent['action'],
  reason: string | null | undefined,
  reasonRequired: boolean,
) {
  demoAuthorizeRemediation(propertyId);
  const remediation = demoLatestRemediation(propertyId, fromState);
  // A blank optional reason is none (Q-4, Q-5); escalation requires one (Q-3).
  const cleanReason = reason?.trim() || null;
  if (reasonRequired && !cleanReason) throw new Error('A reason is required to escalate this remediation');
  remediation.state = toState;
  demoRemediationEvent(remediation, action, fromState, toState, cleanReason);
  return { ...remediation };
}

export type AcquisitionStatus = 'active' | 'on_hold' | 'withdrawn' | 'complete';

const normalStatusRoles = new Set(['negotiator', 'supervisor', 'land_acquisition_manager', 'system_admin']);
const controlledStatusRoles = new Set(['supervisor', 'land_acquisition_manager', 'system_admin']);
const completeReversalRoles = new Set(['land_acquisition_manager', 'system_admin']);

/** Mirrors the N-2 operation rows in transition_property_status(). */
export function demoStatusOperation(from: string, to: AcquisitionStatus, stage: AcquisitionStage) {
  let roles = controlledStatusRoles;
  let reasonRequired = false;
  const rules: string[] = [];
  if ((from === 'active' && to === 'on_hold') || (from === 'on_hold' && to === 'active')) {
    roles = normalStatusRoles;
  } else if (to === 'withdrawn' && (from === 'active' || from === 'on_hold')) {
    reasonRequired = true;
  } else if (from === 'on_hold' && to === 'complete') {
    rules.push('on_hold_completion');
  } else if (from === 'withdrawn') {
    rules.push('withdrawn_reversal');
  } else if (from === 'complete') {
    roles = completeReversalRoles;
    rules.push('complete_reversal');
  }
  if (to === 'complete' && stage !== 'payment_closing') rules.push('completion_stage_condition');
  return { roles, reasonRequired: reasonRequired || rules.length > 0, rules };
}

const interactionRoles = new Set(['system_admin', 'land_acquisition_manager', 'supervisor', 'negotiator']);
const interactionTypes = new Set<InteractionType>(['call', 'meeting', 'site_visit', 'message', 'other']);

/** Mirrors can_read_interaction()/can_write_interaction(): the four interaction roles. */
function demoCanUseInteractions(): boolean {
  const member = demoActorMembership();
  return !!member && interactionRoles.has(member.role);
}

function decorateInteraction(interaction: Interaction): Interaction {
  return {
    ...interaction,
    owner_name: interaction.owner_id ? demoOwners.find((owner) => owner.id === interaction.owner_id)?.display_name ?? null : null,
    recorded_by_name: demoUsers[interaction.recorded_by_user_id] ?? null,
  };
}

const agreementSignatureWriteRoles = new Set(['system_admin', 'land_acquisition_manager', 'legal_documentation']);

/** Same fixed role set as documents; no property scoping, no assignee model. */
function demoCanWriteAgreementSignature(): boolean {
  const member = demoActorMembership();
  return !!member && agreementSignatureWriteRoles.has(member.role);
}

/** Mirror guard_property_owner_agreement_signatures(): an active signature pins its owner link. */
function demoHasActiveOwnerSignature(propertyId: string, ownerId: string): boolean {
  return demoAgreementSignatures.some(
    (signature) => signature.property_id === propertyId && signature.owner_id === ownerId && !signature.archived_at,
  );
}

/** Mirror guard_document_agreement_signatures(): an active signature pins its document's category. */
function demoHasActiveDocumentSignature(documentId: string): boolean {
  return demoAgreementSignatures.some((signature) => signature.document_id === documentId && !signature.archived_at);
}

function decorateAgreementSignature(signature: AgreementSignature): AgreementSignature {
  return {
    ...signature,
    owner_name: demoOwners.find((owner) => owner.id === signature.owner_id)?.display_name ?? null,
    document_title: demoDocuments.find((document) => document.id === signature.document_id)?.title ?? null,
    recorded_by_name: demoUsers[signature.recorded_by_user_id] ?? null,
  };
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

// Mirrors the server's Timeline summary labels and tie ranks exactly.
const timelineEventTypeLabels: Record<NegotiationEventType, string> = {
  offer: 'Offer',
  counteroffer: 'Counteroffer',
  meeting: 'Meeting',
  call: 'Call',
  message: 'Message',
  note: 'Note',
  other: 'Other activity',
};

const timelineDocumentCategoryLabels: Record<DocumentCategory, string> = {
  ownership_evidence: 'Ownership evidence',
  title_deed: 'Title deed',
  tax_declaration: 'Tax declaration',
  legal_opinion: 'Legal opinion',
  survey_plan: 'Survey plan',
  agreement_draft: 'Agreement draft',
  agreement_executed: 'Agreement executed',
  payment_proof: 'Payment proof',
  other: 'Other',
};

const timelinePaymentTypeLabels: Record<PaymentType, string> = {
  deposit: 'Deposit',
  installment: 'Installment',
  final_payment: 'Final payment',
};

const timelinePaymentStatusLabels: Record<PaymentStatus, string> = {
  pending: 'Pending',
  scheduled: 'Scheduled',
  paid: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const timelineSourceRank: Record<TimelineSourceType, number> = {
  negotiation_event: 1,
  negotiation: 2,
  document: 3,
  task: 4,
  payment: 5,
  agreement_signature: 6,
  interaction: 7,
  lifecycle: 8,
};

// Stage labels mirror the property screens; legacy stage values keep their display names.
const timelineStageLabels: Record<string, string> = {
  identified: 'Identified',
  initial_contact: 'Initial contact',
  owner_validation: 'Owner validation',
  property_validation: 'Property validation',
  documentation: 'Documentation',
  negotiation: 'Negotiation',
  commercial_review: 'Commercial review',
  legal_review: 'Legal review',
  agreement_preparation: 'Agreement preparation',
  signing: 'Signing',
  payment_closing: 'Payment / closing',
  acquisition_complete: 'Complete',
  on_hold: 'On hold',
  withdrawn: 'Withdrawn',
};

const timelineStatusLabels: Record<string, string> = {
  active: 'Active',
  on_hold: 'On hold',
  withdrawn: 'Withdrawn',
  complete: 'Complete',
};

const timelineRiskLabels: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

function timelineLifecycleSummary(noun: string, labels: Record<string, string>, fromValue: string | null, toValue: string) {
  const to = labels[toValue] ?? toValue;
  // The reason recorded with a change is never part of the summary.
  return fromValue == null ? `${noun} set to ${to}` : `${noun} changed from ${labels[fromValue] ?? fromValue} to ${to}`;
}

const timelineInteractionTypeLabels: Record<InteractionType, string> = {
  call: 'Call',
  meeting: 'Meeting',
  site_visit: 'Site visit',
  message: 'Message',
  other: 'Other interaction',
};

function timelineMoney(amount: number | string, currency: string | null) {
  return `${currency ?? ''} ${Number(amount).toLocaleString('en-US')}`.trim();
}

/** YYYY-MM-DD for an instant in the given IANA zone; unrecognized zones fail like PostgreSQL's 22023. */
function calendarDay(instant: Date, timeZone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  } catch {
    throw new Error(`time zone "${timeZone}" not recognized`);
  }
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Mirrors the app_users read rule: a name is visible only while that user is an active member. */
function demoTimelineActor(userId: string | null): TimelineEntry['actor'] {
  if (!userId) return null;
  const active = demoMemberships.some((member) => member.user_id === userId && member.is_active);
  return { id: userId, display_name: active ? demoUsers[userId] ?? null : null };
}

function demoPropertyTimeline(property: Property, timeZone: string, page: { limit: number; offset: number }): TimelineEntry[] {
  const nowInstant = new Date();
  const today = calendarDay(nowInstant, timeZone);
  const reached = (timestamp: string) => new Date(timestamp).getTime() <= nowInstant.getTime();
  const candidates: TimelineEntry[] = [];
  const add = (entry: Omit<TimelineEntry, 'id' | 'archived'>) =>
    candidates.push({ ...entry, id: `${entry.source_type}:${entry.source_id}:${entry.kind}`, archived: false });

  const negotiations = demoNegotiations.filter((negotiation) => negotiation.property_id === property.id && !negotiation.archived_at);
  for (const negotiation of negotiations) {
    for (const event of demoNegotiationEvents.filter((entry) => entry.negotiation_id === negotiation.id)) {
      if (!reached(event.occurred_at)) continue;
      const label = timelineEventTypeLabels[event.event_type] ?? 'Negotiation activity';
      add({
        kind: 'negotiation_event',
        source_type: 'negotiation_event',
        source_id: event.id,
        occurred_at: new Date(event.occurred_at).toISOString(),
        precision: 'timestamp',
        basis: 'occurrence',
        actor: demoTimelineActor(event.actor_user_id),
        summary:
          event.amount != null && (event.event_type === 'offer' || event.event_type === 'counteroffer')
            ? `${label}: ${timelineMoney(event.amount, negotiation.currency_code)}`
            : `${label} logged`,
      });
    }
    if (reached(negotiation.created_at)) {
      add({
        kind: 'negotiation_recorded',
        source_type: 'negotiation',
        source_id: negotiation.id,
        occurred_at: new Date(negotiation.created_at).toISOString(),
        precision: 'timestamp',
        basis: 'recorded',
        actor: null,
        summary:
          negotiation.opening_amount != null
            ? `Negotiation recorded · opening ${timelineMoney(negotiation.opening_amount, negotiation.currency_code)}`
            : 'Negotiation recorded',
      });
    }
  }
  for (const document of demoDocuments) {
    if (document.property_id !== property.id || document.archived_at || !reached(document.created_at)) continue;
    add({
      kind: 'document_uploaded',
      source_type: 'document',
      source_id: document.id,
      occurred_at: new Date(document.created_at).toISOString(),
      precision: 'timestamp',
      basis: 'recorded',
      actor: demoTimelineActor(document.uploaded_by_user_id),
      summary: `${timelineDocumentCategoryLabels[document.category] ?? 'Document'}: ${document.title}`,
    });
  }
  for (const task of demoTasks) {
    if (task.property_id !== property.id || task.archived_at || !reached(task.created_at)) continue;
    add({
      kind: 'task_created',
      source_type: 'task',
      source_id: task.id,
      occurred_at: new Date(task.created_at).toISOString(),
      precision: 'timestamp',
      basis: 'recorded',
      actor: demoTimelineActor(task.created_by_user_id),
      summary: `Task created: ${task.title}`,
    });
  }
  for (const payment of demoPayments) {
    if (payment.property_id !== property.id || payment.archived_at) continue;
    const typeLabel = timelinePaymentTypeLabels[payment.payment_type] ?? 'Payment';
    const money = timelineMoney(payment.amount, payment.currency_code);
    if (reached(payment.created_at)) {
      add({
        kind: 'payment_recorded',
        source_type: 'payment',
        source_id: payment.id,
        occurred_at: new Date(payment.created_at).toISOString(),
        precision: 'timestamp',
        basis: 'recorded',
        actor: demoTimelineActor(payment.recorded_by_user_id),
        summary: `${typeLabel} recorded: ${money} · ${timelinePaymentStatusLabels[payment.status] ?? payment.status}`,
      });
    }
    // B1-a: only a payment currently marked paid with a reached paid_on date.
    if (payment.status === 'paid' && payment.paid_on && payment.paid_on <= today) {
      add({
        kind: 'payment_paid',
        source_type: 'payment',
        source_id: payment.id,
        occurred_at: payment.paid_on,
        precision: 'date',
        basis: 'occurrence',
        actor: null,
        summary: `${typeLabel} paid: ${money}`,
      });
    }
  }
  for (const signature of demoAgreementSignatures) {
    if (signature.property_id !== property.id || signature.archived_at || signature.signed_on > today) continue;
    const ownerName = demoOwners.find((owner) => owner.id === signature.owner_id)?.display_name;
    const documentTitle = demoDocuments.find((document) => document.id === signature.document_id)?.title;
    add({
      kind: 'agreement_signed',
      source_type: 'agreement_signature',
      source_id: signature.id,
      occurred_at: signature.signed_on,
      precision: 'date',
      basis: 'occurrence',
      actor: demoTimelineActor(signature.recorded_by_user_id),
      summary: `${ownerName ?? 'Unknown owner'} signed ${documentTitle ?? 'an agreement'}`,
    });
  }
  // Only the interaction source is role-filtered; notes are never included.
  if (demoCanUseInteractions()) {
    for (const interaction of demoInteractions) {
      if (interaction.property_id !== property.id || interaction.archived_at || !reached(interaction.occurred_at)) continue;
      const label = timelineInteractionTypeLabels[interaction.interaction_type] ?? 'Interaction';
      const ownerName = interaction.owner_id ? demoOwners.find((owner) => owner.id === interaction.owner_id)?.display_name : null;
      add({
        kind: 'interaction',
        source_type: 'interaction',
        source_id: interaction.id,
        occurred_at: new Date(interaction.occurred_at).toISOString(),
        precision: 'timestamp',
        basis: 'occurrence',
        actor: demoTimelineActor(interaction.recorded_by_user_id),
        summary: ownerName ? `${label} with ${ownerName}` : label,
      });
    }
  }
  // Lifecycle history is visible wherever the property is.
  for (const history of demoLifecycleHistory) {
    if (history.property_id !== property.id || !reached(history.changed_at)) continue;
    if (history.field === 'risk') {
      add({
        kind: 'risk_changed',
        source_type: 'lifecycle',
        source_id: history.id,
        occurred_at: new Date(history.changed_at).toISOString(),
        precision: 'timestamp',
        basis: 'occurrence',
        actor: demoTimelineActor(history.actor_user_id),
        summary: timelineLifecycleSummary('Risk', timelineRiskLabels, history.from_value, history.to_value),
      });
      continue;
    }
    const isStage = history.field === 'acquisition_stage';
    add({
      kind: isStage ? 'stage_changed' : 'status_changed',
      source_type: 'lifecycle',
      source_id: history.id,
      occurred_at: new Date(history.changed_at).toISOString(),
      precision: 'timestamp',
      basis: 'occurrence',
      actor: demoTimelineActor(history.actor_user_id),
      // An override is shown as such; its reason and rules stay out of the summary.
      summary: `${
        isStage
          ? timelineLifecycleSummary('Acquisition stage', timelineStageLabels, history.from_value, history.to_value)
          : timelineLifecycleSummary('Acquisition status', timelineStatusLabels, history.from_value, history.to_value)
      }${history.is_override ? ' (override)' : history.remediation_id ? ' (legacy remediation)' : ''}`,
    });
  }

  // Same keys as the server: calendar day (organization timezone) desc,
  // date-only after that day's timestamps (desc), timestamp desc, tie rank,
  // then source id in code-unit order.
  const sortKey = (entry: TimelineEntry) => ({
    day: entry.precision === 'date' ? entry.occurred_at : calendarDay(new Date(entry.occurred_at), timeZone),
    dateOnly: entry.precision === 'date' ? 1 : 0,
    time: entry.precision === 'date' ? null : new Date(entry.occurred_at).getTime(),
  });
  return candidates
    .map((entry) => ({ entry, key: sortKey(entry) }))
    .sort((a, b) => {
      if (a.key.day !== b.key.day) return a.key.day < b.key.day ? 1 : -1;
      if (a.key.dateOnly !== b.key.dateOnly) return b.key.dateOnly - a.key.dateOnly;
      if (a.key.time !== b.key.time) {
        if (a.key.time == null) return 1;
        if (b.key.time == null) return -1;
        return b.key.time - a.key.time;
      }
      const rank = timelineSourceRank[a.entry.source_type] - timelineSourceRank[b.entry.source_type];
      if (rank !== 0) return rank;
      return a.entry.source_id < b.entry.source_id ? -1 : a.entry.source_id > b.entry.source_id ? 1 : 0;
    })
    .map(({ entry }) => entry)
    .slice(page.offset, page.offset + page.limit);
}

const taskPriorityRank: Record<TaskPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/** The organization's calendar day; an unrecognized zone falls back to UTC, as on the server. */
function attentionToday(instant: Date, timeZone: string) {
  try {
    return calendarDay(instant, timeZone);
  } catch {
    return calendarDay(instant, 'UTC');
  }
}

function attentionList<Row>(rows: Row[]) {
  return { total: rows.length, items: rows.slice(0, ATTENTION_LIST_LIMIT) };
}

/** Mirrors loadAttention on the server: same rules, ordering and limits. */
function demoAttention(organizationId: string, timeZone: string): Attention {
  const member = demoActorMembership();
  if (!member || member.organization_id !== organizationId) {
    throw new Error('You do not have permission for this operation');
  }
  const today = attentionToday(new Date(), timeZone);
  const visible = demoProperties.filter((property) => property.organization_id === organizationId && demoCanReadProperty(property));
  const references = new Map(visible.map((property) => [property.id, property.property_reference]));
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // Open or in progress, not archived, and on a property the actor can see.
  const openTasks = demoTasks
    .filter((task) => task.organization_id === organizationId && !task.archived_at && references.has(task.property_id))
    .filter((task) => task.status === 'open' || task.status === 'in_progress')
    .map(
      (task): AttentionTask => ({
        id: task.id,
        property_id: task.property_id,
        property_reference: references.get(task.property_id) ?? '',
        title: task.title,
        status: task.status,
        priority: task.priority,
        assigned_user_id: task.assigned_user_id,
        assigned_user_name: demoTimelineActor(task.assigned_user_id)?.display_name ?? null,
        due_on: task.due_on,
        overdue: task.due_on !== null && task.due_on < today,
      }),
    )
    // Earliest due date first, undated last, then the most urgent.
    .sort((a, b) => {
      if (a.due_on !== b.due_on) {
        if (a.due_on === null) return 1;
        if (b.due_on === null) return -1;
        return a.due_on < b.due_on ? -1 : 1;
      }
      return taskPriorityRank[b.priority] - taskPriorityRank[a.priority] || byId(a, b);
    });

  const properties = visible
    .filter((property) => property.acquisition_status === 'active' || property.acquisition_status === 'on_hold')
    .filter((property) => property.legal_status === 'blocked' || property.risk === 'high')
    .map(
      (property): AttentionProperty => ({
        id: property.id,
        property_reference: property.property_reference,
        acquisition_stage: property.acquisition_stage,
        acquisition_status: property.acquisition_status,
        risk: property.risk,
        legal_status: property.legal_status,
      }),
    )
    .sort((a, b) =>
      a.property_reference < b.property_reference ? -1 : a.property_reference > b.property_reference ? 1 : byId(a, b),
    );

  return {
    today,
    my_tasks: attentionList(openTasks.filter((task) => task.assigned_user_id === DEMO_ACTOR_ID)),
    overdue_tasks: attentionList(openTasks.filter((task) => task.overdue && task.assigned_user_id !== DEMO_ACTOR_ID)),
    properties: attentionList(properties),
  };
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
    // A pre-existing record still on a legacy stage value, awaiting remediation (L-06).
    {
      id: '70000000-0000-4000-8000-000000000004',
      organization_id: demoOrg,
      project_id: projectId,
      property_reference: 'NCP-00077',
      title_number: null,
      tax_declaration: 'TD-077',
      lot_number: 'Lot 77',
      area_hectares: 1.4,
      municipality: 'Calamba',
      province: 'Laguna',
      barangay: 'Makiling',
      acquisition_stage: 'withdrawn',
      acquisition_status: 'active',
      assigned_negotiator_id: null,
      assigned_manager_id: null,
      legal_status: 'unknown',
      documentation_status: 'missing',
      payment_status: 'not_started',
      readiness_percent: 0,
      risk: 'medium',
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
  // No seeded signatures: the demo seed has no agreement_executed document,
  // and adding one would change the Documents seed other tests rely on.
  demoAgreementSignatures = [];
  // No seeded interactions, so the seeded Timeline stays as documented.
  demoInteractions = [];
  // No backfill: seeded properties have no lifecycle history until they change.
  demoLifecycleHistory = [];
  // No seeded remediation cycles: the seed has no legacy-stage properties.
  demoRemediations = [];
  demoRemediationEvents = [];
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
        body: jsonRequestBody(input, 'createOwner'),
      });
    }
    rejectUnknownDemoKeys(input, 'createOwner');
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

  /**
   * One page of properties, most recently changed first (then by id, so pages
   * never repeat or skip a row). `limit` defaults to PROPERTY_PAGE_SIZE.
   */
  async listProperties(
    orgId: string,
    filters?: { projectId?: string; stage?: AcquisitionStage; search?: string; limit?: number; offset?: number },
  ) {
    const limit = filters?.limit ?? PROPERTY_PAGE_SIZE;
    const offset = filters?.offset ?? 0;
    if (operationsApiMode === 'live') {
      // Only filters that are set are sent: an unset one would otherwise travel as the text "undefined" and be refused.
      const query = new URLSearchParams({ organizationId: orgId, limit: String(limit), offset: String(offset) });
      if (filters?.projectId) query.set('projectId', filters.projectId);
      if (filters?.stage) query.set('stage', filters.stage);
      if (filters?.search?.trim()) query.set('search', filters.search.trim());
      return request<Property[]>(`/ops/properties?${query}`);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) {
      throw new Error('Request validation failed');
    }
    const search = filters?.search?.trim().toLowerCase();
    return demoProperties
      .filter((property) => property.organization_id === orgId)
      .filter((property) => !filters?.projectId || property.project_id === filters.projectId)
      .filter((property) => !filters?.stage || property.acquisition_stage === filters.stage)
      .filter(
        (property) =>
          !search ||
          `${property.property_reference} ${property.lot_number ?? ''} ${property.municipality ?? ''} ${property.barangay ?? ''}`
            .toLowerCase()
            .includes(search),
      )
      .sort((a, b) => {
        const left = a.updated_at ?? '';
        const right = b.updated_at ?? '';
        if (left !== right) return left < right ? 1 : -1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .slice(offset, offset + limit)
      .map(decorateProperty);
  },

  async getProperty(id: string) {
    if (operationsApiMode === 'live') return request<Property>(`/ops/properties/${id}`);
    const property = demoProperties.find((entry) => entry.id === id);
    if (!property) throw new Error('Property not found');
    return { ...decorateProperty(property), owners: ownersForProperty(id) };
  },

  async createProperty(input: CreatePropertyInput) {
    if (operationsApiMode === 'live') return request<Property>('/ops/properties', { method: 'POST', body: jsonRequestBody(input, 'createProperty') });
    rejectUnknownDemoKeys(input, 'createProperty');
    // Mirrors enforce_property_creation_rules() (P-6, L-05): identified is the only creation stage.
    if (input.acquisitionStage !== undefined && input.acquisitionStage !== 'identified') {
      throw new Error(`A property can only be created in the identified stage (requested ${input.acquisitionStage})`);
    }
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
      acquisition_stage: 'identified',
      acquisition_status: 'active',
      assigned_negotiator_id: input.assignedNegotiatorId ?? null,
      assigned_manager_id: input.assignedManagerId ?? null,
      legal_status: 'unknown',
      documentation_status: 'not_started',
      payment_status: 'not_started',
      readiness_percent: 0,
      risk: (input.risk ?? 'medium') as 'low' | 'medium' | 'high',
      created_at: now(),
      updated_at: now(),
    });
    demoProperties = [property, ...demoProperties];
    recordDemoLifecycleHistory(null, property);
    return property;
  },

  async updateProperty(id: string, input: Record<string, unknown>) {
    if (operationsApiMode === 'live') {
      return request<Property>(`/ops/properties/${id}`, { method: 'PATCH', body: jsonRequestBody(input, 'updateProperty') });
    }
    rejectUnknownDemoKeys(input, 'updateProperty');
    const index = demoProperties.findIndex((property) => property.id === id);
    if (index < 0) throw new Error('Property not found');
    if (input.acquisitionStage !== undefined) {
      throw new Error('Use a stage transition to change the acquisition stage');
    }
    if (input.acquisitionStatus !== undefined) {
      throw new Error('Use a status transition to change the acquisition status');
    }
    const mapped = Object.fromEntries(
      Object.entries(input).map(([key, value]) => [propertyPatchColumns[key] ?? key, value]),
    );
    const next = { ...demoProperties[index], ...mapped, updated_at: now() } as Property;
    assertAssignmentRoles(next.organization_id, next.assigned_negotiator_id, next.assigned_manager_id);
    const previous = demoProperties[index];
    demoProperties[index] = decorateProperty(next);
    recordDemoLifecycleHistory(previous, demoProperties[index]);
    return demoProperties[index];
  },

  /** Mirrors transition_property_stage(): the only path that changes the stage. */
  async transitionPropertyStage(
    id: string,
    input: { targetStage: AcquisitionStage; expectedStage: AcquisitionStage; reason?: string | null; override?: boolean },
  ) {
    if (operationsApiMode === 'live') {
      return request<Property>(`/ops/properties/${id}/stage-transitions`, { method: 'POST', body: jsonRequestBody(input, 'transitionPropertyStage') });
    }
    rejectUnknownDemoKeys(input, 'transitionPropertyStage');
    const index = demoProperties.findIndex((property) => property.id === id);
    if (index < 0 || !demoCanReadProperty(demoProperties[index])) throw new Error('Property not found');
    const previous = demoProperties[index];
    if (input.expectedStage !== previous.acquisition_stage) {
      demoLifecycleConflict('acquisition_stage', previous.acquisition_stage, input.expectedStage);
    }
    if (input.targetStage === previous.acquisition_stage) return previous;
    const fromPosition = stageOrder.indexOf(previous.acquisition_stage);
    const toPosition = stageOrder.indexOf(input.targetStage);
    if (fromPosition < 0) {
      throw new Error(`The current stage ${previous.acquisition_stage} is a legacy value and can only be resolved through remediation`);
    }
    if (toPosition < 0) throw new Error(`The stage ${input.targetStage} is a legacy value and cannot be selected`);
    const role = demoActorMembership()?.role ?? '';
    const reason = input.reason?.trim() || null;
    if (toPosition > fromPosition) {
      if (!forwardStageRoles.has(role)) throw new Error('You do not have permission to move this property to a later stage');
    } else {
      if (!backwardStageRoles.has(role)) throw new Error('You do not have permission to move this property to an earlier stage');
      if (!reason) throw new Error('A reason is required to move a property to an earlier stage');
    }
    // Mirrors the negotiation exception (L-04): an open or paused negotiation,
    // archived or not, blocks leaving negotiation unless deliberately overridden.
    const rules: string[] = [];
    if (
      previous.acquisition_stage === 'negotiation' &&
      demoNegotiations.some((negotiation) => negotiation.property_id === id && (negotiation.status === 'open' || negotiation.status === 'paused'))
    ) {
      rules.push('negotiation_unresolved_exit');
    }
    if (rules.length > 0) {
      if (!negotiationExceptionRoles.has(role)) {
        throw new Error('You do not have permission to leave negotiation while a negotiation is open or paused');
      }
      if (!reason) throw new Error('A reason is required to leave negotiation while a negotiation is open or paused');
      if (!input.override) {
        throw new Error('Leaving negotiation while a negotiation is open or paused requires an override (negotiation_unresolved_exit)');
      }
    } else if (input.override) {
      throw new Error(`No override applies to moving this property from ${previous.acquisition_stage} to ${input.targetStage}`);
    }
    demoProperties[index] = decorateProperty({ ...previous, acquisition_stage: input.targetStage, updated_at: now() });
    recordDemoLifecycleHistory(previous, demoProperties[index], reason, rules.length > 0 ? rules : null);
    return demoProperties[index];
  },

  /** Mirrors transition_property_status(): the only path that changes the status. */
  /** Mirrors the remediation queue: legacy-stage properties and open cycles, NOT_REVIEWED when no cycle exists. */
  async listRemediationQueue(organizationId: string) {
    if (operationsApiMode === 'live') {
      return request<RemediationQueueItem[]>(`/ops/remediations?${new URLSearchParams({ organizationId })}`);
    }
    return demoProperties
      .filter((property) => property.organization_id === organizationId && demoCanReadProperty(property))
      .map((property): RemediationQueueItem | null => {
        const latest = demoRemediations.filter((entry) => entry.property_id === property.id).sort((a, b) => b.cycle - a.cycle)[0];
        const open = latest && latest.state !== 'RESOLVED';
        if (!legacyStages.includes(property.acquisition_stage) && !open) return null;
        return {
          property_id: property.id,
          property_reference: property.property_reference,
          acquisition_stage: property.acquisition_stage,
          acquisition_status: property.acquisition_status,
          remediation_id: latest?.id ?? null,
          cycle: latest?.cycle ?? null,
          legacy_value: latest?.legacy_value ?? null,
          state: latest?.state ?? 'NOT_REVIEWED',
        };
      })
      .filter((item): item is RemediationQueueItem => item !== null)
      .sort((a, b) => a.property_reference.localeCompare(b.property_reference));
  },

  /** The remediation cycles of a property, oldest first, each with its events. */
  async listPropertyRemediations(propertyId: string) {
    if (operationsApiMode === 'live') return request<PropertyRemediation[]>(`/ops/properties/${propertyId}/remediations`);
    const property = demoProperties.find((entry) => entry.id === propertyId);
    if (!property || !demoCanReadProperty(property)) throw new Error('Property not found');
    return demoRemediations
      .filter((entry) => entry.property_id === propertyId)
      .sort((a, b) => a.cycle - b.cycle)
      .map((entry) => ({ ...entry, events: demoRemediationEvents.filter((event) => event.remediation_id === entry.id) }));
  },

  /** Mirrors start_property_stage_remediation(): NOT_REVIEWED -> UNDER_REVIEW for a legacy-stage property. */
  async startRemediation(propertyId: string) {
    if (operationsApiMode === 'live') {
      return request<PropertyRemediation>(`/ops/properties/${propertyId}/remediation/start`, { method: 'POST', body: '{}' });
    }
    const property = demoAuthorizeRemediation(propertyId);
    if (!legacyStages.includes(property.acquisition_stage)) {
      throw new Error(`The stage ${property.acquisition_stage} is not a legacy value; there is nothing to remediate`);
    }
    if (demoRemediations.some((entry) => entry.property_id === propertyId)) {
      throw new Error('This property already has a remediation cycle; continue or reopen it');
    }
    const remediation: PropertyRemediation = {
      id: crypto.randomUUID(),
      organization_id: property.organization_id,
      property_id: propertyId,
      cycle: 1,
      legacy_value: property.acquisition_stage as PropertyRemediation['legacy_value'],
      stage_at_open: property.acquisition_stage,
      state: 'UNDER_REVIEW',
      opened_by_user_id: DEMO_ACTOR_ID,
      opened_at: new Date().toISOString(),
      resolved_by_user_id: null,
      resolved_at: null,
      resulting_stage: null,
      resolution_reason: null,
      evidence: null,
      evidence_document_id: null,
      evidence_interaction_id: null,
    };
    demoRemediations.push(remediation);
    demoRemediationEvent(remediation, 'review_started', 'NOT_REVIEWED', 'UNDER_REVIEW', null);
    return { ...remediation };
  },

  /** Mirrors escalate_property_stage_remediation(): insufficient evidence (R-8); the stage is kept. */
  async escalateRemediation(propertyId: string, input: { reason?: string | null }) {
    if (operationsApiMode === 'live') {
      return request<PropertyRemediation>(`/ops/properties/${propertyId}/remediation/escalate`, { method: 'POST', body: jsonRequestBody(input, 'remediationStep') });
    }
    rejectUnknownDemoKeys(input, 'remediationStep');
    return demoMoveRemediation(propertyId, 'UNDER_REVIEW', 'REQUIRES_ESCALATION', 'escalated', input.reason, true);
  },

  /** Mirrors return_property_stage_remediation_to_review(): escalation resolution. */
  async returnRemediationToReview(propertyId: string, input: { reason?: string | null }) {
    if (operationsApiMode === 'live') {
      return request<PropertyRemediation>(`/ops/properties/${propertyId}/remediation/return-to-review`, {
        method: 'POST',
        body: jsonRequestBody(input, 'remediationStep'),
      });
    }
    rejectUnknownDemoKeys(input, 'remediationStep');
    return demoMoveRemediation(propertyId, 'REQUIRES_ESCALATION', 'UNDER_REVIEW', 'returned_to_review', input.reason, false);
  },

  /** Mirrors resolve_property_stage_remediation(): reason and evidence (Q-1), references, and integrity (P-12). */
  async resolveRemediation(propertyId: string, input: ResolveRemediationInput) {
    if (operationsApiMode === 'live') {
      return request<PropertyRemediation>(`/ops/properties/${propertyId}/remediation/resolve`, { method: 'POST', body: jsonRequestBody(input, 'resolveRemediation') });
    }
    rejectUnknownDemoKeys(input, 'resolveRemediation');
    const property = demoAuthorizeRemediation(propertyId);
    if (input.expectedStage !== property.acquisition_stage) {
      demoLifecycleConflict('acquisition_stage', property.acquisition_stage, input.expectedStage);
    }
    const remediation = demoLatestRemediation(propertyId, 'UNDER_REVIEW');
    const reason = input.reason?.trim() || null;
    const evidence = input.evidence?.trim() || null;
    if (!reason) throw new Error('A reason is required to resolve a legacy stage');
    if (!evidence) throw new Error('Supporting evidence is required to resolve a legacy stage');
    if (input.evidenceDocumentId && input.evidenceInteractionId) {
      throw new Error('Reference either a document or an interaction as evidence, not both');
    }
    if (input.evidenceDocumentId && !demoDocuments.some((entry) => entry.id === input.evidenceDocumentId && entry.property_id === propertyId)) {
      throw new Error('The evidence document must belong to this property');
    }
    if (
      input.evidenceInteractionId &&
      !demoInteractions.some((entry) => entry.id === input.evidenceInteractionId && entry.property_id === propertyId)
    ) {
      throw new Error('The evidence interaction must belong to this property');
    }
    if (!stageOrder.includes(input.resultingStage)) {
      throw new Error(`The stage ${input.resultingStage} is a legacy value and cannot be the corrected stage`);
    }
    if (
      input.resultingStage !== 'negotiation' &&
      demoNegotiations.some((entry) => entry.property_id === propertyId && (entry.status === 'open' || entry.status === 'paused'))
    ) {
      throw new Error('A property with an open or paused negotiation can only be resolved to negotiation');
    }
    Object.assign(remediation, {
      state: 'RESOLVED',
      resolved_by_user_id: DEMO_ACTOR_ID,
      resolved_at: new Date().toISOString(),
      resulting_stage: input.resultingStage,
      resolution_reason: reason,
      evidence,
      evidence_document_id: input.evidenceDocumentId ?? null,
      evidence_interaction_id: input.evidenceInteractionId ?? null,
    });
    demoRemediationEvent(remediation, 'resolved', 'UNDER_REVIEW', 'RESOLVED', reason);
    if (property.acquisition_stage !== input.resultingStage) {
      const index = demoProperties.findIndex((entry) => entry.id === propertyId);
      demoProperties[index] = decorateProperty({ ...property, acquisition_stage: input.resultingStage, updated_at: now() });
      recordDemoLifecycleHistory(property, demoProperties[index], reason, null, remediation.id);
    }
    return { ...remediation };
  },

  /** Mirrors reopen_property_stage_remediation(): a new cycle; the resolved one is kept (R-7). */
  async reopenRemediation(propertyId: string, input: { reason?: string | null }) {
    if (operationsApiMode === 'live') {
      return request<PropertyRemediation>(`/ops/properties/${propertyId}/remediation/reopen`, { method: 'POST', body: jsonRequestBody(input, 'remediationStep') });
    }
    rejectUnknownDemoKeys(input, 'remediationStep');
    const property = demoAuthorizeRemediation(propertyId);
    const previous = demoLatestRemediation(propertyId, 'RESOLVED');
    // The reason is optional (Q-5); a blank one is none.
    const reason = input.reason?.trim() || null;
    const remediation: PropertyRemediation = {
      ...previous,
      id: crypto.randomUUID(),
      cycle: previous.cycle + 1,
      stage_at_open: property.acquisition_stage,
      state: 'UNDER_REVIEW',
      opened_by_user_id: DEMO_ACTOR_ID,
      opened_at: new Date().toISOString(),
      resolved_by_user_id: null,
      resolved_at: null,
      resulting_stage: null,
      resolution_reason: null,
      evidence: null,
      evidence_document_id: null,
      evidence_interaction_id: null,
    };
    demoRemediations.push(remediation);
    demoRemediationEvent(remediation, 'reopened', 'RESOLVED', 'UNDER_REVIEW', reason);
    return { ...remediation };
  },

  async transitionPropertyStatus(
    id: string,
    input: { targetStatus: AcquisitionStatus; expectedStatus: AcquisitionStatus; reason?: string | null; override?: boolean },
  ) {
    if (operationsApiMode === 'live') {
      return request<Property>(`/ops/properties/${id}/status-transitions`, { method: 'POST', body: jsonRequestBody(input, 'transitionPropertyStatus') });
    }
    rejectUnknownDemoKeys(input, 'transitionPropertyStatus');
    const index = demoProperties.findIndex((property) => property.id === id);
    if (index < 0 || !demoCanReadProperty(demoProperties[index])) throw new Error('Property not found');
    const previous = demoProperties[index];
    const from = previous.acquisition_status;
    if (input.expectedStatus !== from) demoLifecycleConflict('acquisition_status', from, input.expectedStatus);
    const to = input.targetStatus;
    if (to === from) return previous;
    const operation = demoStatusOperation(from, to, previous.acquisition_stage);
    const role = demoActorMembership()?.role ?? '';
    const reason = input.reason?.trim() || null;
    if (!operation.roles.has(role)) throw new Error(`You do not have permission to change this property from ${from} to ${to}`);
    if (operation.reasonRequired && !reason) throw new Error(`A reason is required to change this property from ${from} to ${to}`);
    if (operation.rules.length > 0 && !input.override) {
      throw new Error(`Changing this property from ${from} to ${to} requires an override (${operation.rules.join(', ')})`);
    }
    if (operation.rules.length === 0 && input.override) throw new Error(`No override applies to changing this property from ${from} to ${to}`);
    demoProperties[index] = decorateProperty({ ...previous, acquisition_status: to, updated_at: now() });
    recordDemoLifecycleHistory(previous, demoProperties[index], reason, operation.rules.length > 0 ? operation.rules : null);
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
      return request(`/ops/properties/${propertyId}/owners`, { method: 'POST', body: jsonRequestBody(input, 'linkPropertyOwner') });
    }
    rejectUnknownDemoKeys(input, 'linkPropertyOwner');
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
    if (demoHasActiveOwnerSignature(propertyId, ownerId)) {
      throw new Error(
        'This property owner has active agreement signatures; archive them before unlinking or changing the owner link',
      );
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
      return request<Negotiation>('/ops/negotiations', { method: 'POST', body: jsonRequestBody(input, 'createNegotiation') });
    }
    rejectUnknownDemoKeys(input, 'createNegotiation');
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
      return request<Negotiation>(`/ops/negotiations/${id}`, { method: 'PATCH', body: jsonRequestBody(input, 'updateNegotiation') });
    }
    rejectUnknownDemoKeys(input, 'updateNegotiation');
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
        body: jsonRequestBody(input, 'createNegotiationEvent'),
      });
    }
    rejectUnknownDemoKeys(input, 'createNegotiationEvent');
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
    // Checked in both modes, before any request: the live form below is built from
    // fixed fields, so an unknown key would otherwise be dropped instead of refused.
    rejectUnknownDemoKeys(input, 'uploadDocument', ['file']);
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
      return request<PropertyDocument>(`/ops/documents/${id}`, { method: 'PATCH', body: jsonRequestBody(input, 'updateDocument') });
    }
    rejectUnknownDemoKeys(input, 'updateDocument');
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
    if (
      existing.category === 'agreement_executed' &&
      input.category !== undefined &&
      input.category !== existing.category &&
      demoHasActiveDocumentSignature(id)
    ) {
      throw new Error('This document has active agreement signatures; archive them before changing its category');
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
        body: jsonRequestBody(input, 'createTask'),
      });
    }
    rejectUnknownDemoKeys(input, 'createTask');
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
      return request<PropertyTask>(`/ops/tasks/${id}`, { method: 'PATCH', body: jsonRequestBody(input, 'updateTask') });
    }
    rejectUnknownDemoKeys(input, 'updateTask');
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
        body: jsonRequestBody(input, 'createPayment'),
      });
    }
    rejectUnknownDemoKeys(input, 'createPayment');
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
      return request<PropertyPayment>(`/ops/payments/${id}`, { method: 'PATCH', body: jsonRequestBody(input, 'updatePayment') });
    }
    rejectUnknownDemoKeys(input, 'updatePayment');
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

  async listAgreementSignatures(propertyId: string, filters?: { documentId?: string; includeArchived?: boolean }) {
    if (operationsApiMode === 'live') {
      const query = new URLSearchParams();
      if (filters?.documentId) query.set('documentId', filters.documentId);
      if (filters?.includeArchived) query.set('includeArchived', 'true');
      const qs = query.toString();
      return request<AgreementSignature[]>(`/ops/properties/${propertyId}/agreement-signatures${qs ? `?${qs}` : ''}`);
    }
    return demoAgreementSignatures
      .filter((signature) => signature.property_id === propertyId)
      .filter((signature) => !filters?.documentId || signature.document_id === filters.documentId)
      .filter((signature) => filters?.includeArchived || !signature.archived_at)
      .map(decorateAgreementSignature)
      .sort((a, b) => b.signed_on.localeCompare(a.signed_on) || b.created_at.localeCompare(a.created_at));
  },

  async createAgreementSignature(
    propertyId: string,
    input: { documentId: string; ownerId: string; signedOn: string },
  ) {
    if (operationsApiMode === 'live') {
      return request<AgreementSignature>(`/ops/properties/${propertyId}/agreement-signatures`, {
        method: 'POST',
        body: jsonRequestBody(input, 'createAgreementSignature'),
      });
    }
    rejectUnknownDemoKeys(input, 'createAgreementSignature');
    if (!demoCanWriteAgreementSignature()) throw new Error('You do not have permission for this operation');
    if (!input.signedOn) throw new Error('A signed date is required');
    const property = demoProperties.find((entry) => entry.id === propertyId);
    if (!property) throw new Error('Property not found');
    const document = demoDocuments.find((entry) => entry.id === input.documentId);
    if (!document) throw new Error('Document not found for agreement signature');
    if (document.property_id !== propertyId) {
      throw new Error('Agreement signature document must belong to the same property');
    }
    if (document.category !== 'agreement_executed') {
      throw new Error('Agreement signatures may only reference an agreement_executed document');
    }
    const linked = demoPropertyOwners.some(
      (link) => link.property_id === propertyId && link.owner_id === input.ownerId,
    );
    if (!linked) throw new Error('Signatory must be an existing owner of the property');
    const duplicate = demoAgreementSignatures.some(
      (signature) =>
        signature.document_id === input.documentId && signature.owner_id === input.ownerId && !signature.archived_at,
    );
    if (duplicate) throw new Error('This owner already has an active signature on this document');
    const timestamp = now();
    const signature = decorateAgreementSignature({
      id: crypto.randomUUID(),
      organization_id: property.organization_id,
      property_id: propertyId,
      document_id: input.documentId,
      owner_id: input.ownerId,
      signed_on: input.signedOn,
      recorded_by_user_id: DEMO_ACTOR_ID,
      created_at: timestamp,
      updated_at: timestamp,
      archived_at: null,
    });
    demoAgreementSignatures = [signature, ...demoAgreementSignatures];
    return signature;
  },

  /** Signatures are immutable; archiving is the only permitted change. */
  async archiveAgreementSignature(id: string) {
    if (operationsApiMode === 'live') {
      return request<AgreementSignature>(`/ops/agreement-signatures/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: true }),
      });
    }
    if (!demoCanWriteAgreementSignature()) throw new Error('You do not have permission for this operation');
    const index = demoAgreementSignatures.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error('Agreement signature not found');
    const existing = demoAgreementSignatures[index];
    const next = decorateAgreementSignature({
      ...existing,
      archived_at: existing.archived_at ?? now(),
      updated_at: now(),
    });
    demoAgreementSignatures[index] = next;
    return next;
  },

  async listInteractions(propertyId: string) {
    if (operationsApiMode === 'live') {
      return request<Interaction[]>(`/ops/properties/${propertyId}/interactions`);
    }
    if (!demoProperties.some((entry) => entry.id === propertyId)) throw new Error('Property not found');
    if (!demoCanUseInteractions()) throw new Error('You do not have permission for this operation');
    return demoInteractions
      .filter((interaction) => interaction.property_id === propertyId && !interaction.archived_at)
      .map(decorateInteraction)
      .sort(
        (a, b) =>
          b.occurred_at.localeCompare(a.occurred_at) || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id),
      );
  },

  async createInteraction(
    propertyId: string,
    input: { interactionType: InteractionType; notes: string; occurredAt?: string; ownerId?: string | null },
  ) {
    if (operationsApiMode === 'live') {
      return request<Interaction>(`/ops/properties/${propertyId}/interactions`, {
        method: 'POST',
        body: jsonRequestBody(input, 'createInteraction'),
      });
    }
    rejectUnknownDemoKeys(input, 'createInteraction');
    const property = demoProperties.find((entry) => entry.id === propertyId);
    if (!property) throw new Error('Property not found');
    if (!demoCanUseInteractions()) throw new Error('You do not have permission for this operation');
    const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
    if (!interactionTypes.has(input.interactionType) || !notes || notes.length > 4000) {
      throw new Error('Request validation failed');
    }
    let occurredAt = now();
    if (input.occurredAt !== undefined) {
      const parsed = new Date(input.occurredAt);
      if (Number.isNaN(parsed.getTime()) || !/Z$/.test(input.occurredAt)) throw new Error('Request validation failed');
      // Zero tolerance, mirroring the database guard.
      if (parsed.getTime() > Date.now()) {
        throw new Error('Interactions must record something that already happened; occurred_at is in the future');
      }
      occurredAt = parsed.toISOString();
    }
    const ownerId = input.ownerId ?? null;
    if (ownerId && !demoPropertyOwners.some((link) => link.property_id === propertyId && link.owner_id === ownerId)) {
      throw new Error('Interaction owner must be an existing owner of the property');
    }
    const timestamp = now();
    const interaction: Interaction = {
      id: crypto.randomUUID(),
      organization_id: property.organization_id,
      property_id: propertyId,
      owner_id: ownerId,
      interaction_type: input.interactionType,
      notes,
      occurred_at: occurredAt,
      recorded_by_user_id: DEMO_ACTOR_ID,
      created_at: timestamp,
      updated_at: timestamp,
      archived_at: null,
    };
    demoInteractions = [interaction, ...demoInteractions];
    return decorateInteraction(interaction);
  },

  /** Interactions are immutable; archiving is the only change and cannot be undone. */
  async archiveInteraction(id: string) {
    if (operationsApiMode === 'live') {
      return request<Interaction>(`/ops/interactions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: true }),
      });
    }
    const index = demoInteractions.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error('Interaction not found');
    if (!demoCanUseInteractions()) throw new Error('You do not have permission for this operation');
    const existing = demoInteractions[index];
    const next: Interaction = existing.archived_at ? existing : { ...existing, archived_at: now(), updated_at: now() };
    demoInteractions[index] = next;
    return decorateInteraction(next);
  },

  /** Read-only; the demo builds the same entries the server derives from its records. */
  async getPropertyTimeline(propertyId: string, page: { limit?: number; offset?: number } = {}) {
    const limit = page.limit ?? 50;
    const offset = page.offset ?? 0;
    if (operationsApiMode === 'live') {
      const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      return request<TimelineEntry[]>(`/ops/properties/${propertyId}/timeline?${query.toString()}`);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) {
      throw new Error('Request validation failed');
    }
    const property = demoProperties.find((entry) => entry.id === propertyId);
    if (!property) throw new Error('Property not found');
    const organization = await organizationApi.getOrganization(property.organization_id);
    return demoPropertyTimeline(property, organization.timezone, { limit, offset });
  },

  /** Read-only: what needs the caller's attention across the organization. */
  async getAttention(organizationId: string) {
    if (operationsApiMode === 'live') {
      return request<Attention>(`/ops/attention?${new URLSearchParams({ organizationId })}`);
    }
    const organization = await organizationApi.getOrganization(organizationId);
    return demoAttention(organizationId, organization.timezone);
  },

  /** Read-only portfolio counts. The API sends them as text; both modes return numbers. */
  async dashboard(orgId: string): Promise<DashboardSummary> {
    if (operationsApiMode === 'live') {
      const data = await request<{
        total: string;
        active: string;
        negotiation: string;
        blocked: string;
        ready: string;
        stages: Array<{ acquisition_stage: AcquisitionStage; count: string }>;
      }>(`/ops/dashboard?${new URLSearchParams({ organizationId: orgId })}`);
      return {
        total: Number(data.total),
        active: Number(data.active),
        negotiation: Number(data.negotiation),
        blocked: Number(data.blocked),
        ready: Number(data.ready),
        stages: data.stages.map((entry) => ({ acquisition_stage: entry.acquisition_stage, count: Number(entry.count) })),
      };
    }
    const member = demoActorMembership();
    if (!member || member.organization_id !== orgId) throw new Error('You do not have permission for this operation');
    // Mirrors GET /ops/dashboard over the properties the actor can see. Demo properties are never archived.
    const properties = demoProperties.filter((property) => property.organization_id === orgId && demoCanReadProperty(property));
    const active = properties.filter((property) => property.acquisition_status === 'active');
    return {
      total: properties.length,
      active: active.length,
      negotiation: properties.filter((property) => property.acquisition_stage === 'negotiation').length,
      blocked: properties.filter((property) => property.legal_status === 'blocked' || property.risk === 'high').length,
      ready: active.filter((property) => property.readiness_percent >= 80).length,
      stages: acquisitionStageOrder
        .map((stage) => ({ acquisition_stage: stage, count: active.filter((property) => property.acquisition_stage === stage).length }))
        .filter((entry) => entry.count > 0),
    };
  },
};
