import type {
  AgentPresenceStatus,
  AgentRole,
  ChannelActionKind,
  DeliveryStatus,
  Marketplace,
  TicketPriority,
  TicketStatus,
  TicketType,
} from '../enums';
import type {
  AgentLoad,
  ApiEnvelope,
  AvailableActionView,
  BillingCheckoutResult,
  BillingEventListResult,
  BillingWebhookResult,
  ChannelHealthView,
  ConnectorDescriptor,
  DeleteTenantCommand,
  DeleteTenantResult,
  InvitationStatus,
  IntegrationSetupGuide,
  PageRequest,
  Paginated,
  PlanUsageView,
  RestoreTenantCommand,
  RestoreTenantResult,
  TenantBackupResult,
  TenantBackupView,
  PlatformAlertsResult,
  PlatformBillingSummary,
  PlatformMetrics,
  PlatformTenantListQuery,
  PlatformTenantListResult,
  PlatformTenantUpdateCommand,
  PlatformTenantView,
  QueueSnapshot,
  SystemStatusSnapshot,
  TenantBillingUpdateCommand,
  TenantBillingView,
  TenantExportPayload,
  TenantMetrics,
  TenantProfile,
  TenantPurgeResult,
  TenantPurgeRunResult,
  TicketDetail,
  TicketListItem,
  TicketStats,
} from '../dto';
import type { SupportTicketRecord, TicketMessageRecord, TicketListFilter } from '../dto';
import type {
  ChannelActionResult,
  ChannelRuntimeConfig,
  HydratedInboundMessage,
  IMarketplaceChannelAdapter,
  InboundEnvelope,
  OutboundAttachmentInput,
  OutboundValidationInput,
  PolicyEvaluation,
  RawWebhookRequest,
  RouteDecision,
} from '../adapter';
import type { ICache, IClock, ILogger, IQueuePublisher, IRealtimePublisher } from './infra';
import type {
  AdminInvitationListResult,
  AuditActorContext,
  IAdminUserService,
  IAuditService,
  RevokeSessionResult,
  UserSessionView,
} from '../admin';
import type {
  SsoCallbackCommand,
  SsoCallbackResult,
  SsoConnectionTestCommand,
  SsoConnectionTestResult,
  SsoDiscoveryResult,
  SsoExchangeCommand,
  SsoPasswordLoginSubject,
  SsoStartCommand,
  SsoStartResult,
  SsoConnectionView,
  UpdateSsoConnectionCommand,
} from '../sso';

/* ==========================================================================
 * Ticket ingestion + commands
 * ========================================================================== */

export interface IngestOutcome {
  ticketId: string;
  created: boolean;
  messageId: string | null;
  duplicate: boolean;
  warnings: string[];
}

export interface IUnifiedTicketService {
  ingest(message: HydratedInboundMessage): Promise<IngestOutcome>;
  assign(ticketId: string, agentId: string, actorLabel?: string): Promise<SupportTicketRecord>;
  changeStatus(
    ticketId: string,
    status: TicketStatus,
    actor?: { agentId?: string; label?: string },
  ): Promise<SupportTicketRecord>;
  closeWithoutResponse(ticketId: string, agent: { id: string; name: string }): Promise<SupportTicketRecord>;
  markAsRead(ticketId: string, agent?: { id: string; name: string }): Promise<SupportTicketRecord>;
  addInternalNote(
    ticketId: string,
    agent: { id: string; name: string },
    text: string,
  ): Promise<TicketMessageRecord>;
  refreshSla(ticketId: string): Promise<SupportTicketRecord>;
}

/* ==========================================================================
 * Outbound routing
 * ========================================================================== */

export interface SendMessageCommand {
  ticketId: string;
  agent: { id: string; name: string; email: string };
  bodyText: string;
  bodyHtml?: string | null;
  subject?: string | null;
  recipient?: 'BUYER' | 'MEDIATOR';
  forceImportant?: boolean;
  closeWithoutResponse?: boolean;
  attachmentS3Keys?: string[];
  meliActionGuideReasonId?: string | null;
  shopeeMessageType?: 'text' | 'image' | 'order' | 'item';
  shopeeOrderCardOrderSn?: string | null;
  shopeeItemCardItemId?: number | null;
  /** Idempotency-Key header from the UI, prevents double-send on retry. */
  idempotencyKey?: string | null;
}

export interface SendMessageResult {
  messageId: string;
  routeUsed: string;
  deliveryStatus: DeliveryStatus;
  warnings: string[];
  ticket: SupportTicketRecord;
}

export interface ExecuteActionCommand {
  ticketId: string;
  agent: { id: string; name: string; email: string };
  kind: ChannelActionKind;
  bodyText?: string;
  attachments?: OutboundAttachmentInput[];
  lastReadMessageId?: string | null;
  payload?: Record<string, unknown>;
}

export interface PreviewPolicyCommand {
  ticketId: string;
  draft: Omit<OutboundValidationInput, 'marketplace' | 'ticketType' | 'hasActiveClaim' | 'hasPriorInbound'>;
}

export interface IOutboundRouterService {
  send(command: SendMessageCommand): Promise<SendMessageResult>;
  executeAction(command: ExecuteActionCommand): Promise<ChannelActionResult>;
  previewPolicy(command: PreviewPolicyCommand): Promise<PolicyEvaluation>;
  resolveRoute(ticketId: string, recipient?: 'BUYER' | 'MEDIATOR'): Promise<RouteDecision>;
}

/* ==========================================================================
 * Query side (read models for the UI)
 * ========================================================================== */

export interface IAgentSummary {
  id: string;
  tenantId?: string | null;
  name: string;
  email: string;
  role: string;
  presence: AgentPresenceStatus;
  avatarColor: string;
  activeTickets: number;
}

export interface ITicketQueryService {
  listQueue(filter: TicketListFilter, page: PageRequest): Promise<Paginated<TicketListItem>>;
  getDetail(ticketId: string, tenantId?: string | null): Promise<TicketDetail>;
  getStats(filter?: TicketListFilter): Promise<TicketStats>;
  getQueueSnapshot(filter?: TicketListFilter): Promise<QueueSnapshot>;
  getAvailableActions(ticketId: string): Promise<AvailableActionView[]>;
  listAgents(): Promise<IAgentSummary[]>;
  agentLoads(): Promise<AgentLoad[]>;
}

/* ==========================================================================
 * Accounts / onboarding / OAuth
 * ========================================================================== */

export interface ConnectAccountRequest {
  marketplace: Marketplace;
  displayName: string;
  externalSellerId: string;
  marketplaceSiteId: string;
  /** Amazon: LWA refresh token + SMTP sender + inbound email route. */
  refreshToken?: string;
  accessToken?: string;
  tokenExpiresAt?: Date;
  channelConfig?: Record<string, unknown>;
}

export interface OAuthStartResult {
  authorizeUrl: string;
  state: string;
  marketplace: Marketplace;
}

export interface OAuthCallbackInput {
  code: string;
  state: string;
  shopId?: string;
  /** Amazon SP-API consent returns the seller id as `selling_partner_id`. */
  sellingPartnerId?: string;
  rawQuery: Record<string, string>;
}

export interface IAccountService {
  listAccounts(tenantId?: string | null): Promise<Array<{
    id: string;
    marketplace: Marketplace;
    displayName: string;
    externalSellerId: string;
    marketplaceSiteId: string;
    status: string;
    channelConfig: Record<string, unknown>;
    tokenExpiresAt: string | null;
    authExpiresAt: string | null;
  }>>;
  describeConnectors(): ConnectorDescriptor[];
  startOAuth(marketplace: Marketplace, displayName: string, tenantId?: string | null): Promise<OAuthStartResult>;
  completeOAuth(marketplace: Marketplace, input: OAuthCallbackInput): Promise<{ accountId: string; displayName: string }>;
  connectWithCredentials(input: ConnectAccountRequest, tenantId?: string | null): Promise<{ accountId: string; displayName: string }>;
  disconnect(accountId: string): Promise<void>;
  refreshNow(accountId: string): Promise<{ ok: boolean; detail: string }>;
}

/* ==========================================================================
 * Tenants (Fase 2: workspace identity + onboarding completion)
 * ========================================================================== */

export interface UpdateTenantCommand {
  /** New workspace display name (trimmed, 1..160 chars). */
  name?: string;
  /** `true` stamps `onboarding_completed_at`; `false` clears it (wizard rerun). */
  onboardingCompleted?: boolean;
  /**
   * Workspace 2FA policy. `PATCH /tenants/me` is ADMIN-only; flipping it emits
   * `tenant.2fa_policy_changed` with the before/after values.
   */
  require2fa?: boolean;
}

export interface ITenantService {
  /** Workspace projection for `GET /tenants/me`; 404 when the id is unknown. */
  get(tenantId: string): Promise<TenantProfile>;
  /**
   * Updates only the caller tenant (id comes from the JWT, never the body).
   * `actor` is used exclusively by the audit trail (`tenant.2fa_policy_changed`).
   */
  update(
    tenantId: string,
    command: UpdateTenantCommand,
    actor?: AuditActorContext,
  ): Promise<TenantProfile>;
}

/* ==========================================================================
 * Plan quotas (Fase 4: max_agents / max_accounts)
 * ========================================================================== */

/**
 * Single gate for every "add a seat / add a store" path.
 *
 * The effective quota comes from the tenant row (`max_accounts`/`max_agents`),
 * so an ENTERPRISE workspace is unlimited in practice without a second code
 * path. Every violation raises `PLAN_LIMIT_REACHED` (409) with
 * `details = { limit, current, plan, resource }`.
 */
export interface IPlanLimitService {
  /** Plan + effective limits + current usage (console/UI upgrade prompt). */
  usage(tenantId: string): Promise<PlanUsageView>;
  /** Accepting an invitation / creating an operator: agents < maxAgents. */
  assertCanAddAgent(tenantId: string): Promise<void>;
  /**
   * Sending an invitation: agents + pending invitations < maxAgents.
   * `excludeEmail` lets a resend for an already-pending address through (it does
   * not reserve a second seat).
   */
  assertCanInviteAgent(tenantId: string, options?: { excludeEmail?: string }): Promise<void>;
  /** Connecting a NEW store: accounts < maxAccounts. */
  assertCanAddAccount(tenantId: string): Promise<void>;
}

/* ==========================================================================
 * Platform console (Fase 4) - cross-tenant, requires `is_platform_admin`
 * ========================================================================== */

export interface IPlatformService {
  /**
   * Fails with 403 `AUTHORIZATION_ERROR` unless the operator is an active
   * platform administrator. Re-read from the database (never the JWT claim) so
   * revoking the flag takes effect immediately.
   */
  requirePlatformAdmin(actorId: string): Promise<void>;
  /** Page + optional name/slug search; `total` reflects the filtered set. */
  listTenants(query: PlatformTenantListQuery): Promise<PlatformTenantListResult>;
  updateTenant(tenantId: string, command: PlatformTenantUpdateCommand): Promise<PlatformTenantView>;
  metrics(): Promise<PlatformMetrics>;
  /** Operational snapshot of ONE workspace (404 when unknown). */
  tenantMetrics(tenantId: string): Promise<TenantMetrics>;
  /** Alerts derived from live data (accounts, quotas, SLA, lifecycle). */
  alerts(): Promise<PlatformAlertsResult>;
  /** MRR base derived from plan prices and `billing_status`. */
  billingSummary(): Promise<PlatformBillingSummary>;
  /** Updates subscription status/trial/billing e-mail of a workspace. */
  updateBilling(
    tenantId: string,
    command: TenantBillingUpdateCommand,
  ): Promise<TenantBillingView>;
}

/* ==========================================================================
 * Marketplace app setup guide (Fase 2 onboarding, platform console)
 * ========================================================================== */

/**
 * Read-only, environment-derived guide to CREATE the app in each marketplace
 * portal (Meli DevCenter, Shopee Open Platform, Amazon Seller Central).
 *
 * It is configuration introspection, not a marketplace call: the guide only
 * exposes public app identifiers, the exact redirect/webhook URLs derived from
 * `APP_BASE_URL` and the NAMES of the missing environment variables. Webhook
 * signing secrets are referenced by variable name, never by value.
 */
export interface IIntegrationSetupService {
  /** Full guide, or a single channel when `marketplace` is provided. */
  guide(marketplace?: Marketplace): IntegrationSetupGuide;
}

/* ==========================================================================
 * Billing gateway (Fase 4) - provider-agnostic, no external call
 * ========================================================================== */

/**
 * Raw gateway delivery. `rawBody` MUST be the exact request bytes: the HMAC is
 * computed over them, never over a re-serialized payload. `body` is the parsed
 * JSON (normalized contract) and is only inspected after the signature passes.
 */
export interface BillingWebhookCommand {
  rawBody: Buffer;
  signature?: string | null;
  body?: unknown;
}

/**
 * Payment gateway contract.
 *
 * - `handleWebhook`: 503 when `BILLING_WEBHOOK_SECRET` is absent, 401 on a bad
 *   signature, 200 (duplicate included) on an accepted event.
 * - `checkout`: hosted checkout URL rendered from the env template; 503 when the
 *   template is absent. Nothing is sent to the provider.
 * - `listEvents`: audit trail of the last billing callbacks.
 */
export interface IBillingService {
  handleWebhook(command: BillingWebhookCommand): Promise<BillingWebhookResult>;
  checkout(tenantId: string): Promise<BillingCheckoutResult>;
  listEvents(limit?: number): Promise<BillingEventListResult>;
}

/* ==========================================================================
 * LGPD physical purge (Fase 4): soft delete + 30-day grace -> hard delete
 * ========================================================================== */

export interface TenantPurgeRunOptions {
  /** Overrides the batch size (defaults to `TENANT_PURGE_BATCH_SIZE`). */
  limit?: number;
}

/**
 * Physical deletion of workspaces soft-deleted more than
 * `TENANT_PURGE_RETENTION_DAYS` ago.
 *
 * Runs from the daily `queue.tenant.purge` scheduler; `purgeTenant` is the
 * manual platform-admin entry point (`POST /platform/tenants/:id/purge`) that
 * skips the grace period but never purges a workspace that is not deleted.
 */
export interface ITenantPurgeService {
  /** One bounded sweep: finds eligible workspaces and purges each one. */
  run(options?: TenantPurgeRunOptions): Promise<TenantPurgeRunResult>;
  /** Manual purge of a single ALREADY soft-deleted workspace. */
  purgeTenant(tenantId: string, actorId?: string | null): Promise<TenantPurgeResult>;
}

/* ==========================================================================
 * Backup / restore por workspace (Fase 4)
 * ========================================================================== */

/**
 * LGPD Art. 15/16 (storage limitation): expires backup artifacts older than the
 * retention window. Called by the daily `queue.tenant.backup.purge` job.
 */
export interface TenantBackupPurgeOptions {
  /**
   * Retention window in days. `<= 0` disables the sweep: nothing is read,
   * deleted or logged as a failure (used by `BACKUP_RETENTION_DAYS=0`).
   */
  retentionDays: number;
  /** Max index rows handled per run (default 100). */
  batchSize?: number;
  /** Clock override used by tests; defaults to `IClock.now()`. */
  at?: Date;
}

/**
 * Outcome of one bounded backup-expiry sweep.
 *
 * `failures` counts rows KEPT because the S3 object could not be removed: the
 * index row is the only pointer to the artifact (which still holds personal
 * data), so deleting it would orphan the object and lose the audit trail. The
 * next daily run retries those rows (S3 delete is idempotent).
 */
export interface TenantBackupPurgeResult {
  /** Rows returned by the expiry query (bounded by `batchSize`). */
  scanned: number;
  /** Index rows actually removed from `tenant_backups`. */
  deleted: number;
  /** S3 objects confirmed absent (removed now or already missing). */
  objectsDeleted: number;
  /** Rows retained because the S3 delete failed. */
  failures: number;
}

/**
 * Platform-admin backup and restore.
 *
 *  - `createBackup` writes a complete JSON artifact to
 *    `backups/<tenantSlug>/<timestamp>.json` and indexes it in `tenant_backups`.
 *  - `listBackups` reads the index (the storage port has no ListObjects).
 *  - `restore` creates a NEW workspace from an artifact: never overwrites an
 *    existing tenant, never restores credentials (stores must be reconnected),
 *    and regenerates every agent password (`mustResetPassword`).
 *  - `purgeExpired` applies the LGPD storage limit (see the option/result
 *    contracts above).
 */
export interface ITenantBackupService {
  /** 404 unknown workspace; the artifact carries no credentials. */
  createBackup(tenantId: string, actorId: string): Promise<TenantBackupResult>;
  /** Newest first; 404 unknown workspace. */
  listBackups(tenantId: string): Promise<TenantBackupView[]>;
  /**
   * 404 when the S3 object does not exist, 422 when it is not a valid backup,
   * 409 when `newSlug` is already taken.
   */
  restore(command: RestoreTenantCommand, actorId: string): Promise<RestoreTenantResult>;
  /**
   * Expires backups older than `retentionDays`: S3 object first, index row
   * second. Never throws per item; returns aggregate counters. A no-op when
   * `retentionDays <= 0`.
   */
  purgeExpired(options: TenantBackupPurgeOptions): Promise<TenantBackupPurgeResult>;
}

/* ==========================================================================
 * LGPD tenant privacy (Fase 4): export + soft delete
 * ========================================================================== */

export interface ITenantPrivacyService {
  /** JSON export scoped to the tenant (no password hashes, tokens or raw PII). */
  exportData(tenantId: string, actorId: string): Promise<TenantExportPayload>;
  /**
   * Soft delete after re-authentication (ADMIN password + slug). Keeps every
   * business row for audit; the physical purge is a future platform job.
   */
  deleteTenant(
    tenantId: string,
    command: DeleteTenantCommand,
    actorId: string,
  ): Promise<DeleteTenantResult>;
  /**
   * Platform-console soft delete (no re-authentication): revokes the workspace
   * sessions and marks it as deleted so the manual `purgeTenant` can run. Used
   * for abandoned/restored workspaces whose ADMIN password is unknown.
   */
  deleteTenantByPlatform(tenantId: string, actorId: string): Promise<DeleteTenantResult>;
}

/* ==========================================================================
 * Agents / auth
 * ========================================================================== */

/** Authenticated session issued by login, 2FA challenge, refresh or invitation. */
export interface LoginSuccess {
  token: string;
  /** Rotating refresh token; absent when the session store is unavailable. */
  refreshToken?: string;
  agent: { id: string; name: string; email: string; role: string; presence: AgentPresenceStatus; tenantId: string | null };
}

/**
 * Password accepted but the operator has 2FA enabled: NO access/refresh token is
 * issued. The caller must redeem `challengeToken` (5 min, `scope: '2fa'`) on
 * `POST /auth/2fa/challenge` with a TOTP or recovery code.
 */
export interface LoginTwoFactorRequired {
  twoFactorRequired: true;
  challengeToken: string;
}

export type LoginResult = LoginSuccess | LoginTwoFactorRequired;

/** Optional device fingerprint captured on login/refresh (no PII beyond the UA). */
export interface SessionDeviceInfo {
  userAgent?: string | null;
  ip?: string | null;
}

export interface IAgentService {
  login(email: string, password: string, device?: SessionDeviceInfo): Promise<LoginResult>;
  /**
   * Issues an access + refresh token for an already authenticated operator.
   * Used by login (after every gate) and by the 2FA challenge completion, so
   * both paths share the exact same claim/session shape.
   */
  issueSession(agentId: string, device?: SessionDeviceInfo): Promise<LoginSuccess>;
  verifyToken(token: string): Promise<{
    agentId: string;
    email: string;
    name: string;
    role: string;
    tenantId: string | null;
    isPlatformAdmin: boolean;
    /**
     * Access-token id (`jti`). Optional because tokens minted before the P0
     * revocation feature do not carry it and are still accepted until `exp`.
     */
    jti?: string;
    /**
     * Refresh-session row (`sid` claim) that backs the token; used to mark the
     * current device in `GET /auth/sessions`. Absent on legacy tokens.
     */
    sessionId?: string;
    /** `exp` claim in Unix seconds, used by logout to size the denylist TTL. */
    tokenExpiresAt?: number;
  }>;
  setPresence(agentId: string, presence: AgentPresenceStatus): Promise<IAgentSummary>;
  heartbeat(agentId: string): Promise<void>;
  list(tenantId?: string | null): Promise<IAgentSummary[]>;
  /**
   * Self-service profile: only the display name is editable. Returns the same
   * `IAgentSummary` projection as `GET /auth/me`; throws 404 for an unknown or
   * inactive operator. The optional `device` is only used by the audit trail.
   */
  updateProfile(
    agentId: string,
    input: { name: string },
    device?: SessionDeviceInfo,
  ): Promise<IAgentSummary>;
}

/* ==========================================================================
 * Self-service auth (Fase 1: signup + e-mail verification)
 * ========================================================================== */

export interface SignupCommand {
  companyName: string;
  name: string;
  email: string;
  password: string;
}

export interface SignupResult {
  tenantId: string;
  userId: string;
  emailVerificationRequired: true;
}

export interface IAuthService {
  /** Creates the tenant + ADMIN operator and sends the verification e-mail. */
  signup(command: SignupCommand): Promise<SignupResult>;
  /** Consumes a single-use verification token (hash + TTL checked). */
  verifyEmail(token: string): Promise<void>;
  /** Always resolves (no account enumeration); throttled to 1/min per e-mail. */
  resendVerification(email: string): Promise<void>;
  /** Always resolves: unknown/inactive accounts get the same 202 outcome. */
  forgotPassword(email: string): Promise<void>;
  /** Consumes the reset token, re-hashes the password and revokes all sessions. */
  resetPassword(token: string, password: string): Promise<void>;
}

/* ==========================================================================
 * Two-factor authentication (Fase 1: TOTP, JWT-authenticated management)
 * ========================================================================== */

export interface TwoFactorSetupResult {
  /** Base32 TOTP secret; returned only by `/auth/2fa/setup` (never again). */
  secret: string;
  /** `otpauth://totp/...` URL the client renders as a QR code. */
  otpauthUrl: string;
}

export interface TwoFactorVerifyResult {
  enabled: true;
  /** 8 one-time recovery codes shown only in this response. */
  recoveryCodes: string[];
}

export interface TwoFactorStatusResult {
  enabled: boolean;
}

export interface TwoFactorRecoveryCodesResult {
  /** 8 fresh one-time recovery codes; returned only by the regenerate call. */
  recoveryCodes: string[];
}

export interface TwoFactorRecoveryCodeCountResult {
  /** Recovery codes that were never used (0 when 2FA is off). */
  remaining: number;
}

/**
 * `POST /auth/2fa/enroll/setup` - first step of the ENFORCED enrollment flow.
 *
 * The caller proves possession of the short-lived `setupToken` issued by a login
 * blocked by the workspace `require_2fa` policy; no access token exists yet.
 */
export interface TwoFactorEnrollmentSetupResult {
  /** Base32 TOTP secret, returned once (also embedded in `otpauthUri`). */
  secret: string;
  /** `otpauth://totp/...` URI the client renders as a QR code. */
  otpauthUri: string;
}

/**
 * `POST /auth/2fa/enroll/verify` - second step. Enables TOTP, emits the normal
 * session (same shape as login) and returns the 8 one-time recovery codes.
 */
export interface TwoFactorEnrollmentVerifyResult {
  session: LoginSuccess;
  /** 8 one-time recovery codes, shown only in this response. */
  recoveryCodes: string[];
}

export interface ITwoFactorService {
  /** Generates and encrypts a pending secret; 409 when 2FA is already enabled. */
  setup(userId: string): Promise<TwoFactorSetupResult>;
  /** Confirms the pending secret, enables 2FA and returns the recovery codes. */
  verify(userId: string, code: string): Promise<TwoFactorVerifyResult>;
  /**
   * Enforced enrollment, step 1: validates the short-lived `setupToken` issued
   * by login and stores a fresh pending secret. Public route (Bearer setupToken).
   */
  enrollSetup(
    setupToken: string,
    device?: SessionDeviceInfo,
  ): Promise<TwoFactorEnrollmentSetupResult>;
  /**
   * Enforced enrollment, step 2: validates the setup token AND a TOTP code,
   * enables TOTP, audits `auth.2fa.enrolled` and issues the session. The token is
   * single-use (its `jti` is burned before the session is minted).
   */
  enrollVerify(
    setupToken: string,
    code: string,
    device?: SessionDeviceInfo,
  ): Promise<TwoFactorEnrollmentVerifyResult>;
  /** Requires the account password AND a valid TOTP/recovery code. */
  disable(userId: string, password: string, code?: string): Promise<void>;
  /**
   * Replaces the whole recovery-code set after re-authentication (password +
   * TOTP/recovery code). The previous codes stop working atomically; the new
   * set is returned exactly once.
   */
  regenerateRecoveryCodes(
    userId: string,
    password: string,
    code?: string,
  ): Promise<TwoFactorRecoveryCodesResult>;
  /** Number of recovery codes not yet consumed (UI "running low" warning). */
  countRecoveryCodes(userId: string): Promise<TwoFactorRecoveryCodeCountResult>;
  status(userId: string): Promise<TwoFactorStatusResult>;
  /**
   * Redeems a short-lived challenge JWT (issued by login) with a TOTP or a
   * one-time recovery code and returns the same session shape as login.
   */
  challenge(
    challengeToken: string,
    code: string,
    device?: SessionDeviceInfo,
  ): Promise<LoginSuccess>;
}

/* ==========================================================================
 * Sessions (Fase 1: rotating refresh tokens)
 * ========================================================================== */

export interface IssuedSession {
  refreshToken: string;
  expiresAt: Date;
  /** Row id of the refresh session; also embedded in the access token (`sid`). */
  sessionId?: string;
}

export interface RefreshSessionResult {
  token: string;
  refreshToken: string;
  agent: LoginSuccess['agent'];
  expiresAt: Date;
}

export interface IAuthSessionService {
  /** Creates a session for a freshly authenticated operator. */
  issue(userId: string, device?: SessionDeviceInfo): Promise<IssuedSession>;
  /** Validates + rotates: revokes the presented token and returns a new pair. */
  rotate(refreshToken: string, device?: SessionDeviceInfo): Promise<RefreshSessionResult>;
  /** Revokes the presented session when it belongs to `userId`. */
  revoke(refreshToken: string, userId: string): Promise<boolean>;
  /** "Logout everywhere" / password reset: revokes every live session. */
  revokeAllForUser(userId: string): Promise<number>;
  /** Live sessions of the operator, newest first; `current` comes from the JWT. */
  listForUser(userId: string, currentSessionId?: string): Promise<UserSessionView[]>;
  /**
   * Revokes one session of the operator (idempotent). A session of another
   * operator is a 404 — the API never reveals the existence of foreign rows.
   */
  revokeById(
    sessionId: string,
    userId: string,
    currentSessionId?: string,
  ): Promise<RevokeSessionResult>;
  /** Revokes every live session except the current one; returns the count. */
  revokeOthers(userId: string, currentSessionId?: string): Promise<number>;
}

/* ==========================================================================
 * Invitations (Fase 1: operator invites)
 * ========================================================================== */

export interface CreateInvitationCommand {
  email: string;
  role: AgentRole;
  /** Authenticated ADMIN issuing the invitation (tenant + audit). */
  actor: { id: string; name: string; tenantId: string; email?: string | null };
}

export interface CreateInvitationResult {
  invitationId: string;
  email: string;
  role: AgentRole;
  expiresAt: Date;
}

/**
 * Actor of `POST /admin/invitations/:id/resend`.
 *
 * Extends the audited provenance with the ADMIN display name rendered by the
 * invitation e-mail template (`"Você foi convidado por <name>"`), so a resend
 * uses the exact same delivery path as `create`.
 */
export interface ResendInvitationActor extends AuditActorContext {
  name?: string | null;
}

/** Result of a resend: the invite is guaranteed PENDING after the call. */
export interface ResendInvitationResult {
  id: string;
  email: string;
  role: AgentRole;
  /** New expiry (`now + INVITATION_TTL_MS`), never the previous instant. */
  expiresAt: Date;
  status: 'PENDING';
}

/** Tenant-scoped invitation projection rendered by `GET /invitations`. */
export interface InvitationSummary {
  id: string;
  email: string;
  role: AgentRole;
  status: InvitationStatus;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
}

export interface AcceptInvitationCommand {
  token: string;
  name: string;
  password: string;
}

export interface AcceptInvitationResult {
  /** Access JWT, byte-identical to the login/refresh claim shape. */
  token: string;
  /** Present when the session store accepted the new operator. */
  refreshToken?: string;
  agent: {
    id: string;
    name: string;
    email: string;
    role: AgentRole;
    presence: AgentPresenceStatus;
    tenantId: string;
  };
}

export interface IInvitationService {
  /** Creates/refreshes the invite, mails the single-use link and returns the row. */
  create(command: CreateInvitationCommand): Promise<CreateInvitationResult>;
  /** Every invitation of the tenant, newest first, with the derived status. */
  list(tenantId: string): Promise<InvitationSummary[]>;
  /** Revokes a pending invitation (expires it now); 404 when out of scope. */
  revoke(invitationId: string, tenantId: string): Promise<void>;
  /**
   * ADMIN console list: uppercase derived status + ISO instants, newest first,
   * always scoped to the caller tenant.
   */
  listForAdmin(tenantId: string): Promise<AdminInvitationListResult>;
  /**
   * ADMIN console revoke: hard-deletes a PENDING row, 404 out of scope and
   * 409 `INVITATION_ALREADY_ACCEPTED` once consumed. Audits `invitation.revoked`.
   */
  revokeForAdmin(
    tenantId: string,
    actor: AuditActorContext,
    invitationId: string,
  ): Promise<void>;
  /**
   * ADMIN console resend: re-issues a PENDING or EXPIRED invitation with a NEW
   * single-use token and a fresh TTL, mailing it through the same template as
   * `create`. An ACCEPTED row is 409 `INVITATION_ALREADY_ACCEPTED`; a foreign or
   * unknown id is 404. The e-mail is sent BEFORE the row is updated, so a
   * delivery failure is 502 `EMAIL_SEND_FAILED` and leaves the stored token
   * hash/expiry untouched. Audits `invitation.resent`.
   */
  resendForAdmin(
    tenantId: string,
    actor: ResendInvitationActor,
    invitationId: string,
  ): Promise<ResendInvitationResult>;
  /** Consumes the token, creates the verified operator and opens a session. */
  accept(
    command: AcceptInvitationCommand,
    device?: SessionDeviceInfo,
  ): Promise<AcceptInvitationResult>;
}

/* ==========================================================================
 * Enterprise SSO (OpenID Connect) - Fase 5
 * ========================================================================== */

/**
 * Password-login gate of a workspace with `enforce_sso`.
 *
 * Called by `AgentService.login` ONLY after the password was validated, so a
 * wrong password still answers `401` and the workspace policy is never leaked to
 * an unauthenticated caller (no account enumeration).
 */
export interface ISsoPasswordGuard {
  /** 403 `SSO_REQUIRED` when the workspace enforces SSO and the caller is a member. */
  assertPasswordLoginAllowed(subject: SsoPasswordLoginSubject): Promise<void>;
}

/**
 * Tenant-scoped configuration of the workspace IdP plus the public discovery
 * used to route the SPA to the right tenant before any session exists.
 *
 * Every write is ADMIN-only at the HTTP layer and the tenant id always comes
 * from the JWT. The client secret is write-only: the read model exposes only
 * `clientSecretConfigured`.
 */
export interface ITenantSsoService extends ISsoPasswordGuard {
  /** 404 `SSO_NOT_CONFIGURED` when the workspace has no connection. */
  get(tenantId: string): Promise<SsoConnectionView>;
  /** Upsert; validates https, normalizes domains and encrypts a new secret. */
  update(tenantId: string, command: UpdateSsoConnectionCommand): Promise<SsoConnectionView>;
  /** 404 `SSO_NOT_CONFIGURED` when there was nothing to delete. */
  remove(tenantId: string): Promise<void>;
  /**
   * ADMIN "test connection" probe over the SAVED connection: reads the OIDC
   * discovery document and the JWKS and reports every check. It never exchanges
   * a token nor uses the client secret, is throttled per tenant + client IP and
   * works even while the connection is disabled. 404 `SSO_NOT_CONFIGURED` when
   * the workspace has no connection.
   */
  test(tenantId: string, command?: SsoConnectionTestCommand): Promise<SsoConnectionTestResult>;
  /** Public: `{ enabled, provider, tenantSlug }` or 404 `SSO_NOT_CONFIGURED`. */
  discover(query: { email?: string; domain?: string; ip?: string | null }): Promise<SsoDiscoveryResult>;
}

/**
 * Public OIDC flow.
 *
 * - `start`: builds the authorize URL with signed single-use `state`, `nonce`
 *   and PKCE S256.
 * - `callback`: validates state, exchanges the code at the issuer token
 *   endpoint, fully validates the ID token (RS256/JWKS, iss, aud, exp, nonce),
 *   requires a verified e-mail inside `allowed_domains`, JIT provisions the
 *   operator and returns a redirect carrying a ONE-TIME code (never a token).
 * - `exchange`: consumes that code once and mints the session (`AuthResponse`).
 */
export interface ISsoAuthService {
  start(command: SsoStartCommand): Promise<SsoStartResult>;
  callback(command: SsoCallbackCommand): Promise<SsoCallbackResult>;
  exchange(command: SsoExchangeCommand): Promise<LoginSuccess>;
  /** SPA URL for post-state failures (`?error=<stable code>`). */
  failureRedirect(errorCode: string): string;
}

/* ==========================================================================
 * Webhook ingress
 * ========================================================================== */

export interface WebhookAck {
  accepted: boolean;
  duplicate: boolean;
  status: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
  httpStatus: number;
  body: Record<string, unknown>;
  eventId?: string | null;
  durationMs: number;
}

export interface IWebhookIngressService {
  accept(marketplace: Marketplace, request: RawWebhookRequest): Promise<WebhookAck>;
}

/* ==========================================================================
 * Health / adapter registry / container
 * ========================================================================== */

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  uptimeSeconds: number;
  checks: Array<{ name: string; ok: boolean; detail: string; latencyMs?: number }>;
  channels: ChannelHealthView[];
}

/**
 * Readiness probe result (`GET /health/ready`, `GET /api/v1/health/ready`).
 *
 * Deliberately smaller than `HealthReport`: an orchestrator only needs to know
 * whether the process can serve traffic and which dependency failed. Each check
 * is a flat `ok`/`error` so the payload stays stable and cheap to parse.
 */
export type ReadinessCheckState = 'ok' | 'error';

export interface ReadinessReport {
  status: 'ready' | 'degraded';
  checks: {
    database: ReadinessCheckState;
    redis: ReadinessCheckState;
    storage: ReadinessCheckState;
  };
  /** Sanitized probe message per failing dependency (absent when ready). */
  errors?: Partial<Record<'database' | 'redis' | 'storage', string>>;
}

export interface IHealthService {
  health(): Promise<HealthReport>;
  channels(): Promise<ChannelHealthView[]>;
  /** Bounded (per-probe timeout), never-throwing readiness for orchestrators. */
  readiness(): Promise<ReadinessReport>;
}

/**
 * Public status page (`GET /status`, `GET /api/v1/status`).
 *
 * Anonymous and PII-free. It reuses only the infrastructure probes (database,
 * Redis, object storage) and aggregates the stored account state per
 * marketplace: no adapter/marketplace call is made, so the endpoint is cheap
 * and cannot spend paid API quota.
 */
export interface IStatusService {
  snapshot(): Promise<SystemStatusSnapshot>;
}

/* ==========================================================================
 * Live diagnostics (real credentials; used by /diagnostics and `npm run doctor`)
 * ========================================================================== */

export interface IDiagnosticsService {
  /** Infrastructure + every connected account, in parallel where safe. */
  system(): Promise<import('../dto').SystemDiagnosis>;
  /** Real marketplace calls for a single account. */
  account(accountId: string): Promise<import('../dto').AccountDiagnosis>;
}

export interface IAdapterRegistry {
  get(marketplace: Marketplace): IMarketplaceChannelAdapter;
}

/* ==========================================================================
 * File storage facade (attachments: NF-e, evidence, dispute media)
 * ========================================================================== */

export interface UploadedFile {
  key: string;
  uri: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export interface IFileService {
  upload(input: { fileName: string; mimeType: string; buffer: Buffer }): Promise<UploadedFile>;
  signedUrl(key: string, expiresInSeconds?: number): Promise<string>;
  /** Resolves storage keys into attachment payloads accepted by adapters. */
  resolveAttachmentInputs(keys: string[]): Promise<OutboundAttachmentInput[]>;
}

export interface IAppServices {
  readonly config: ChannelRuntimeConfig;
  readonly logger: ILogger;
  readonly clock: IClock;
  readonly cache: ICache;
  readonly queue: IQueuePublisher;
  readonly realtime: IRealtimePublisher;
  readonly adapters: IAdapterRegistry;
  readonly accounts: IAccountService;
  readonly tenants: ITenantService;
  readonly tenantPrivacy: ITenantPrivacyService;
  readonly tenantPurge: ITenantPurgeService;
  readonly tenantBackup: ITenantBackupService;
  readonly planLimits: IPlanLimitService;
  readonly platform: IPlatformService;
  /** Fase 2 onboarding: how to create the apps in the marketplace portals. */
  readonly integrationSetup: IIntegrationSetupService;
  readonly billing: IBillingService;
  readonly tickets: ITicketQueryService;
  readonly ticketCommands: IUnifiedTicketService;
  readonly outbound: IOutboundRouterService;
  readonly agents: IAgentService;
  readonly auth: IAuthService;
  /** Enterprise SSO: workspace IdP configuration + password-login gate. */
  readonly tenantSso: ITenantSsoService;
  /** Enterprise SSO: public OIDC login flow (start/callback/exchange). */
  readonly sso: ISsoAuthService;
  readonly twoFactor: ITwoFactorService;
  readonly sessions: IAuthSessionService;
  readonly invitations: IInvitationService;
  /** Administrative audit trail (best-effort writes + tenant-scoped reads). */
  readonly audit: IAuditService;
  /** Workspace user administration (`/admin/users`, ADMIN only). */
  readonly adminUsers: IAdminUserService;
  readonly webhooks: IWebhookIngressService;
  readonly health: IHealthService;
  readonly status: IStatusService;
  readonly files: IFileService;
  readonly diagnostics: IDiagnosticsService;
}

/* ==========================================================================
 * Worker job payloads (shared with the HTTP layer for manual replays)
 * ========================================================================== */

export interface InboundJobPayload {
  marketplace: Marketplace;
  accountId: string;
  topic?: string | null;
  resource?: string | null;
  eventId?: string | null;
  payload: Record<string, unknown>;
  rawS3Uri?: string | null;
  receivedAt: string;
  webhookEventId?: string | null;
}

export interface EnrichmentJobPayload {
  ticketId: string;
  accountId: string;
  marketplace: Marketplace;
  externalOrderId?: string | null;
  reason: string;
}

export interface OutboundJobPayload {
  ticketId: string;
  messageId: string;
  accountId: string;
  marketplace: Marketplace;
  attempt: number;
}

export type { ApiEnvelope, InboundEnvelope };
