import { z } from 'zod';
import { SSO_PROVIDERS } from '@sac/shared';

/**
 * ============================================================================
 * Enterprise SSO HTTP contracts
 * ============================================================================
 *
 * The body schema is `.strict()`: a `tenantId` smuggled into the payload is a
 * 422, because the workspace ALWAYS comes from the JWT. URL *protocol* rules
 * (https, no fragment, exact redirect) live in `TenantSsoService`, which is the
 * single validation boundary for both HTTP and direct service calls.
 */

/**
 * Provider slug, case-insensitive.
 *
 * The SPA settings form and provider presets use lowercase slugs (`microsoft`),
 * while the persisted enum is uppercase; normalizing here keeps both accepted
 * without duplicating the enum in the client.
 */
export const ssoProviderSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
  z.enum(SSO_PROVIDERS),
);

export const ssoRoleSchema = z.enum(['ADMIN', 'SUPERVISOR', 'AGENT']);

const httpUrlSchema = z.string().trim().min(1).max(512).url();

/** `null` means "use the deployment default" (the read-only URL the UI shows). */
const optionalHttpUrlSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  httpUrlSchema.optional(),
);

/** `PUT /tenants/me/sso` - upsert of the workspace IdP. */
export const updateSsoConnectionBodySchema = z
  .object({
    provider: ssoProviderSchema,
    issuerUrl: httpUrlSchema,
    clientId: z.string().trim().min(1).max(255),
    /** Write-only. Omitted on update = keep the stored secret. */
    clientSecret: z.string().min(8).max(512).optional(),
    redirectUri: optionalHttpUrlSchema,
    allowedDomains: z.array(z.string().trim().min(1).max(253)).max(50).optional(),
    groupRoleMap: z.record(z.string(), ssoRoleSchema).optional(),
    autoProvision: z.boolean().optional(),
    defaultRole: ssoRoleSchema.optional(),
    enforceSso: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type UpdateSsoConnectionBody = z.infer<typeof updateSsoConnectionBodySchema>;

/** `GET /auth/sso/discover?email=` or `?domain=` (public). */
export const ssoDiscoverQuerySchema = z
  .object({
    email: z.string().trim().email().max(180).optional(),
    domain: z.string().trim().min(3).max(253).optional(),
  })
  .refine((value) => value.email !== undefined || value.domain !== undefined, {
    message: 'Either email or domain is required',
  });

export type SsoDiscoverQuery = z.infer<typeof ssoDiscoverQuerySchema>;

/** `GET /auth/sso/start?email=&provider=` (public). */
export const ssoStartQuerySchema = z.object({
  email: z.string().trim().email().max(180),
  provider: ssoProviderSchema.optional(),
});

export type SsoStartQuery = z.infer<typeof ssoStartQuerySchema>;

/**
 * `GET /auth/sso/callback?code=&state=` (public).
 *
 * `error` is accepted because the IdP redirects with `?error=access_denied`
 * when the user cancels; the raw provider text is never echoed back.
 */
export const ssoCallbackQuerySchema = z.object({
  code: z.string().trim().min(1).max(4_096).optional(),
  state: z.string().trim().min(1).max(512),
  error: z.string().trim().max(256).optional(),
});

export type SsoCallbackQuery = z.infer<typeof ssoCallbackQuerySchema>;

/** `POST /auth/sso/exchange { code }` (public). */
export const ssoExchangeBodySchema = z
  .object({
    code: z.string().trim().min(1).max(256),
  })
  .strict();

export type SsoExchangeBody = z.infer<typeof ssoExchangeBodySchema>;
