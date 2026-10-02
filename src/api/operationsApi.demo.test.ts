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

  it('lists the seeded document and uploads a new one, refusing client-supplied storage metadata', async () => {
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
    // Like the API, a storage field is refused (400 validation_error) before anything is stored.
    await expect(
      operationsApi.uploadDocument(negotiationProperty, {
        category: 'title_deed',
        title: 'Second Deed',
        // @ts-expect-error -- storage_provider is not part of the input type; this proves it cannot be set from the client even if a caller tries.
        storageProvider: 's3',
        file,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'validation_error' });
    expect(await operationsApi.listDocuments(negotiationProperty)).toHaveLength(1);

    const uploaded = await operationsApi.uploadDocument(negotiationProperty, { category: 'title_deed', title: 'Second Deed', file });
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

  // The demo actor is fixed as Alex Villanueva (system_admin), so only the
  // elevated-manager path is reachable through the demo API -- the full
  // negotiator/legal/finance/viewer authorization matrix is exercised
  // exhaustively in the mocked route tests and the real-Postgres RLS
  // integration tests instead, where the acting role can be varied freely.

  it('lists the seeded tasks for a property', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';

    const tasks = await operationsApi.listTasks(negotiationProperty);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      title: 'Follow up on survey plan',
      status: 'open',
      priority: 'high',
      assigned_user_name: 'Luis Reyes',
    });
    expect(tasks.some((task) => task.title === 'Review title deed for encumbrances' && task.status === 'done')).toBe(
      true,
    );
  });

  it('creates a task as the elevated demo actor, assigned to another active member', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';

    const task = await operationsApi.createTask(negotiationProperty, {
      title: 'Schedule site visit',
      priority: 'urgent',
      assignedUserId: '5517eab7-57db-412f-b381-33844d31a64f',
      dueOn: '2026-10-01',
    });
    expect(task).toMatchObject({
      title: 'Schedule site visit',
      status: 'open',
      priority: 'urgent',
      assigned_user_id: '5517eab7-57db-412f-b381-33844d31a64f',
      assigned_user_name: 'Luis Reyes',
      created_by_user_id: '758d5718-53d9-4ea2-b9d5-02828fcc0e2c',
    });

    const tasks = await operationsApi.listTasks(negotiationProperty);
    expect(tasks.some((entry) => entry.id === task.id)).toBe(true);
  });

  it('creates an unassigned task', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';

    const task = await operationsApi.createTask(negotiationProperty, { title: 'Unassigned follow-up' });
    expect(task.assigned_user_id).toBeNull();
  });

  it('rejects assigning a task to an inactive member', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';

    await expect(
      operationsApi.createTask(negotiationProperty, {
        title: 'Assign to inactive member',
        // Paolo Lim is seeded as an inactive finance member.
        assignedUserId: '884e9d32-aad1-42e5-8603-4f9846cff79d',
      }),
    ).rejects.toThrow(/active member/i);
  });

  it('updates status, priority, due date, and reassigns a task as the elevated demo actor', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';
    const [seeded] = await operationsApi.listTasks(negotiationProperty);

    const updated = await operationsApi.updateTask(seeded.id, {
      status: 'in_progress',
      priority: 'urgent',
      dueOn: '2026-10-05',
      assignedUserId: '419fa143-1d97-40cd-b47b-812cb364acfd',
    });
    expect(updated).toMatchObject({
      status: 'in_progress',
      priority: 'urgent',
      due_on: '2026-10-05',
      assigned_user_id: '419fa143-1d97-40cd-b47b-812cb364acfd',
      assigned_user_name: 'Celina Cruz',
    });
  });

  it('archives a task and excludes it from the default list until includeArchived is set', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';
    const [seeded] = await operationsApi.listTasks(negotiationProperty);

    const archived = await operationsApi.updateTask(seeded.id, { archived: true });
    expect(archived.archived_at).not.toBeNull();

    const defaultList = await operationsApi.listTasks(negotiationProperty);
    expect(defaultList.some((task) => task.id === seeded.id)).toBe(false);

    const withArchived = await operationsApi.listTasks(negotiationProperty, { includeArchived: true });
    expect(withArchived.some((task) => task.id === seeded.id)).toBe(true);
  });

  // The demo actor is fixed as Alex Villanueva (system_admin), so only the
  // elevated-writer path is reachable through the demo API for payments too
  // -- supervisor/negotiator/legal_documentation/viewer denial is exercised
  // exhaustively in the mocked route tests and the real-Postgres RLS
  // integration tests instead.

  it('lists the seeded payments for a property', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';

    const payments = await operationsApi.listPayments(negotiationProperty);
    expect(payments).toHaveLength(2);
    expect(payments.some((payment) => payment.payment_type === 'deposit' && payment.status === 'paid')).toBe(true);
    expect(payments.some((payment) => payment.payment_type === 'installment' && payment.status === 'scheduled')).toBe(
      true,
    );
  });

  it('creates a payment as the elevated demo actor', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';

    const payment = await operationsApi.createPayment(negotiationProperty, {
      amount: 250000,
      paymentType: 'final_payment',
      referenceNumber: 'FINAL-01',
    });
    expect(payment).toMatchObject({
      amount: 250000,
      currency_code: 'PHP',
      payment_type: 'final_payment',
      status: 'pending',
      reference_number: 'FINAL-01',
      recorded_by_user_id: '758d5718-53d9-4ea2-b9d5-02828fcc0e2c',
      recorded_by_name: 'Alex Villanueva',
    });

    const payments = await operationsApi.listPayments(negotiationProperty);
    expect(payments.some((entry) => entry.id === payment.id)).toBe(true);
  });

  it('rejects a non-positive payment amount', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';

    await expect(
      operationsApi.createPayment(negotiationProperty, { amount: 0, paymentType: 'deposit' }),
    ).rejects.toThrow(/greater than zero/i);
    await expect(
      operationsApi.createPayment(negotiationProperty, { amount: -100, paymentType: 'deposit' }),
    ).rejects.toThrow(/greater than zero/i);
  });

  it('rejects a payment negotiation link that does not belong to the same property', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';

    await expect(
      operationsApi.createPayment(negotiationProperty, {
        amount: 100000,
        paymentType: 'deposit',
        negotiationId: 'aaaaaaaa-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/negotiation must belong to the same property/i);
  });

  it('updates status and paid date, and archives a payment', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationProperty = '70000000-0000-4000-8000-000000000001';
    const [seeded] = await operationsApi.listPayments(negotiationProperty);

    const updated = await operationsApi.updatePayment(seeded.id, { status: 'paid', paidOn: '2026-10-05' });
    expect(updated).toMatchObject({ status: 'paid', paid_on: '2026-10-05' });

    const archived = await operationsApi.updatePayment(seeded.id, { archived: true });
    expect(archived.archived_at).not.toBeNull();

    const defaultList = await operationsApi.listPayments(negotiationProperty);
    expect(defaultList.some((payment) => payment.id === seeded.id)).toBe(false);

    const withArchived = await operationsApi.listPayments(negotiationProperty, { includeArchived: true });
    expect(withArchived.some((payment) => payment.id === seeded.id)).toBe(true);
  });

  // As with the other verticals, the demo actor is fixed as system_admin, so
  // the read-only-role denials are exercised in the mocked route and
  // real-Postgres suites; everything else is mirrored here.
  const signatureProperty = '70000000-0000-4000-8000-000000000001';
  const otherProperty = '70000000-0000-4000-8000-000000000002';
  const rosa = '80000000-0000-4000-8000-000000000001';

  async function uploadExecuted(propertyId: string, title: string) {
    const { operationsApi } = await import('./operationsApi');
    return operationsApi.uploadDocument(propertyId, {
      category: 'agreement_executed',
      title,
      file: new File(['signed'], `${title}.pdf`, { type: 'application/pdf' }),
    });
  }

  it('records a signature for an existing owner on an executed agreement', async () => {
    const { operationsApi } = await import('./operationsApi');
    const executed = await uploadExecuted(signatureProperty, 'Deed of Sale');

    const signature = await operationsApi.createAgreementSignature(signatureProperty, {
      documentId: executed.id,
      ownerId: rosa,
      signedOn: '2026-09-20',
    });
    expect(signature).toMatchObject({
      property_id: signatureProperty,
      document_id: executed.id,
      owner_id: rosa,
      signed_on: '2026-09-20',
      owner_name: 'Rosa Mendoza',
      document_title: 'Deed of Sale',
      recorded_by_name: 'Alex Villanueva',
      archived_at: null,
    });
  });

  it('rejects non-executed documents, other-property documents, and non-owner signatories', async () => {
    const { operationsApi } = await import('./operationsApi');
    const seededTitleDeed = '92000000-0000-4000-8000-000000000001';
    await expect(
      operationsApi.createAgreementSignature(signatureProperty, { documentId: seededTitleDeed, ownerId: rosa, signedOn: '2026-09-20' }),
    ).rejects.toThrow(/agreement_executed/);

    const elsewhere = await uploadExecuted(otherProperty, 'Other deed');
    await expect(
      operationsApi.createAgreementSignature(signatureProperty, { documentId: elsewhere.id, ownerId: rosa, signedOn: '2026-09-20' }),
    ).rejects.toThrow(/same property/);

    const executed = await uploadExecuted(signatureProperty, 'Deed of Sale');
    const stranger = await operationsApi.createOwner({
      organizationId: '2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f',
      ownerType: 'individual',
      displayName: 'Not An Owner Here',
    });
    await expect(
      operationsApi.createAgreementSignature(signatureProperty, { documentId: executed.id, ownerId: stranger.id, signedOn: '2026-09-20' }),
    ).rejects.toThrow(/existing owner/);
  });

  it('rejects a duplicate active signature and allows a replacement after archiving', async () => {
    const { operationsApi } = await import('./operationsApi');
    const executed = await uploadExecuted(signatureProperty, 'Deed of Sale');
    const first = await operationsApi.createAgreementSignature(signatureProperty, {
      documentId: executed.id,
      ownerId: rosa,
      signedOn: '2026-09-20',
    });
    await expect(
      operationsApi.createAgreementSignature(signatureProperty, { documentId: executed.id, ownerId: rosa, signedOn: '2026-09-21' }),
    ).rejects.toThrow(/already has an active signature/);

    const archived = await operationsApi.archiveAgreementSignature(first.id);
    expect(archived.archived_at).not.toBeNull();
    // Archiving changes nothing else about the record.
    expect(archived).toMatchObject({ document_id: executed.id, owner_id: rosa, signed_on: '2026-09-20' });
    const archivedAgain = await operationsApi.archiveAgreementSignature(first.id);
    expect(archivedAgain.archived_at).toBe(archived.archived_at);

    const replacement = await operationsApi.createAgreementSignature(signatureProperty, {
      documentId: executed.id,
      ownerId: rosa,
      signedOn: '2026-09-21',
    });
    expect(replacement.id).not.toBe(first.id);

    const active = await operationsApi.listAgreementSignatures(signatureProperty);
    expect(active.map((signature) => signature.id)).toEqual([replacement.id]);
    const all = await operationsApi.listAgreementSignatures(signatureProperty, { includeArchived: true });
    expect(all).toHaveLength(2);
  });

  it('supports multiple owners and multiple executed agreements, keyed per document', async () => {
    const { operationsApi } = await import('./operationsApi');
    const secondOwner = await operationsApi.createOwner({
      organizationId: '2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f',
      ownerType: 'individual',
      displayName: 'Co-owner Luz',
    });
    await operationsApi.linkPropertyOwner(signatureProperty, { ownerId: secondOwner.id, ownershipPercent: 50 });
    const deed = await uploadExecuted(signatureProperty, 'Deed of Sale');
    const supplement = await uploadExecuted(signatureProperty, 'Deed Supplement');

    await operationsApi.createAgreementSignature(signatureProperty, { documentId: deed.id, ownerId: rosa, signedOn: '2026-09-20' });
    await operationsApi.createAgreementSignature(signatureProperty, { documentId: deed.id, ownerId: secondOwner.id, signedOn: '2026-09-20' });
    await operationsApi.createAgreementSignature(signatureProperty, { documentId: supplement.id, ownerId: rosa, signedOn: '2026-09-21' });

    expect(await operationsApi.listAgreementSignatures(signatureProperty, { documentId: deed.id })).toHaveLength(2);
    const supplementSignatures = await operationsApi.listAgreementSignatures(signatureProperty, { documentId: supplement.id });
    expect(supplementSignatures.map((signature) => signature.owner_id)).toEqual([rosa]);
  });

  it('blocks unlinking an owner with an active signature until it is archived; unsigned owners unlink freely', async () => {
    const { operationsApi } = await import('./operationsApi');
    const unsignedOwner = await operationsApi.createOwner({
      organizationId: '2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f',
      ownerType: 'individual',
      displayName: 'Unsigned Co-owner',
    });
    await operationsApi.linkPropertyOwner(signatureProperty, { ownerId: unsignedOwner.id, ownershipPercent: 10 });
    const executed = await uploadExecuted(signatureProperty, 'Deed of Sale');
    const signature = await operationsApi.createAgreementSignature(signatureProperty, {
      documentId: executed.id,
      ownerId: rosa,
      signedOn: '2026-09-20',
    });

    await expect(operationsApi.unlinkPropertyOwner(signatureProperty, rosa)).rejects.toThrow(/active agreement signatures/);
    expect((await operationsApi.listPropertyOwners(signatureProperty)).some((owner) => owner.owner_id === rosa)).toBe(true);

    await operationsApi.unlinkPropertyOwner(signatureProperty, unsignedOwner.id);

    await operationsApi.archiveAgreementSignature(signature.id);
    await operationsApi.unlinkPropertyOwner(signatureProperty, rosa);
    expect((await operationsApi.listPropertyOwners(signatureProperty)).some((owner) => owner.owner_id === rosa)).toBe(false);
  });

  it('blocks recategorizing a signed executed document until signatures are archived; other edits stay allowed', async () => {
    const { operationsApi } = await import('./operationsApi');
    const signed = await uploadExecuted(signatureProperty, 'Deed of Sale');
    const unsigned = await uploadExecuted(signatureProperty, 'Deed Supplement');
    const signature = await operationsApi.createAgreementSignature(signatureProperty, {
      documentId: signed.id,
      ownerId: rosa,
      signedOn: '2026-09-20',
    });

    await expect(operationsApi.updateDocument(signed.id, { category: 'other' })).rejects.toThrow(/active agreement signatures/);

    const retitled = await operationsApi.updateDocument(signed.id, { title: 'Deed of Sale (final)', status: 'verified' });
    expect(retitled).toMatchObject({ title: 'Deed of Sale (final)', category: 'agreement_executed' });

    const recategorizedUnsigned = await operationsApi.updateDocument(unsigned.id, { category: 'agreement_draft' });
    expect(recategorizedUnsigned.category).toBe('agreement_draft');

    await operationsApi.archiveAgreementSignature(signature.id);
    const recategorized = await operationsApi.updateDocument(signed.id, { category: 'other' });
    expect(recategorized.category).toBe('other');
  });

  it('leaves lifecycle fields and other verticals unchanged when every owner signs', async () => {
    const { operationsApi } = await import('./operationsApi');
    const snapshot = async () => {
      const property = await operationsApi.getProperty(signatureProperty);
      return {
        stage: property.acquisition_stage,
        status: property.acquisition_status,
        legal: property.legal_status,
        documentation: property.documentation_status,
        payment: property.payment_status,
        tasks: (await operationsApi.listTasks(signatureProperty, { includeArchived: true })).length,
        payments: (await operationsApi.listPayments(signatureProperty, { includeArchived: true })).length,
        negotiations: (await operationsApi.listNegotiations('2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f', { propertyId: signatureProperty })).length,
      };
    };
    const before = await snapshot();
    const executed = await uploadExecuted(signatureProperty, 'Deed of Sale');
    await operationsApi.createAgreementSignature(signatureProperty, { documentId: executed.id, ownerId: rosa, signedOn: '2026-09-20' });
    expect(await snapshot()).toEqual(before);
  });

  // Property Timeline: the demo must produce the same entries the server
  // derives, so these mirror the real-PostgreSQL timeline suite.
  const emptyProperty = '70000000-0000-4000-8000-000000000003';
  const alex = '758d5718-53d9-4ea2-b9d5-02828fcc0e2c';

  function dayIn(timeZone: string, offsetDays = 0) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(
      new Date(Date.now() + offsetDays * 86_400_000),
    );
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  it('maps the seeded records to the locked kinds, summaries, actors, and newest-first order', async () => {
    const { operationsApi } = await import('./operationsApi');
    const entries = await operationsApi.getPropertyTimeline(signatureProperty);
    expect(entries.map((entry) => [entry.kind, entry.source_id, entry.summary, entry.actor?.display_name ?? null])).toEqual([
      ['task_created', 'a1000000-0000-4000-8000-000000000001', 'Task created: Follow up on survey plan', 'Alex Villanueva'],
      ['payment_recorded', 'b1000000-0000-4000-8000-000000000002', 'Installment recorded: PHP 1,200,000 · Scheduled', 'Maria Santos'],
      ['task_created', 'a1000000-0000-4000-8000-000000000002', 'Task created: Review title deed for encumbrances', 'Celina Cruz'],
      ['payment_paid', 'b1000000-0000-4000-8000-000000000001', 'Deposit paid: PHP 500,000', null],
      ['payment_recorded', 'b1000000-0000-4000-8000-000000000001', 'Deposit recorded: PHP 500,000 · Paid', 'Maria Santos'],
      ['negotiation_event', '91000000-0000-4000-8000-000000000001', 'Offer: PHP 12,500,000', 'Alex Villanueva'],
      ['document_uploaded', '92000000-0000-4000-8000-000000000001', 'Title deed: Transfer Certificate of Title', 'Celina Cruz'],
      ['negotiation_recorded', '90000000-0000-4000-8000-000000000001', 'Negotiation recorded · opening PHP 12,000,000', null],
    ]);
    expect(entries.find((entry) => entry.kind === 'payment_paid')).toEqual({
      id: 'payment:b1000000-0000-4000-8000-000000000001:payment_paid',
      kind: 'payment_paid',
      source_type: 'payment',
      source_id: 'b1000000-0000-4000-8000-000000000001',
      occurred_at: '2026-08-15',
      precision: 'date',
      basis: 'occurrence',
      actor: null,
      summary: 'Deposit paid: PHP 500,000',
      archived: false,
    });
    expect(entries.find((entry) => entry.kind === 'negotiation_event')).toMatchObject({
      occurred_at: '2026-08-12T00:00:00.000Z',
      precision: 'timestamp',
      basis: 'occurrence',
      actor: { id: alex, display_name: 'Alex Villanueva' },
    });
    expect(entries.find((entry) => entry.kind === 'negotiation_recorded')).toMatchObject({ basis: 'recorded', actor: null });
    expect(entries.every((entry) => entry.archived === false)).toBe(true);
  });

  it('never exposes notes, planned dates, or owner links', async () => {
    const { operationsApi } = await import('./operationsApi');
    const serialized = JSON.stringify(await operationsApi.getPropertyTimeline(signatureProperty));
    expect(serialized).not.toContain('Opening offer recorded');
    expect(serialized).not.toContain('2026-09-26');
    expect(serialized).not.toContain('2026-10-01');
    expect(serialized).not.toContain(rosa);
  });

  it('emits payment_paid only for status paid with a reached paid_on date (B1-a)', async () => {
    const { operationsApi } = await import('./operationsApi');
    const make = async (status: 'paid' | 'pending', paidOn: string | null, archive = false) => {
      const payment = await operationsApi.createPayment(emptyProperty, { amount: 1000, paymentType: 'deposit', paidOn });
      await operationsApi.updatePayment(payment.id, { status, ...(archive ? { archived: true } : {}) });
      return payment.id;
    };
    const paidWithDate = await make('paid', '2026-03-01');
    const paidNoDate = await make('paid', null);
    const pendingWithDate = await make('pending', '2026-03-02');
    const pendingNoDate = await make('pending', null);
    const paidTomorrow = await make('paid', dayIn('Asia/Manila', 1));
    const paidToday = await make('paid', dayIn('Asia/Manila'));
    const paidArchived = await make('paid', '2026-03-03', true);

    const entries = await operationsApi.getPropertyTimeline(emptyProperty);
    const kinds = (id: string) => entries.filter((entry) => entry.source_id === id).map((entry) => entry.kind).sort();
    expect(kinds(paidWithDate)).toEqual(['payment_paid', 'payment_recorded']);
    expect(kinds(paidNoDate)).toEqual(['payment_recorded']);
    expect(kinds(pendingWithDate)).toEqual(['payment_recorded']);
    expect(kinds(pendingNoDate)).toEqual(['payment_recorded']);
    expect(kinds(paidTomorrow)).toEqual(['payment_recorded']);
    expect(kinds(paidToday)).toEqual(['payment_paid', 'payment_recorded']);
    expect(kinds(paidArchived)).toEqual([]);
    expect(entries.filter((entry) => entry.kind === 'payment_paid').every((entry) => entry.actor === null)).toBe(true);
  });

  it('excludes future occurrences and sorts date-only entries at the end of their day', async () => {
    const { operationsApi } = await import('./operationsApi');
    await operationsApi.createNegotiationEvent('90000000-0000-4000-8000-000000000001', {
      eventType: 'meeting',
      occurredAt: '2999-01-01T00:00:00.000Z',
    });
    const deed = await uploadExecuted(signatureProperty, 'Deed of Sale');
    const coOwner = await operationsApi.createOwner({ organizationId: '2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f', ownerType: 'individual', displayName: 'Co-owner' });
    const lateOwner = await operationsApi.createOwner({ organizationId: '2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f', ownerType: 'individual', displayName: 'Late owner' });
    await operationsApi.linkPropertyOwner(signatureProperty, { ownerId: coOwner.id });
    await operationsApi.linkPropertyOwner(signatureProperty, { ownerId: lateOwner.id });
    // Same Manila day as the seeded task created at 2026-09-20T00:00Z (08:00 in Manila).
    const sameDay = await operationsApi.createAgreementSignature(signatureProperty, { documentId: deed.id, ownerId: rosa, signedOn: '2026-09-20' });
    const today = await operationsApi.createAgreementSignature(signatureProperty, { documentId: deed.id, ownerId: coOwner.id, signedOn: dayIn('Asia/Manila') });
    const tomorrow = await operationsApi.createAgreementSignature(signatureProperty, { documentId: deed.id, ownerId: lateOwner.id, signedOn: dayIn('Asia/Manila', 1) });

    const entries = await operationsApi.getPropertyTimeline(signatureProperty);
    const order = entries.map((entry) => entry.source_id);
    expect(order).not.toContain(tomorrow.id);
    expect(entries.some((entry) => entry.summary === 'Meeting logged')).toBe(false);
    expect(order).toContain(today.id);
    expect(order.indexOf(sameDay.id)).toBe(order.indexOf('a1000000-0000-4000-8000-000000000001') - 1);
    expect(entries.find((entry) => entry.source_id === sameDay.id)).toMatchObject({
      kind: 'agreement_signed',
      occurred_at: '2026-09-20',
      precision: 'date',
      basis: 'occurrence',
      actor: { id: alex, display_name: 'Alex Villanueva' },
      summary: 'Rosa Mendoza signed Deed of Sale',
    });
  });

  it('uses the organization timezone for date eligibility and rejects an unrecognized zone', async () => {
    const { operationsApi } = await import('./operationsApi');
    const { organizationApi } = await import('./organizationApi');
    const deed = await uploadExecuted(signatureProperty, 'Deed of Sale');
    const signature = await operationsApi.createAgreementSignature(signatureProperty, {
      documentId: deed.id,
      ownerId: rosa,
      signedOn: dayIn('Pacific/Kiritimati'),
    });
    await organizationApi.updateOrganization('2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f', { timezone: 'Pacific/Kiritimati' });
    expect((await operationsApi.getPropertyTimeline(signatureProperty)).map((entry) => entry.source_id)).toContain(signature.id);
    await organizationApi.updateOrganization('2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f', { timezone: 'Pacific/Pago_Pago' });
    expect((await operationsApi.getPropertyTimeline(signatureProperty)).map((entry) => entry.source_id)).not.toContain(signature.id);
    await organizationApi.updateOrganization('2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f', { timezone: 'Not/AZone' });
    await expect(operationsApi.getPropertyTimeline(signatureProperty)).rejects.toThrow(/time zone/);
  });

  it('excludes archived records, follows negotiation archiving for events, and keeps signatures on archived documents', async () => {
    const { operationsApi } = await import('./operationsApi');
    const deed = await uploadExecuted(signatureProperty, 'Deed later archived');
    const other = await operationsApi.createOwner({ organizationId: '2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f', ownerType: 'individual', displayName: 'Other owner' });
    await operationsApi.linkPropertyOwner(signatureProperty, { ownerId: other.id });
    const kept = await operationsApi.createAgreementSignature(signatureProperty, { documentId: deed.id, ownerId: rosa, signedOn: '2026-09-01' });
    const dropped = await operationsApi.createAgreementSignature(signatureProperty, { documentId: deed.id, ownerId: other.id, signedOn: '2026-09-01' });
    await operationsApi.archiveAgreementSignature(dropped.id);
    await operationsApi.updateDocument(deed.id, { archived: true });
    await operationsApi.updateTask('a1000000-0000-4000-8000-000000000002', { archived: true });
    await operationsApi.updateNegotiation('90000000-0000-4000-8000-000000000001', { archivedAt: new Date().toISOString() });

    const order = (await operationsApi.getPropertyTimeline(signatureProperty)).map((entry) => entry.source_id);
    expect(order).toContain(kept.id);
    expect(order).not.toContain(dropped.id);
    expect(order).not.toContain(deed.id);
    expect(order).not.toContain('a1000000-0000-4000-8000-000000000002');
    expect(order).not.toContain('90000000-0000-4000-8000-000000000001');
    expect(order).not.toContain('91000000-0000-4000-8000-000000000001');
  });

  it('pages by limit and offset with a default of 50, a maximum of 200, and stable boundaries', async () => {
    const { operationsApi } = await import('./operationsApi');
    for (let index = 0; index < 55; index += 1) {
      await operationsApi.createTask(emptyProperty, { title: `Page task ${index}` });
    }
    expect(await operationsApi.getPropertyTimeline(emptyProperty)).toHaveLength(50);
    expect(await operationsApi.getPropertyTimeline(emptyProperty, { limit: 200 })).toHaveLength(55);
    expect(await operationsApi.getPropertyTimeline(emptyProperty, { offset: 50 })).toHaveLength(5);

    const all = (await operationsApi.getPropertyTimeline(signatureProperty)).map((entry) => entry.id);
    const pages = [
      ...(await operationsApi.getPropertyTimeline(signatureProperty, { limit: 3 })),
      ...(await operationsApi.getPropertyTimeline(signatureProperty, { limit: 3, offset: 3 })),
      ...(await operationsApi.getPropertyTimeline(signatureProperty, { limit: 3, offset: 6 })),
    ].map((entry) => entry.id);
    expect(pages).toEqual(all);

    for (const page of [{ limit: 0 }, { limit: 201 }, { limit: 2.5 }, { offset: -1 }]) {
      await expect(operationsApi.getPropertyTimeline(signatureProperty, page)).rejects.toThrow(/validation/);
    }
    await expect(operationsApi.getPropertyTimeline('70000000-0000-4000-8000-00000000dead')).rejects.toThrow(/Property not found/);
  });

  it('reads without changing any source record', async () => {
    const { operationsApi } = await import('./operationsApi');
    const snapshot = async () =>
      JSON.stringify([
        await operationsApi.listNegotiations('2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f', { propertyId: signatureProperty }),
        await operationsApi.listNegotiationEvents('90000000-0000-4000-8000-000000000001'),
        await operationsApi.listDocuments(signatureProperty, { includeArchived: true }),
        await operationsApi.listTasks(signatureProperty, { includeArchived: true }),
        await operationsApi.listPayments(signatureProperty, { includeArchived: true }),
        await operationsApi.listAgreementSignatures(signatureProperty, { includeArchived: true }),
        await operationsApi.getProperty(signatureProperty),
      ]);
    const before = await snapshot();
    await operationsApi.getPropertyTimeline(signatureProperty);
    await operationsApi.getPropertyTimeline(signatureProperty, { limit: 2, offset: 1 });
    expect(await snapshot()).toBe(before);
  });

  // Interactions (Gate A): the demo mirrors the database guard and the
  // Timeline branch. The demo actor is always system_admin, so role denial
  // and supervisor/negotiator scope are proven in the mocked and PostgreSQL suites.
  it('records, lists, and archives an interaction with server-derived fields', async () => {
    const { operationsApi } = await import('./operationsApi');
    const created = await operationsApi.createInteraction(signatureProperty, {
      interactionType: 'site_visit',
      notes: '  Walked the boundary with the owner.  ',
      ownerId: rosa,
    });
    expect(created).toMatchObject({
      property_id: signatureProperty,
      owner_id: rosa,
      owner_name: 'Rosa Mendoza',
      interaction_type: 'site_visit',
      notes: 'Walked the boundary with the owner.',
      recorded_by_user_id: alex,
      recorded_by_name: 'Alex Villanueva',
      archived_at: null,
    });
    expect((await operationsApi.listInteractions(signatureProperty)).map((row) => row.id)).toEqual([created.id]);

    const archived = await operationsApi.archiveInteraction(created.id);
    expect(archived.archived_at).not.toBeNull();
    expect(archived).toMatchObject({ notes: 'Walked the boundary with the owner.', interaction_type: 'site_visit' });
    expect((await operationsApi.archiveInteraction(created.id)).archived_at).toBe(archived.archived_at);
    expect(await operationsApi.listInteractions(signatureProperty)).toEqual([]);
    await expect(operationsApi.archiveInteraction('c0000000-0000-4000-8000-00000000dead')).rejects.toThrow(/not found/);
  });

  it('accepts exactly the five locked types and rejects note, follow_up, and blank or oversized notes', async () => {
    const { operationsApi } = await import('./operationsApi');
    for (const interactionType of ['call', 'meeting', 'site_visit', 'message', 'other'] as const) {
      await operationsApi.createInteraction(emptyProperty, { interactionType, notes: 'x'.repeat(4000) });
    }
    for (const interactionType of ['note', 'follow_up', 'offer']) {
      await expect(
        operationsApi.createInteraction(emptyProperty, { interactionType: interactionType as 'call', notes: 'x' }),
      ).rejects.toThrow(/validation/);
    }
    for (const notes of ['', ' \n\t ', 'x'.repeat(4001)]) {
      await expect(operationsApi.createInteraction(emptyProperty, { interactionType: 'call', notes })).rejects.toThrow(/validation/);
    }
    expect(await operationsApi.listInteractions(emptyProperty)).toHaveLength(5);
  });

  it('keeps the owner optional and requires a supplied owner to be linked to the property', async () => {
    const { operationsApi } = await import('./operationsApi');
    const stranger = await operationsApi.createOwner({
      organizationId: '2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f',
      ownerType: 'individual',
      displayName: 'Not Linked Here',
    });
    expect((await operationsApi.createInteraction(signatureProperty, { interactionType: 'call', notes: 'x' })).owner_id).toBeNull();
    await expect(
      operationsApi.createInteraction(signatureProperty, { interactionType: 'call', notes: 'x', ownerId: stranger.id }),
    ).rejects.toThrow(/existing owner/);
    await expect(
      operationsApi.createInteraction(emptyProperty, { interactionType: 'call', notes: 'x', ownerId: rosa }),
    ).rejects.toThrow(/existing owner/);
  });

  it('rejects a future occurredAt with zero tolerance and stamps the current time when omitted', async () => {
    const { operationsApi } = await import('./operationsApi');
    await expect(
      operationsApi.createInteraction(emptyProperty, {
        interactionType: 'call',
        notes: 'x',
        occurredAt: new Date(Date.now() + 1000).toISOString(),
      }),
    ).rejects.toThrow(/future/);
    await expect(
      operationsApi.createInteraction(emptyProperty, { interactionType: 'call', notes: 'x', occurredAt: '2026-09-01 10:00' }),
    ).rejects.toThrow(/validation/);
    const past = await operationsApi.createInteraction(emptyProperty, {
      interactionType: 'call',
      notes: 'x',
      occurredAt: '2026-01-15T09:30:00.000Z',
    });
    expect(past.occurred_at).toBe('2026-01-15T09:30:00.000Z');
    const before = Date.now();
    const stamped = await operationsApi.createInteraction(emptyProperty, { interactionType: 'call', notes: 'x' });
    expect(new Date(stamped.occurred_at).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(stamped.occurred_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('adds interactions to the Timeline at rank 7 with structured summaries, no notes, and no archived entries', async () => {
    const { operationsApi } = await import('./operationsApi');
    // Same instant as the seeded task created at 2026-09-20T00:00Z: the task (rank 4) sorts first.
    const call = await operationsApi.createInteraction(signatureProperty, {
      interactionType: 'call',
      notes: 'Owner shared a private family matter',
      ownerId: rosa,
      occurredAt: '2026-09-20T00:00:00.000Z',
    });
    const visit = await operationsApi.createInteraction(signatureProperty, {
      interactionType: 'site_visit',
      notes: 'Gate code 4471',
      occurredAt: '2026-09-21T00:00:00.000Z',
    });
    const archived = await operationsApi.createInteraction(signatureProperty, {
      interactionType: 'meeting',
      notes: 'Archived meeting',
      occurredAt: '2026-09-22T00:00:00.000Z',
    });
    await operationsApi.archiveInteraction(archived.id);

    const entries = await operationsApi.getPropertyTimeline(signatureProperty);
    const order = entries.map((entry) => entry.source_id);
    expect(order.slice(0, 4)).toEqual([
      visit.id,
      'a1000000-0000-4000-8000-000000000001',
      'b1000000-0000-4000-8000-000000000002',
      call.id,
    ]);
    expect(entries.find((entry) => entry.source_id === call.id)).toEqual({
      id: `interaction:${call.id}:interaction`,
      kind: 'interaction',
      source_type: 'interaction',
      source_id: call.id,
      occurred_at: '2026-09-20T00:00:00.000Z',
      precision: 'timestamp',
      basis: 'occurrence',
      actor: { id: alex, display_name: 'Alex Villanueva' },
      summary: 'Call with Rosa Mendoza',
      archived: false,
    });
    expect(entries.find((entry) => entry.source_id === visit.id)?.summary).toBe('Site visit');
    expect(order).not.toContain(archived.id);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('private family matter');
    expect(serialized).not.toContain('Gate code');
  });

  it('keeps an interaction after its owner is unlinked and allows many per property and per owner', async () => {
    const { operationsApi } = await import('./operationsApi');
    for (const interactionType of ['call', 'call', 'message'] as const) {
      await operationsApi.createInteraction(signatureProperty, { interactionType, notes: 'x', ownerId: rosa });
    }
    await operationsApi.unlinkPropertyOwner(signatureProperty, rosa);
    const listed = await operationsApi.listInteractions(signatureProperty);
    expect(listed.filter((row) => row.owner_id === rosa)).toHaveLength(3);
    expect(listed.every((row) => row.owner_name === 'Rosa Mendoza')).toBe(true);
    const summaries = (await operationsApi.getPropertyTimeline(signatureProperty)).map((entry) => entry.summary);
    expect(summaries.filter((summary) => summary === 'Call with Rosa Mendoza')).toHaveLength(2);
  });

  it('changes no lifecycle field or other vertical when recording and archiving interactions', async () => {
    const { operationsApi } = await import('./operationsApi');
    const snapshot = async () =>
      JSON.stringify([
        await operationsApi.getProperty(signatureProperty),
        await operationsApi.listNegotiations('2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f', { propertyId: signatureProperty }),
        await operationsApi.listDocuments(signatureProperty, { includeArchived: true }),
        await operationsApi.listTasks(signatureProperty, { includeArchived: true }),
        await operationsApi.listPayments(signatureProperty, { includeArchived: true }),
        await operationsApi.listAgreementSignatures(signatureProperty, { includeArchived: true }),
        await operationsApi.listPropertyOwners(signatureProperty),
      ]);
    const before = await snapshot();
    const created = await operationsApi.createInteraction(signatureProperty, { interactionType: 'meeting', notes: 'x', ownerId: rosa });
    await operationsApi.archiveInteraction(created.id);
    expect(await snapshot()).toBe(before);
  });

  // Lifecycle history (L-01): mirrors public.property_lifecycle_history and
  // Timeline source 8.
  it('records initial stage and status on create and each changed field on update, shown in the Timeline at rank 8', async () => {
    const { operationsApi, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    const property = await operationsApi.createProperty({
      organizationId: DEMO_ORGANIZATION_ID,
      projectId: '6c8e5a14-2b89-4d1d-a2f0-8f9b0a2f0001',
      propertyReference: 'LH-DEMO-1',
    });
    const created = await operationsApi.getPropertyTimeline(property.id);
    expect(created.map((entry) => [entry.source_type, entry.kind, entry.summary]).sort()).toEqual([
      ['lifecycle', 'stage_changed', 'Acquisition stage set to Identified'],
      ['lifecycle', 'status_changed', 'Acquisition status set to Active'],
    ]);
    expect(created.every((entry) => entry.actor?.id === alex && entry.basis === 'occurrence')).toBe(true);

    // Readiness and other non-lifecycle fields record nothing.
    await operationsApi.updateProperty(property.id, { risk: 'high', readinessPercent: 40 });
    expect(await operationsApi.getPropertyTimeline(property.id)).toHaveLength(2);

    // Stage and status in one update: one entry each.
    // Stage and status change through their transitions (L-02, L-03).
    await operationsApi.transitionPropertyStage(property.id, { expectedStage: (await operationsApi.getProperty(property.id)).acquisition_stage, targetStage: 'initial_contact' });
    await operationsApi.transitionPropertyStatus(property.id, { expectedStatus: (await operationsApi.getProperty(property.id)).acquisition_status, targetStatus: 'on_hold' });
    const summaries = (await operationsApi.getPropertyTimeline(property.id)).map((entry) => entry.summary);
    expect(summaries).toHaveLength(4);
    expect(summaries).toEqual(
      expect.arrayContaining([
        'Acquisition stage changed from Identified to Initial contact',
        'Acquisition status changed from Active to On hold',
      ]),
    );
  });

  it('has no lifecycle history for seeded properties (no backfill)', async () => {
    const { operationsApi } = await import('./operationsApi');
    const entries = await operationsApi.getPropertyTimeline(signatureProperty);
    expect(entries.some((entry) => entry.source_type === 'lifecycle')).toBe(false);
  });

  // Stage transitions (L-02): mirrors transition_property_stage(). The demo
  // actor is always system_admin, so role refusals are proven against
  // PostgreSQL; direction, reason, legacy, and no-op rules are mirrored here.
  it('changes the stage only through a transition, forward without a reason and backward with one', async () => {
    const { operationsApi, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    const property = await operationsApi.createProperty({
      organizationId: DEMO_ORGANIZATION_ID,
      projectId: '6c8e5a14-2b89-4d1d-a2f0-8f9b0a2f0001',
      propertyReference: 'ST-DEMO-1',
    });
    await expect(operationsApi.updateProperty(property.id, { acquisitionStage: 'signing' })).rejects.toThrow(/stage transition/);

    expect(await operationsApi.transitionPropertyStage(property.id, { expectedStage: (await operationsApi.getProperty(property.id)).acquisition_stage, targetStage: 'negotiation' })).toMatchObject({
      acquisition_stage: 'negotiation',
      acquisition_status: 'active',
    });
    for (const reason of [undefined, null, '', ' \t\n ']) {
      await expect(operationsApi.transitionPropertyStage(property.id, { expectedStage: (await operationsApi.getProperty(property.id)).acquisition_stage, targetStage: 'documentation', reason })).rejects.toThrow(
        /reason is required/,
      );
    }
    await operationsApi.transitionPropertyStage(property.id, { expectedStage: (await operationsApi.getProperty(property.id)).acquisition_stage, targetStage: 'documentation', reason: ' Missing title copy ' });
    // Same stage is a no-op.
    await operationsApi.transitionPropertyStage(property.id, { expectedStage: (await operationsApi.getProperty(property.id)).acquisition_stage, targetStage: 'documentation' });

    const current = await operationsApi.getProperty(property.id);
    expect(current).toMatchObject({ acquisition_stage: 'documentation', acquisition_status: 'active' });
    const summaries = (await operationsApi.getPropertyTimeline(property.id)).map((entry) => entry.summary);
    // Demo writes can share a millisecond, so compare without order.
    expect(summaries.filter((summary) => summary.startsWith('Acquisition stage')).sort()).toEqual([
      'Acquisition stage changed from Identified to Negotiation',
      'Acquisition stage changed from Negotiation to Documentation',
      'Acquisition stage set to Identified',
    ]);
    expect(JSON.stringify(await operationsApi.getPropertyTimeline(property.id))).not.toContain('Missing title copy');
  });

  it('never selects a legacy value and never moves a property off one', async () => {
    const { operationsApi, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    const create = (propertyReference: string, acquisitionStage?: 'withdrawn') =>
      operationsApi.createProperty({
        organizationId: DEMO_ORGANIZATION_ID,
        projectId: '6c8e5a14-2b89-4d1d-a2f0-8f9b0a2f0001',
        propertyReference,
        acquisitionStage,
      });
    const normal = await create('ST-DEMO-2');
    for (const legacy of ['on_hold', 'withdrawn', 'acquisition_complete'] as const) {
      await expect(operationsApi.transitionPropertyStage(normal.id, { expectedStage: (await operationsApi.getProperty(normal.id)).acquisition_stage, targetStage: legacy, reason: 'x' })).rejects.toThrow(/legacy value/);
    }
    // Since L-05 a legacy value cannot be created either, so the demo holds no
    // legacy rows; moving off one is proven against PostgreSQL.
    await expect(create('ST-DEMO-3', 'withdrawn')).rejects.toThrow(/only be created in the identified stage/);
    await expect(operationsApi.transitionPropertyStage('70000000-0000-4000-8000-00000000dead', { expectedStage: 'identified', targetStage: 'signing' })).rejects.toThrow(
      /Property not found/,
    );
  });

  // Status transitions (L-03): mirrors transition_property_status(). The demo
  // actor is always system_admin, so role refusals (including the supervisor
  // complete reversal) are proven against PostgreSQL; the matrix, reason,
  // override, completion-condition, and no-op rules are mirrored here.
  it('changes the status only through a transition, applying reasons, overrides, and the completion condition', async () => {
    const { operationsApi, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    const property = await operationsApi.createProperty({
      organizationId: DEMO_ORGANIZATION_ID,
      projectId: '6c8e5a14-2b89-4d1d-a2f0-8f9b0a2f0001',
      propertyReference: 'SS-DEMO-1',
    });
    // Since L-05 creation starts in identified; the stage moves forward through a transition.
    await operationsApi.transitionPropertyStage(property.id, { expectedStage: (await operationsApi.getProperty(property.id)).acquisition_stage, targetStage: 'signing' });
    await expect(operationsApi.updateProperty(property.id, { acquisitionStatus: 'complete' })).rejects.toThrow(/status transition/);

    await operationsApi.transitionPropertyStatus(property.id, { expectedStatus: (await operationsApi.getProperty(property.id)).acquisition_status, targetStatus: 'on_hold' });
    await expect(operationsApi.transitionPropertyStatus(property.id, { expectedStatus: (await operationsApi.getProperty(property.id)).acquisition_status, targetStatus: 'on_hold', override: true })).resolves.toMatchObject({
      acquisition_status: 'on_hold',
    });
    await expect(operationsApi.transitionPropertyStatus(property.id, { expectedStatus: (await operationsApi.getProperty(property.id)).acquisition_status, targetStatus: 'active', override: true })).rejects.toThrow(
      /No override applies/,
    );
    for (const reason of [undefined, null, '', ' \t\n ']) {
      await expect(operationsApi.transitionPropertyStatus(property.id, { expectedStatus: (await operationsApi.getProperty(property.id)).acquisition_status, targetStatus: 'withdrawn', reason })).rejects.toThrow(
        /reason is required/,
      );
    }
    await operationsApi.transitionPropertyStatus(property.id, { expectedStatus: (await operationsApi.getProperty(property.id)).acquisition_status, targetStatus: 'withdrawn', reason: ' Owner declined ' });
    await expect(
      operationsApi.transitionPropertyStatus(property.id, { expectedStatus: (await operationsApi.getProperty(property.id)).acquisition_status, targetStatus: 'complete', reason: 'Closed anyway' }),
    ).rejects.toThrow(/requires an override \(withdrawn_reversal, completion_stage_condition\)/);
    const completed = await operationsApi.transitionPropertyStatus(property.id, { expectedStatus: (await operationsApi.getProperty(property.id)).acquisition_status,
      targetStatus: 'complete',
      reason: 'Closed anyway',
      override: true,
    });
    expect(completed).toMatchObject({ acquisition_stage: 'signing', acquisition_status: 'complete' });
    await operationsApi.transitionPropertyStatus(property.id, { expectedStatus: (await operationsApi.getProperty(property.id)).acquisition_status, targetStatus: 'active', reason: 'Payment bounced', override: true });

    const summaries = (await operationsApi.getPropertyTimeline(property.id))
      .filter((entry) => entry.kind === 'status_changed')
      .map((entry) => entry.summary)
      .sort();
    expect(summaries).toEqual([
      'Acquisition status changed from Active to On hold',
      'Acquisition status changed from Complete to Active (override)',
      'Acquisition status changed from On hold to Withdrawn',
      'Acquisition status changed from Withdrawn to Complete (override)',
      'Acquisition status set to Active',
    ]);
    const serialized = JSON.stringify(await operationsApi.getPropertyTimeline(property.id));
    expect(serialized).not.toContain('Payment bounced');
    expect(serialized).not.toContain('complete_reversal');
    expect((await operationsApi.getProperty(property.id)).acquisition_stage).toBe('signing');
  });

  it('completes at payment_closing without an override and refuses an unneeded one', async () => {
    const { operationsApi, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    const property = await operationsApi.createProperty({
      organizationId: DEMO_ORGANIZATION_ID,
      projectId: '6c8e5a14-2b89-4d1d-a2f0-8f9b0a2f0001',
      propertyReference: 'SS-DEMO-2',
    });
    // Since L-05 creation starts in identified; the stage moves forward through a transition.
    await operationsApi.transitionPropertyStage(property.id, { expectedStage: (await operationsApi.getProperty(property.id)).acquisition_stage, targetStage: 'payment_closing' });
    await expect(
      operationsApi.transitionPropertyStatus(property.id, { expectedStatus: (await operationsApi.getProperty(property.id)).acquisition_status, targetStatus: 'complete', reason: 'x', override: true }),
    ).rejects.toThrow(/No override applies/);
    expect(await operationsApi.transitionPropertyStatus(property.id, { expectedStatus: (await operationsApi.getProperty(property.id)).acquisition_status, targetStatus: 'complete' })).toMatchObject({
      acquisition_stage: 'payment_closing',
      acquisition_status: 'complete',
    });
    await expect(operationsApi.transitionPropertyStatus('70000000-0000-4000-8000-00000000dead', { expectedStatus: 'active', targetStatus: 'on_hold' })).rejects.toThrow(
      /Property not found/,
    );
  });

  // Negotiation exception (L-04): mirrors transition_property_stage() in 015.
  // The seeded NCP-00102 is in negotiation with an open negotiation.
  it('blocks leaving negotiation with an open negotiation unless the exception is used, leaving the negotiation unchanged', async () => {
    const { operationsApi } = await import('./operationsApi');
    const negotiationsBefore = JSON.stringify(
      await operationsApi.listNegotiations('2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f', { propertyId: signatureProperty }),
    );
    for (const input of [
      { targetStage: 'commercial_review' as const, expectedStage: 'negotiation' as const, reason: 'Terms agreed verbally' },
      { targetStage: 'commercial_review' as const, expectedStage: 'negotiation' as const, reason: 'Terms agreed verbally', override: false },
      { targetStage: 'documentation' as const, expectedStage: 'negotiation' as const, reason: 'Back for papers' },
    ]) {
      await expect(operationsApi.transitionPropertyStage(signatureProperty, input)).rejects.toThrow(
        /requires an override \(negotiation_unresolved_exit\)/,
      );
    }
    for (const reason of [undefined, null, '', ' \t ']) {
      await expect(
        operationsApi.transitionPropertyStage(signatureProperty, { expectedStage: (await operationsApi.getProperty(signatureProperty)).acquisition_stage, targetStage: 'commercial_review', reason, override: true }),
      ).rejects.toThrow(/reason is required to leave negotiation/);
    }
    expect((await operationsApi.getProperty(signatureProperty)).acquisition_stage).toBe('negotiation');

    const moved = await operationsApi.transitionPropertyStage(signatureProperty, { expectedStage: (await operationsApi.getProperty(signatureProperty)).acquisition_stage,
      targetStage: 'commercial_review',
      reason: ' Terms agreed verbally ',
      override: true,
    });
    expect(moved).toMatchObject({ acquisition_stage: 'commercial_review', acquisition_status: 'active' });
    const entries = await operationsApi.getPropertyTimeline(signatureProperty);
    expect(entries.map((entry) => entry.summary)).toContain('Acquisition stage changed from Negotiation to Commercial review (override)');
    expect(JSON.stringify(entries)).not.toContain('Terms agreed verbally');
    expect(JSON.stringify(entries)).not.toContain('negotiation_unresolved_exit');
    expect(
      JSON.stringify(await operationsApi.listNegotiations('2cb1ec8c-2fc4-47b9-99ec-bb1e7d64a91f', { propertyId: signatureProperty })),
    ).toBe(negotiationsBefore);
  });

  // Creation rules (L-05): mirrors enforce_property_creation_rules() (P-6).
  it('creates properties only in identified and active, with the creation history, and nothing on refusal', async () => {
    const { operationsApi, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    const base = { organizationId: DEMO_ORGANIZATION_ID, projectId: '6c8e5a14-2b89-4d1d-a2f0-8f9b0a2f0001' };
    const before = (await operationsApi.listProperties(DEMO_ORGANIZATION_ID)).length;
    expect(before).toBeGreaterThan(0);
    for (const acquisitionStage of [
      'initial_contact',
      'negotiation',
      'payment_closing',
      'on_hold',
      'withdrawn',
      'acquisition_complete',
    ] as const) {
      await expect(operationsApi.createProperty({ ...base, propertyReference: `CR-DEMO-${acquisitionStage}`, acquisitionStage })).rejects.toThrow(
        /only be created in the identified stage/,
      );
    }
    expect((await operationsApi.listProperties(DEMO_ORGANIZATION_ID)).length).toBe(before);

    for (const acquisitionStage of [undefined, 'identified'] as const) {
      const created = await operationsApi.createProperty({ ...base, propertyReference: `CR-DEMO-${acquisitionStage ?? 'default'}`, acquisitionStage });
      expect(created).toMatchObject({ acquisition_stage: 'identified', acquisition_status: 'active' });
      expect((await operationsApi.getPropertyTimeline(created.id)).map((entry) => entry.summary).sort()).toEqual([
        'Acquisition stage set to Identified',
        'Acquisition status set to Active',
      ]);
    }
  });

  it('refuses an override on a stage transition where no designated rule applies', async () => {
    const { operationsApi, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    const property = await operationsApi.createProperty({
      organizationId: DEMO_ORGANIZATION_ID,
      projectId: '6c8e5a14-2b89-4d1d-a2f0-8f9b0a2f0001',
      propertyReference: 'NX-DEMO-1',
    });
    // Since L-05 creation starts in identified; the stage moves forward through a transition.
    await operationsApi.transitionPropertyStage(property.id, { expectedStage: (await operationsApi.getProperty(property.id)).acquisition_stage, targetStage: 'negotiation' });
    await expect(
      operationsApi.transitionPropertyStage(property.id, { expectedStage: (await operationsApi.getProperty(property.id)).acquisition_stage, targetStage: 'commercial_review', reason: 'x', override: true }),
    ).rejects.toThrow(/No override applies/);
    expect(await operationsApi.transitionPropertyStage(property.id, { expectedStage: (await operationsApi.getProperty(property.id)).acquisition_stage, targetStage: 'commercial_review' })).toMatchObject({
      acquisition_stage: 'commercial_review',
    });
  });

  // Legacy stage remediation (L-06): mirrors the 017 functions. The seeded
  // NCP-00077 is a pre-existing record on the legacy stage withdrawn. The demo
  // actor is always system_admin, so role refusals are proven against PostgreSQL.
  const legacySeed = '70000000-0000-4000-8000-000000000004';

  it('remediates a legacy stage only through review and resolution with reason and evidence, then reopens as a new cycle', async () => {
    const { operationsApi, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    expect((await operationsApi.listRemediationQueue(DEMO_ORGANIZATION_ID)).map((item) => [item.property_reference, item.state])).toEqual([
      ['NCP-00077', 'NOT_REVIEWED'],
    ]);
    // Ordinary paths never convert it.
    await expect(operationsApi.transitionPropertyStage(legacySeed, { expectedStage: (await operationsApi.getProperty(legacySeed)).acquisition_stage, targetStage: 'documentation', reason: 'x' })).rejects.toThrow(/remediation/);
    await expect(operationsApi.updateProperty(legacySeed, { acquisitionStage: 'documentation' })).rejects.toThrow(/stage transition/);

    await expect(operationsApi.escalateRemediation(legacySeed, { reason: 'x' })).rejects.toThrow(/No remediation cycle/);
    expect(await operationsApi.startRemediation(legacySeed)).toMatchObject({ cycle: 1, legacy_value: 'withdrawn', state: 'UNDER_REVIEW' });
    await expect(operationsApi.startRemediation(legacySeed)).rejects.toThrow(/already has a remediation cycle/);
    for (const reason of [undefined, null, '', ' \t ']) {
      await expect(operationsApi.escalateRemediation(legacySeed, { reason })).rejects.toThrow(/reason is required/);
    }
    await operationsApi.escalateRemediation(legacySeed, { reason: 'Survey missing' });
    await expect(
      operationsApi.resolveRemediation(legacySeed, { expectedStage: (await operationsApi.getProperty(legacySeed)).acquisition_stage, resultingStage: 'documentation', reason: 'x', evidence: 'y' }),
    ).rejects.toThrow(/No remediation cycle of this property is UNDER_REVIEW/);
    expect((await operationsApi.getProperty(legacySeed)).acquisition_stage).toBe('withdrawn');
    // Q-4: returning to review takes an optional reason.
    await operationsApi.returnRemediationToReview(legacySeed, {});
    await operationsApi.escalateRemediation(legacySeed, { reason: ' Still missing ' });
    await operationsApi.returnRemediationToReview(legacySeed, { reason: '  Survey found ' });

    for (const reason of [undefined, null, '', '   ']) {
      await expect(operationsApi.resolveRemediation(legacySeed, { expectedStage: (await operationsApi.getProperty(legacySeed)).acquisition_stage, resultingStage: 'documentation', reason, evidence: 'Survey 2024' })).rejects.toThrow(
        /reason is required to resolve/,
      );
    }
    for (const evidence of [undefined, null, '', '   ']) {
      await expect(operationsApi.resolveRemediation(legacySeed, { expectedStage: (await operationsApi.getProperty(legacySeed)).acquisition_stage, resultingStage: 'documentation', reason: 'Survey decides', evidence })).rejects.toThrow(
        /Supporting evidence is required/,
      );
    }
    await expect(
      operationsApi.resolveRemediation(legacySeed, { expectedStage: (await operationsApi.getProperty(legacySeed)).acquisition_stage, resultingStage: 'on_hold', reason: 'Survey decides', evidence: 'Survey 2024' }),
    ).rejects.toThrow(/legacy value/);
    const otherDocument = (await operationsApi.listDocuments(signatureProperty))[0];
    await expect(
      operationsApi.resolveRemediation(legacySeed, { expectedStage: (await operationsApi.getProperty(legacySeed)).acquisition_stage,
        resultingStage: 'documentation',
        reason: 'Survey decides',
        evidence: 'Survey 2024',
        evidenceDocumentId: otherDocument.id,
      }),
    ).rejects.toThrow(/must belong to this property/);
    const interaction = await operationsApi.createInteraction(legacySeed, { interactionType: 'call', notes: 'Owner confirmed' });
    expect((await operationsApi.getProperty(legacySeed)).acquisition_stage).toBe('withdrawn');

    const resolved = await operationsApi.resolveRemediation(legacySeed, { expectedStage: (await operationsApi.getProperty(legacySeed)).acquisition_stage,
      resultingStage: 'documentation',
      reason: '  Survey decides ',
      evidence: ' Survey 2024 ',
      evidenceInteractionId: interaction.id,
    });
    expect(resolved).toMatchObject({
      state: 'RESOLVED',
      resulting_stage: 'documentation',
      resolution_reason: 'Survey decides',
      evidence: 'Survey 2024',
      evidence_interaction_id: interaction.id,
    });
    expect(await operationsApi.getProperty(legacySeed)).toMatchObject({ acquisition_stage: 'documentation', acquisition_status: 'active' });
    const entries = await operationsApi.getPropertyTimeline(legacySeed);
    expect(entries.map((entry) => entry.summary)).toContain('Acquisition stage changed from Withdrawn to Documentation (legacy remediation)');
    expect(JSON.stringify(entries)).not.toContain('Survey decides');
    expect(await operationsApi.listRemediationQueue(DEMO_ORGANIZATION_ID)).toEqual([]);

    // Q-5: reopening takes an optional reason.
    expect(await operationsApi.reopenRemediation(legacySeed, {})).toMatchObject({
      cycle: 2,
      stage_at_open: 'documentation',
      legacy_value: 'withdrawn',
      state: 'UNDER_REVIEW',
    });
    await expect(operationsApi.resolveRemediation(legacySeed, { expectedStage: (await operationsApi.getProperty(legacySeed)).acquisition_stage, resultingStage: 'signing', reason: 'x', evidence: ' ' })).rejects.toThrow(
      /Supporting evidence is required/,
    );
    const cycles = await operationsApi.listPropertyRemediations(legacySeed);
    expect(cycles.map((cycle) => [cycle.cycle, cycle.state, cycle.resulting_stage])).toEqual([
      [1, 'RESOLVED', 'documentation'],
      [2, 'UNDER_REVIEW', null],
    ]);
    expect(cycles[0].events?.map((event) => [event.action, event.reason])).toEqual([
      ['review_started', null],
      ['escalated', 'Survey missing'],
      ['returned_to_review', null],
      ['escalated', 'Still missing'],
      ['returned_to_review', 'Survey found'],
      ['resolved', 'Survey decides'],
    ]);
    expect(cycles[1].events?.map((event) => [event.action, event.reason])).toEqual([['reopened', null]]);
  });

  it('refuses to remediate a property that is not on a legacy stage', async () => {
    const { operationsApi } = await import('./operationsApi');
    await expect(operationsApi.startRemediation(signatureProperty)).rejects.toThrow(/not a legacy value/);
  });

  // Lifecycle concurrency (L-07): the demo mirrors the 409 lifecycle conflict
  // the functions raise for a stale expected value (D-X1, S-25).
  it('refuses stale stage, status, and resolution requests as lifecycle conflicts, changing nothing', async () => {
    const { operationsApi, isLifecycleConflict, OperationsApiError, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    const property = await operationsApi.createProperty({
      organizationId: DEMO_ORGANIZATION_ID,
      projectId: '6c8e5a14-2b89-4d1d-a2f0-8f9b0a2f0001',
      propertyReference: 'CC-DEMO-1',
    });
    await operationsApi.transitionPropertyStage(property.id, { targetStage: 'documentation', expectedStage: 'identified' });

    const stale = await operationsApi
      .transitionPropertyStage(property.id, { targetStage: 'initial_contact', expectedStage: 'identified' })
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(OperationsApiError);
    expect(isLifecycleConflict(stale)).toBe(true);
    expect(stale).toMatchObject({
      status: 409,
      code: 'lifecycle_conflict',
      details: { conflict: 'lifecycle', field: 'acquisition_stage', current: 'documentation', expected: 'identified' },
    });
    // A stale no-op is a conflict too, not a success.
    await expect(
      operationsApi.transitionPropertyStage(property.id, { targetStage: 'documentation', expectedStage: 'identified' }),
    ).rejects.toMatchObject({ code: 'lifecycle_conflict' });
    await expect(operationsApi.transitionPropertyStatus(property.id, { targetStatus: 'on_hold', expectedStatus: 'withdrawn' })).rejects.toMatchObject({
      code: 'lifecycle_conflict',
      details: { field: 'acquisition_status', current: 'active', expected: 'withdrawn' },
    });
    const summaries = (await operationsApi.getPropertyTimeline(property.id)).map((entry) => entry.summary).sort();
    expect(summaries).toEqual([
      'Acquisition stage changed from Identified to Documentation',
      'Acquisition stage set to Identified',
      'Acquisition status set to Active',
    ]);

    await operationsApi.startRemediation(legacySeed);
    await expect(
      operationsApi.resolveRemediation(legacySeed, { resultingStage: 'documentation', expectedStage: 'on_hold', reason: 'x', evidence: 'y' }),
    ).rejects.toMatchObject({ code: 'lifecycle_conflict', details: { current: 'withdrawn', expected: 'on_hold' } });
    expect((await operationsApi.listPropertyRemediations(legacySeed))[0].state).toBe('UNDER_REVIEW');

    // Other refusals are not conflicts.
    const invalid = await operationsApi
      .transitionPropertyStage(property.id, { targetStage: 'identified', expectedStage: 'documentation' })
      .catch((error: unknown) => error);
    expect(isLifecycleConflict(invalid)).toBe(false);
  });
});
