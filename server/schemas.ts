import { z } from 'zod';

export const organizationRoleSchema = z.enum([
  'system_admin',
  'land_acquisition_manager',
  'supervisor',
  'negotiator',
  'legal_documentation',
  'finance',
  'viewer',
]);

export const organizationIdParamsSchema = z.object({
  organizationId: z.uuid(),
});

export const organizationMemberParamsSchema = organizationIdParamsSchema.extend({
  userId: z.uuid(),
});

export const organizationInvitationParamsSchema = organizationIdParamsSchema.extend({
  invitationId: z.uuid(),
});

export const onboardOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  timezone: z.string().trim().min(1).max(80).default('Asia/Manila'),
});

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    legalName: z.string().trim().max(160).nullable().optional(),
    timezone: z.string().trim().min(1).max(80).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one organization field is required',
  });

export const createInvitationSchema = z.object({
  email: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z.email(),
  ),
  role: organizationRoleSchema.exclude(['system_admin']),
  expiresInHours: z.number().int().min(1).max(24 * 14).default(72),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(32).max(512),
});

export const updateMembershipSchema = z
  .object({
    role: organizationRoleSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => value.role !== undefined || value.isActive !== undefined, {
    message: 'Role or active state is required',
  });

export type OrganizationRole = z.infer<typeof organizationRoleSchema>;
