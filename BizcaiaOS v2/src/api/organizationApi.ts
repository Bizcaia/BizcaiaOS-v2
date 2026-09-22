export type OrganizationRole =
  | 'system_admin'
  | 'land_acquisition_manager'
  | 'supervisor'
  | 'negotiator'
  | 'legal_documentation'
  | 'finance'
  | 'viewer';

export const roleLabels: Record<OrganizationRole, string> = {
  system_admin: 'System Administrator',
  land_acquisition_manager: 'Land Acquisition Manager',
  supervisor: 'Supervisor',
  negotiator: 'Negotiator',
  legal_documentation: 'Legal / Documentation',
  finance: 'Finance',
  viewer: 'Viewer',
};

export type Organization = {
  id: string;
  name: string;
  slug: string;
  legal_name: string | null;
  timezone: string;
  settings: Record<string, unknown>;
  role?: OrganizationRole;
  created_at: string;
  updated_at: string;
};

export type Member = {
  user_id: string;
  display_name: string;
  email: string;
  role: OrganizationRole;
  is_active: boolean;
  created_at: string;
};

export type Invitation = {
  id: string;
  organization_id: string;
  email: string;
  role: OrganizationRole;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expires_at: string;
  accepted_at?: string | null;
  revoked_at?: string | null;
  created_at: string;
};

type AuthBridge = { getAccessToken: () => Promise<string> };

declare global {
  interface Window {
    __BIZCAIAOS_AUTH__?: AuthBridge;
  }
}

const apiBase = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '';
export const organizationApiMode = apiBase ? 'live' : 'demo';

export class OrganizationApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'OrganizationApiError';
  }
}

type ApiEnvelope<T> = {
  data?: T;
  error?: { code?: string; message?: string };
  invitationToken?: string;
  deliveryRequired?: boolean;
};

async function requestEnvelope<T>(path: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  if (!apiBase) throw new OrganizationApiError('Live API mode is not configured', 503, 'demo_mode');
  const auth = window.__BIZCAIAOS_AUTH__;
  if (!auth) {
    throw new OrganizationApiError(
      'Authentication provider is not connected to window.__BIZCAIAOS_AUTH__',
      401,
      'auth_not_connected',
    );
  }

  const token = await auth.getAccessToken();
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  });

  if (response.status === 204) return {};
  const payload = (await response.json()) as ApiEnvelope<T>;

  if (!response.ok) {
    throw new OrganizationApiError(
      payload.error?.message ?? 'Organization request failed',
      response.status,
      payload.error?.code,
    );
  }

  return payload;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const payload = await requestEnvelope<T>(path, init);
  return (payload.data ?? payload) as T;
}

const demoOrganization: Organization = {
  id: '2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f',
  name: 'North Corridor Land Holdings',
  slug: 'north-corridor',
  legal_name: 'North Corridor Land Holdings, Inc.',
  timezone: 'Asia/Manila',
  settings: { portfolioCode: 'NCP-2026' },
  role: 'system_admin',
  created_at: '2026-01-12T08:00:00.000Z',
  updated_at: '2026-09-20T06:30:00.000Z',
};

let demoMembers: Member[] = [
  { user_id: '758d5718-53d9-4ea2-b9d5-02828fcc0e2c', display_name: 'Alex Villanueva', email: 'alex@northcorridor.ph', role: 'system_admin', is_active: true, created_at: '2026-01-12T08:00:00.000Z' },
  { user_id: '8714eff3-6be9-4cc8-bf5f-c4dbb62d90cb', display_name: 'Maria Santos', email: 'maria@northcorridor.ph', role: 'land_acquisition_manager', is_active: true, created_at: '2026-02-03T08:00:00.000Z' },
  { user_id: '5517eab7-57db-412f-b381-33844d31a64f', display_name: 'Luis Reyes', email: 'luis@northcorridor.ph', role: 'negotiator', is_active: true, created_at: '2026-03-18T08:00:00.000Z' },
  { user_id: '419fa143-1d97-40cd-b47b-812cb364acfd', display_name: 'Celina Cruz', email: 'celina@northcorridor.ph', role: 'legal_documentation', is_active: true, created_at: '2026-04-02T08:00:00.000Z' },
  { user_id: '884e9d32-aad1-42e5-8603-4f9846cff79d', display_name: 'Paolo Lim', email: 'paolo@northcorridor.ph', role: 'finance', is_active: false, created_at: '2026-05-14T08:00:00.000Z' },
];

let demoInvitations: Invitation[] = [
  { id: '97243bed-f3e3-4abe-83bd-27a8b40acb71', organization_id: demoOrganization.id, email: 'r.fernandez@northcorridor.ph', role: 'supervisor', status: 'pending', expires_at: '2026-09-25T08:00:00.000Z', created_at: '2026-09-21T08:00:00.000Z' },
];

const pause = () => new Promise((resolve) => window.setTimeout(resolve, 260));

export const organizationApi = {
  async getMe() {
    if (organizationApiMode === 'live') {
      return request<{ id: string; email: string; displayName: string; organizations: Organization[] }>('/me');
    }
    await pause();
    return { id: demoMembers[0].user_id, email: demoMembers[0].email, displayName: demoMembers[0].display_name, organizations: [demoOrganization] };
  },

  async onboardOrganization(input: { name: string; slug: string; timezone: string }) {
    if (organizationApiMode === 'live') {
      return request<{ organizationId: string; userId: string; role: OrganizationRole }>('/organizations/onboard', {
        method: 'POST', body: JSON.stringify(input),
      });
    }
    await pause();
    return { organizationId: demoOrganization.id, userId: demoMembers[0].user_id, role: 'system_admin' as const };
  },

  async getOrganization(organizationId: string) {
    if (organizationApiMode === 'live') return request<Organization>(`/organizations/${organizationId}`);
    await pause();
    return { ...demoOrganization };
  },

  async updateOrganization(organizationId: string, input: { name?: string; legalName?: string | null; timezone?: string }) {
    if (organizationApiMode === 'live') {
      return request<Organization>(`/organizations/${organizationId}`, { method: 'PATCH', body: JSON.stringify(input) });
    }
    await pause();
    if (input.name !== undefined) demoOrganization.name = input.name;
    if (input.legalName !== undefined) demoOrganization.legal_name = input.legalName;
    if (input.timezone !== undefined) demoOrganization.timezone = input.timezone;
    demoOrganization.updated_at = new Date().toISOString();
    return { ...demoOrganization };
  },

  async listMembers(organizationId: string) {
    if (organizationApiMode === 'live') return request<Member[]>(`/organizations/${organizationId}/members`);
    await pause();
    return demoMembers.map((member) => ({ ...member }));
  },

  async updateMember(organizationId: string, userId: string, input: { role?: OrganizationRole; isActive?: boolean }) {
    if (organizationApiMode === 'live') {
      return request<{ organization_id: string; user_id: string; role: OrganizationRole; is_active: boolean }>(
        `/organizations/${organizationId}/members/${userId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
    }
    await pause();
    demoMembers = demoMembers.map((member) => member.user_id === userId ? { ...member, role: input.role ?? member.role, is_active: input.isActive ?? member.is_active } : member);
    const member = demoMembers.find((entry) => entry.user_id === userId)!;
    return { organization_id: organizationId, user_id: member.user_id, role: member.role, is_active: member.is_active };
  },

  async removeMember(organizationId: string, userId: string) {
    if (organizationApiMode === 'live') {
      await request<void>(`/organizations/${organizationId}/members/${userId}`, { method: 'DELETE' });
      return;
    }
    await pause();
    demoMembers = demoMembers.filter((member) => member.user_id !== userId);
  },

  async listInvitations(organizationId: string) {
    if (organizationApiMode === 'live') return request<Invitation[]>(`/organizations/${organizationId}/invitations`);
    await pause();
    return demoInvitations.map((invitation) => ({ ...invitation }));
  },

  async createInvitation(organizationId: string, input: { email: string; role: Exclude<OrganizationRole, 'system_admin'>; expiresInHours?: number }) {
    if (organizationApiMode === 'live') {
      const payload = await requestEnvelope<Invitation>(`/organizations/${organizationId}/invitations`, {
        method: 'POST', body: JSON.stringify(input),
      });
      return {
        ...payload.data!,
        invitationToken: payload.invitationToken,
        deliveryRequired: payload.deliveryRequired,
      };
    }
    await pause();
    const invitation: Invitation = { id: crypto.randomUUID(), organization_id: organizationId, email: input.email.toLowerCase(), role: input.role, status: 'pending', expires_at: new Date(Date.now() + (input.expiresInHours ?? 72) * 3_600_000).toISOString(), created_at: new Date().toISOString() };
    demoInvitations = [invitation, ...demoInvitations];
    return { ...invitation, invitationToken: `demo_${crypto.randomUUID().replaceAll('-', '')}`, deliveryRequired: true };
  },

  async revokeInvitation(organizationId: string, invitationId: string) {
    if (organizationApiMode === 'live') {
      return request<Invitation>(`/organizations/${organizationId}/invitations/${invitationId}/revoke`, { method: 'POST' });
    }
    await pause();
    demoInvitations = demoInvitations.map((invitation) => invitation.id === invitationId ? { ...invitation, status: 'revoked', revoked_at: new Date().toISOString() } : invitation);
    return demoInvitations.find((invitation) => invitation.id === invitationId)!;
  },
};
