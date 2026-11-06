import type { AgentRole } from './enums';

/**
 * ============================================================================
 * Enterprise SSO (OpenID Connect) - shared contract
 * ============================================================================
 *
 * One connection per workspace (`tenant_sso_connections`). The provider is only
 * an onboarding preset: every flow is the generic OIDC authorization-code grant
 * with PKCE S256, nonce and a single-use, HMAC-signed `state`.
 *
 * Flow (all public endpoints except the tenant configuration):
 *
 *   GET  /auth/sso/discover?email|domain -> which tenant/IdP serves this domain
 *   GET  /auth/sso/start?email&provider  -> 302 to the IdP `authorization_endpoint`
 *   GET  /auth/sso/callback?code&state   -> validates everything, JIT provision,
 *                                          302 to <WEB_ORIGIN>/auth/sso/callback?code=<one-time>
 *   POST /auth/sso/exchange { code }     -> 200 AuthResponse (single use, 60s)
 *
 * Access/refresh tokens never travel in a URL: the callback only redirects with
 * an opaque one-time code that the SPA exchanges for the real session.
 */

/** Providers supported by the generic connector. */
export type SsoProvider = 'MICROSOFT' | 'GOOGLE' | 'OKTA' | 'OIDC';

export const SSO_PROVIDERS = ['MICROSOFT', 'GOOGLE', 'OKTA', 'OIDC'] as const satisfies readonly SsoProvider[];

export const SSO_PROVIDER_LABEL: Record<SsoProvider, string> = {
  MICROSOFT: 'Microsoft Entra ID',
  GOOGLE: 'Google Workspace',
  OKTA: 'Okta',
  OIDC: 'OpenID Connect (genérico)',
};

/**
 * Known public issuer presets. `null` means the issuer depends on the tenant
 * (Entra ID/Okta domain) and MUST be typed by the workspace admin.
 */
export const SSO_PROVIDER_DEFAULT_ISSUER: Record<SsoProvider, string | null> = {
  MICROSOFT: null,
  GOOGLE: 'https://accounts.google.com',
  OKTA: null,
  OIDC: null,
};

/** Scopes required by the flow; `openid` is mandatory, `email` yields the e-mail claim. */
export const SSO_DEFAULT_SCOPES = 'openid profile email';

/** `state` lives 10 minutes; it is consumed exactly once by the callback. */
export const SSO_STATE_TTL_SECONDS = 10 * 60;
/** One-time hand-off code between the callback redirect and the SPA exchange. */
export const SSO_CODE_TTL_SECONDS = 60;
/** OIDC discovery document cache (Redis + in-process). */
export const SSO_DISCOVERY_TTL_SECONDS = 60 * 60;
/** JWKS cache (Redis + in-process); a rotated `kid` triggers one forced refetch. */
export const SSO_JWKS_TTL_SECONDS = 60 * 60;
/** Allowed clock skew when validating `exp`/`iat`/`nbf` of the ID token. */
export const SSO_CLOCK_SKEW_SECONDS = 60;
/** Absolute path the IdP must register as the redirect URI. */
export const SSO_CALLBACK_PATH = '/api/v1/auth/sso/callback';

/**
 * Stable error codes (never reworded; the SPA and the docs rely on them).
 *
 * | code | http | when |
 * |---|---|---|
 * | `SSO_NOT_CONFIGURED` | 404/409 | no enabled connection for the domain/tenant |
 * | `SSO_STATE_INVALID` | 400 | missing/forged/expired/replayed `state` |
 * | `SSO_TOKEN_INVALID` | 401 | token endpoint failure or ID token rejected (sig/iss/aud/exp/nonce) |
 * | `SSO_DOMAIN_NOT_ALLOWED` | 403 | e-mail domain outside `allowed_domains` |
 * | `SSO_EMAIL_UNVERIFIED` | 403 | `email_verified === false` at the IdP |
 * | `SSO_REQUIRED` | 403 | password login blocked by `enforce_sso` |
 * | `SSO_PROVIDER_ERROR` | 502 | discovery/JWKS/token endpoint unreachable or malformed |
 * | `SSO_ACCOUNT_CONFLICT` | 409 | e-mail already belongs to another workspace |
 * | `SSO_ACCOUNT_DISABLED` | 403 | local operator was deactivated by an admin |
 * | `SSO_PROVISIONING_DISABLED` | 403 | unknown operator and `auto_provision=false` |
 * | `INVALID_SSO_CODE` | 401 | one-time code unknown/expired/already redeemed |
 * | `SSO_CANCELLED` | 302 | the IdP returned `error=...` (user cancelled/denied) |
 */
export const SSO_ERROR_CODES = {
  notConfigured: 'SSO_NOT_CONFIGURED',
  stateInvalid: 'SSO_STATE_INVALID',
  tokenInvalid: 'SSO_TOKEN_INVALID',
  domainNotAllowed: 'SSO_DOMAIN_NOT_ALLOWED',
  emailUnverified: 'SSO_EMAIL_UNVERIFIED',
  required: 'SSO_REQUIRED',
  providerError: 'SSO_PROVIDER_ERROR',
  accountConflict: 'SSO_ACCOUNT_CONFLICT',
  accountDisabled: 'SSO_ACCOUNT_DISABLED',
  provisioningDisabled: 'SSO_PROVISIONING_DISABLED',
  invalidCode: 'INVALID_SSO_CODE',
  cancelled: 'SSO_CANCELLED',
} as const;

/**
 * Failures that happen AFTER the `state` was validated and therefore may be
 * reported to the SPA with a redirect to `<WEB_ORIGIN>/auth/sso/callback?error=<code>`
 * instead of a raw JSON error page in the browser.
 */
export const SSO_REDIRECTABLE_ERROR_CODES: readonly string[] = [
  SSO_ERROR_CODES.notConfigured,
  SSO_ERROR_CODES.tokenInvalid,
  SSO_ERROR_CODES.domainNotAllowed,
  SSO_ERROR_CODES.emailUnverified,
  SSO_ERROR_CODES.providerError,
  SSO_ERROR_CODES.accountConflict,
  SSO_ERROR_CODES.accountDisabled,
  SSO_ERROR_CODES.provisioningDisabled,
  SSO_ERROR_CODES.cancelled,
];

/* ==========================================================================
 * Persistence / read models
 * ========================================================================== */

/** Raw `tenant_sso_connections` row (includes the encrypted secret). */
export interface TenantSsoConnectionRecord {
  id: string;
  tenantId: string;
  provider: SsoProvider;
  issuerUrl: string;
  clientId: string;
  /** `null` = public client (PKCE only). Never leaves the server. */
  clientSecretEnc: string | null;
  redirectUri: string;
  scopes: string;
  allowedDomains: string[];
  groupRoleMap: Record<string, AgentRole>;
  autoProvision: boolean;
  defaultRole: AgentRole;
  enforceSso: boolean;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Safe projection returned by `GET/PUT /tenants/me/sso` (no secret, ever). */
export interface SsoConnectionView {
  tenantId: string;
  provider: SsoProvider;
  issuerUrl: string;
  clientId: string;
  /** `true` when a client secret is stored (confidential client). */
  clientSecretConfigured: boolean;
  redirectUri: string;
  scopes: string;
  allowedDomains: string[];
  groupRoleMap: Record<string, AgentRole>;
  autoProvision: boolean;
  defaultRole: AgentRole;
  enforceSso: boolean;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Enabled connection matched by e-mail domain, with the workspace routing data. */
export interface SsoDomainMatch {
  connection: TenantSsoConnectionRecord;
  tenantSlug: string;
  tenantStatus: string;
}

/** Upsert payload: every field already normalized/validated by the service. */
export interface UpsertTenantSsoConnectionInput {
  tenantId: string;
  provider: SsoProvider;
  issuerUrl: string;
  clientId: string;
  clientSecretEnc: string | null;
  redirectUri: string;
  scopes: string;
  allowedDomains: string[];
  groupRoleMap: Record<string, AgentRole>;
  autoProvision: boolean;
  defaultRole: AgentRole;
  enforceSso: boolean;
  enabled: boolean;
}

/* ==========================================================================
 * Commands / results
 * ========================================================================== */

/**
 * `PUT /tenants/me/sso` body.
 *
 * `clientSecret` is write-only: omitted on update means "keep the stored one".
 * Omitted optional fields also keep the current value (a PUT never resets a
 * flag by accident); on the first write the schema defaults apply.
 */
export interface UpdateSsoConnectionCommand {
  provider: SsoProvider;
  issuerUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
  allowedDomains?: string[];
  groupRoleMap?: Record<string, AgentRole>;
  autoProvision?: boolean;
  defaultRole?: AgentRole;
  enforceSso?: boolean;
  enabled?: boolean;
}

/* ==========================================================================
 * Admin connection test (before enabling `enforce_sso`)
 * ========================================================================== */

/**
 * Stable ids of the `POST /tenants/me/sso/test` checks.
 *
 * They map 1:1 to the OIDC metadata being validated, so the SPA can label them
 * without parsing `detail`:
 *  - `discovery`              `<issuer>/.well-known/openid-configuration` reachable;
 *  - `issuer`                 document issuer equals the configured issuer (RFC 8414);
 *  - `authorization_endpoint` https (loopback http outside production) URL;
 *  - `token_endpoint`         idem;
 *  - `jwks_uri`               idem;
 *  - `response_types`         advertises the authorization `code`;
 *  - `code_challenge_methods` advertises PKCE `S256`;
 *  - `id_token_signing_alg`   advertises `RS256`;
 *  - `jwks`                   publishes a usable RSA/sig key with a `kid`;
 *  - `allowed_domains`        the workspace allowlist is not empty.
 */
export type SsoConnectionTestCheckName =
  | 'discovery'
  | 'issuer'
  | 'authorization_endpoint'
  | 'token_endpoint'
  | 'jwks_uri'
  | 'response_types'
  | 'code_challenge_methods'
  | 'id_token_signing_alg'
  | 'jwks'
  | 'allowed_domains';

/** One diagnostic line of the ADMIN connection test. */
export interface SsoConnectionTestCheck {
  name: SsoConnectionTestCheckName;
  ok: boolean;
  /** Secret-free explanation: HTTP status, counts, expected vs. discovered issuer. */
  detail?: string;
}

/** `POST /tenants/me/sso/test` - the caller IP is used only by the throttle. */
export interface SsoConnectionTestCommand {
  ip?: string | null;
}

/**
 * Result of the ADMIN "test connection" probe.
 *
 * The probe only READS the provider metadata: no authorization code is
 * exchanged, no token is requested and the client secret is never used, so a
 * public/PKCE client is validated exactly like a confidential one.
 *
 * `enabled` mirrors the stored switch: a disabled connection is still testable
 * (that is how it gets configured) and that flag never makes `ok` false on its
 * own. `ok` is true only when every check passed.
 */
export interface SsoConnectionTestResult {
  ok: boolean;
  checks: SsoConnectionTestCheck[];
  /** Canonical issuer advertised by the discovery document (when readable). */
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  /** `kid`s of the usable RSA/sig signing keys published by the JWKS ([] = none usable). */
  jwksKeys?: string[];
  /** Stored `enabled` flag (reported, not part of `ok`). */
  enabled?: boolean;
}

/** `GET /auth/sso/discover` - which IdP serves this e-mail domain. */
export interface SsoDiscoveryResult {
  enabled: true;
  provider: SsoProvider;
  tenantSlug: string;
}

export interface SsoStartCommand {
  email: string;
  provider?: SsoProvider;
  /** Caller IP, used only by the fixed-window throttle. */
  ip?: string | null;
}

export interface SsoStartResult {
  /** Fully built IdP authorization URL (302 target). */
  authorizationUrl: string;
}

export interface SsoCallbackCommand {
  code?: string;
  state?: string;
  /** Set when the IdP redirects with `?error=...` (user cancelled/denied). */
  error?: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface SsoCallbackResult {
  /** `<WEB_ORIGIN>/auth/sso/callback?code=<one-time>`; never carries a token. */
  redirectUrl: string;
  agentId: string;
  tenantId: string;
  /** `true` when the operator was created by this login (JIT). */
  provisioned: boolean;
}

export interface SsoExchangeCommand {
  code: string;
  ip?: string | null;
  userAgent?: string | null;
}

/* ==========================================================================
 * JIT provisioning port shapes
 * ========================================================================== */

/** Operator created by an SSO login (no password can ever match the random hash). */
export interface CreateSsoAgentInput {
  tenantId: string;
  email: string;
  name: string;
  /** bcrypt hash of a random 48-byte secret: password login is impossible. */
  passwordHash: string;
  role: AgentRole;
  emailVerifiedAt: Date;
}

/**
 * Fields refreshed on every SSO login of an existing operator.
 *
 * `role` is `undefined` when no IdP group matched the mapping: the existing role
 * is then preserved (an unmapped login must never demote an ADMIN).
 */
export interface UpdateSsoAgentInput {
  name: string;
  role?: AgentRole;
  emailVerifiedAt: Date;
  mustResetPassword: boolean;
}

/** Read model of the password-login gate (implemented by `TenantSsoService`). */
export interface SsoPasswordLoginSubject {
  tenantId: string | null;
  isPlatformAdmin: boolean;
}
