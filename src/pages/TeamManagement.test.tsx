import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeamManagement from './TeamManagement';
import type { Invitation, Member, Organization } from '../api/organizationApi';

const apiMocks = vi.hoisted(() => ({
  getMe: vi.fn(),
  getOrganization: vi.fn(),
  listMembers: vi.fn(),
  listInvitations: vi.fn(),
  updateMember: vi.fn(),
  removeMember: vi.fn(),
  createInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
  updateOrganization: vi.fn(),
}));

vi.mock('../api/organizationApi', async () => {
  const actual = await vi.importActual<typeof import('../api/organizationApi')>('../api/organizationApi');
  return {
    ...actual,
    organizationApiMode: 'demo',
    organizationApi: apiMocks,
  };
});

const organization: Organization = {
  id: 'org-1',
  name: 'North Corridor Land Holdings',
  slug: 'north-corridor',
  legal_name: 'North Corridor Land Holdings, Inc.',
  timezone: 'Asia/Manila',
  settings: {},
  role: 'system_admin',
  created_at: '2026-01-12T08:00:00.000Z',
  updated_at: '2026-09-20T06:30:00.000Z',
};

const members: Member[] = [
  { user_id: 'user-admin', display_name: 'Alex Villanueva', email: 'alex@example.com', role: 'system_admin', is_active: true, created_at: '2026-01-12T08:00:00.000Z' },
  { user_id: 'user-manager', display_name: 'Maria Santos', email: 'maria@example.com', role: 'land_acquisition_manager', is_active: true, created_at: '2026-02-03T08:00:00.000Z' },
  { user_id: 'user-finance', display_name: 'Paolo Lim', email: 'paolo@example.com', role: 'finance', is_active: false, created_at: '2026-05-14T08:00:00.000Z' },
];

const invitations: Invitation[] = [
  { id: 'invite-1', organization_id: 'org-1', email: 'pending@example.com', role: 'supervisor', status: 'pending', expires_at: '2026-09-25T08:00:00.000Z', created_at: '2026-09-21T08:00:00.000Z' },
];

function arrangeSuccessfulLoad() {
  apiMocks.getMe.mockResolvedValue({ id: 'user-admin', email: 'alex@example.com', displayName: 'Alex Villanueva', organizations: [organization] });
  apiMocks.getOrganization.mockResolvedValue(organization);
  apiMocks.listMembers.mockResolvedValue(members);
  apiMocks.listInvitations.mockResolvedValue(invitations);
}

function renderTeam() {
  const notify = vi.fn();
  const onPreviewOnboarding = vi.fn();
  render(<TeamManagement organizationId="org-1" notify={notify} onPreviewOnboarding={onPreviewOnboarding} />);
  return { notify, onPreviewOnboarding };
}

async function loadedMemberRow(name: string) {
  const nameElement = await screen.findByText(name);
  const row = nameElement.closest('.member-row');
  if (!row) throw new Error(`Member row not found for ${name}`);
  return within(row as HTMLElement);
}

describe('TeamManagement', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    arrangeSuccessfulLoad();
  });

  it('loads organization access in parallel and protects the current user controls', async () => {
    renderTeam();

    expect(document.querySelector('.team-skeleton')).toBeInTheDocument();
    const adminRow = await loadedMemberRow('Alex Villanueva');
    expect(screen.getByText('Active members').nextElementSibling).toHaveTextContent('2');
    expect(screen.getByText('System administrators').nextElementSibling).toHaveTextContent('1');
    expect(screen.getByText('Pending invitations').nextElementSibling).toHaveTextContent('1');
    expect(adminRow.getByLabelText('Role for Alex Villanueva')).toBeDisabled();
    expect(adminRow.getByRole('button', { name: 'Active' })).toBeDisabled();
    expect(adminRow.getByRole('button', { name: 'Remove Alex Villanueva' })).toBeDisabled();
    expect(apiMocks.getOrganization).toHaveBeenCalledWith('org-1');
    expect(apiMocks.listMembers).toHaveBeenCalledWith('org-1');
  });

  it('filters the member directory by name, email, and role label', async () => {
    const user = userEvent.setup();
    renderTeam();
    await screen.findByText('Maria Santos');

    await user.type(screen.getByPlaceholderText('Search name, email, or role'), 'finance');
    expect(screen.getByText('Paolo Lim')).toBeVisible();
    expect(screen.queryByText('Maria Santos')).not.toBeInTheDocument();
    expect(screen.queryByText('Alex Villanueva')).not.toBeInTheDocument();
  });

  it('updates a non-current member role and active state through the API', async () => {
    const user = userEvent.setup();
    const { notify } = renderTeam();
    const mariaRow = await loadedMemberRow('Maria Santos');
    apiMocks.updateMember
      .mockResolvedValueOnce({ organization_id: 'org-1', user_id: 'user-manager', role: 'supervisor', is_active: true })
      .mockResolvedValueOnce({ organization_id: 'org-1', user_id: 'user-manager', role: 'supervisor', is_active: false });

    await user.selectOptions(mariaRow.getByLabelText('Role for Maria Santos'), 'supervisor');
    expect(apiMocks.updateMember).toHaveBeenNthCalledWith(1, 'org-1', 'user-manager', { role: 'supervisor' });
    expect(await mariaRow.findByDisplayValue('Supervisor')).toBeVisible();

    await user.click(mariaRow.getByRole('button', { name: 'Active' }));
    expect(apiMocks.updateMember).toHaveBeenNthCalledWith(2, 'org-1', 'user-manager', { isActive: false });
    expect(await mariaRow.findByRole('button', { name: 'Inactive' })).toBeVisible();
    expect(notify).toHaveBeenCalledWith('Member access updated.');
  });

  it('creates an invitation, moves to invitation history, and exposes the one-time token', async () => {
    const user = userEvent.setup();
    const created: Invitation & { invitationToken: string; deliveryRequired: boolean } = {
      id: 'invite-2', organization_id: 'org-1', email: 'ana@example.com', role: 'supervisor', status: 'pending', expires_at: '2026-09-26T08:00:00.000Z', created_at: '2026-09-22T08:00:00.000Z', invitationToken: 'secure-one-time-token-1234567890', deliveryRequired: true,
    };
    apiMocks.createInvitation.mockResolvedValue(created);
    const { notify } = renderTeam();
    await screen.findByText('Maria Santos');

    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    await user.type(screen.getByLabelText('Work email'), 'ana@example.com');
    await user.selectOptions(screen.getByLabelText('Organization role'), 'supervisor');
    await user.click(screen.getByRole('button', { name: 'Create invitation' }));

    expect(apiMocks.createInvitation).toHaveBeenCalledWith('org-1', {
      email: 'ana@example.com', role: 'supervisor', expiresInHours: 72,
    });
    expect(await screen.findByText('ana@example.com')).toBeVisible();
    expect(screen.getByText('secure-one-time-token-1234567890')).toBeVisible();
    expect(screen.getByText('One-time invitation token')).toBeVisible();
    expect(notify).toHaveBeenCalledWith('Invitation created.');
  });

  it('copies the one-time token and revokes a pending invitation', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    apiMocks.createInvitation.mockResolvedValue({
      id: 'invite-2', organization_id: 'org-1', email: 'copy@example.com', role: 'viewer', status: 'pending', expires_at: '2026-09-26T08:00:00.000Z', created_at: '2026-09-22T08:00:00.000Z', invitationToken: 'copy-token-12345678901234567890', deliveryRequired: true,
    });
    apiMocks.revokeInvitation.mockResolvedValue({ ...invitations[0], status: 'revoked', revoked_at: '2026-09-22T09:00:00.000Z' });
    const { notify } = renderTeam();
    await screen.findByText('Maria Santos');

    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    await user.type(screen.getByLabelText('Work email'), 'copy@example.com');
    await user.selectOptions(screen.getByLabelText('Organization role'), 'viewer');
    await user.click(screen.getByRole('button', { name: 'Create invitation' }));
    await user.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('copy-token-12345678901234567890');

    const pendingRow = screen.getByText('pending@example.com').closest('.invitation-row');
    if (!pendingRow) throw new Error('Pending invitation row not found');
    await user.click(within(pendingRow as HTMLElement).getByRole('button', { name: 'Revoke' }));
    expect(apiMocks.revokeInvitation).toHaveBeenCalledWith('org-1', 'invite-1');
    expect(await within(pendingRow as HTMLElement).findByText('revoked')).toBeVisible();
    expect(notify).toHaveBeenCalledWith('Invitation revoked.');
  });

  it('requires confirmation before removing a member and updates the directory after success', async () => {
    const user = userEvent.setup();
    apiMocks.removeMember.mockResolvedValue(undefined);
    const { notify } = renderTeam();
    const mariaRow = await loadedMemberRow('Maria Santos');

    await user.click(mariaRow.getByRole('button', { name: 'Remove Maria Santos' }));
    expect(screen.getByRole('heading', { name: 'Remove Maria Santos?' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Keep member' }));
    expect(screen.queryByRole('heading', { name: 'Remove Maria Santos?' })).not.toBeInTheDocument();

    await user.click(mariaRow.getByRole('button', { name: 'Remove Maria Santos' }));
    await user.click(screen.getByRole('button', { name: 'Remove access' }));
    expect(apiMocks.removeMember).toHaveBeenCalledWith('org-1', 'user-manager');
    await waitFor(() => expect(screen.queryByText('Maria Santos')).not.toBeInTheDocument());
    expect(notify).toHaveBeenCalledWith('Member removed from the organization.');
  });

  it('loads and saves the organization profile through the API', async () => {
    const user = userEvent.setup();
    const updatedOrganization = { ...organization, name: 'North Corridor Development', legal_name: 'North Corridor Development Corp.', timezone: 'Asia/Singapore' };
    apiMocks.updateOrganization.mockResolvedValue(updatedOrganization);
    const { notify } = renderTeam();
    await screen.findByText('Maria Santos');

    await user.click(screen.getByRole('button', { name: 'Organization profile' }));
    const displayName = screen.getByLabelText('Display name');
    const legalName = screen.getByLabelText('Legal name');
    await user.clear(displayName);
    await user.type(displayName, updatedOrganization.name);
    await user.clear(legalName);
    await user.type(legalName, updatedOrganization.legal_name);
    await user.selectOptions(screen.getByLabelText('Timezone'), 'Asia/Singapore');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(apiMocks.updateOrganization).toHaveBeenCalledWith('org-1', {
      name: updatedOrganization.name,
      legalName: updatedOrganization.legal_name,
      timezone: 'Asia/Singapore',
    });
    expect(await screen.findByText(updatedOrganization.name)).toBeVisible();
    expect(notify).toHaveBeenCalledWith('Organization profile saved.');
  });

  it('shows a recoverable load error and retries the complete data request', async () => {
    const user = userEvent.setup();
    apiMocks.getOrganization.mockRejectedValueOnce(new Error('API unavailable'));
    renderTeam();

    expect(await screen.findByText('Organization access could not be loaded')).toBeVisible();
    expect(screen.getByText('API unavailable')).toBeVisible();
    apiMocks.getOrganization.mockResolvedValue(organization);
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Maria Santos')).toBeVisible();
    expect(apiMocks.getOrganization).toHaveBeenCalledTimes(2);
  });
});
