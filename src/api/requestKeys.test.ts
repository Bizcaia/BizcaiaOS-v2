import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as operationsSchemas from '../../server/operationsSchemas';
import * as organizationSchemas from '../../server/schemas';
import { REQUEST_BODY_KEYS, unknownBigIntKeys, unknownRequestKeys, type RequestBodyOperation } from './requestKeys';

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

  it('ignores an unknown key whose value is undefined, which a live request never sends', () => {
    expect(unknownRequestKeys({ title: 'T', stauts: undefined }, 'updateTask')).toEqual([]);
    for (const value of ['x', 0, false, {}, [], null]) {
      expect(unknownRequestKeys({ title: 'T', stauts: value }, 'updateTask')).toEqual(['stauts']);
    }
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

describe('unknown keys follow the serialized JSON body alike in live and demo mode', () => {
  const apiBase = 'https://api.example.com/api/v1';
  const propertyId = '70000000-0000-4000-8000-000000000001';
  type Api = Record<string, (...args: unknown[]) => Promise<unknown>>;
  type Sent = { method: string; path: string; body: unknown };

  // Every client function that checks its request body, with placeholder ids;
  // the input is passed as the last argument.
  const OPERATIONS: [api: 'operations' | 'organization', name: string, args: unknown[], input: Record<string, unknown>][] = [
    ['operations', 'createOwner', [], { ownerType: 'individual', displayName: 'Owner', contactDetails: { any: { nested: true } } }],
    ['operations', 'createProperty', [], { propertyReference: 'NCP-U1' }],
    ['operations', 'updateProperty', ['id-1'], { risk: 'high', metadata: { any: { nested: true } } }],
    ['operations', 'transitionPropertyStage', ['id-1'], { targetStage: 'negotiation', expectedStage: 'identified' }],
    ['operations', 'escalateRemediation', ['id-1'], { reason: 'r' }],
    ['operations', 'returnRemediationToReview', ['id-1'], { reason: 'r' }],
    ['operations', 'resolveRemediation', ['id-1'], { resultingStage: 'identified', expectedStage: 'identified', reason: 'r' }],
    ['operations', 'reopenRemediation', ['id-1'], { reason: 'r' }],
    ['operations', 'transitionPropertyStatus', ['id-1'], { targetStatus: 'active', expectedStatus: 'active' }],
    ['operations', 'linkPropertyOwner', ['id-1'], { ownerId: 'owner-1' }],
    ['operations', 'createNegotiation', [], { propertyId: 'id-1' }],
    ['operations', 'updateNegotiation', ['id-1'], { status: 'paused' }],
    ['operations', 'createNegotiationEvent', ['id-1'], { eventType: 'note', metadata: { any: { nested: true } } }],
    ['operations', 'updateDocument', ['id-1'], { title: 'T' }],
    ['operations', 'createTask', ['id-1'], { title: 'T' }],
    ['operations', 'updateTask', ['id-1'], { title: 'T' }],
    ['operations', 'createPayment', ['id-1'], { amount: 1, paymentType: 'deposit' }],
    ['operations', 'updatePayment', ['id-1'], { amount: 1 }],
    ['operations', 'createAgreementSignature', ['id-1'], { documentId: 'document-1', ownerId: 'owner-1' }],
    ['operations', 'createInteraction', ['id-1'], { interactionType: 'call', notes: 'n' }],
    ['organization', 'onboardOrganization', [], { name: 'Org', slug: 'org', timezone: 'Asia/Manila' }],
    ['organization', 'updateOrganization', ['org-1'], { name: 'Org', settings: { any: { nested: true } } }],
    ['organization', 'updateMember', ['org-1', 'user-1'], { isActive: true }],
    ['organization', 'createInvitation', ['org-1'], { email: 'a@example.com', role: 'viewer' }],
    ['operations', 'uploadDocument', [propertyId], { category: 'title_deed', title: 'Deed' }],
  ];

  const withFile = (name: string, input: Record<string, unknown>) =>
    name === 'uploadDocument' ? { ...input, file: new File(['deed'], 'deed.pdf', { type: 'application/pdf' }) } : input;

  async function wireBody(body: unknown) {
    if (!(body instanceof FormData)) return typeof body === 'string' ? JSON.parse(body) : body;
    return Promise.all([...body.entries()].map(async ([key, value]) => [key, value instanceof File ? await value.text() : value]));
  }

  async function loadLive() {
    vi.resetModules();
    vi.stubEnv('VITE_API_BASE_URL', `${apiBase}/`);
    window.__BIZCAIAOS_AUTH__ = { getAccessToken: vi.fn().mockResolvedValue('verified-jwt-token') };
    const sent: Sent[] = [];
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init = {}) => {
      const path = url.replace(apiBase, '');
      const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (path === '/ops/config') return respond(200, { data: { documentUpload: { maxSizeBytes: 1024, acceptedMimeTypes: ['application/pdf'] } } });
      sent.push({ method: init.method ?? 'GET', path, body: await wireBody(init.body) });
      // Stands in for the strict API, which refuses any top-level key its schema does not declare.
      return JSON.stringify(sent.at(-1)?.body).includes('unexpectedKey')
        ? respond(400, { error: { code: 'validation_error', message: 'Request validation failed', details: [{ code: 'unrecognized_keys', keys: ['unexpectedKey'], path: [] }] } })
        : respond(200, { data: { id: 'server-1' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const [operations, organization] = await Promise.all([import('./operationsApi'), import('./organizationApi')]);
    return { apis: { operations: operations.operationsApi as unknown as Api, organization: organization.organizationApi as unknown as Api }, sent, fetchMock };
  }

  async function loadDemo() {
    vi.resetModules();
    vi.stubEnv('VITE_API_BASE_URL', '');
    const [operations, organization] = await Promise.all([import('./operationsApi'), import('./organizationApi')]);
    return { operations: operations.operationsApi as unknown as Api, organization: organization.organizationApi as unknown as Api };
  }

  async function outcome(promise: Promise<unknown>) {
    return promise.then(
      // Generated ids, tokens and timestamps differ between two otherwise identical demo writes.
      (value) => ({
        resolved: JSON.stringify(value)
          .replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, '<id>')
          .replace(/demo_[0-9a-f]{32}/g, '<token>')
          .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>'),
      }),
      (error: { name: string; message: string; status?: number; code?: string }) => ({ rejected: [error.name, error.message, error.status, error.code] }),
    );
  }

  afterEach(() => {
    delete window.__BIZCAIAOS_AUTH__;
    vi.unstubAllGlobals();
  });

  it.each(OPERATIONS)('%s.%s: live sends the same request with or without the undefined key, and demo answers alike', async (api, name, args, input) => {
    const live = await loadLive();
    const plain = await outcome(live.apis[api][name](...args, withFile(name, input)));
    const extra = await outcome(live.apis[api][name](...args, withFile(name, { ...input, unexpectedKey: undefined })));
    expect(plain).toEqual({ resolved: JSON.stringify({ id: 'server-1' }) });
    expect(extra).toEqual(plain);
    expect(live.sent).toHaveLength(2);
    expect(live.sent[1]).toEqual(live.sent[0]);
    expect(JSON.stringify(live.sent)).not.toContain('unexpectedKey');

    // Placeholder ids make most demo calls fail later (e.g. not found); with or
    // without the undefined key the demo must give the same answer, never a validation_error.
    const demoPlain = await outcome((await loadDemo())[api][name](...args, withFile(name, input)));
    const demoExtra = await outcome((await loadDemo())[api][name](...args, withFile(name, { ...input, unexpectedKey: undefined })));
    expect(demoExtra).toEqual(demoPlain);
    expect(JSON.stringify(demoExtra)).not.toContain('validation_error');
  });

  it.each(OPERATIONS)('%s.%s: an unknown key with a defined value, null included, is still refused in both modes', async (api, name, args, input) => {
    const errorName = api === 'organization' ? 'OrganizationApiError' : 'OperationsApiError';
    for (const value of ['x', 1, true, { nested: 1 }, [1], null]) {
      const live = await loadLive();
      const liveResult = await outcome(live.apis[api][name](...args, withFile(name, { ...input, unexpectedKey: value })));
      const demoResult = await outcome((await loadDemo())[api][name](...args, withFile(name, { ...input, unexpectedKey: value })));
      expect(liveResult).toEqual({ rejected: [errorName, 'Request validation failed', 400, 'validation_error'] });
      expect(demoResult).toEqual(liveResult);
      // The upload client refuses locally; every other live client sends the key and the API refuses it.
      if (name === 'uploadDocument') expect(live.fetchMock).not.toHaveBeenCalled();
      else expect(JSON.stringify(live.sent[0].body)).toContain('unexpectedKey');
    }
  });

  it('accepts real demo writes carrying an undefined unknown key', async () => {
    const { operationsApi, DEMO_ORGANIZATION_ID } = await loadDemo().then(() => import('./operationsApi'));
    const { organizationApi } = await import('./organizationApi');
    const project = await operationsApi.createProject({ organization_id: DEMO_ORGANIZATION_ID, code: 'NCP-U2', name: 'Undefined' });
    const property = await operationsApi.createProperty({ organizationId: DEMO_ORGANIZATION_ID, projectId: project.id, propertyReference: 'NCP-U2001', unexpectedKey: undefined } as never);
    expect(property).toMatchObject({ property_reference: 'NCP-U2001' });

    await expect(operationsApi.updateProperty(property.id, { risk: 'high', unexpectedKey: undefined })).resolves.toMatchObject({ risk: 'high' });
    expect(JSON.parse(JSON.stringify(await operationsApi.getProperty(property.id)))).not.toHaveProperty('unexpectedKey');

    const task = await operationsApi.createTask(property.id, { title: 'Call owner', unexpectedKey: undefined } as never);
    expect(task).toMatchObject({ title: 'Call owner' });
    expect(task).not.toHaveProperty('unexpectedKey');

    const { organizations: [organization] } = await organizationApi.getMe();
    const [member] = await organizationApi.listMembers(organization.id);
    await expect(organizationApi.updateMember(organization.id, member.user_id, { isActive: member.is_active, unexpectedKey: undefined } as never)).resolves.toMatchObject({ user_id: member.user_id });

    const file = new File(['deed'], 'deed.pdf', { type: 'application/pdf' });
    await expect(operationsApi.uploadDocument(propertyId, { category: 'title_deed', title: 'Deed', file, unexpectedKey: undefined } as never)).resolves.toMatchObject({ title: 'Deed', storage_provider: 'local' });
  });

  describe('values JSON leaves out or cannot serialize', () => {
    const LEFT_OUT: Record<string, () => unknown> = {
      function: () => () => 123,
      symbol: () => Symbol('unexpected'),
      'toJSON() returning undefined': () => ({ toJSON: () => undefined }),
    };
    const KEPT: Record<string, () => unknown> = {
      'toJSON() returning a value': () => ({ toJSON: () => 'x' }),
      'function with toJSON() returning a value': () => Object.assign(() => 123, { toJSON: () => 'x' }),
    };
    const refused = (api: string) => ({ rejected: [api === 'organization' ? 'OrganizationApiError' : 'OperationsApiError', 'Request validation failed', 400, 'validation_error'] });

    it('counts a key only if serialization keeps it, and a BigInt as present', () => {
      for (const make of Object.values(LEFT_OUT)) expect(unknownRequestKeys({ title: 'T', stauts: make() }, 'updateTask')).toEqual([]);
      for (const make of Object.values(KEPT)) expect(unknownRequestKeys({ title: 'T', stauts: make() }, 'updateTask')).toEqual(['stauts']);
      expect(unknownRequestKeys({ title: 'T', stauts: 123n }, 'updateTask')).toEqual(['stauts']);
      expect(unknownRequestKeys({ title: 'T', stauts: { nested: 1n } }, 'updateTask')).toEqual(['stauts']);
      expect(unknownBigIntKeys({ title: 1n, stauts: { nested: 1n }, other: 'x' }, 'updateTask')).toEqual(['stauts']);
      // Known keys and nested free-form values are outside the rule.
      expect(unknownRequestKeys({ title: () => 1, description: 1n }, 'updateTask')).toEqual([]);
      expect(unknownRequestKeys({ metadata: { fn: () => 1, big: 1n, sym: Symbol('s') } }, 'updateProperty')).toEqual([]);
      expect(unknownBigIntKeys({ metadata: { big: 1n } }, 'updateProperty')).toEqual([]);
      // A body that cannot be serialized for another reason keeps the object rule.
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(unknownRequestKeys({ title: 'T', stauts: cyclic }, 'updateTask')).toEqual(['stauts']);
    });

    it.each(OPERATIONS)('%s.%s: a value JSON leaves out is treated like an absent key in both modes', async (api, name, args, input) => {
      for (const make of Object.values(LEFT_OUT)) {
        const live = await loadLive();
        const plain = await outcome(live.apis[api][name](...args, withFile(name, input)));
        const extra = await outcome(live.apis[api][name](...args, withFile(name, { ...input, unexpectedKey: make() })));
        expect(plain).toEqual({ resolved: JSON.stringify({ id: 'server-1' }) });
        expect(extra).toEqual(plain);
        expect(live.sent).toHaveLength(2);
        expect(live.sent[1]).toEqual(live.sent[0]);
        expect(JSON.stringify(live.sent)).not.toContain('unexpectedKey');

        const demoPlain = await outcome((await loadDemo())[api][name](...args, withFile(name, input)));
        const demoExtra = await outcome((await loadDemo())[api][name](...args, withFile(name, { ...input, unexpectedKey: make() })));
        expect(demoExtra).toEqual(demoPlain);
        expect(JSON.stringify(demoExtra)).not.toContain('validation_error');
      }
    });

    it.each(OPERATIONS)('%s.%s: a value JSON keeps through toJSON() is still refused in both modes', async (api, name, args, input) => {
      for (const make of Object.values(KEPT)) {
        const live = await loadLive();
        const liveResult = await outcome(live.apis[api][name](...args, withFile(name, { ...input, unexpectedKey: make() })));
        const demoResult = await outcome((await loadDemo())[api][name](...args, withFile(name, { ...input, unexpectedKey: make() })));
        expect(liveResult).toEqual(refused(api));
        expect(demoResult).toEqual(liveResult);
        if (name === 'uploadDocument') expect(live.fetchMock).not.toHaveBeenCalled();
        else expect(live.sent[0].body).toMatchObject({ unexpectedKey: 'x' });
      }
    });

    it.each(OPERATIONS)('%s.%s: a BigInt under an unknown key is refused with 400 validation_error in both modes, before any request', async (api, name, args, input) => {
      for (const value of [123n, { nested: 1n }]) {
        const live = await loadLive();
        const liveResult = await outcome(live.apis[api][name](...args, withFile(name, { ...input, unexpectedKey: value })));
        const demoResult = await outcome((await loadDemo())[api][name](...args, withFile(name, { ...input, unexpectedKey: value })));
        expect(liveResult).toEqual(refused(api));
        expect(live.fetchMock).not.toHaveBeenCalled();
        expect(demoResult).toEqual(liveResult);
      }
    });

    it('refuses a BigInt unknown key in demo writes without changing anything', async () => {
      const { operationsApi, DEMO_ORGANIZATION_ID } = await loadDemo().then(() => import('./operationsApi'));
      const { organizationApi } = await import('./organizationApi');
      const rejection = { status: 400, code: 'validation_error', message: 'Request validation failed' };

      const property = await operationsApi.getProperty(propertyId);
      await expect(operationsApi.updateProperty(propertyId, { risk: 'high', unexpectedKey: 1n })).rejects.toMatchObject(rejection);
      expect(await operationsApi.getProperty(propertyId)).toEqual(property);

      const properties = await operationsApi.listProperties(DEMO_ORGANIZATION_ID);
      await expect(operationsApi.createProperty({ organizationId: DEMO_ORGANIZATION_ID, projectId: property.project_id, propertyReference: 'NCP-B1', unexpectedKey: 1n } as never)).rejects.toMatchObject(rejection);
      expect(await operationsApi.listProperties(DEMO_ORGANIZATION_ID)).toEqual(properties);

      const tasks = await operationsApi.listTasks(propertyId);
      await expect(operationsApi.createTask(propertyId, { title: 'Call owner', unexpectedKey: 1n } as never)).rejects.toMatchObject(rejection);
      expect(await operationsApi.listTasks(propertyId)).toEqual(tasks);

      const documents = await operationsApi.listDocuments(propertyId);
      const file = new File(['deed'], 'deed.pdf', { type: 'application/pdf' });
      await expect(operationsApi.uploadDocument(propertyId, { category: 'title_deed', title: 'Deed', file, unexpectedKey: 1n } as never)).rejects.toMatchObject(rejection);
      expect(await operationsApi.listDocuments(propertyId)).toEqual(documents);

      const { organizations: [organization] } = await organizationApi.getMe();
      const members = await organizationApi.listMembers(organization.id);
      await expect(organizationApi.updateMember(organization.id, members[0].user_id, { isActive: false, unexpectedKey: 1n } as never)).rejects.toMatchObject(rejection);
      expect(await organizationApi.listMembers(organization.id)).toEqual(members);
    });

    it('leaves known keys and nested free-form values as they were', async () => {
      // A known key whose value JSON leaves out is simply not sent.
      let live = await loadLive();
      await live.apis.operations.updateTask('task-1', { title: () => 1, priority: 'high' });
      expect(live.sent[0].body).toEqual({ priority: 'high' });
      // A known key holding a BigInt still fails with the native TypeError, before any request.
      live = await loadLive();
      expect(await outcome(live.apis.operations.updateTask('task-1', { title: 'T', description: 1n }))).toEqual({ rejected: ['TypeError', expect.any(String), undefined, undefined] });
      expect(live.fetchMock).not.toHaveBeenCalled();
      // Nested free-form values serialize as before, including a nested BigInt's TypeError.
      live = await loadLive();
      await live.apis.operations.updateProperty('id-1', { metadata: { keep: 1, fn: () => 1, sym: Symbol('s') } });
      expect(live.sent[0].body).toEqual({ metadata: { keep: 1 } });
      live = await loadLive();
      expect(await outcome(live.apis.operations.updateProperty('id-1', { metadata: { big: 1n } }))).toEqual({ rejected: ['TypeError', expect.any(String), undefined, undefined] });
      expect(live.fetchMock).not.toHaveBeenCalled();
      // Demo still accepts and keeps nested free-form values.
      const { operationsApi } = await loadDemo().then(() => import('./operationsApi'));
      await expect(operationsApi.updateProperty(propertyId, { metadata: { keep: 1, fn: () => 1 } })).resolves.toMatchObject({ metadata: { keep: 1 } });
    });
  });
});
