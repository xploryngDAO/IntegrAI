/**
 * Frontend-local contracts shared by the core shell and the workspace features.
 *
 * All DTO/enums come from `@sac/shared` as TYPE-ONLY imports: the browser bundle
 * must never pull runtime values from the shared package.
 */
import type {
  AccountDiagnosis,
  AccountStatus,
  AgentPresenceStatus,
  ChannelHealthView,
  IAgentSummary,
  Marketplace,
  PolicyEvaluation,
  SystemDiagnosis,
  TicketDetail,
  TicketListItem,
  TicketStats,
  TicketStatus,
} from '@sac/shared';

/* ==========================================================================
 * Queue filters
 * ========================================================================== */

export type QueueKey =
  | 'ALL'
  | 'SLA_CRITICAL'
  | 'CLAIMS'
  | 'PRE_SALE'
  | 'WAITING_ME'
  | 'UNASSIGNED';

export interface WorkspaceFilters {
  queueKey: QueueKey;
  marketplaces: Marketplace[];
  accountId: string | null;
  search: string;
}

export const DEFAULT_FILTERS: WorkspaceFilters = {
  queueKey: 'ALL',
  marketplaces: [],
  accountId: null,
  search: '',
};

/* ==========================================================================
 * Toasts
 * ========================================================================== */

export type ToastTone = 'ok' | 'warn' | 'danger' | 'info';

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
}

/* ==========================================================================
 * Local read/command models (not part of @sac/shared)
 * ========================================================================== */

/** Mirrors `GET /accounts` `AccountRow` (docs/API_CONTRACT.md §5). */
export interface AccountRow {
  id: string;
  marketplace: Marketplace;
  displayName: string;
  externalSellerId: string;
  marketplaceSiteId: string;
  status: AccountStatus;
  channelConfig: Record<string, unknown>;
  tokenExpiresAt: string | null;
  authExpiresAt: string | null;
}

export type ChatRecipient = 'BUYER' | 'MEDIATOR';

/** Body of `POST /tickets/:id/messages`. */
export interface SendMessageBody {
  bodyText: string;
  bodyHtml?: string | null;
  subject?: string | null;
  recipient?: ChatRecipient;
  forceImportant?: boolean;
  closeWithoutResponse?: boolean;
  attachmentS3Keys?: string[];
  meliActionGuideReasonId?: string | null;
  shopeeMessageType?: 'text' | 'image' | 'order' | 'item';
  shopeeOrderCardOrderSn?: string | null;
  shopeeItemCardItemId?: number | null;
}

export interface SendMessageResult {
  messageId: string;
  routeUsed: string;
  deliveryStatus: string;
  warnings: string[];
}

/** Body of `POST /tickets/:id/policy-check`. */
export interface PolicyCheckBody {
  bodyText: string;
  bodyHtml?: string | null;
  subject?: string | null;
  recipient?: ChatRecipient;
  attachmentCount?: number;
}

/** Body of `POST /tickets/:id/actions`. `kind` is a `ChannelActionKind`. */
export interface ActionBody {
  kind: string;
  bodyText?: string;
  attachmentS3Keys?: string[];
  lastReadMessageId?: string | null;
  payload?: Record<string, unknown>;
}

/** Body of `POST /accounts/connect`. */
export interface ConnectAccountPayload {
  marketplace: Marketplace;
  displayName: string;
  externalSellerId: string;
  marketplaceSiteId: string;
  refreshToken?: string;
  accessToken?: string;
  channelConfig?: Record<string, unknown>;
}

/** Body of `POST /auth/signup` (Fase 1 self-service account creation). */
export interface SignupBody {
  companyName: string;
  name: string;
  email: string;
  password: string;
}

/**
 * Body of `POST /auth/accept-invitation` (public).
 *
 * The invitation token proves ownership of the invited e-mail, so the caller
 * sends only the two fields the invitee chooses: display name and password.
 */
export interface AcceptInvitationBody {
  token: string;
  name: string;
  password: string;
}

export interface UploadedFile {
  key: string;
  uri: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Client projection of `GET /tenants/me` (Fase 2 + workspace security policy).
 *
 * The API serialises the timestamp, so the browser sees an ISO string (or null
 * when the guided onboarding was never completed).
 */
export interface TenantProfile {
  id: string;
  slug: string;
  name: string;
  onboardingCompletedAt: string | null;
  /**
   * Workspace policy: every operator must have TOTP enrolled to sign in.
   *
   * `null` means the deployment did **not** publish the field — an older API,
   * not "policy off". The settings screen renders that as "indisponível nesta
   * API" instead of inventing a disabled policy.
   */
  require2fa: boolean | null;
}

/** Body of `PATCH /tenants/me` for the workspace security policy (ADMIN). */
export interface TenantSettingsUpdate {
  require2fa: boolean;
}

/* ==========================================================================
 * Fase 1 — verificação em duas etapas (TOTP)
 *
 * Client-side contracts of the 2FA API (docs/PHASE1_AUTH.md):
 *
 *   GET  /auth/2fa/status          -> TwoFactorStatusResult
 *   POST /auth/2fa/setup           -> TwoFactorSetupResult
 *   POST /auth/2fa/verify          -> TwoFactorVerifyResult (8 recovery codes, once)
 *   POST /auth/2fa/disable         -> { enabled: false }
 *   POST /auth/2fa/challenge       -> AuthResponse (same session as login)
 *   POST /auth/2fa/enroll/setup    -> TwoFactorEnrollSetupResult (Bearer setupToken)
 *   POST /auth/2fa/enroll/verify   -> TwoFactorEnrollResult  (Bearer setupToken)
 *
 * The secret and the recovery codes are returned exactly once by the API, so
 * the UI keeps them in component state only (never in storage).
 * ========================================================================== */

export interface TwoFactorStatusResult {
  enabled: boolean;
}

export interface TwoFactorSetupResult {
  /** Base32 secret; only `POST /auth/2fa/setup` ever returns it. */
  secret: string;
  /** `otpauth://totp/...` URL the operator can open/copy instead of scanning a QR. */
  otpauthUrl: string;
}

export interface TwoFactorVerifyResult {
  enabled: boolean;
  /** 8 one-time recovery codes — shown only in this response. */
  recoveryCodes: string[];
}

/**
 * `POST /auth/2fa/enroll/setup` (public, `Authorization: Bearer <setupToken>`).
 *
 * Forced enrollment started by a `TWO_FACTOR_SETUP_REQUIRED` login: the
 * short-lived setup token is exchanged for the pending TOTP secret. The API
 * calls the URL `otpauthUri`; `otpauthUrl` is tolerated by the client too.
 */
export interface TwoFactorEnrollSetupResult {
  /** Base32 secret, shown once so the operator can type it in the authenticator. */
  secret: string;
  /** `otpauth://totp/...` URI (empty when the deployment did not send one). */
  otpauthUri: string;
}

/**
 * `POST /auth/2fa/enroll/verify` — confirms the pending secret, issues a real
 * session (`token`/`refreshToken`, persisted by the client like `login()`) and
 * returns the recovery codes exactly once.
 */
export interface TwoFactorEnrollResult {
  token: string;
  refreshToken?: string;
  recoveryCodes: string[];
}

export interface TwoFactorDisableBody {
  password: string;
  /** TOTP (6 digits) or one-time recovery code. */
  code?: string;
}

export interface TwoFactorDisableResult {
  enabled: false;
}

/* ==========================================================================
 * Fase 5 — SSO corporativo (Microsoft Entra ID)
 *
 * Client-side contracts of the corporate login API:
 *
 *   GET    /auth/sso/discover?email=  -> SsoDiscovery       (pública)
 *   GET    /auth/sso/start?email=     -> 302 para o IdP     (pública)
 *   POST   /auth/sso/exchange         -> AuthResponse       (pública)
 *   GET    /tenants/me/sso            -> TenantSsoConfig    (ADMIN)
 *   PUT    /tenants/me/sso            -> TenantSsoConfig    (ADMIN)
 *   DELETE /tenants/me/sso            -> 204                (ADMIN)
 *   POST   /tenants/me/sso/test       -> TenantSsoTestResult (ADMIN)
 *
 * The OAuth client secret never comes back from the API: the read model only
 * says whether a secret is stored (`clientSecretConfigured`). The callback URL
 * registered at the IdP is rendered read-only by `/settings`.
 * ========================================================================== */

/** `GET /auth/sso/discover` — whether this e-mail's domain uses SSO. */
export interface SsoDiscovery {
  enabled: boolean;
  /** Provider slug recognised by the API (e.g. `microsoft`); null when disabled. */
  provider: string | null;
}

/** `GET|PUT /tenants/me/sso` — tenant configuration without any secret. */
export interface TenantSsoConfig {
  /** Provider slug (`microsoft`); empty when the tenant never configured SSO. */
  provider: string;
  /** OIDC issuer of the tenant (`https://login.microsoftonline.com/<id>/v2.0`). */
  issuerUrl: string;
  /** Application (client) id of the app registration. */
  clientId: string;
  /** Whether the API holds a client secret (the value itself is never returned). */
  clientSecretConfigured: boolean;
  /** Effective callback URL the IdP must call; null when the API omitted it. */
  redirectUri: string | null;
  /** E-mail domains allowed to sign in through SSO (already normalised). */
  allowedDomains: string[];
  /** IdP group id/name → workspace role. Opaque to the UI; preserved on save. */
  groupRoleMap: Record<string, string>;
  /** Create the operator on the first SSO login instead of requiring an invite. */
  autoProvision: boolean;
  /** Role given to a provisioned operator (`ADMIN` | `SUPERVISOR` | `AGENT`). */
  defaultRole: string;
  /** Whether the API refuses password login for the SSO-covered domains. */
  enforceSso: boolean;
  /** Whether the corporate login is active for this workspace. */
  enabled: boolean;
}

/**
 * Body of `PUT /tenants/me/sso`.
 *
 * Omitting `clientSecret` keeps the stored one — that is how the form lets an
 * operator change the issuer/client id without retyping the secret.
 */
export interface TenantSsoUpdate {
  provider?: string;
  issuerUrl?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string | null;
  allowedDomains?: string[];
  groupRoleMap?: Record<string, string>;
  autoProvision?: boolean;
  defaultRole?: string;
  enforceSso?: boolean;
  enabled?: boolean;
}

/** One verification reported by `POST /tenants/me/sso/test` (ADMIN). */
export interface TenantSsoTestCheck {
  /**
   * Stable id chosen by the API for the check (`discovery`,
   * `authorization_endpoint`, …). The card maps the known ids to PT-BR labels
   * and shows an unknown id raw, so a newer backend stays readable.
   */
  name: string;
  /** Whether this specific check passed. */
  ok: boolean;
  /** Extra context (HTTP status, endpoint, failure reason); null when omitted. */
  detail: string | null;
}

/**
 * `POST /tenants/me/sso/test` (ADMIN) — result of validating the **saved**
 * connection against the IdP discovery document.
 *
 * The request has no body: it always checks what is stored, never the unsaved
 * form. `checks` may be empty on a partial/older deployment; the card then
 * shows an honest warning instead of inventing verification details.
 */
export interface TenantSsoTestResult {
  /** Overall verdict of the API (true only when the required checks passed). */
  ok: boolean;
  /** Individual checks, in the order the API reported them. */
  checks: TenantSsoTestCheck[];
  /** Issuer found in the discovery document, when the API includes it. */
  issuer: string | null;
  /** `authorization_endpoint` found in discovery, when included. */
  authorizationEndpoint: string | null;
  /** `token_endpoint` found in discovery, when included. */
  tokenEndpoint: string | null;
  /** `kid`s of the usable RSA signing keys published by the JWKS (empty when none). */
  jwksKeys: string[];
}

/* ==========================================================================
 * Fase 4 — console interno da plataforma + LGPD
 *
 * These are the client-side contracts of the platform API (admin-only):
 *
 *   GET   /platform/metrics          -> PlatformMetrics
 *   GET   /platform/tenants?page…    -> Paginated<PlatformTenant>
 *   PATCH /platform/tenants/:id      -> PlatformTenant
 *   GET   /tenants/me/export         -> JSON payload (raw artifact, no envelope)
 *   DELETE /tenants/me               -> 202 + DeleteTenantResult
 *
 * The shapes mirror `@sac/shared` (PlatformTenantView, PlatformMetrics,
 * PlatformTenantUpdateCommand) without importing runtime values — the bundle
 * never pulls the shared package.
 * ========================================================================== */

/** Commercial plans of a tenant (`PLAN_LIMITS` in `@sac/shared`). */
export type TenantPlan = 'FREE' | 'PRO' | 'ENTERPRISE';

/** Effective quotas of one tenant (custom values may override plan defaults). */
export interface PlatformTenantLimits {
  maxAccounts: number;
  maxAgents: number;
}

/** Usage counters rendered by the console for a single tenant. */
export interface PlatformTenantCounts {
  accounts: number;
  agents: number;
  tickets: number;
}

/** Global counters rendered on the platform dashboard. */
export interface PlatformMetrics {
  generatedAt?: string;
  totalTenants?: number;
  activeTenants: number;
  accountsByMarketplace: Record<Marketplace, number>;
  totalAccounts?: number;
  openTickets: number;
  messagesLast24h?: number;
  slaAtRisk: number;
  slaRiskHorizonMinutes?: number;
}

/** One tenant row of the platform console. */
export interface PlatformTenant {
  id: string;
  name: string;
  slug: string;
  plan: TenantPlan;
  status: string;
  limits: PlatformTenantLimits;
  counts: PlatformTenantCounts;
  onboardingCompletedAt: string | null;
  /** Soft-delete marker (null = live workspace). */
  deletedAt: string | null;
  createdAt: string;
  /**
   * Billing projection. Optional on purpose: `GET /platform/tenants` does not
   * return it yet, and the billing form must never invent a value the API did
   * not return. If a future detail endpoint adds these fields, the drawer
   * pre-fills the form instead of starting from "não alterar".
   */
  billingStatus?: string | null;
  trialEndsAt?: string | null;
  billingEmail?: string | null;
}

/* ==========================================================================
 * Fase 4 (billing + alertas) — console operacional
 *
 *   GET   /platform/tenants/:id/metrics -> PlatformTenantMetrics
 *   GET   /platform/alerts              -> PlatformAlert[]
 *   GET   /platform/billing/summary     -> PlatformBillingSummary
 *   PATCH /platform/tenants/:id/billing -> PlatformTenant | 204
 *
 * The billing endpoints are optional while the API is being published: a
 * 404/405/501 is surfaced as "não publicado" without taking the console down.
 * ========================================================================== */

/** One daily bucket of `ticketsLast14d`. */
export interface PlatformDailyTickets {
  /** ISO date (`YYYY-MM-DD`) or a serialised timestamp. */
  date: string;
  count: number;
}

/**
 * Quota usage returned by the metrics endpoint. The server may answer one
 * overall percentage or one value per resource; the UI accepts both.
 */
export type PlatformUsagePct =
  | number
  | {
      accounts?: number;
      agents?: number;
    };

/** Metrics of a single tenant (`GET /platform/tenants/:id/metrics`). */
export interface PlatformTenantMetrics {
  accounts: number;
  agents: number;
  ticketsByStatus: Record<string, number>;
  openTickets: number;
  slaAtRisk: number;
  slaBreached: number;
  /** Average minutes to the first agent reply (null = no data yet). */
  avgFirstResponseMinutes?: number | null;
  messagesLast7d: number;
  ticketsLast14d?: PlatformDailyTickets[];
  plan: TenantPlan;
  limits: PlatformTenantLimits;
  usagePct?: PlatformUsagePct;
}

/** Raw severity of `GET /platform/alerts` (normalised by `lib/platform`). */
export type PlatformAlertSeverity = 'critical' | 'warning' | 'info';

/**
 * Stable alert kinds derived from live data. Unknown values are tolerated and
 * rendered raw, so a newer API never breaks the console.
 */
export type PlatformAlertType =
  | 'TENANT_SUSPENDED'
  | 'ACCOUNT_STATUS'
  | 'ACCOUNT_ERROR'
  | 'AGENTS_QUOTA'
  | 'ACCOUNTS_QUOTA'
  | 'SLA_AT_RISK'
  | 'INVITATIONS_EXPIRING';

/** One operational alert of the platform console. */
export interface PlatformAlert {
  severity: string;
  tenantId: string;
  tenantSlug: string;
  type: PlatformAlertType | string;
  message: string;
  value?: number | string | null;
}

/**
 * `GET /platform/alerts` answers `{ generatedAt, total, alerts }`. The client
 * also accepts a bare array so both shapes of the contract keep working.
 */
export interface PlatformAlertsResult {
  generatedAt?: string;
  total?: number;
  alerts: PlatformAlert[];
}

/** One row of the billing breakdown by plan. */
export interface PlatformBillingPlanSlice {
  plan: string;
  tenants: number;
  mrr: number;
}

/** `GET /platform/billing/summary`. */
export interface PlatformBillingSummary {
  mrr: number;
  byPlan: PlatformBillingPlanSlice[];
  trialing: number;
  pastDue: number;
}

/** Billing lifecycle of a tenant (server-side enum, kept tolerant). */
export type PlatformBillingStatus = 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELED';

/**
 * Body of `PATCH /platform/tenants/:id/billing`.
 *
 * Only the fields the operator actually changed are sent; `null` clears an
 * existing value (empty date/email after a populated one).
 */
export interface PlatformTenantBillingUpdate {
  billingStatus?: string;
  trialEndsAt?: string | null;
  billingEmail?: string | null;
}

/** Response of `PATCH /platform/tenants/:id/billing` (server-normalised view). */
export interface PlatformTenantBillingResult {
  tenantId: string;
  slug: string;
  plan: TenantPlan;
  billingStatus: string;
  trialEndsAt: string | null;
  billingEmail: string | null;
  /** Monthly list price of the current plan in BRL (0 for FREE). */
  monthlyPriceBrl?: number;
  updatedAt?: string;
}

/**
 * Response of `POST /platform/tenants/:id/checkout`.
 *
 * The URL is built server-side from `BILLING_CHECKOUT_URL_TEMPLATE`; the API
 * answers `503 BILLING_NOT_CONFIGURED` while the deployment has no template.
 */
export interface PlatformCheckoutResult {
  /** Absolute http(s) URL of the provider hosted checkout. */
  checkoutUrl: string;
}

/** One audit row of `GET /platform/billing/events`. */
export interface PlatformBillingEvent {
  id: string;
  /** Normalised gateway event (`subscription.activated`, `payment.failed`, …). */
  type: string;
  tenantId: string;
  tenantSlug: string;
  /** `webhook_events.status`: RECEIVED | PROCESSED | FAILED. */
  status: string;
  /** ISO instant of the callback. */
  receivedAt: string;
}

/** Response of `GET /platform/billing/events?limit=`. */
export interface PlatformBillingEventsResult {
  items: PlatformBillingEvent[];
  /** Effective limit applied by the API (1..100, default 50). */
  limit: number;
}

/* ==========================================================================
 * Setup de apps de integração (platform admin)
 *
 *   GET /platform/integration-setup -> IntegrationSetup
 *
 * The API owns the values: redirect URI, webhook URL, topics/scopes and the
 * step list are rendered exactly as returned. A `null` field means the server
 * did not publish that value yet — the UI says so instead of inventing it.
 * `missing` is the list of environment variables the deployment still needs.
 * ========================================================================== */

/** One channel card of the integration setup screen. */
export interface IntegrationSetupChannel {
  /** Marketplace identifier as returned by the API (normalised for display by `lib/integrations`). */
  marketplace: string;
  /** Whether every app credential of this channel is present in the API env. */
  configured: boolean;
  /** Environment variables still missing for this channel. */
  missing: string[];
  /** Public app id (Meli App ID / Shopee partner_id / Amazon LWA client id). */
  appIdPublic: string | null;
  redirectUri: string | null;
  webhookUrl: string | null;
  /** Meli/Shopee topics or OAuth scopes, in the order the portal expects. */
  oauthScopesOrTopics: string[];
  portalUrl: string | null;
  docsUrl: string | null;
  /** Ordered, operator-facing steps to create the app in the portal. */
  steps: string[];
  /** Env variable that holds the webhook secret (the value is never exposed). */
  webhookSecretEnv: string | null;
}

/** Response of `GET /platform/integration-setup`. */
export interface IntegrationSetup {
  /** ISO instant of the server read (empty when the API omitted it). */
  generatedAt: string;
  apiBaseUrl: string;
  webOrigin: string;
  channels: IntegrationSetupChannel[];
}

/**
 * `GET /auth/2fa/recovery-codes/count` — how many unused recovery codes the
 * operator still has (the count never exposes the codes themselves).
 */
export interface RecoveryCodeCountResult {
  remaining: number;
}

/** Body of `POST /auth/2fa/recovery-codes/regenerate`. */
export interface RegenerateRecoveryCodesBody {
  password: string;
  /** TOTP (6 digits) or one-time recovery code. */
  code: string;
}

/**
 * Response of `POST /auth/2fa/recovery-codes/regenerate` — the 8 new codes are
 * returned exactly once; every previously issued code stops working.
 */
export interface RegenerateRecoveryCodesResult {
  recoveryCodes: string[];
}

/** Body of `PATCH /platform/tenants/:id`. */
export interface PlatformTenantUpdate {
  plan?: TenantPlan;
  maxAccounts?: number;
  maxAgents?: number;
  /** ACTIVE or SUSPENDED; DELETED is reserved for the LGPD delete flow. */
  status?: 'ACTIVE' | 'SUSPENDED';
}

/** Query of `GET /platform/tenants`. */
export interface PlatformTenantQuery {
  page: number;
  pageSize?: number;
  /** Sent for forward compatibility; the current API filters client-side. */
  search?: string;
}

/** Body of `DELETE /tenants/me` (double confirmation: password + slug). */
export interface DeleteTenantBody {
  password: string;
  /** API field name of the workspace slug confirmation. */
  confirmSlug: string;
}

/* ==========================================================================
 * Conta do operador + administração do workspace
 *
 * Client-side contracts of the account/admin API (the backend is the guard;
 * the UI only offers what `/auth/me` says the operator may do):
 *
 *   PATCH /auth/me                    -> IAgentSummary            (perfil)
 *   GET   /auth/sessions              -> { items: UserSession[] }
 *   DELETE /auth/sessions/:id         -> 204
 *   POST  /auth/sessions/revoke-others-> { revoked: number }
 *   GET   /admin/overview             -> AdminOverview
 *   GET   /admin/users?search=&role=&status=&page=&perPage=
 *                                     -> { items, total, page, perPage }
 *   GET   /admin/users/export.csv?search=&role=&status= -> text/csv
 *   PATCH /admin/users/:id            -> AdminUser
 *   POST  /admin/users/:id/reset-2fa  -> { id, twoFactorEnabled: false }
 *   POST  /admin/users/:id/revoke-sessions -> { revoked: number }
 *   GET   /admin/sessions?page=&perPage= -> { items, total }
 *   DELETE /admin/sessions/:id        -> 204 (409 CANNOT_REVOKE_CURRENT_SESSION)
 *   GET   /admin/audit-logs           -> { items, page, perPage, total }
 *   POST  /invitations                -> { invitationId, email, role, expiresAt }
 *
 * Every response travels inside the standard `{ data }` envelope, which the
 * HTTP client unwraps before these types apply.
 * ========================================================================== */

/**
 * `GET /admin/overview` (ADMIN) — the counters shown above the `/admin` tabs.
 *
 * Contract: `{ data: { users: { total, active, admins }, sessions: { active },
 * invitations: { pending }, accounts: { total, connected, byMarketplace:
 * { AMAZON, MERCADO_LIVRE, SHOPEE } }, tickets: { total, unread, unassigned },
 * audit: { last24h } } }`. The HTTP client unwraps `data`, so this read model
 * starts at the six groups below (`api.adminOverview`).
 *
 * The wire type also exists as `AdminOverview` in `@sac/shared`; this local copy
 * is the tolerant read model of the SPA. It keeps `byMarketplace` keyed by the
 * plain marketplace code, so a deployment that adds a channel is displayed
 * instead of rejected by the type — the same reason `AdminUser.role` is a
 * `string` here and an `AgentRole` there.
 *
 * Every counter is an integer `>= 0`: `api.adminOverview` renders an absent
 * field as `0` and clamps a negative/invalid value to `0`, so a card never
 * shows `-1`, `NaN` or a blank where the API omitted a metric.
 */
export interface AdminOverview {
  users: {
    /** Every operator of the workspace (active + inactive). */
    total: number;
    /** Operators with `isActive` (the ones that can sign in). */
    active: number;
    /** ADMIN operators of the workspace, active or not. */
    admins: number;
  };
  sessions: {
    /** Live refresh sessions (`revoked_at IS NULL` and not expired). */
    active: number;
  };
  invitations: {
    /** Invitations not accepted and not expired. */
    pending: number;
  };
  accounts: {
    /** Marketplace accounts of the workspace, any status. */
    total: number;
    /** Accounts currently `ACTIVE` (usable token). */
    connected: number;
    /**
     * Accounts per marketplace code, upper-cased (`AMAZON`, `MERCADO_LIVRE`,
     * `SHOPEE`). The three channels this UI knows are always present (zero when
     * the API omitted them); an extra code sent by a newer deployment is kept
     * verbatim so the breakdown never hides a connected channel.
     *
     * Each row counts **every** account of that channel, whatever its status;
     * `connected` above is the `ACTIVE` subset.
     */
    byMarketplace: Record<string, number>;
  };
  tickets: {
    /** Every support ticket of the workspace. */
    total: number;
    /** Tickets in the `UNREAD` status (a new buyer message arrived). */
    unread: number;
    /** Non-terminal tickets without an assignee. */
    unassigned: number;
  };
  audit: {
    /** Administrative audit events recorded in the last rolling 24h. */
    last24h: number;
  };
}

/** One active refresh session of the authenticated operator. */
export interface UserSession {
  id: string;
  /** ISO instant the session was opened. */
  createdAt: string;
  /** ISO instant of the last refresh, or null when never used. */
  lastUsedAt: string | null;
  /** Raw browser user-agent (rendered through `describeDevice`). */
  userAgent: string | null;
  ip: string | null;
  /** True for the session that issued the current access token. */
  current: boolean;
}

/** One operator row of `GET /admin/users`. */
export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  /**
   * Whether TOTP is currently enrolled for this operator.
   *
   * Tolerant read: `api.adminUsers` maps an absent/non-boolean field to `false`
   * (a deployment that predates the admin 2FA column), so the table always has
   * a boolean instead of rendering "unknown".
   */
  twoFactorEnabled: boolean;
  /** ISO instant of the last successful login (null = never). */
  lastLoginAt: string | null;
  createdAt: string;
  sessionsCount: number;
}

/**
 * Status values accepted by `GET /admin/users?status=` (same union as
 * `AdminUserStatus` in `@sac/shared`).
 *
 * Uppercase on purpose: the API enums of this project (`TenantStatus`,
 * `TicketStatus`, invitation status) are uppercase and the role filter already
 * sends `ADMIN`/`SUPERVISOR`/`AGENT`. `INACTIVE` names the deactivated operator.
 */
export type AdminUserStatus = 'ACTIVE' | 'INACTIVE';

/**
 * Query of `GET /admin/users` (server-side filtering + pagination).
 *
 * Every filter is optional and an empty string is omitted from the URL, exactly
 * like the other list endpoints. `page` is 1-based and the API caps `perPage` at
 * 100 — the tab only offers 25/50/100.
 */
export interface AdminUsersQuery {
  /** Free text matched against the operator name/e-mail (trimmed by the client). */
  search?: string;
  /** `ADMIN` | `SUPERVISOR` | `AGENT`; absent = every role. */
  role?: string;
  /** Active flag; absent = both. */
  status?: AdminUserStatus;
  /** 1-based page (API default: 1). */
  page?: number;
  /** Page size, 1..100 (API default: 25). */
  perPage?: number;
}

/** Query of `GET /admin/users/export.csv` — the same filters, without pagination. */
export type AdminUsersExportQuery = Omit<AdminUsersQuery, 'page' | 'perPage'>;

/**
 * `GET /admin/users` envelope.
 *
 * `total` is the size of the whole filtered set (not only the returned page);
 * `page`/`perPage` are the effective values echoed by the API, so the client
 * paginates by what the server actually did. The client tolerates a deployment
 * that omits them (see `api.adminUsers`).
 */
export interface AdminUsersResult {
  items: AdminUser[];
  total: number;
  page: number;
  perPage: number;
}

/** Body of `PATCH /admin/users/:id` — only the changed fields are sent. */
export interface AdminUserUpdate {
  role?: string;
  isActive?: boolean;
}

/**
 * `POST /admin/users/:id/reset-2fa` (200) — the ADMIN removed the target's TOTP
 * enrollment and every live session of that operator was closed.
 *
 * `twoFactorEnabled` is read straight from the API response (`false` on a
 * successful reset); when the deployment answers with an empty body,
 * `api.resetAdminUserTwoFactor` still resolves with the requested id and
 * `false`, because the route's only successful outcome is a disabled 2FA.
 * 409 `CANNOT_RESET_OWN_2FA`, 409 `TWO_FACTOR_NOT_ENABLED` and 404 (unknown or
 * cross-tenant operator) are errors, never a silent success.
 */
export interface AdminUserTwoFactorResetResult {
  id: string;
  twoFactorEnabled: boolean;
}

/**
 * One **active session** of any operator of the workspace
 * (`GET /admin/sessions`).
 *
 * It is the administrative view of `UserSession`: the same refresh-token row,
 * plus the operator it belongs to. `current` marks the session that issued the
 * access token of the request that listed it, so the current ADMIN may see it
 * marked even when browsing from another device — the API is the only source
 * for that flag, the UI never derives it.
 */
export interface AdminSession {
  id: string;
  /** Operator that owns the session (null when the API did not send it). */
  agentId: string | null;
  name: string;
  email: string;
  role: string;
  ip: string | null;
  /** Raw browser user-agent (rendered through `describeDevice`). */
  userAgent: string | null;
  /** ISO instant the session was opened (empty when the API omitted it). */
  createdAt: string;
  /** ISO instant of the last refresh, or null when never used. */
  lastUsedAt: string | null;
  /** True for the session that issued the current access token. */
  current: boolean;
}

/** Query of `GET /admin/sessions` (server-side pagination). */
export interface AdminSessionsQuery {
  /** 1-based page (API default: 1). */
  page?: number;
  /** Page size, 1..100 (API default: 50). */
  perPage?: number;
}

/**
 * `GET /admin/sessions` envelope.
 *
 * The API answers `{ data: { items, total } }`; the HTTP client unwraps `data`,
 * so this read model starts at `{ items, total }`. `total` counts every active
 * session of the tenant (not only the returned page). `page`/`perPage` carry the
 * effective pagination — echoed by the API when present, otherwise the values
 * requested — so the tab paginates by what the server actually did.
 */
export interface AdminSessionsResult {
  items: AdminSession[];
  total: number;
  page: number;
  perPage: number;
}

/** One row of the administrative audit trail (`GET /admin/audit-logs`). */
export interface AuditLogEntry {
  id: string;
  /** Stable action code (`auth.login`, `user.role_changed`, …). */
  action: string;
  actorId: string | null;
  actorEmail: string | null;
  resourceType: string | null;
  resourceId: string | null;
  ip: string | null;
  userAgent: string | null;
  /** Free-form JSON payload; rendered as expandable metadata. */
  metadata: unknown;
  createdAt: string;
}

/** Query of `GET /admin/audit-logs` (all filters optional). */
export interface AuditLogQuery {
  action?: string;
  actorId?: string;
  page?: number;
  perPage?: number;
  /** ISO instant lower bound (inclusive). */
  from?: string;
  /** ISO instant upper bound (inclusive). */
  to?: string;
}

/** One page of the audit trail. */
export interface AuditLogPage {
  items: AuditLogEntry[];
  page: number;
  perPage: number;
  total: number;
}

/** Body of `POST /invitations` (existing Fase 1 endpoint behind the CTA). */
export interface InviteUserBody {
  email: string;
  role: string;
}

/** Response of `POST /invitations`. */
export interface InviteUserResult {
  invitationId: string;
  email: string;
  role: string;
  expiresAt: string;
}

/* ==========================================================================
 * Convites pendentes (`/admin/invitations`) + exportação da trilha
 *
 *   GET    /admin/invitations            -> { items: AdminInvitation[], total }
 *   POST   /admin/invitations/:id/resend -> 200 (409 INVITATION_ALREADY_ACCEPTED,
 *                                           502 EMAIL_SEND_FAILED)
 *   DELETE /admin/invitations/:id        -> 204 (409 INVITATION_ALREADY_ACCEPTED)
 *   GET    /admin/audit-logs/export.csv?action=&actorId=&from=&to= -> text/csv
 * ========================================================================== */

/** Status known by this UI; the API owns the enum. */
export type KnownInvitationStatus = 'PENDING' | 'EXPIRED' | 'ACCEPTED';

/** One invitation row of `GET /admin/invitations`. */
export interface AdminInvitation {
  id: string;
  email: string;
  /** Role the invitee receives on acceptance (`ADMIN` | `SUPERVISOR` | `AGENT`). */
  role: string;
  /** ISO instant the invitation was created (empty when the API omitted it). */
  createdAt: string;
  /** ISO instant the single-use link stops working. */
  expiresAt: string;
  /** ISO instant the invitee accepted (null while pending/expired). */
  acceptedAt: string | null;
  /**
   * Known status, or the raw code when the API introduces a new one — the table
   * shows it verbatim instead of guessing.
   */
  status: KnownInvitationStatus | (string & {});
}

/** `GET /admin/invitations` envelope. */
export interface AdminInvitationsResult {
  items: AdminInvitation[];
  total: number;
}

/**
 * Response of `POST /admin/invitations/:id/resend` (ADMIN).
 *
 * The API re-issues the single-use link and answers the refreshed invitation
 * (`id`, `email`, `role`, `expiresAt`, `status: 'PENDING'`). The client keeps the
 * same row shape, so a partial body still renders what the API actually sent.
 * These fields feed the success message only — the table is re-read from
 * `GET /admin/invitations` right after the call.
 */
export type ResendInvitationResult = Pick<
  AdminInvitation,
  'id' | 'email' | 'role' | 'expiresAt' | 'status'
>;

/** Query of `GET /admin/audit-logs/export.csv` (same filters as the trail). */
export type AuditLogExportQuery = Omit<AuditLogQuery, 'page' | 'perPage'>;

/** Authenticated binary download returned by the API. */
export interface DownloadedFile {
  blob: Blob;
  /** File name parsed from `Content-Disposition` (already sanitised); null when absent. */
  fileName: string | null;
  /** Effective `Content-Type` header (e.g. `text/csv; charset=utf-8`). */
  contentType: string | null;
}

/* ==========================================================================
 * Store shape (single zustand hook — see docs/UI_KIT.md §3)
 * ========================================================================== */

export interface WorkspaceState {
  // data
  tickets: TicketListItem[];
  totalTickets: number;
  stats: TicketStats | null;
  selectedTicketId: string | null;
  detail: TicketDetail | null;
  agents: IAgentSummary[];
  accounts: AccountRow[];
  health: ChannelHealthView[];
  filters: WorkspaceFilters;
  loadingQueue: boolean;
  loadingDetail: boolean;
  toasts: Toast[];
  presence: AgentPresenceStatus;
  sending: boolean;
  policy: PolicyEvaluation | null;
  currentAgent: IAgentSummary | null;
  /** Last live diagnostics report (infrastructure + connected accounts). */
  systemDiagnosis: SystemDiagnosis | null;
  /** Last live diagnosis per account id. */
  accountDiagnoses: Record<string, AccountDiagnosis>;
  diagnosticsLoading: boolean;
  diagnosticsError: string | null;
  diagnosingAccountId: string | null;

  // actions
  boot(): Promise<void>;
  refreshQueue(): Promise<void>;
  refreshStats(): Promise<void>;
  refreshDetail(id?: string): Promise<void>;
  selectTicket(id: string): void;
  setFilters(patch: Partial<WorkspaceFilters>): void;
  sendMessage(body: SendMessageBody): Promise<boolean>;
  checkPolicy(body: PolicyCheckBody): Promise<void>;
  runAction(body: ActionBody): Promise<void>;
  closeWithoutResponse(): Promise<void>;
  markRead(): Promise<void>;
  assignTo(agentId: string): Promise<void>;
  changeStatus(status: TicketStatus): Promise<void>;
  setPresence(presence: AgentPresenceStatus): Promise<void>;
  pushToast(t: Omit<Toast, 'id'>): void;
  dismissToast(id: string): void;
  /** Live system diagnostics (`GET /diagnostics`). Rejects on failure. */
  systemDiagnostics(): Promise<SystemDiagnosis>;
  /** Alias for `systemDiagnostics` (task-17 contract naming). */
  diagnostics(): Promise<SystemDiagnosis>;
  /** Live diagnosis for one account (`POST /accounts/:id/diagnose`). Rejects on failure. */
  diagnoseAccount(accountId: string): Promise<AccountDiagnosis>;
}

/* ==========================================================================
 * Re-exports: convenient single import path for the workspace features.
 * ========================================================================== */

export type {
  AccountDiagnosis,
  AccountStatus,
  AgentPresenceStatus,
  AgentRole,
  AttachmentView,
  AvailableActionView,
  ChannelActionResult,
  ChannelHealthView,
  ChannelRoute,
  ConnectorDescriptor,
  CrrStatusView,
  CustomerView,
  DeliveryStatus,
  DiagnosisCheck,
  DiagnosisStatus,
  IAgentSummary,
  Marketplace,
  MessageDirection,
  MessageView,
  OrderItemSnapshot,
  OrderView,
  PolicyEvaluation,
  PolicySeverity,
  PolicyViolation,
  QueueSnapshot,
  RouteDecision,
  RoutePreview,
  SlaState,
  SystemDiagnosis,
  SystemStatusChannel,
  SystemStatusLevel,
  SystemStatusService,
  SystemStatusServiceName,
  SystemStatusSnapshot,
  TicketDetail,
  TicketListItem,
  TicketPriority,
  TicketStats,
  TicketStatus,
  TicketType,
  AuthResponse,
} from '@sac/shared';
