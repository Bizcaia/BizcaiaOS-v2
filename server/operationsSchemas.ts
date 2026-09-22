import { z } from 'zod';

export const projectStatusSchema = z.enum(['planning', 'active', 'paused', 'completed', 'archived']);
export const acquisitionStageSchema = z.enum(['identified','initial_contact','owner_validation','property_validation','documentation','negotiation','commercial_review','legal_review','agreement_preparation','signing','payment_closing','acquisition_complete','on_hold','withdrawn']);
export const acquisitionStatusSchema = z.enum(['active','on_hold','withdrawn','complete']);
export const propertyRiskSchema = z.enum(['low','medium','high']);

export const projectListQuerySchema = z.object({ organizationId: z.uuid() });
export const propertyListQuerySchema = z.object({ organizationId: z.uuid(), projectId: z.uuid().optional(), stage: acquisitionStageSchema.optional(), search: z.string().trim().max(120).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
export const idParamsSchema = z.object({ id: z.uuid() });
export const organizationAndIdParamsSchema = z.object({ organizationId: z.uuid(), id: z.uuid() });

export const createProjectSchema = z.object({ organizationId: z.uuid(), code: z.string().trim().min(2).max(40), name: z.string().trim().min(2).max(160), description: z.string().trim().max(2000).optional(), status: projectStatusSchema.default('planning'), acquisitionTarget: z.number().nonnegative().optional(), managerUserId: z.uuid().nullable().optional(), startsOn: z.string().date().nullable().optional(), targetCompletionOn: z.string().date().nullable().optional() });
export const createPropertySchema = z.object({ organizationId: z.uuid(), projectId: z.uuid(), propertyReference: z.string().trim().min(1).max(80), titleNumber: z.string().trim().max(120).nullable().optional(), taxDeclaration: z.string().trim().max(120).nullable().optional(), lotNumber: z.string().trim().max(120).nullable().optional(), areaHectares: z.number().nonnegative().nullable().optional(), municipality: z.string().trim().max(120).nullable().optional(), province: z.string().trim().max(120).nullable().optional(), barangay: z.string().trim().max(120).nullable().optional(), acquisitionStage: acquisitionStageSchema.default('identified'), assignedNegotiatorId: z.uuid().nullable().optional(), assignedManagerId: z.uuid().nullable().optional(), risk: propertyRiskSchema.default('medium') });
export const updatePropertySchema = createPropertySchema.partial().omit({ organizationId: true, projectId: true, propertyReference: true }).extend({
  acquisitionStatus: acquisitionStatusSchema.optional(),
  legalStatus: z.enum(['unknown','clear','under_review','blocked']).optional(),
  documentationStatus: z.string().trim().max(80).optional(),
  paymentStatus: z.string().trim().max(80).optional(),
  readinessPercent: z.number().int().min(0).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ownerTypeSchema = z.enum(['individual', 'corporate', 'estate', 'government', 'other']);
export const ownerListQuerySchema = z.object({ organizationId: z.uuid() });
export const createOwnerSchema = z.object({
  organizationId: z.uuid(),
  ownerType: ownerTypeSchema,
  displayName: z.string().trim().min(1).max(160),
  organizationName: z.string().trim().max(160).nullable().optional(),
  contactDetails: z.record(z.string(), z.unknown()).optional(),
});
export const linkOwnerSchema = z.object({
  ownerId: z.uuid(),
  ownershipPercent: z.number().min(0).max(100).nullable().optional(),
  isPrimary: z.boolean().optional(),
});
export const propertyOwnerParamsSchema = z.object({ id: z.uuid(), ownerId: z.uuid() });

export type AcquisitionStage = z.infer<typeof acquisitionStageSchema>;
export type OwnerType = z.infer<typeof ownerTypeSchema>;
