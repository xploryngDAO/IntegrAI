import { z } from 'zod';
import {
  BILLING_STATUSES,
  ENTERPRISE_UNLIMITED,
  TENANT_PLANS,
  TENANT_SEARCH_MAX_LENGTH,
} from '@sac/shared';
import { uuidSchema } from './enums.schema';
import { blankAsUndefined } from './common';

/**
 * Schemas for the Fase 4 platform console (`/platform/*`).
 *
 * Every route is JWT + `is_platform_admin`; the schemas only shape the payload.
 */

/**
 * `GET /platform/tenants?page=&pageSize=&search=`.
 *
 * `search` is matched server-side against `name` OR `slug` (case-insensitive
 * `contains`); a blank `?search=` is treated as "no filter" instead of a 422.
 */
export const platformTenantListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: blankAsUndefined(
    z.string().trim().min(1).max(TENANT_SEARCH_MAX_LENGTH).optional(),
  ),
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

/**
 * `PATCH /platform/tenants/:id/billing`.
 *
 * `trialEndsAt` and `billingEmail` accept `null` to clear the value; at least
 * one of the three fields is required. The payment gateway is a follow-up, so
 * this only persists the commercial state.
 */
export const platformTenantBillingBodySchema = z
  .object({
    billingStatus: z.enum(BILLING_STATUSES).optional(),
    trialEndsAt: z.union([z.null(), z.coerce.date()]).optional(),
    billingEmail: z.union([z.null(), z.string().trim().email().max(180)]).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.billingStatus !== undefined ||
      value.trialEndsAt !== undefined ||
      value.billingEmail !== undefined,
    { message: 'At least one of billingStatus, trialEndsAt or billingEmail is required' },
  );

export type PlatformTenantListQuery = z.infer<typeof platformTenantListQuerySchema>;
export type PlatformTenantUpdateBody = z.infer<typeof platformTenantUpdateBodySchema>;
export type PlatformTenantBillingBody = z.infer<typeof platformTenantBillingBodySchema>;
