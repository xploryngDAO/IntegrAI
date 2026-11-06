import { z } from 'zod';
import {
  BILLING_STATUSES,
  ENTERPRISE_UNLIMITED,
  MARKETPLACES,
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

/**
 * `POST /platform/tenants/restore`.
 *
 * `backupKey` is restricted to the backup prefix (`backups/<tenant>/<file>.json`)
 * so the endpoint can never be used to read an arbitrary object from the
 * bucket. The slug is normalized to lowercase and must be a NEW workspace:
 * the service answers 409 when it already exists.
 */
export const platformTenantRestoreBodySchema = z
  .object({
    backupKey: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(
        /^backups\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.json$/,
        'backupKey must match backups/<tenant>/<timestamp>.json',
      ),
    newSlug: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .transform((value) => value.toLowerCase())
      .refine(
        (value) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value),
        'newSlug must contain only lowercase letters, digits and inner hyphens',
      ),
    newName: z.string().trim().min(1).max(160),
  })
  .strict();

export type PlatformTenantListQuery = z.infer<typeof platformTenantListQuerySchema>;
export type PlatformTenantUpdateBody = z.infer<typeof platformTenantUpdateBodySchema>;
export type PlatformTenantBillingBody = z.infer<typeof platformTenantBillingBodySchema>;
export type PlatformTenantRestoreBody = z.infer<typeof platformTenantRestoreBodySchema>;

/**
 * `GET /platform/integration-setup?marketplace=`.
 *
 * `marketplace` filters the guide to ONE channel; a blank value means "all
 * channels" (the UI calls it without a query on the first render). An unknown
 * channel is a 422 instead of silently returning the full guide, so a typo in
 * the onboarding deep-link fails loudly.
 */
export const integrationSetupQuerySchema = z.object({
  marketplace: blankAsUndefined(z.enum(MARKETPLACES).optional()),
});

export type IntegrationSetupQuery = z.infer<typeof integrationSetupQuerySchema>;
