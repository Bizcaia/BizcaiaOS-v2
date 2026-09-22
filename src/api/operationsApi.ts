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

let demoProjects: Project[] = [];
let demoProperties: Property[] = [];
let demoOwners: Owner[] = [];
let demoPropertyOwners: Array<{
  property_id: string;
  owner_id: string;
  ownership_percent: number | null;
  is_primary: boolean;
}> = [];

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
