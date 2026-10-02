/**
 * The API refuses an unknown top-level request-body key with 400
 * validation_error (issue code unrecognized_keys). The demo adapters apply the
 * same rule, so demo mode never accepts a body the live API refuses. Each list
 * mirrors the keys of the server's body schema; requestKeys.test.ts fails if
 * they drift apart.
 */
export const REQUEST_BODY_KEYS = {
  // operations API
  createOwner: ['organizationId', 'ownerType', 'displayName', 'organizationName', 'contactDetails'],
  createProperty: ['organizationId', 'projectId', 'propertyReference', 'titleNumber', 'taxDeclaration', 'lotNumber', 'areaHectares', 'municipality', 'province', 'barangay', 'acquisitionStage', 'assignedNegotiatorId', 'assignedManagerId', 'risk'],
  updateProperty: ['titleNumber', 'taxDeclaration', 'lotNumber', 'areaHectares', 'municipality', 'province', 'barangay', 'acquisitionStage', 'assignedNegotiatorId', 'assignedManagerId', 'risk', 'acquisitionStatus', 'legalStatus', 'documentationStatus', 'paymentStatus', 'readinessPercent', 'metadata'],
  transitionPropertyStage: ['targetStage', 'expectedStage', 'reason', 'override'],
  transitionPropertyStatus: ['targetStatus', 'expectedStatus', 'reason', 'override'],
  remediationStep: ['reason'],
  resolveRemediation: ['resultingStage', 'expectedStage', 'reason', 'evidence', 'evidenceDocumentId', 'evidenceInteractionId'],
  linkPropertyOwner: ['ownerId', 'ownershipPercent', 'isPrimary'],
  createNegotiation: ['organizationId', 'propertyId', 'assignedNegotiatorId', 'openingAmount', 'targetAmount', 'currencyCode', 'startedAt'],
  updateNegotiation: ['status', 'assignedNegotiatorId', 'openingAmount', 'targetAmount', 'currencyCode', 'startedAt', 'closedAt', 'archivedAt'],
  createNegotiationEvent: ['eventType', 'amount', 'contextualNote', 'occurredAt', 'metadata'],
  uploadDocument: ['category', 'title', 'negotiationId'],
  updateDocument: ['category', 'status', 'title', 'negotiationId', 'archived'],
  createTask: ['title', 'description', 'priority', 'assignedUserId', 'dueOn'],
  updateTask: ['title', 'description', 'status', 'priority', 'assignedUserId', 'dueOn', 'archived'],
  createPayment: ['amount', 'currencyCode', 'paymentType', 'negotiationId', 'scheduledOn', 'paidOn', 'referenceNumber'],
  updatePayment: ['amount', 'currencyCode', 'paymentType', 'negotiationId', 'status', 'scheduledOn', 'paidOn', 'referenceNumber', 'archived'],
  createAgreementSignature: ['documentId', 'ownerId', 'signedOn'],
  createInteraction: ['interactionType', 'notes', 'occurredAt', 'ownerId'],
  // organization API
  onboardOrganization: ['name', 'slug', 'timezone'],
  updateOrganization: ['name', 'legalName', 'timezone', 'settings'],
  updateMember: ['role', 'isActive'],
  createInvitation: ['email', 'role', 'expiresInHours'],
} as const satisfies Record<string, readonly string[]>;

export type RequestBodyOperation = keyof typeof REQUEST_BODY_KEYS;

/**
 * The top-level keys of a request body that the API does not accept for the operation.
 * A key whose value is undefined is not counted: JSON.stringify leaves it out of the
 * live request, so the API never sees it.
 */
export function unknownRequestKeys(input: object, operation: RequestBodyOperation): string[] {
  const allowed: readonly string[] = REQUEST_BODY_KEYS[operation];
  return Object.entries(input)
    .filter(([key, value]) => !allowed.includes(key) && value !== undefined)
    .map(([key]) => key);
}
