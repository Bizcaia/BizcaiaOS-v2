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

  it('lists the seeded document and uploads a new one, ignoring any client-supplied storage metadata', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';

    const seeded = await operationsApi.listDocuments(negotiationProperty);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({
      title: 'Transfer Certificate of Title',
      category: 'title_deed',
      status: 'submitted',
      storage_provider: 'local',
    });

    const file = new File(['deed contents'], 'deed.pdf', { type: 'application/pdf' });
    const uploaded = await operationsApi.uploadDocument(negotiationProperty, {
      category: 'title_deed',
      title: 'Second Deed',
      // @ts-expect-error -- storage_provider is not part of the input type; this proves it cannot be set from the client even if a caller tries.
      storageProvider: 's3',
      file,
    });
    expect(uploaded).toMatchObject({
      title: 'Second Deed',
      storage_provider: 'local',
      original_filename: 'deed.pdf',
      content_type: 'application/pdf',
    });

    const afterUpload = await operationsApi.listDocuments(negotiationProperty);
    expect(afterUpload).toHaveLength(2);
  });

  it('rejects an oversized or unsupported document upload', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';

    const oversized = new File([new Uint8Array(30 * 1024 * 1024)], 'huge.pdf', { type: 'application/pdf' });
    await expect(
      operationsApi.uploadDocument(negotiationProperty, { category: 'other', title: 'Too Big', file: oversized }),
    ).rejects.toThrow(/exceeds the maximum allowed size/i);

    const badType = new File(['exe'], 'bad.exe', { type: 'application/x-msdownload' });
    await expect(
      operationsApi.uploadDocument(negotiationProperty, { category: 'other', title: 'Bad Type', file: badType }),
    ).rejects.toThrow(/not accepted/i);
  });

  it('archives a document and excludes it from the default list until includeArchived is set', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';
    const [seeded] = await operationsApi.listDocuments(negotiationProperty);

    const updated = await operationsApi.updateDocument(seeded.id, { status: 'verified', archived: true });
    expect(updated.status).toBe('verified');
    expect(updated.archived_at).not.toBeNull();

    const defaultList = await operationsApi.listDocuments(negotiationProperty);
    expect(defaultList.some((doc) => doc.id === seeded.id)).toBe(false);

    const withArchived = await operationsApi.listDocuments(negotiationProperty, { includeArchived: true });
    expect(withArchived.some((doc) => doc.id === seeded.id)).toBe(true);
  });

  it('downloads a document as a blob with its original filename', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';
    const [seeded] = await operationsApi.listDocuments(negotiationProperty);

    const { blob, filename } = await operationsApi.downloadDocument(seeded.id);
    expect(filename).toBe('tct-102.pdf');
    expect(await blob.text()).toBe('Seeded demo title deed contents');
  });

  it('rejects a document negotiation link that does not resolve to the same property', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';
    const file = new File(['x'], 'x.pdf', { type: 'application/pdf' });

    await expect(
      operationsApi.uploadDocument(negotiationProperty, {
        category: 'other',
        title: 'Mismatched negotiation',
        negotiationId: 'aaaaaaaa-0000-0000-0000-000000000000',
        file,
      }),
    ).rejects.toThrow(/negotiation must belong to the same property/i);
  });
});
