import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as operationsSchemas from '../../server/operationsSchemas';
import * as organizationSchemas from '../../server/schemas';
import { REQUEST_BODY_KEYS, unknownRequestKeys, type RequestBodyOperation } from './requestKeys';

// The demo adapters refuse the same request-body keys the API refuses. These
// lists must stay equal to the server schemas' keys.
const SERVER_SCHEMA: Record<RequestBodyOperation, { shape: Record<string, unknown> }> = {
  createOwner: operationsSchemas.createOwnerSchema,
  createProperty: operationsSchemas.createPropertySchema,
  updateProperty: operationsSchemas.updatePropertySchema,
  transitionPropertyStage: operationsSchemas.stageTransitionSchema,
  transitionPropertyStatus: operationsSchemas.statusTransitionSchema,
  remediationStep: operationsSchemas.remediationStepSchema,
  resolveRemediation: operationsSchemas.remediationResolveSchema,
  linkPropertyOwner: operationsSchemas.linkOwnerSchema,
  createNegotiation: operationsSchemas.createNegotiationSchema,
  updateNegotiation: operationsSchemas.updateNegotiationSchema,
  createNegotiationEvent: operationsSchemas.createNegotiationEventSchema,
  uploadDocument: operationsSchemas.createDocumentFieldsSchema,
  updateDocument: operationsSchemas.updateDocumentSchema,
  createTask: operationsSchemas.createTaskSchema,
  updateTask: operationsSchemas.updateTaskSchema,
  createPayment: operationsSchemas.createPaymentSchema,
  updatePayment: operationsSchemas.updatePaymentSchema,
  createAgreementSignature: operationsSchemas.createAgreementSignatureSchema,
  createInteraction: operationsSchemas.createInteractionSchema,
  onboardOrganization: organizationSchemas.onboardOrganizationSchema,
  updateOrganization: organizationSchemas.updateOrganizationSchema,
  updateMember: organizationSchemas.updateMembershipSchema,
  createInvitation: organizationSchemas.createInvitationSchema,
};

describe('demo request-body keys', () => {
  it.each(Object.keys(REQUEST_BODY_KEYS) as RequestBodyOperation[])('%s matches the server schema keys', (operation) => {
    expect([...REQUEST_BODY_KEYS[operation]].sort()).toEqual(Object.keys(SERVER_SCHEMA[operation].shape).sort());
  });

  it('reports only the keys outside the operation', () => {
    expect(unknownRequestKeys({ title: 'T', stauts: 'done', priority: 'high' }, 'updateTask')).toEqual(['stauts']);
    expect(unknownRequestKeys({ metadata: { anything: { nested: 1 } } }, 'updateProperty')).toEqual([]);
  });
});

describe('demo adapters refuse unknown request-body keys like the API', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_BASE_URL', '');
  });

  it('refuses an unknown key on a property update without changing the property', async () => {
    const { operationsApi, OperationsApiError, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    const project = await operationsApi.createProject({ organization_id: DEMO_ORGANIZATION_ID, code: 'NCP-E1', name: 'Strict' });
    const property = await operationsApi.createProperty({ organizationId: DEMO_ORGANIZATION_ID, projectId: project.id, propertyReference: 'NCP-E1001' });
    const before = await operationsApi.getProperty(property.id);

    const refused = operationsApi.updateProperty(property.id, { risk: 'high', riks: 'low' });
    await expect(refused).rejects.toBeInstanceOf(OperationsApiError);
    await expect(refused).rejects.toMatchObject({ status: 400, code: 'validation_error', message: 'Request validation failed' });
    expect(await operationsApi.getProperty(property.id)).toEqual(before);

    // Known keys, free-form metadata, and the specific lifecycle refusals still behave as before.
    await expect(operationsApi.updateProperty(property.id, { risk: 'high', metadata: { any: { nested: true } } })).resolves.toMatchObject({ risk: 'high' });
    await expect(operationsApi.updateProperty(property.id, { acquisitionStage: 'signing' })).rejects.toThrow(/stage transition/);
  });

  it('refuses an unknown key on a create before anything is stored', async () => {
    const { operationsApi, DEMO_ORGANIZATION_ID } = await import('./operationsApi');
    const project = await operationsApi.createProject({ organization_id: DEMO_ORGANIZATION_ID, code: 'NCP-E2', name: 'Strict' });
    const count = (await operationsApi.listProperties(DEMO_ORGANIZATION_ID)).length;
    await expect(
      operationsApi.createProperty({ organizationId: DEMO_ORGANIZATION_ID, projectId: project.id, propertyReference: 'NCP-E2001', acquisitionStatus: 'complete' } as never),
    ).rejects.toMatchObject({ status: 400, code: 'validation_error' });
    expect(await operationsApi.listProperties(DEMO_ORGANIZATION_ID)).toHaveLength(count);
  });

  it('refuses an unknown key on a membership update without changing the member', async () => {
    const { organizationApi, OrganizationApiError } = await import('./organizationApi');
    const { organizations: [organization] } = await organizationApi.getMe();
    const [member] = await organizationApi.listMembers(organization.id);
    const refused = organizationApi.updateMember(organization.id, member.user_id, { isActive: false, rol: 'viewer' } as never);
    await expect(refused).rejects.toBeInstanceOf(OrganizationApiError);
    await expect(refused).rejects.toMatchObject({ status: 400, code: 'validation_error' });
    expect((await organizationApi.listMembers(organization.id))[0]).toEqual(member);
  });
});

describe('uploadDocument refuses unknown input keys in live and demo mode', () => {
  const apiBase = 'https://api.example.com/api/v1';
  const propertyId = '70000000-0000-4000-8000-000000000001';
  const negotiationId = '71000000-0000-4000-8000-000000000001';
  const config = { documentUpload: { maxSizeBytes: 1024 * 1024, acceptedMimeTypes: ['application/pdf'] } };
  const pdf = () => new File(['deed contents'], 'deed.pdf', { type: 'application/pdf' });

  function respond(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  async function loadLiveClient() {
    vi.resetModules();
    vi.stubEnv('VITE_API_BASE_URL', `${apiBase}/`);
    window.__BIZCAIAOS_AUTH__ = { getAccessToken: vi.fn().mockResolvedValue('verified-jwt-token') };
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) =>
      url.endsWith('/ops/config') ? respond({ data: config }) : respond({ data: { id: 'document-1', title: 'Deed' } }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);
    return { ...(await import('./operationsApi')), fetchMock };
  }

  async function loadDemoClient() {
    vi.resetModules();
    vi.stubEnv('VITE_API_BASE_URL', '');
    return import('./operationsApi');
  }

  async function rejection(promise: Promise<unknown>) {
    const error = await promise.then(() => null, (reason: unknown) => reason);
    expect(error).not.toBeNull();
    const { name, message, status, code } = error as { name: string; message: string; status: number; code: string };
    return { name, message, status, code };
  }

  const refused = { name: 'OperationsApiError', message: 'Request validation failed', status: 400, code: 'validation_error' };
  const invalidInputs: Record<string, Record<string, unknown>> = {
    'one unknown key': { unexpectedKey: 1 },
    'several unknown keys': { unexpectedKey: 1, other: 'x', nested: { deep: true } },
    'a server-owned field': { storageProvider: 's3' },
  };

  afterEach(() => {
    delete window.__BIZCAIAOS_AUTH__;
    vi.unstubAllGlobals();
  });

  it('sends a valid live upload as multipart with the same fields, method, endpoint and token', async () => {
    const { operationsApi, fetchMock } = await loadLiveClient();
    const file = pdf();

    await expect(operationsApi.uploadDocument(propertyId, { category: 'title_deed', title: 'Deed', negotiationId, file })).resolves.toEqual({ id: 'document-1', title: 'Deed' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`${apiBase}/ops/config`);
    const [url, init = {}] = fetchMock.mock.calls[1];
    expect(url).toBe(`${apiBase}/ops/properties/${propertyId}/documents`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer verified-jwt-token' });
    const body = init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect([...body.keys()]).toEqual(['category', 'title', 'negotiationId', 'file']);
    expect(body.get('category')).toBe('title_deed');
    expect(body.get('title')).toBe('Deed');
    expect(body.get('negotiationId')).toBe(negotiationId);
    expect((body.get('file') as File).name).toBe('deed.pdf');

    // Without a negotiation the field is still left out, as before.
    await operationsApi.uploadDocument(propertyId, { category: 'title_deed', title: 'Deed', negotiationId: null, file });
    expect([...(fetchMock.mock.calls[3][1]?.body as FormData).keys()]).toEqual(['category', 'title', 'file']);
  });

  it.each(Object.entries(invalidInputs))('refuses %s in live mode before any request is sent', async (_label, extra) => {
    const { operationsApi, fetchMock } = await loadLiveClient();
    const input = { category: 'title_deed' as const, title: 'Deed', file: pdf(), ...extra };

    expect(await rejection(operationsApi.uploadDocument(propertyId, input))).toEqual(refused);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(Object.entries(invalidInputs))('refuses %s in demo mode before anything is stored', async (_label, extra) => {
    const { operationsApi } = await loadDemoClient();
    const before = await operationsApi.listDocuments(propertyId);
    const input = { category: 'title_deed' as const, title: 'Deed', file: pdf(), ...extra };

    expect(await rejection(operationsApi.uploadDocument(propertyId, input))).toEqual(refused);
    expect(await operationsApi.listDocuments(propertyId)).toEqual(before);
  });

  it('still uploads a valid document in demo mode', async () => {
    const { operationsApi } = await loadDemoClient();
    const count = (await operationsApi.listDocuments(propertyId)).length;
    await expect(operationsApi.uploadDocument(propertyId, { category: 'title_deed', title: 'Deed', file: pdf() })).resolves.toMatchObject({
      title: 'Deed',
      storage_provider: 'local',
      original_filename: 'deed.pdf',
    });
    expect(await operationsApi.listDocuments(propertyId)).toHaveLength(count + 1);
  });

  it('gives the same rejection for the same invalid input in live and demo mode', async () => {
    const input = { category: 'title_deed' as const, title: 'Deed', file: pdf(), storageProvider: 's3', unexpectedKey: 1 };
    const live = await rejection((await loadLiveClient()).operationsApi.uploadDocument(propertyId, input));
    const demo = await rejection((await loadDemoClient()).operationsApi.uploadDocument(propertyId, input));
    expect(live).toEqual(demo);
    expect(live).toEqual(refused);
  });
});
