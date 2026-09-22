import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiBase = 'https://api.example.com/api/v1';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function loadLiveClient() {
  vi.resetModules();
  vi.stubEnv('VITE_API_BASE_URL', `${apiBase}/`);
  window.__BIZCAIAOS_AUTH__ = {
    getAccessToken: vi.fn().mockResolvedValue('verified-jwt-token'),
  };
  return import('./organizationApi');
}

describe('organizationApi live request integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('authenticates and unwraps the current-user response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: { id: 'user-1', email: 'alex@example.com', displayName: 'Alex', organizations: [] },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { organizationApi, organizationApiMode } = await loadLiveClient();

    await expect(organizationApi.getMe()).resolves.toEqual({
      id: 'user-1', email: 'alex@example.com', displayName: 'Alex', organizations: [],
    });
    expect(organizationApiMode).toBe('live');
    expect(fetchMock).toHaveBeenCalledWith(`${apiBase}/me`, expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer verified-jwt-token',
        'Content-Type': 'application/json',
      }),
    }));
  });

  it('posts the exact organization onboarding payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: { organizationId: 'org-1', userId: 'user-1', role: 'system_admin' },
    }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const { organizationApi } = await loadLiveClient();
    const input = { name: 'North Corridor', slug: 'north-corridor', timezone: 'Asia/Manila' };

    await expect(organizationApi.onboardOrganization(input)).resolves.toEqual({
      organizationId: 'org-1', userId: 'user-1', role: 'system_admin',
    });
    expect(fetchMock).toHaveBeenCalledWith(`${apiBase}/organizations/onboard`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(input),
    }));
  });

  it('preserves the one-time invitation token from the response envelope', async () => {
    const invitation = {
      id: 'invite-1', organization_id: 'org-1', email: 'invitee@example.com', role: 'viewer', status: 'pending', expires_at: '2026-09-25T08:00:00.000Z', created_at: '2026-09-22T08:00:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: invitation,
      invitationToken: 'one-time-token-12345678901234567890',
      deliveryRequired: true,
    }, 201)));
    const { organizationApi } = await loadLiveClient();

    await expect(organizationApi.createInvitation('org-1', {
      email: 'invitee@example.com', role: 'viewer', expiresInHours: 72,
    })).resolves.toEqual({
      ...invitation,
      invitationToken: 'one-time-token-12345678901234567890',
      deliveryRequired: true,
    });
  });

  it('supports a no-content member deletion response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { organizationApi } = await loadLiveClient();

    await expect(organizationApi.removeMember('org-1', 'user-2')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `${apiBase}/organizations/org-1/members/user-2`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('maps API error envelopes to OrganizationApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: { code: '42501', message: 'Administrator role required' },
    }, 403)));
    const { organizationApi, OrganizationApiError } = await loadLiveClient();

    const request = organizationApi.updateMember('org-1', 'user-2', { role: 'finance' });
    await expect(request).rejects.toBeInstanceOf(OrganizationApiError);
    await expect(request).rejects.toMatchObject({
      message: 'Administrator role required', status: 403, code: '42501',
    });
  });

  it('fails before fetch when the authentication bridge is missing', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { organizationApi, OrganizationApiError } = await loadLiveClient();
    delete window.__BIZCAIAOS_AUTH__;

    await expect(organizationApi.getMe()).rejects.toMatchObject({
      name: OrganizationApiError.name,
      status: 401,
      code: 'auth_not_connected',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
