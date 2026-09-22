import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('operationsApi demo adapter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_BASE_URL', '');
  });

  it('creates projects, properties, owners, and assignments without using a live organization', async () => {
    const { operationsApi, operationsApiMode, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    expect(operationsApiMode).toBe('demo');

    const project = await operationsApi.createProject({
      organization_id: DEMO_ORGANIZATION_ID,
      code: 'NCP-09',
      name: 'West Extension',
    });
    expect(project).toMatchObject({ organization_id: DEMO_ORGANIZATION_ID, code: 'NCP-09', name: 'West Extension' });

    const property = await operationsApi.createProperty({
      organizationId: DEMO_ORGANIZATION_ID,
      projectId: project.id,
      propertyReference: 'NCP-09001',
      municipality: 'Calamba',
      province: 'Laguna',
      barangay: 'Pansol',
      assignedNegotiatorId: '5517eab7-57db-412f-b381-33844d31a64f',
      assignedManagerId: '8714eff3-6be9-4cc8-bf5f-c4dbb62d90cb',
    });
    expect(property).toMatchObject({
      property_reference: 'NCP-09001',
      project_code: 'NCP-09',
      negotiator_name: 'Luis Reyes',
      manager_name: 'Maria Santos',
    });

    const owner = await operationsApi.createOwner({
      organizationId: DEMO_ORGANIZATION_ID,
      ownerType: 'estate',
      displayName: 'Mendoza Estate',
    });
    await operationsApi.linkPropertyOwner(property.id, {
      ownerId: owner.id,
      ownershipPercent: 100,
      isPrimary: true,
    });
    const detail = await operationsApi.getProperty(property.id);
    expect(detail.owners).toEqual([
      expect.objectContaining({ owner_id: owner.id, display_name: 'Mendoza Estate', is_primary: true }),
    ]);
  });

  it('rejects an invalid negotiator assignment', async () => {
    const { operationsApi, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    const project = (await operationsApi.listProjects(DEMO_ORGANIZATION_ID))[0];
    await expect(
      operationsApi.createProperty({
        organizationId: DEMO_ORGANIZATION_ID,
        projectId: project.id,
        propertyReference: 'NCP-BAD-NEG',
        assignedNegotiatorId: '758d5718-53d9-4ea2-b9d5-02828fcc0e2c',
      }),
    ).rejects.toThrow(/active negotiator/i);
  });

  it('rejects an invalid manager assignment', async () => {
    const { operationsApi, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    const project = (await operationsApi.listProjects(DEMO_ORGANIZATION_ID))[0];
    await expect(
      operationsApi.createProperty({
        organizationId: DEMO_ORGANIZATION_ID,
        projectId: project.id,
        propertyReference: 'NCP-BAD-MGR',
        assignedManagerId: '5517eab7-57db-412f-b381-33844d31a64f',
      }),
    ).rejects.toThrow(/manager or supervisor/i);
  });

  it('accepts a valid negotiator assignment', async () => {
    const { operationsApi, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    const project = (await operationsApi.listProjects(DEMO_ORGANIZATION_ID))[0];
    await expect(
      operationsApi.createProperty({
        organizationId: DEMO_ORGANIZATION_ID,
        projectId: project.id,
        propertyReference: 'NCP-OK-NEG',
        assignedNegotiatorId: '5517eab7-57db-412f-b381-33844d31a64f',
      }),
    ).resolves.toMatchObject({
      assigned_negotiator_id: '5517eab7-57db-412f-b381-33844d31a64f',
      negotiator_name: 'Luis Reyes',
    });
  });

  it('accepts a valid manager assignment', async () => {
    const { operationsApi, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    const project = (await operationsApi.listProjects(DEMO_ORGANIZATION_ID))[0];
    await expect(
      operationsApi.createProperty({
        organizationId: DEMO_ORGANIZATION_ID,
        projectId: project.id,
        propertyReference: 'NCP-OK-MGR',
        assignedManagerId: '8714eff3-6be9-4cc8-bf5f-c4dbb62d90cb',
      }),
    ).resolves.toMatchObject({
      assigned_manager_id: '8714eff3-6be9-4cc8-bf5f-c4dbb62d90cb',
      manager_name: 'Maria Santos',
    });
  });

  it('enforces negotiation stage, open uniqueness, offer amounts, and current_amount sync', async () => {
    const { operationsApi, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';
    const documentationProperty = '70000000-0000-4000-8000-000000000003';

    await expect(
      operationsApi.createNegotiation({
        organizationId: DEMO_ORGANIZATION_ID,
        propertyId: documentationProperty,
      }),
    ).rejects.toThrow(/negotiation stage/i);

    await expect(
      operationsApi.createNegotiation({
        organizationId: DEMO_ORGANIZATION_ID,
        propertyId: negotiationProperty,
      }),
    ).rejects.toThrow(/only one open or paused/i);

    const existing = await operationsApi.getNegotiation('90000000-0000-4000-8000-000000000001');
    expect(existing.current_amount).toBe(12500000);

    await expect(
      operationsApi.createNegotiationEvent(existing.id, { eventType: 'offer' }),
    ).rejects.toThrow(/amount/i);

    const offer = await operationsApi.createNegotiationEvent(existing.id, {
      eventType: 'counteroffer',
      amount: 13000000,
      contextualNote: 'Revised offer',
    });
    expect(offer.amount).toBe(13000000);
    const updated = await operationsApi.getNegotiation(existing.id);
    expect(updated.current_amount).toBe(13000000);

    const events = await operationsApi.listNegotiationEvents(existing.id);
    expect(events.some((event) => event.contextual_note === 'Opening offer recorded')).toBe(true);
    expect(events[0].amount).toBe(13000000);
  });
});
