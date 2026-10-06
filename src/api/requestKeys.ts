/**
 * The API refuses an unknown top-level request-body key with 400
 * validation_error (issue code unrecognized_keys). The demo adapters apply the
 * same rule to the body JSON.stringify would send (see unknownRequestKeys), so
 * demo mode never accepts a body the live API refuses. Each list
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
 *
 * Strictness follows the serialized JSON body, not the caller's object: a key counts
 * only if JSON.stringify keeps it in the live request. A key whose value it leaves out
 * (undefined, a function, a symbol, or a toJSON() that returns undefined) never reaches
 * the API and is not counted; a value it keeps (including through toJSON()) is. A BigInt,
 * primitive or wrapped as an object, cannot be serialized at all; it counts as present, so an unknown key holding one is
 * refused with 400 validation_error in both modes (see jsonRequestBody in the adapters).
 */
export function unknownRequestKeys(input: object, operation: RequestBodyOperation): string[] {
  const allowed: readonly string[] = REQUEST_BODY_KEYS[operation];
  const keys = serializedBodyKeys(input) ?? Object.keys(input).filter((key) => (input as Record<string, unknown>)[key] !== undefined);
  return keys.filter((key) => !allowed.includes(key));
}

/** The unknown top-level keys whose value holds a BigInt, which makes JSON.stringify throw. */
export function unknownBigIntKeys(input: object, operation: RequestBodyOperation): string[] {
  const allowed: readonly string[] = REQUEST_BODY_KEYS[operation];
  return Object.keys(input).filter((key) => !allowed.includes(key) && holdsBigInt(key, (input as Record<string, unknown>)[key]));
}

/** A BigInt, or a BigInt wrapper object such as Object(1n), which JSON.stringify unwraps and equally refuses. */
function isBigInt(value: unknown): boolean {
  if (typeof value === 'bigint') return true;
  if (typeof value !== 'object' || value === null) return false;
  try {
    BigInt.prototype.valueOf.call(value);
    return true;
  } catch {
    return false;
  }
}

const bigIntAsNull = (_key: string, value: unknown) => (isBigInt(value) ? null : value);

/**
 * The top-level keys of JSON.stringify(input), keeping a BigInt value (as null) instead
 * of throwing. Null when serialization fails for another reason (for example a cycle);
 * the caller then falls back to the object's own keys that hold a defined value.
 */
function serializedBodyKeys(input: object): string[] | null {
  try {
    const body: unknown = JSON.parse(JSON.stringify(input, bigIntAsNull) ?? 'null');
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  } catch {
    return null;
  }
}

function holdsBigInt(key: string, value: unknown): boolean {
  let found = false;
  try {
    JSON.stringify({ [key]: value }, (nestedKey, nested: unknown) => {
      if (isBigInt(nested)) found = true;
      return bigIntAsNull(nestedKey, nested);
    });
  } catch {
    // Serialization fails for another reason; only a BigInt is normalized.
  }
  return found;
}
