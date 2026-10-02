import { z } from 'zod';

export const projectStatusSchema = z.enum(['planning', 'active', 'paused', 'completed', 'archived']);
export const acquisitionStageSchema = z.enum(['identified','initial_contact','owner_validation','property_validation','documentation','negotiation','commercial_review','legal_review','agreement_preparation','signing','payment_closing','acquisition_complete','on_hold','withdrawn']);
export const acquisitionStatusSchema = z.enum(['active','on_hold','withdrawn','complete']);
export const propertyRiskSchema = z.enum(['low','medium','high']);

export const projectListQuerySchema = z.object({ organizationId: z.uuid() });
export const propertyListQuerySchema = z.object({ organizationId: z.uuid(), projectId: z.uuid().optional(), stage: acquisitionStageSchema.optional(), search: z.string().trim().max(120).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
export const idParamsSchema = z.object({ id: z.uuid() });
export const organizationAndIdParamsSchema = z.object({ organizationId: z.uuid(), id: z.uuid() });

// Request bodies are strict objects: an unknown top-level key is refused with
// 400 validation_error (issue code unrecognized_keys), including fields the
// server derives or that are immutable. Free-form metadata and contactDetails
// keep any nested keys. Query and path schemas are not request bodies.
export const createProjectSchema = z.strictObject({ organizationId: z.uuid(), code: z.string().trim().min(2).max(40), name: z.string().trim().min(2).max(160), description: z.string().trim().max(2000).optional(), status: projectStatusSchema.default('planning'), acquisitionTarget: z.number().nonnegative().optional(), managerUserId: z.uuid().nullable().optional(), startsOn: z.string().date().nullable().optional(), targetCompletionOn: z.string().date().nullable().optional() });
// P-6 (L-05): identified is the only creation stage; status always starts active.
export const createPropertySchema = z.strictObject({ organizationId: z.uuid(), projectId: z.uuid(), propertyReference: z.string().trim().min(1).max(80), titleNumber: z.string().trim().max(120).nullable().optional(), taxDeclaration: z.string().trim().max(120).nullable().optional(), lotNumber: z.string().trim().max(120).nullable().optional(), areaHectares: z.number().nonnegative().nullable().optional(), municipality: z.string().trim().max(120).nullable().optional(), province: z.string().trim().max(120).nullable().optional(), barangay: z.string().trim().max(120).nullable().optional(), acquisitionStage: z.literal('identified', { error: 'A property can only be created in the identified stage' }).default('identified'), assignedNegotiatorId: z.uuid().nullable().optional(), assignedManagerId: z.uuid().nullable().optional(), risk: propertyRiskSchema.default('medium') });
export const updatePropertySchema = createPropertySchema.partial().omit({ organizationId: true, projectId: true, propertyReference: true }).extend({
  // The stage changes only through a stage transition (L-02).
  acquisitionStage: z.never({ error: 'Use a stage transition to change the acquisition stage' }).optional(),
  // The status changes only through a status transition (L-03).
  acquisitionStatus: z.never({ error: 'Use a status transition to change the acquisition status' }).optional(),
  // No default: .partial() keeps the create default, which would turn an
  // omitted risk into 'medium' and overwrite (or forbid) the update.
  risk: propertyRiskSchema.optional(),
  legalStatus: z.enum(['unknown','clear','under_review','blocked']).optional(),
  documentationStatus: z.string().trim().max(80).optional(),
  paymentStatus: z.string().trim().max(80).optional(),
  readinessPercent: z.number().int().min(0).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// Legacy values are accepted here so the database can refuse them with a clear
// message; the transition function is the authority for every stage rule.
// expectedStage / expectedStatus: the value the caller's screen showed (D-X1,
// L-07). A stale value is refused as a lifecycle conflict (409).
export const stageTransitionSchema = z.strictObject({
  targetStage: acquisitionStageSchema,
  expectedStage: acquisitionStageSchema,
  reason: z.string().max(2000).nullable().optional(),
  // Only a designated rule (the negotiation exception, L-04) can be overridden.
  override: z.boolean().optional(),
});

// The transition function is the authority for every status rule (N-2).
export const statusTransitionSchema = z.strictObject({
  targetStatus: acquisitionStatusSchema,
  expectedStatus: acquisitionStatusSchema,
  reason: z.string().max(2000).nullable().optional(),
  override: z.boolean().optional(),
});

// Legacy stage remediation (L-06). The remediation functions are the
// authority for every rule (state, authority, reason, evidence, integrity).
export const remediationStepSchema = z.strictObject({
  reason: z.string().max(2000).nullable().optional(),
});

export const remediationResolveSchema = z.strictObject({
  resultingStage: acquisitionStageSchema,
  expectedStage: acquisitionStageSchema,
  reason: z.string().max(2000).nullable().optional(),
  evidence: z.string().max(4000).nullable().optional(),
  evidenceDocumentId: z.uuid().nullable().optional(),
  evidenceInteractionId: z.uuid().nullable().optional(),
});

export const remediationQueueQuerySchema = z.object({ organizationId: z.uuid() });

export const ownerTypeSchema = z.enum(['individual', 'corporate', 'estate', 'government', 'other']);
export const ownerListQuerySchema = z.object({ organizationId: z.uuid() });
export const createOwnerSchema = z.strictObject({
  organizationId: z.uuid(),
  ownerType: ownerTypeSchema,
  displayName: z.string().trim().min(1).max(160),
  organizationName: z.string().trim().max(160).nullable().optional(),
  contactDetails: z.record(z.string(), z.unknown()).optional(),
});
export const linkOwnerSchema = z.strictObject({
  ownerId: z.uuid(),
  ownershipPercent: z.number().min(0).max(100).nullable().optional(),
  isPrimary: z.boolean().optional(),
});
export const propertyOwnerParamsSchema = z.object({ id: z.uuid(), ownerId: z.uuid() });

export type AcquisitionStage = z.infer<typeof acquisitionStageSchema>;
export type OwnerType = z.infer<typeof ownerTypeSchema>;

export const negotiationStatusSchema = z.enum(['open', 'paused', 'accepted', 'rejected', 'withdrawn', 'closed']);
export const negotiationEventTypeSchema = z.enum(['offer', 'counteroffer', 'meeting', 'call', 'message', 'note', 'other']);

export const negotiationListQuerySchema = z.object({
  organizationId: z.uuid(),
  propertyId: z.uuid().optional(),
  status: negotiationStatusSchema.optional(),
});

export const createNegotiationSchema = z.strictObject({
  organizationId: z.uuid(),
  propertyId: z.uuid(),
  assignedNegotiatorId: z.uuid().nullable().optional(),
  openingAmount: z.number().nonnegative().nullable().optional(),
  targetAmount: z.number().nonnegative().nullable().optional(),
  currencyCode: z.string().trim().length(3).default('PHP'),
  startedAt: z.string().datetime().optional(),
});

export const updateNegotiationSchema = z.strictObject({
  status: negotiationStatusSchema.optional(),
  assignedNegotiatorId: z.uuid().nullable().optional(),
  openingAmount: z.number().nonnegative().nullable().optional(),
  targetAmount: z.number().nonnegative().nullable().optional(),
  currencyCode: z.string().trim().length(3).optional(),
  startedAt: z.string().datetime().optional(),
  closedAt: z.string().datetime().nullable().optional(),
  archivedAt: z.string().datetime().nullable().optional(),
});

export const createNegotiationEventSchema = z.strictObject({
  eventType: negotiationEventTypeSchema,
  amount: z.number().nonnegative().nullable().optional(),
  contextualNote: z.string().trim().max(4000).nullable().optional(),
  occurredAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).superRefine((value, ctx) => {
  if ((value.eventType === 'offer' || value.eventType === 'counteroffer') && (value.amount == null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Offer and counteroffer events require an amount',
      path: ['amount'],
    });
  }
});

export const documentCategorySchema = z.enum([
  'ownership_evidence',
  'title_deed',
  'tax_declaration',
  'legal_opinion',
  'survey_plan',
  'agreement_draft',
  'agreement_executed',
  'payment_proof',
  'other',
]);
export const documentStatusSchema = z.enum([
  'draft',
  'submitted',
  'under_review',
  'verified',
  'rejected',
  'superseded',
]);

export const documentListQuerySchema = z.object({
  category: documentCategorySchema.optional(),
  status: documentStatusSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
});

// Non-file multipart fields for POST /properties/:id/documents. storage_key,
// storage_provider, content_type, size_bytes, and original_filename are never
// accepted from the client -- they are derived server-side from the upload.
export const createDocumentFieldsSchema = z.strictObject({
  category: documentCategorySchema,
  title: z.string().trim().min(1).max(200),
  negotiationId: z.uuid().optional(),
});

export const updateDocumentSchema = z.strictObject({
  category: documentCategorySchema.optional(),
  status: documentStatusSchema.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  negotiationId: z.uuid().nullable().optional(),
  archived: z.boolean().optional(),
});

export type DocumentCategory = z.infer<typeof documentCategorySchema>;
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const taskStatusSchema = z.enum(['open', 'in_progress', 'done', 'cancelled']);
export const taskPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);

export const taskListQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export const createTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  priority: taskPrioritySchema.default('normal'),
  assignedUserId: z.uuid().nullable().optional(),
  dueOn: z.string().date().nullable().optional(),
});

export const updateTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  assignedUserId: z.uuid().nullable().optional(),
  dueOn: z.string().date().nullable().optional(),
  archived: z.boolean().optional(),
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const paymentTypeSchema = z.enum(['deposit', 'installment', 'final_payment']);
export const paymentStatusSchema = z.enum(['pending', 'scheduled', 'paid', 'failed', 'cancelled']);

export const paymentListQuerySchema = z.object({
  status: paymentStatusSchema.optional(),
  paymentType: paymentTypeSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export const createPaymentSchema = z.strictObject({
  amount: z.number().positive(),
  currencyCode: z.string().trim().length(3).default('PHP'),
  paymentType: paymentTypeSchema,
  negotiationId: z.uuid().nullable().optional(),
  scheduledOn: z.string().date().nullable().optional(),
  paidOn: z.string().date().nullable().optional(),
  referenceNumber: z.string().trim().max(120).nullable().optional(),
});

export const updatePaymentSchema = z.strictObject({
  amount: z.number().positive().optional(),
  currencyCode: z.string().trim().length(3).optional(),
  paymentType: paymentTypeSchema.optional(),
  negotiationId: z.uuid().nullable().optional(),
  status: paymentStatusSchema.optional(),
  scheduledOn: z.string().date().nullable().optional(),
  paidOn: z.string().date().nullable().optional(),
  referenceNumber: z.string().trim().max(120).nullable().optional(),
  archived: z.boolean().optional(),
});

export type PaymentType = z.infer<typeof paymentTypeSchema>;
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const agreementSignatureListQuerySchema = z.object({
  documentId: z.uuid().optional(),
  includeArchived: z.coerce.boolean().default(false),
});

// organization_id, property_id, and recorded_by_user_id are derived
// server-side and never accepted from the client.
export const createAgreementSignatureSchema = z.strictObject({
  documentId: z.uuid(),
  ownerId: z.uuid(),
  signedOn: z.string().date(),
});

// Signatures are immutable; the only permitted change is archiving.
export const archiveAgreementSignatureSchema = z.strictObject({
  archived: z.literal(true),
});

export const interactionTypeSchema = z.enum(['call', 'meeting', 'site_visit', 'message', 'other']);

// organization_id, property_id, and recorded_by_user_id are derived
// server-side. occurredAt defaults to the server clock; a supplied future
// value is rejected by the database (zero tolerance).
export const createInteractionSchema = z.strictObject({
  interactionType: interactionTypeSchema,
  notes: z.string().trim().min(1).max(4000),
  occurredAt: z.string().datetime().optional(),
  ownerId: z.uuid().nullable().optional(),
});

// Interactions are immutable; the only permitted change is archiving.
export const archiveInteractionSchema = z.strictObject({
  archived: z.literal(true),
});

// Same limit/offset convention as propertyListQuerySchema. There is
// deliberately no includeArchived: archived records never appear.
export const propertyTimelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
