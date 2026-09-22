import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_ORGANIZATION_ID, resetOperationsDemoState } from '../api/operationsApi';
import type { Member, Organization } from '../api/organizationApi';

const organization: Organization = {
  id: DEMO_ORGANIZATION_ID,
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
  { user_id: '758d5718-53d9-4ea2-b9d5-02828fcc0e2c', display_name: 'Alex Villanueva', email: 'alex@example.com', role: 'system_admin', is_active: true, created_at: '2026-01-12T08:00:00.000Z' },
  { user_id: '8714eff3-6be9-4cc8-bf5f-c4dbb62d90cb', display_name: 'Maria Santos', email: 'maria@example.com', role: 'land_acquisition_manager', is_active: true, created_at: '2026-02-03T08:00:00.000Z' },
  { user_id: '5517eab7-57db-412f-b381-33844d31a64f', display_name: 'Luis Reyes', email: 'luis@example.com', role: 'negotiator', is_active: true, created_at: '2026-03-18T08:00:00.000Z' },
  { user_id: '419fa143-1d97-40cd-b47b-812cb364acfd', display_name: 'Celina Cruz', email: 'celina@example.com', role: 'legal_documentation', is_active: true, created_at: '2026-04-02T08:00:00.000Z' },
  { user_id: '97243bed-f3e3-4abe-83bd-27a8b40acb71', display_name: 'Ramon Fernandez', email: 'ramon@example.com', role: 'supervisor', is_active: true, created_at: '2026-04-03T08:00:00.000Z' },
  { user_id: '884e9d32-aad1-42e5-8603-4f9846cff79d', display_name: 'Paolo Lim', email: 'paolo@example.com', role: 'finance', is_active: false, created_at: '2026-05-14T08:00:00.000Z' },
];

const apiMocks = vi.hoisted(() => ({
  getMe: vi.fn(),
  listMembers: vi.fn(),
}));

vi.mock('../api/organizationApi', async () => {
  const actual = await vi.importActual<typeof import('../api/organizationApi')>('../api/organizationApi');
  return {
    ...actual,
    organizationApiMode: 'demo',
    organizationApi: {
      ...actual.organizationApi,
      getMe: apiMocks.getMe,
      listMembers: apiMocks.listMembers,
    },
  };
});

import OpsApp from './OpsApp';

describe('OpsApp property workflow', () => {
  beforeEach(() => {
    resetOperationsDemoState();
    apiMocks.getMe.mockResolvedValue({
      id: members[0].user_id,
      email: members[0].email,
      displayName: members[0].display_name,
      organizations: [organization],
    });
    apiMocks.listMembers.mockResolvedValue(members);
  });

  it('creates a project in demo mode and a property with assignments and owners', async () => {
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Portfolio overview' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Projects' }));
    await user.click(await screen.findByRole('button', { name: /add project/i }));
    await user.type(screen.getByLabelText('Project code'), 'NCP-08');
    await user.type(screen.getByLabelText('Project name'), 'East Expansion');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText(/NCP-08 — East Expansion/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /add property/i }));
    await user.type(screen.getByLabelText('Property reference'), 'NCP-08001');
    await user.selectOptions(screen.getByLabelText('Project'), 'NCP-08 — East Expansion');
    await user.type(screen.getByLabelText('Municipality'), 'Calamba');
    await user.type(screen.getByLabelText('Province'), 'Laguna');
    await user.type(screen.getByLabelText('Barangay'), 'Pansol');
    await user.selectOptions(screen.getByLabelText('Assigned negotiator'), 'Luis Reyes');
    await user.selectOptions(screen.getByLabelText('Assigned manager'), 'Maria Santos');
    await user.click(screen.getByRole('button', { name: 'Create property' }));

    await user.click(await screen.findByRole('button', { name: /NCP-08001/ }));
    expect((await screen.findAllByText('Luis Reyes')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Maria Santos').length).toBeGreaterThan(0);

    await user.type(screen.getByLabelText('Display name'), 'River Estate');
    await user.selectOptions(screen.getByLabelText('Owner type'), 'estate');
    await user.type(screen.getByLabelText('Ownership %'), '100');
    await user.click(screen.getByLabelText('Primary owner'));
    await user.click(screen.getByRole('button', { name: 'Create and link owner' }));

    await waitFor(() => {
      expect(screen.getByText('River Estate')).toBeVisible();
      expect(screen.getByText(/Estate · Primary · 100%/)).toBeVisible();
    });
  });

  it('shows seeded owners and assignments on property detail', async () => {
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));
    expect((await screen.findAllByText('Rosa Mendoza')).length).toBeGreaterThan(0);
    expect(screen.getByText(/Individual · Primary · 100%/)).toBeVisible();
    expect(screen.getAllByText('Luis Reyes').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Maria Santos').length).toBeGreaterThan(0);
  });

  it('limits assignment selectors to the SQL assignment roles', async () => {
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /add property/i }));

    const negotiatorOptions = [...screen.getByLabelText('Assigned negotiator').querySelectorAll('option')].map(
      (option) => option.textContent,
    );
    expect(negotiatorOptions).toEqual(['Unassigned', 'Luis Reyes']);

    const managerOptions = [...screen.getByLabelText('Assigned manager').querySelectorAll('option')].map(
      (option) => option.textContent,
    );
    expect(managerOptions).toEqual(['Unassigned', 'Alex Villanueva', 'Maria Santos', 'Ramon Fernandez']);
  });

  it('shows negotiation state and history on a negotiation-stage property', async () => {
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));

    expect(await screen.findByRole('heading', { name: 'Negotiation' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Negotiation history' })).toBeVisible();
    expect(screen.getByText(/Opening offer recorded/)).toBeVisible();
    expect(screen.getAllByText(/12,?500,?000/).length).toBeGreaterThan(0);

    await user.selectOptions(screen.getByLabelText('Event type'), 'Counteroffer');
    await user.type(screen.getByLabelText('Amount'), '13100000');
    await user.type(screen.getByLabelText('Note'), 'Owner counter');
    await user.click(screen.getByRole('button', { name: 'Record event' }));

    await waitFor(() => {
      expect(screen.getAllByText(/13,?100,?000/).length).toBeGreaterThan(0);
      expect(screen.getByText(/Owner counter/)).toBeVisible();
    });
  });

  it('shows the seeded document and lets an allowed role upload a new one', async () => {
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));

    expect(await screen.findByRole('heading', { name: 'Documents' })).toBeVisible();
    expect(screen.getByText('Transfer Certificate of Title')).toBeVisible();
    expect(screen.getByText(/Title deed · Submitted/)).toBeVisible();

    const file = new File(['a small pdf'], 'deed.pdf', { type: 'application/pdf' });
    await user.type(screen.getByLabelText('Document title'), 'Second Title Deed');
    await user.selectOptions(screen.getByLabelText('Document category'), 'Title deed');
    await user.upload(screen.getByLabelText('File'), file);
    await user.click(screen.getByRole('button', { name: 'Upload document' }));

    await waitFor(() => {
      expect(screen.getByText('Second Title Deed')).toBeVisible();
    });
  });

  it('archives a document and hides it from the default list', async () => {
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));

    await screen.findByText('Transfer Certificate of Title');
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() => {
      expect(screen.queryByText('Transfer Certificate of Title')).not.toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Include archived'));
    expect(await screen.findByText('Transfer Certificate of Title')).toBeVisible();
    expect(screen.getByText(/· Archived/)).toBeVisible();
  });

  it('hides the document upload form from a role without document-write access', async () => {
    apiMocks.getMe.mockResolvedValue({
      id: members[2].user_id,
      email: members[2].email,
      displayName: members[2].display_name,
      organizations: [{ ...organization, role: 'negotiator' }],
    });
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));

    expect(await screen.findByRole('heading', { name: 'Documents' })).toBeVisible();
    expect(screen.getByText('Transfer Certificate of Title')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Upload document' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Document title')).not.toBeInTheDocument();
  });

  it('shows seeded tasks and lets an elevated role create a task with an assignee picker', async () => {
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));

    expect(await screen.findByRole('heading', { name: 'Tasks' })).toBeVisible();
    expect(screen.getByText('Follow up on survey plan')).toBeVisible();
    expect(screen.getByText(/High · Open/)).toBeVisible();

    await user.type(screen.getByLabelText('Task title'), 'Confirm HOA clearance');
    await user.selectOptions(screen.getByLabelText('Assign task to'), 'Luis Reyes');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() => {
      expect(screen.getByText('Confirm HOA clearance')).toBeVisible();
    });
  });

  it('lets a negotiator create a self-assigned task on their assigned property, with no assignee picker', async () => {
    apiMocks.getMe.mockResolvedValue({
      id: members[2].user_id,
      email: members[2].email,
      displayName: members[2].display_name,
      organizations: [{ ...organization, role: 'negotiator' }],
    });
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));

    expect(await screen.findByRole('heading', { name: 'Create task' })).toBeVisible();
    expect(screen.queryByLabelText('Assign task to')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Task title'), 'Call the owner back');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() => {
      expect(screen.getByText('Call the owner back')).toBeVisible();
      expect(screen.getAllByText(/Luis Reyes/).length).toBeGreaterThan(0);
    });
  });

  it('hides task creation and edit controls from a viewer', async () => {
    apiMocks.getMe.mockResolvedValue({
      id: members[0].user_id,
      email: members[0].email,
      displayName: members[0].display_name,
      organizations: [{ ...organization, role: 'viewer' }],
    });
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));

    expect(await screen.findByRole('heading', { name: 'Tasks' })).toBeVisible();
    expect(screen.getByText('Follow up on survey plan')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Create task' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Task title')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Status for Follow up on survey plan/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive task' })).not.toBeInTheDocument();
  });
});
