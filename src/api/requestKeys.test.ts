import { beforeEach, describe, expect, it, vi } from 'vitest';
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
