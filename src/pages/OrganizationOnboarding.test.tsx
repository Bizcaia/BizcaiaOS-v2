import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OrganizationOnboarding from './OrganizationOnboarding';

const apiMocks = vi.hoisted(() => ({
  onboardOrganization: vi.fn(),
}));

vi.mock('../api/organizationApi', () => ({
  organizationApiMode: 'demo',
  organizationApi: apiMocks,
}));

describe('OrganizationOnboarding', () => {
  beforeEach(() => {
    apiMocks.onboardOrganization.mockReset();
  });

  it('renders the security proposition and starts with submission disabled', () => {
    render(<OrganizationOnboarding onComplete={vi.fn()} />);

    expect(screen.getByRole('heading', { name: /build your acquisition/i })).toBeVisible();
    expect(screen.getByText('Tenant isolated')).toBeVisible();
    expect(screen.getByText('Role controlled')).toBeVisible();
    expect(screen.getByText('Property centered')).toBeVisible();
    expect(screen.getByText(/preview mode/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /create secure workspace/i })).toBeDisabled();
  });

  it('derives a safe slug, submits the selected timezone, and completes onboarding', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    apiMocks.onboardOrganization.mockResolvedValue({
      organizationId: 'org-101',
      userId: 'user-101',
      role: 'system_admin',
    });
    render(<OrganizationOnboarding onComplete={onComplete} />);

    await user.type(screen.getByLabelText('Organization name'), 'North & South Holdings');
    expect(screen.getByLabelText('Workspace URL')).toHaveValue('north-south-holdings');
    await user.selectOptions(screen.getByLabelText('Primary timezone'), 'Asia/Singapore');
    await user.click(screen.getByRole('button', { name: /create secure workspace/i }));

    expect(apiMocks.onboardOrganization).toHaveBeenCalledWith({
      name: 'North & South Holdings',
      slug: 'north-south-holdings',
      timezone: 'Asia/Singapore',
    });
    expect(onComplete).toHaveBeenCalledWith('org-101');
  });

  it('allows a custom slug while sanitizing unsupported characters', async () => {
    const user = userEvent.setup();
    apiMocks.onboardOrganization.mockResolvedValue({ organizationId: 'org-102' });
    render(<OrganizationOnboarding onComplete={vi.fn()} />);

    await user.type(screen.getByLabelText('Organization name'), 'Original Name');
    fireEvent.change(screen.getByLabelText('Workspace URL'), {
      target: { value: 'Custom Workspace_URL' },
    });

    expect(screen.getByLabelText('Workspace URL')).toHaveValue('custom-workspace-url');
    await user.click(screen.getByRole('button', { name: /create secure workspace/i }));
    expect(apiMocks.onboardOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'custom-workspace-url' }),
    );
  });

  it('shows progress and a recoverable API error without completing', async () => {
    const user = userEvent.setup();
    let rejectRequest!: (reason: Error) => void;
    apiMocks.onboardOrganization.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectRequest = reject;
    }));
    const onComplete = vi.fn();
    render(<OrganizationOnboarding onComplete={onComplete} />);

    await user.type(screen.getByLabelText('Organization name'), 'Conflict Holdings');
    await user.click(screen.getByRole('button', { name: /create secure workspace/i }));
    expect(screen.getByRole('button', { name: /creating workspace/i })).toBeDisabled();

    rejectRequest(new Error('Organization slug already exists'));
    expect(await screen.findByText('Organization slug already exists')).toBeVisible();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('invokes the optional cancel action', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<OrganizationOnboarding onComplete={vi.fn()} onCancel={onCancel} />);

    await user.click(screen.getByRole('button', { name: 'Close onboarding' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
