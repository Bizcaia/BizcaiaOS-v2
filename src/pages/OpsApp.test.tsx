import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_ORGANIZATION_ID, operationsApi, resetOperationsDemoState, type TimelineEntry } from '../api/operationsApi';
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
      // The owner list entry; the name also appears as an Interaction owner option.
      expect(screen.getByText('River Estate', { selector: 'strong' })).toBeVisible();
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

    expect(await screen.findByRole('heading', { name: 'Payments' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Record payment' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Payment amount')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive payment' })).not.toBeInTheDocument();
  });

  it('shows seeded payments and lets an elevated role record a payment', async () => {
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));

    expect(await screen.findByRole('heading', { name: 'Payments' })).toBeVisible();
    expect(screen.getByText(/Deposit · Paid/)).toBeVisible();
    expect(screen.getByText(/Installment · Scheduled/)).toBeVisible();

    await user.type(screen.getByLabelText('Payment amount'), '250000');
    await user.selectOptions(screen.getByLabelText('Payment type'), 'Final payment');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));

    await waitFor(() => {
      expect(screen.getByText(/Final payment · Pending/)).toBeVisible();
    });
  });

  it('hides payment creation and edit controls from a negotiator, unlike tasks', async () => {
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

    // Negotiators can create/edit their own tasks, but have no payment access at all.
    expect(await screen.findByRole('heading', { name: 'Create task' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Payments' })).toBeVisible();
    expect(screen.getByText(/Deposit · Paid/)).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Record payment' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Payment amount')).not.toBeInTheDocument();
  });

  async function seedExecutedAgreement(title: string) {
    return operationsApi.uploadDocument('70000000-0000-4000-8000-000000000001', {
      category: 'agreement_executed',
      title,
      file: new File(['signed'], `${title}.pdf`, { type: 'application/pdf' }),
    });
  }

  it('shows signatures per executed agreement and lets an allowed role record and archive one', async () => {
    await seedExecutedAgreement('Deed of Sale');
    await seedExecutedAgreement('Deed Supplement');
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));

    expect(await screen.findByRole('heading', { name: 'Agreement signatures' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Deed of Sale' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Deed Supplement' })).toBeVisible();
    expect(screen.getAllByText('0 of 1 owners signed')).toHaveLength(2);

    fireEvent.change(screen.getByLabelText('Signed date for Rosa Mendoza on Deed of Sale'), {
      target: { value: '2026-09-20' },
    });
    await user.click(screen.getByRole('button', { name: 'Record signature for Rosa Mendoza on Deed of Sale' }));

    await waitFor(() => {
      expect(screen.getByText('Signed 2026-09-20 · recorded by Alex Villanueva')).toBeVisible();
      expect(screen.getByText('1 of 1 owners signed')).toBeVisible();
      expect(screen.getByText('0 of 1 owners signed')).toBeVisible();
    });
    // The supplement is a separate document and remains unsigned.
    expect(screen.getByRole('button', { name: 'Record signature for Rosa Mendoza on Deed Supplement' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Archive signature for Rosa Mendoza on Deed of Sale' }));
    await waitFor(() => {
      expect(screen.getAllByText('0 of 1 owners signed')).toHaveLength(2);
    });
  });

  it('derives signed and not-signed per owner when several owners share one executed agreement', async () => {
    const propertyId = '70000000-0000-4000-8000-000000000001';
    const coOwner = await operationsApi.createOwner({
      organizationId: DEMO_ORGANIZATION_ID,
      ownerType: 'individual',
      displayName: 'Co-owner Luz',
    });
    await operationsApi.linkPropertyOwner(propertyId, { ownerId: coOwner.id, ownershipPercent: 50 });
    const executed = await seedExecutedAgreement('Deed of Sale');
    await operationsApi.createAgreementSignature(propertyId, {
      documentId: executed.id,
      ownerId: '80000000-0000-4000-8000-000000000001',
      signedOn: '2026-09-20',
    });
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));

    expect(await screen.findByText('1 of 2 owners signed')).toBeVisible();
    const rosaRow = screen.getByRole('button', { name: 'Archive signature for Rosa Mendoza on Deed of Sale' }).closest('li')!;
    expect(within(rosaRow).getByText('Signed 2026-09-20 · recorded by Alex Villanueva')).toBeVisible();
    const luzRow = screen.getByRole('button', { name: 'Record signature for Co-owner Luz on Deed of Sale' }).closest('li')!;
    expect(within(luzRow).getByText('Not signed')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Record signature for Rosa Mendoza on Deed of Sale' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Signed date for Co-owner Luz on Deed of Sale'), {
      target: { value: '2026-09-21' },
    });
    await user.click(screen.getByRole('button', { name: 'Record signature for Co-owner Luz on Deed of Sale' }));
    expect(await screen.findByText('2 of 2 owners signed')).toBeVisible();
  });

  it('shows why an owner with an active signature cannot be unlinked', async () => {
    const executed = await seedExecutedAgreement('Deed of Sale');
    await operationsApi.createAgreementSignature('70000000-0000-4000-8000-000000000001', {
      documentId: executed.id,
      ownerId: '80000000-0000-4000-8000-000000000001',
      signedOn: '2026-09-20',
    });
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));

    const ownersSection = (await screen.findByRole('heading', { name: 'Owners' })).closest('section')!;
    await user.click(await within(ownersSection).findByRole('button', { name: 'Unlink' }));
    expect(await within(ownersSection).findByText(/active agreement signatures/)).toBeVisible();
    expect(within(ownersSection).getByText('Rosa Mendoza', { selector: 'strong' })).toBeVisible();
  });

  it('shows signatures read-only to a role without signature write access', async () => {
    const executed = await seedExecutedAgreement('Deed of Sale');
    await operationsApi.createAgreementSignature('70000000-0000-4000-8000-000000000001', {
      documentId: executed.id,
      ownerId: '80000000-0000-4000-8000-000000000001',
      signedOn: '2026-09-20',
    });
    apiMocks.getMe.mockResolvedValue({
      id: members[0].user_id,
      email: members[0].email,
      displayName: members[0].display_name,
      organizations: [{ ...organization, role: 'finance' }],
    });
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));

    expect(await screen.findByRole('heading', { name: 'Deed of Sale' })).toBeVisible();
    expect(await screen.findByText(/^Signed 2026-09-20/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Record signature for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Archive signature for/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Signed date for/)).not.toBeInTheDocument();
  });

  async function openProperty(reference: RegExp) {
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: reference }));
    const heading = await screen.findByRole('heading', { name: 'Timeline' });
    return { user, section: heading.closest('section')! };
  }

  function timelineEntry(overrides: Partial<TimelineEntry> & { source_id: string }): TimelineEntry {
    return {
      id: `task:${overrides.source_id}:task_created`,
      kind: 'task_created',
      source_type: 'task',
      occurred_at: '2026-09-01T00:00:00.000Z',
      precision: 'timestamp',
      basis: 'recorded',
      actor: null,
      summary: `Task created: ${overrides.source_id}`,
      archived: false,
      ...overrides,
    };
  }

  it('shows a read-only timeline after the signatures block with date precision and Recorded by labels', async () => {
    const { section } = await openProperty(/NCP-00102/);
    const signatures = screen.getByRole('heading', { name: 'Agreement signatures' }).closest('section')!;
    expect(signatures.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const paid = (await within(section).findByText('Deposit paid: PHP 500,000')).closest('li')!;
    expect(within(paid).getByText('2026-08-15')).toBeVisible();
    expect(within(paid).queryByText(/Recorded by/)).not.toBeInTheDocument();

    const recorded = within(section).getByText('Deposit recorded: PHP 500,000 · Paid').closest('li')!;
    expect(within(recorded).getByText(/^Recorded (?!by )\S/)).toBeVisible();
    expect(within(recorded).getByText('Recorded by Maria Santos')).toBeVisible();

    const negotiation = within(section).getByText('Negotiation recorded · opening PHP 12,000,000').closest('li')!;
    expect(within(negotiation).queryByText(/Recorded by/)).not.toBeInTheDocument();
    expect(within(section).queryByText(/Opening offer recorded/)).not.toBeInTheDocument();

    expect(within(section).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Refresh timeline']);
    expect(within(section).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows the empty state for a property with no recorded activity', async () => {
    const { section } = await openProperty(/NCP-00131/);
    expect(await within(section).findByText('No recorded activity yet.')).toBeVisible();
  });

  it('shows load errors and recovers on Refresh', async () => {
    const spy = vi.spyOn(operationsApi, 'getPropertyTimeline').mockRejectedValueOnce(new Error('Timeline unavailable'));
    const { user, section } = await openProperty(/NCP-00102/);
    expect(await within(section).findByText('Timeline unavailable')).toHaveClass('form-error');

    await operationsApi.createTask('70000000-0000-4000-8000-000000000001', { title: 'Timeline refresh check' });
    await user.click(within(section).getByRole('button', { name: 'Refresh timeline' }));
    expect(await within(section).findByText('Task created: Timeline refresh check')).toBeVisible();
    expect(within(section).queryByText('Timeline unavailable')).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it('loads the next page with Load more and labels unnamed actors as former members', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => timelineEntry({ source_id: `page-one-${index}` }));
    const secondPage = [
      timelineEntry({ source_id: 'former', actor: { id: 'gone-user', display_name: null }, summary: 'Task created: former' }),
      timelineEntry({
        source_id: 'signed',
        id: 'agreement_signature:signed:agreement_signed',
        kind: 'agreement_signed',
        source_type: 'agreement_signature',
        occurred_at: '2026-08-01',
        precision: 'date',
        basis: 'occurrence',
        summary: 'Rosa Mendoza signed Deed of Sale',
      }),
    ];
    const spy = vi
      .spyOn(operationsApi, 'getPropertyTimeline')
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    const { user, section } = await openProperty(/NCP-00102/);

    expect(await within(section).findByText('Task created: page-one-49')).toBeVisible();
    await user.click(within(section).getByRole('button', { name: 'Load more timeline entries' }));

    expect(await within(section).findByText('Recorded by a former member')).toBeVisible();
    const signed = within(section).getByText('Rosa Mendoza signed Deed of Sale').closest('li')!;
    expect(within(signed).getByText('2026-08-01')).toBeVisible();
    expect(within(section).getAllByRole('listitem')).toHaveLength(52);
    expect(within(section).queryByRole('button', { name: 'Load more timeline entries' })).not.toBeInTheDocument();
    expect(spy.mock.calls.map(([, page]) => page)).toEqual([
      { limit: 50, offset: 0 },
      { limit: 50, offset: 50 },
    ]);
    spy.mockRestore();
  });

  function actAs(role: string) {
    apiMocks.getMe.mockResolvedValue({
      id: members[0].user_id,
      email: members[0].email,
      displayName: members[0].display_name,
      organizations: [{ ...organization, role }],
    });
  }

  async function openInteractions() {
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));
    const heading = await screen.findByRole('heading', { name: 'Interactions' });
    return { user, section: heading.closest('section')! };
  }

  it('records an interaction before the negotiation block and shows it without notes in the Timeline', async () => {
    const { user, section } = await openInteractions();
    const negotiation = screen.getByRole('heading', { name: 'Negotiation' }).closest('section')!;
    expect(section.compareDocumentPosition(negotiation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await within(section).findByText('No interactions recorded yet.')).toBeVisible();

    const record = within(section).getByRole('button', { name: 'Record interaction' });
    expect(record).toBeDisabled();
    const ownerOptions = within(within(section).getByLabelText('Interaction owner')).getAllByRole('option');
    expect(ownerOptions.map((option) => option.textContent)).toEqual(['No specific owner', 'Rosa Mendoza']);
    expect(
      within(within(section).getByLabelText('Interaction type')).getAllByRole('option').map((option) => option.textContent),
    ).toEqual(['Call', 'Meeting', 'Site visit', 'Message', 'Other interaction']);

    await user.selectOptions(within(section).getByLabelText('Interaction type'), 'site_visit');
    await user.selectOptions(within(section).getByLabelText('Interaction owner'), '80000000-0000-4000-8000-000000000001');
    await user.type(within(section).getByLabelText('Interaction notes'), 'Walked the eastern boundary');
    await user.click(record);

    const entry = (await within(section).findByText('Site visit with Rosa Mendoza')).closest('li')!;
    expect(within(entry).getByText('Walked the eastern boundary')).toBeVisible();
    expect(within(entry).getByText(/Recorded by Alex Villanueva/)).toBeVisible();

    const timeline = screen.getByRole('heading', { name: 'Timeline' }).closest('section')!;
    await user.click(within(timeline).getByRole('button', { name: 'Refresh timeline' }));
    expect(await within(timeline).findByText('Site visit with Rosa Mendoza')).toBeVisible();
    expect(within(timeline).queryByText(/Walked the eastern boundary/)).not.toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: /^Archive Site visit with Rosa Mendoza from / }));
    expect(await within(section).findByText('No interactions recorded yet.')).toBeVisible();
  });

  it('shows the server error for a future occurred time and records nothing', async () => {
    const { user, section } = await openInteractions();
    fireEvent.change(within(section).getByLabelText(/Occurred at/), { target: { value: '2999-01-01T10:00' } });
    await user.type(within(section).getByLabelText('Interaction notes'), 'Planned meeting');
    await user.click(within(section).getByRole('button', { name: 'Record interaction' }));
    expect(await within(section).findByText(/occurred_at is in the future/)).toHaveClass('form-error');
    expect(within(section).getByText('No interactions recorded yet.')).toBeVisible();
  });

  it.each(['supervisor', 'negotiator', 'land_acquisition_manager'])('shows the interaction block to %s', async (role) => {
    actAs(role);
    const { section } = await openInteractions();
    expect(within(section).getByRole('button', { name: 'Record interaction' })).toBeInTheDocument();
  });

  it.each(['legal_documentation', 'finance', 'viewer'])('hides the interaction block from %s', async (role) => {
    actAs(role);
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));
    expect(await screen.findByRole('heading', { name: 'Timeline' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Interactions' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Interaction notes')).not.toBeInTheDocument();
  });

  it('changes the stage through the stage transition, asking for a reason and showing a refusal', async () => {
    // NCP-00118 has no negotiation, so no negotiation exception applies (L-04).
    const propertyId = '70000000-0000-4000-8000-000000000002';
    const transitionSpy = vi.spyOn(operationsApi, 'transitionPropertyStage');
    const updateSpy = vi.spyOn(operationsApi, 'updateProperty');
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00118/ }));
    const lifecycle = await screen.findByRole('region', { name: 'Lifecycle' });

    // Backward (Commercial review → Documentation) without a reason is refused and nothing changes.
    expect(within(lifecycle).queryByLabelText('Reason for stage change')).not.toBeInTheDocument();
    await user.selectOptions(within(lifecycle).getByLabelText('Acquisition stage'), 'documentation');
    await user.click(within(lifecycle).getByRole('button', { name: 'Change stage' }));
    expect(await within(lifecycle).findByText(/A reason is required/)).toHaveClass('form-error');
    expect((await operationsApi.getProperty(propertyId)).acquisition_stage).toBe('commercial_review');

    await user.type(within(lifecycle).getByLabelText('Reason for stage change'), 'Missing title copy');
    await user.click(within(lifecycle).getByRole('button', { name: 'Change stage' }));
    await waitFor(() => expect(screen.getByLabelText('Current lifecycle')).toHaveTextContent('Stage Documentation'));
    expect(transitionSpy).toHaveBeenLastCalledWith(propertyId, {
      targetStage: 'documentation',
      expectedStage: 'commercial_review',
      reason: 'Missing title copy',
    });
    expect(updateSpy).not.toHaveBeenCalled();
    expect((await operationsApi.getProperty(propertyId)).acquisition_stage).toBe('documentation');
    transitionSpy.mockRestore();
    updateSpy.mockRestore();
  });

  it('shows the negotiation-exception refusal without the override, and leaves negotiation with it', async () => {
    // NCP-00102 is in negotiation with an open negotiation (L-04).
    const propertyId = '70000000-0000-4000-8000-000000000001';
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00102/ }));
    const lifecycle = await screen.findByRole('region', { name: 'Lifecycle' });
    await user.selectOptions(within(lifecycle).getByLabelText('Acquisition stage'), 'commercial_review');
    await user.type(within(lifecycle).getByLabelText('Reason for stage change (optional)'), 'Terms agreed verbally');
    await user.click(within(lifecycle).getByRole('button', { name: 'Change stage' }));
    expect(await within(lifecycle).findByText(/requires an override \(negotiation_unresolved_exit\)/)).toHaveClass('form-error');
    expect((await operationsApi.getProperty(propertyId)).acquisition_stage).toBe('negotiation');

    await user.click(within(lifecycle).getByLabelText(/Use the negotiation exception/));
    await user.click(within(lifecycle).getByRole('button', { name: 'Change stage' }));
    await waitFor(() => expect(screen.getByLabelText('Current lifecycle')).toHaveTextContent('Stage Commercial review'));
    expect(await screen.findByText('Acquisition stage changed from Negotiation to Commercial review (override)')).toBeVisible();
  });

  // Concurrency and UI integration (L-07).
  async function openProperty118() {
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00118/ }));
    const lifecycle = await screen.findByRole('region', { name: 'Lifecycle' });
    return { user, lifecycle, propertyId: '70000000-0000-4000-8000-000000000002' };
  }

  it('keeps the drawer open after a lifecycle change and refreshes the displayed state and the Timeline', async () => {
    const { user, lifecycle } = await openProperty118();
    expect(screen.getByLabelText('Current lifecycle')).toHaveTextContent('Stage Commercial review · Status Active');
    await user.selectOptions(within(lifecycle).getByLabelText('Acquisition stage'), 'legal_review');
    await user.click(within(lifecycle).getByRole('button', { name: 'Change stage' }));
    await waitFor(() => expect(screen.getByLabelText('Current lifecycle')).toHaveTextContent('Stage Legal review'));
    expect(await screen.findByText('Acquisition stage changed from Commercial review to Legal review')).toBeVisible();
    // The list behind the drawer shows the new stage too.
    expect(screen.getByRole('button', { name: /NCP-00118/ })).toHaveTextContent('Legal review');

    const refreshed = await screen.findByRole('region', { name: 'Lifecycle' });
    await user.selectOptions(within(refreshed).getByLabelText('Acquisition status'), 'on_hold');
    await user.click(within(refreshed).getByRole('button', { name: 'Change status' }));
    await waitFor(() => expect(screen.getByLabelText('Current lifecycle')).toHaveTextContent('Status On hold'));
    expect(await screen.findByText('Acquisition status changed from Active to On hold')).toBeVisible();
  });

  it('shows a risk change in the Timeline after it is saved from the drawer', async () => {
    const { user, propertyId } = await openProperty118();
    expect(screen.queryByText(/^Risk changed/)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Risk'), 'high');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    // Saving closes the drawer; the Timeline shows the change when the property is opened again.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Timeline' })).not.toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: /NCP-00118/ }));
    const timeline = (await screen.findByRole('heading', { name: 'Timeline' })).closest('section')!;
    expect(await within(timeline).findByText('Risk changed from Low to High')).toBeVisible();
    expect((await operationsApi.getPropertyTimeline(propertyId)).filter((entry) => entry.kind === 'risk_changed')).toHaveLength(1);
  });

  it('shows a stale-screen conflict with the current and stale values, reloads, and records nothing from the stale attempt', async () => {
    const { user, lifecycle, propertyId } = await openProperty118();
    // Another user moves the property after this screen was loaded.
    await operationsApi.transitionPropertyStage(propertyId, { targetStage: 'legal_review', expectedStage: 'commercial_review' });

    await user.selectOptions(within(lifecycle).getByLabelText('Acquisition stage'), 'signing');
    await user.click(within(lifecycle).getByRole('button', { name: 'Change stage' }));
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Not saved: the acquisition stage changed to Legal review while this screen showed Commercial review');
    // The display is reconciled with the server, not the attempted value.
    await waitFor(() => expect(screen.getByLabelText('Current lifecycle')).toHaveTextContent('Stage Legal review'));
    expect((await operationsApi.getProperty(propertyId)).acquisition_stage).toBe('legal_review');
    const summaries = (await operationsApi.getPropertyTimeline(propertyId)).map((entry) => entry.summary);
    expect(summaries).toContain('Acquisition stage changed from Commercial review to Legal review');
    expect(summaries.some((summary) => summary.includes('Signing'))).toBe(false);

    // Retrying from the reloaded screen works.
    const reloaded = await screen.findByRole('region', { name: 'Lifecycle' });
    await user.selectOptions(within(reloaded).getByLabelText('Acquisition stage'), 'signing');
    await user.click(within(reloaded).getByRole('button', { name: 'Change stage' }));
    await waitFor(() => expect(screen.getByLabelText('Current lifecycle')).toHaveTextContent('Stage Signing'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers a status override only where a designated rule applies', async () => {
    const { user, lifecycle } = await openProperty118();
    await user.selectOptions(within(lifecycle).getByLabelText('Acquisition status'), 'on_hold');
    expect(within(lifecycle).queryByLabelText(/Override:/)).not.toBeInTheDocument();
    await user.selectOptions(within(lifecycle).getByLabelText('Acquisition status'), 'complete');
    expect(within(lifecycle).getByLabelText(/Override: completion away from Payment \/ closing/)).toBeInTheDocument();
  });

  it('offers a negotiator only later stages and pause/resume, and legal no lifecycle controls', async () => {
    actAs('negotiator');
    const { lifecycle } = await openProperty118();
    const stageOptions = [...within(lifecycle).getByLabelText('Acquisition stage').querySelectorAll('option')].map((option) => option.getAttribute('value'));
    expect(stageOptions).toEqual(['', 'legal_review', 'agreement_preparation', 'signing', 'payment_closing']);
    const statusOptions = [...within(lifecycle).getByLabelText('Acquisition status').querySelectorAll('option')].map((option) => option.getAttribute('value'));
    expect(statusOptions).toEqual(['', 'on_hold']);
  });

  it.each(['legal_documentation', 'finance', 'viewer'])('shows %s the lifecycle state without lifecycle controls', async (role) => {
    actAs(role);
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00118/ }));
    expect(await screen.findByLabelText('Current lifecycle')).toHaveTextContent('Stage Commercial review · Status Active');
    expect(screen.queryByRole('region', { name: 'Lifecycle' })).not.toBeInTheDocument();
  });

  it('offers no stage control on a legacy stage, only the status control and remediation', async () => {
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    await user.click(await screen.findByRole('button', { name: /NCP-00077/ }));
    const lifecycle = await screen.findByRole('region', { name: 'Lifecycle' });
    expect(within(lifecycle).queryByLabelText('Acquisition stage')).not.toBeInTheDocument();
    expect(within(lifecycle).getByLabelText('Acquisition status')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Legacy remediation' })).toBeInTheDocument();
  });

  // Legacy stage remediation (L-06): the seeded NCP-00077 is on the legacy stage withdrawn.
  async function openLegacyProperty() {
    const user = userEvent.setup();
    render(<OpsApp onExit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Properties' }));
    expect(await screen.findByText(/Withdrawn · Needs review/)).toBeVisible();
    await user.click(await screen.findByRole('button', { name: /NCP-00077/ }));
    const section = await screen.findByRole('region', { name: 'Legacy remediation' });
    return { user, section };
  }

  it('corrects a legacy stage only through remediation, requiring a reason and supporting evidence', async () => {
    const propertyId = '70000000-0000-4000-8000-000000000004';
    const { user, section } = await openLegacyProperty();
    // No ordinary stage control for a legacy value.
    expect(screen.queryByLabelText('Acquisition stage')).not.toBeInTheDocument();
    expect(within(section).getByText(/Not reviewed/)).toBeVisible();

    await user.click(within(section).getByRole('button', { name: 'Start review' }));
    expect(await within(section).findByText('Cycle 1 · Under review')).toBeVisible();

    await user.selectOptions(within(section).getByLabelText('Corrected stage'), 'documentation');
    await user.click(within(section).getByRole('button', { name: 'Resolve' }));
    expect(await within(section).findByText(/A reason is required to resolve/)).toHaveClass('form-error');
    await user.type(within(section).getByLabelText('Remediation reason'), 'Survey confirms documentation');
    await user.click(within(section).getByRole('button', { name: 'Resolve' }));
    expect(await within(section).findByText(/Supporting evidence is required/)).toHaveClass('form-error');
    expect((await operationsApi.getProperty(propertyId)).acquisition_stage).toBe('withdrawn');

    expect(
      [...within(section).getByLabelText('Corrected stage').querySelectorAll('option')].map((option) => option.getAttribute('value')),
    ).not.toEqual(expect.arrayContaining(['on_hold', 'withdrawn', 'acquisition_complete']));
    await user.type(within(section).getByLabelText('Supporting evidence'), 'Survey report 2024-11');
    await user.click(within(section).getByRole('button', { name: 'Resolve' }));
    await waitFor(async () => expect((await operationsApi.getProperty(propertyId)).acquisition_stage).toBe('documentation'));
    const [cycle] = await operationsApi.listPropertyRemediations(propertyId);
    expect(cycle).toMatchObject({ state: 'RESOLVED', resolution_reason: 'Survey confirms documentation', evidence: 'Survey report 2024-11' });
  });

  it('requires a reason to escalate (Q-3) but not to return to review (Q-4)', async () => {
    const propertyId = '70000000-0000-4000-8000-000000000004';
    const { user, section } = await openLegacyProperty();
    await user.click(within(section).getByRole('button', { name: 'Start review' }));
    await user.click(await within(section).findByRole('button', { name: 'Escalate (evidence insufficient)' }));
    expect(await within(section).findByText(/A reason is required to escalate/)).toHaveClass('form-error');
    await user.type(within(section).getByLabelText('Remediation reason'), 'Survey missing');
    await user.click(within(section).getByRole('button', { name: 'Escalate (evidence insufficient)' }));
    expect(await within(section).findByText('Cycle 1 · Requires escalation')).toBeVisible();

    expect(within(section).getByLabelText('Remediation reason (optional)')).toHaveValue('');
    await user.click(within(section).getByRole('button', { name: 'Return to review' }));
    expect(await within(section).findByText('Cycle 1 · Under review')).toBeVisible();
    const [cycle] = await operationsApi.listPropertyRemediations(propertyId);
    expect(cycle.events?.map((event) => [event.action, event.reason])).toEqual([
      ['review_started', null],
      ['escalated', 'Survey missing'],
      ['returned_to_review', null],
    ]);
    expect((await operationsApi.getProperty(propertyId)).acquisition_stage).toBe('withdrawn');
  });

  it.each(['negotiator', 'legal_documentation', 'finance', 'viewer'])('shows the legacy remediation state to %s without any remediation action', async (role) => {
    actAs(role);
    const { section } = await openLegacyProperty();
    expect(within(section).getByText(/Needs review/)).toBeVisible();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
  });

  describe('Dashboard attention section', () => {
    const attentionSection = async () => screen.findByRole('region', { name: 'Needs attention' });
    const tile = () => screen.getByText('Blocked / high risk').closest('.ops-metric') as HTMLElement;

    it('shows what needs attention on the Dashboard and makes the blocked / high risk tile agree with the list', async () => {
      render(<OpsApp onExit={vi.fn()} />);
      const section = await attentionSection();
      const mine = await within(section).findByLabelText('My tasks');
      const overdue = within(section).getByLabelText('Overdue, not mine');
      const blocked = within(section).getByLabelText('Blocked or high risk');

      expect(await within(mine).findByText('No open tasks assigned to you.')).toBeVisible();
      expect(within(mine).getByRole('heading', { name: 'My tasks · 0' })).toBeVisible();

      expect(within(overdue).getByRole('heading', { name: 'Overdue, not mine · 1' })).toBeVisible();
      const task = within(overdue).getByRole('button', { name: /Follow up on survey plan/ });
      expect(task).toHaveTextContent('Overdue');
      expect(task).toHaveTextContent('NCP-00102 · High · Open · Due 2026-09-26 · Luis Reyes');

      expect(within(blocked).getByRole('heading', { name: 'Blocked or high risk · 1' })).toBeVisible();
      const property = within(blocked).getByRole('button', { name: /NCP-00131/ });
      expect(property).toHaveTextContent('Legal blocked');
      expect(property).toHaveTextContent('High risk');
      expect(property).toHaveTextContent('Documentation · Active');

      expect(within(tile()).getByText('1')).toBeVisible();
      expect(within(section).getByText(/^TODAY · \d{4}-\d{2}-\d{2}$/)).toBeVisible();
      // Read-only: a row is a single link to the property, with no task controls.
      expect(within(section).queryByRole('combobox')).not.toBeInTheDocument();
      expect(within(section).queryByRole('checkbox')).not.toBeInTheDocument();
    });

    it('opens the property of a task row and of a property row', async () => {
      const user = userEvent.setup();
      render(<OpsApp onExit={vi.fn()} />);
      await user.click(await within(await attentionSection()).findByRole('button', { name: /Follow up on survey plan/ }));
      expect(await screen.findByRole('heading', { name: 'NCP-00102', level: 2 })).toBeVisible();
      expect(screen.getByRole('heading', { name: 'Properties' })).toBeVisible();

      await user.click(screen.getByRole('button', { name: 'Dashboard' }));
      await user.click(await within(await attentionSection()).findByRole('button', { name: /NCP-00131/ }));
      expect(await screen.findByRole('heading', { name: 'NCP-00131', level: 2 })).toBeVisible();
    });

    it('lists my own open tasks, and reads again when the Dashboard is shown after a change', async () => {
      await operationsApi.createTask('70000000-0000-4000-8000-000000000001', {
        title: 'Confirm survey date',
        assignedUserId: members[0].user_id,
        dueOn: '2026-01-15',
        priority: 'urgent',
      });
      const user = userEvent.setup();
      render(<OpsApp onExit={vi.fn()} />);
      const mine = await within(await attentionSection()).findByLabelText('My tasks');
      const row = await within(mine).findByRole('button', { name: /Confirm survey date/ });
      expect(row).toHaveTextContent('Overdue');
      expect(row).toHaveTextContent('NCP-00102 · Urgent · Open · Due 2026-01-15');
      expect(within(mine).getByRole('heading', { name: 'My tasks · 1' })).toBeVisible();
      // My own task is not repeated under the overdue tasks of others.
      expect(within(screen.getByLabelText('Overdue, not mine')).queryByText(/Confirm survey date/)).not.toBeInTheDocument();

      // A risk change saved in a property is reflected once the Dashboard is shown again.
      await user.click(screen.getByRole('button', { name: 'Properties' }));
      await user.click(await screen.findByRole('button', { name: /NCP-00118/ }));
      await user.selectOptions(await screen.findByLabelText('Risk'), 'high');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'NCP-00118', level: 2 })).not.toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: 'Dashboard' }));
      const blocked = await within(await attentionSection()).findByLabelText('Blocked or high risk');
      expect(await within(blocked).findByRole('button', { name: /NCP-00118/ })).toHaveTextContent('High risk');
      expect(within(blocked).getByRole('heading', { name: 'Blocked or high risk · 2' })).toBeVisible();
      expect(within(tile()).getByText('2')).toBeVisible();
    });

    it('says how many rows are shown when a list is longer than the page, and uses the full count on the tile', async () => {
      const items = Array.from({ length: 50 }, (_, index) => ({
        id: `70000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
        property_reference: `LIM-${String(index + 1).padStart(3, '0')}`,
        acquisition_stage: 'identified' as const,
        acquisition_status: 'active' as const,
        risk: 'high' as const,
        legal_status: 'unknown',
      }));
      const spy = vi.spyOn(operationsApi, 'getAttention').mockResolvedValue({
        today: '2026-10-07',
        my_tasks: { total: 0, items: [] },
        overdue_tasks: { total: 0, items: [] },
        properties: { total: 61, items },
      });
      try {
        render(<OpsApp onExit={vi.fn()} />);
        const blocked = await within(await attentionSection()).findByLabelText('Blocked or high risk');
        expect(await within(blocked).findByText('Showing 50 of 61')).toBeVisible();
        expect(within(blocked).getAllByRole('button')).toHaveLength(50);
        expect(within(tile()).getByText('61')).toBeVisible();
        expect(within(screen.getByLabelText('Overdue, not mine')).getByText('No overdue tasks.')).toBeVisible();
      } finally {
        spy.mockRestore();
      }
    });

    it('shows the failure instead of the lists, and no number on the tile, when the view cannot be read', async () => {
      const spy = vi.spyOn(operationsApi, 'getAttention').mockRejectedValue(new Error('You do not have permission for this operation'));
      try {
        render(<OpsApp onExit={vi.fn()} />);
        const section = await attentionSection();
        expect(await within(section).findByText('You do not have permission for this operation')).toBeVisible();
        expect(within(section).queryByLabelText('My tasks')).not.toBeInTheDocument();
        expect(within(tile()).getByText('—')).toBeVisible();
        // The other tiles are unaffected.
        expect(screen.getByText('Acquisition-ready')).toBeVisible();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
