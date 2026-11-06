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
 * Client projection of `GET /tenants/me` (Fase 2).
 *
 * The API serialises the timestamp, so the browser sees an ISO string (or null
 * when the guided onboarding was never completed).
 */
export interface TenantProfile {
  id: string;
  slug: string;
  name: string;
  onboardingCompletedAt: string | null;
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

export interface TwoFactorDisableBody {
  password: string;
  /** TOTP (6 digits) or one-time recovery code. */
  code?: string;
}

export interface TwoFactorDisableResult {
  enabled: false;
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
