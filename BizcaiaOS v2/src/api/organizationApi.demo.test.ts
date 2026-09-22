import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('organizationApi preview adapter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_BASE_URL', '');
    const immediateTimeout = ((handler: TimerHandler) => {
      if (typeof handler === 'function') handler();
      return 1;
    }) as typeof window.setTimeout;
    vi.spyOn(window, 'setTimeout').mockImplementation(immediateTimeout);
  });

  it('supports the complete organization, member, and invitation lifecycle without persistence', async () => {
    const { organizationApi, organizationApiMode } = await import('./organizationApi');
    expect(organizationApiMode).toBe('demo');

    const me = await organizationApi.getMe();
    expect(me.organizations).toHaveLength(1);
    const organizationId = me.organizations[0].id;

    await expect(organizationApi.onboardOrganization({
      name: 'Preview Organization', slug: 'preview-organization', timezone: 'UTC',
    })).resolves.toMatchObject({ organizationId, role: 'system_admin' });

    const organization = await organizationApi.getOrganization(organizationId);
    const updatedOrganization = await organizationApi.updateOrganization(organizationId, {
      name: 'Updated Preview Organization', legalName: null, timezone: 'UTC',
    });
    expect(updatedOrganization).toMatchObject({
      id: organization.id, name: 'Updated Preview Organization', legal_name: null, timezone: 'UTC',
    });

    const initialMembers = await organizationApi.listMembers(organizationId);
    const manager = initialMembers.find((member) => member.role === 'land_acquisition_manager')!;
    await expect(organizationApi.updateMember(organizationId, manager.user_id, {
      role: 'supervisor', isActive: false,
    })).resolves.toMatchObject({ role: 'supervisor', is_active: false });

    const finance = initialMembers.find((member) => member.role === 'finance')!;
    await organizationApi.removeMember(organizationId, finance.user_id);
    await expect(organizationApi.listMembers(organizationId)).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ user_id: finance.user_id })]),
    );

    const createdInvitation = await organizationApi.createInvitation(organizationId, {
      email: 'preview.invitee@example.com', role: 'viewer', expiresInHours: 48,
    });
    expect(createdInvitation).toMatchObject({
      email: 'preview.invitee@example.com', role: 'viewer', status: 'pending', deliveryRequired: true,
    });
    expect(createdInvitation.invitationToken).toMatch(/^demo_/);

    const listedInvitations = await organizationApi.listInvitations(organizationId);
    expect(listedInvitations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: createdInvitation.id })]),
    );

    await expect(
      organizationApi.revokeInvitation(organizationId, createdInvitation.id),
    ).resolves.toMatchObject({ status: 'revoked' });
  });
});
