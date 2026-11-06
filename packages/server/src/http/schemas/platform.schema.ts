import { z } from 'zod';
import { ENTERPRISE_UNLIMITED, TENANT_PLANS } from '@sac/shared';
import { uuidSchema } from './enums.schema';

/**
 * Schemas for the Fase 4 platform console (`/platform/*`).
 *
 * Every route is JWT + `is_platform_admin`; the schemas only shape the payload.
 */

/** `GET /platform/tenants?page=&pageSize=`. */
export const platformTenantListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const platformTenantParamsSchema = z.object({
  id: uuidSchema,
});

/**
 * `PATCH /platform/tenants/:id`.
 *
 * `status` only accepts ACTIVE/SUSPENDED: deleting a workspace is the LGPD
 * flow (`DELETE /tenants/me`, with password + slug), never a console toggle.
 */
export const platformTenantUpdateBodySchema = z
  .object({
    plan: z.enum(TENANT_PLANS).optional(),
    maxAccounts: z.number().int().min(1).max(ENTERPRISE_UNLIMITED).optional(),
    maxAgents: z.number().int().min(1).max(ENTERPRISE_UNLIMITED).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.plan !== undefined ||
      value.maxAccounts !== undefined ||
      value.maxAgents !== undefined ||
      value.status !== undefined,
    { message: 'At least one of plan, maxAccounts, maxAgents or status is required' },
  );

export type PlatformTenantListQuery = z.infer<typeof platformTenantListQuerySchema>;
export type PlatformTenantUpdateBody = z.infer<typeof platformTenantUpdateBodySchema>;
