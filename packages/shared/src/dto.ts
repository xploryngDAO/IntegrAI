import type {
  AccountStatus,
  AgentPresenceStatus,
  AgentRole,
  ChannelRoute,
  DeliveryStatus,
  Marketplace,
  MessageDirection,
  SlaState,
  TicketPriority,
  TicketStatus,
  TicketType,
} from './enums';
import type { BillingStatus, PlanLimits, TenantPlan } from './plans';

/* ==========================================================================
 * Persistence records (Date-based, consumed by repositories + services)
 * ========================================================================== */

export interface MarketplaceAccountRecord {
  id: string;
  tenantId?: string | null;

  marketplace: Marketplace;
  displayName: string;
  externalSellerId: string;
  marketplaceSiteId: string;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
  authExpiresAt: Date | null;
  channelConfig: Record<string, unknown>;
  status: AccountStatus;
  lastTokenRefreshAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderItemSnapshot {
  sku?: string | null;
  asin?: string | null;
  mlb?: string | null;
  itemId?: string | null;
  title: string;
  quantity: number;
  unitPrice: number;
  imageUrl?: string | null;
  variation?: string | null;
}

export interface OrderCacheRecord {
  id: string;
  accountId: string;
  marketplace: Marketplace;
  externalOrderId: string;
  packId: string | null;
  buyerExternalId: string | null;
  buyerNameOrNick: string | null;
  buyerAnonymizedEmail: string | null;
  orderStatus: string;
  fulfillmentType: string | null;
  totalAmount: number;
  currency: string;
  trackingNumber: string | null;
  carrierName: string | null;
  itemsSnapshot: OrderItemSnapshot[];
  allowedActionsCache: Record<string, unknown>;
  shippingSnapshot: Record<string, unknown>;
  estimatedDeliveryAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupportTicketRecord {
  id: string;
  tenantId: string | null;
  accountId: string;
  marketplace: Marketplace;
  ticketType: TicketType;
  externalReferenceId: string;
  externalOrderId: string | null;
  orderCacheId: string | null;
  packId: string | null;
  claimId: string | null;
  conversationId: string | null;
  returnSn: string | null;
  subject: string | null;
  buyerExternalId: string | null;
  buyerDisplayName: string | null;
  buyerAnonymizedEmail: string | null;
  buyerContactHash: string | null;
  hasActiveClaim: boolean;
  status: TicketStatus;
  priority: TicketPriority;
  slaDeadlineAt: Date;
  slaTargetAt: Date | null;
  slaLegMinutes: number | null;
  slaBreached: boolean;
  slaState: SlaState;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  lastMessageAt: Date | null;
  unreadCount: number;
  assignedAgentId: string | null;
  assignedQueue: string | null;
  channelMetadata: Record<string, unknown>;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface TicketMessageRecord {
  id: string;
  ticketId: string;
  externalMessageId: string | null;
  inReplyToId: string | null;
  referencesIds: string[];
  direction: MessageDirection;
  channelRouteUsed: ChannelRoute;
  messageType: string;
  bodyCleanText: string;
  bodyHtml: string | null;
  contentPayload: Record<string, unknown>;
  bodyRawS3Uri: string | null;
  deliveryStatus: DeliveryStatus;
  errorDetail: string | null;
  isInternalNote: boolean;
  authorAgentId: string | null;
  marketplaceCreatedAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageAttachmentRecord {
  id: string;
  messageId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
  s3Uri: string;
  externalUploadId: string | null;
  isEvidence: boolean;
  createdAt: Date;
}

export interface TicketEventRecord {
  id: string;
  ticketId: string;
  eventType: string;
  actorAgentId: string | null;
  actorLabel: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface AgentRecord {
  id: string;
  tenantId: string | null;
  email: string;
  name: string;
  passwordHash: string;
  role: AgentRole;
  presence: AgentPresenceStatus;
  avatarColor: string;
  maxConcurrent: number;
  isActive: boolean;
  lastSeenAt: Date | null;
  /** `null` until the self-service e-mail verification is consumed (Fase 1). */
  emailVerifiedAt: Date | null;
  /**
   * TOTP secret encrypted with `ISecretCipher` (AES-256-GCM). Present while a
   * setup is pending and while 2FA is enabled; `null` when 2FA is off.
   */
  twoFactorSecretEnc: string | null;
  /** True only after `/auth/2fa/verify` accepted a valid TOTP code. */
  twoFactorEnabled: boolean;
  /**
   * Fase 4: internal platform console operator. Grants cross-tenant access to
   * `/platform/*`; granted only by the seed (`ADMIN_EMAIL` /
   * `PLATFORM_ADMIN_EMAILS`), never through a self-service flow.
   */
  isPlatformAdmin: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One-time 2FA recovery code. Only the SHA-256 of the normalized code is
 * persisted; `usedAt` is the single-use marker.
 */
export interface TwoFactorRecoveryCodeRecord {
  id: string;
  userId: string;
  codeHash: string;
  usedAt: Date | null;
  createdAt: Date;
}

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  /** ACTIVE | SUSPENDED | DELETED (see `TENANT_STATUSES`). */
  status: string;
  /** Fase 4: commercial plan + effective quotas (may differ from plan defaults). */
  plan: TenantPlan;
  maxAccounts: number;
  maxAgents: number;
  /** Fase 4: subscription state (TRIALING until billing activates it). */
  billingStatus: BillingStatus;
  /** End of the trial; null when the workspace is not time-boxed. */
  trialEndsAt: Date | null;
  /** Billing contact e-mail (nullable; the gateway integration is a follow-up). */
  billingEmail: string | null;
  /** Fase 2: first time the guided onboarding wizard was completed. */
  onboardingCompletedAt: Date | null;
  /** Fase 4/LGPD: soft-delete marker (physical purge is a future job). */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Projection returned by `GET/PATCH /tenants/me` (no internal status column). */
export interface TenantProfile {
  id: string;
  slug: string;
  name: string;
  onboardingCompletedAt: Date | null;
}

/* ==========================================================================
 * FASE 4 - platform console, plan quotas and LGPD tenant privacy
 * ========================================================================== */

/**
 * Fields the platform console may change on a workspace. Kept apart from
 * `UpdateTenantInput` on purpose: an operator can rename its tenant and toggle
 * the onboarding marker, never the plan/quota/status.
 */
export interface TenantPolicyPatch {
  plan?: TenantPlan;
  maxAccounts?: number;
  maxAgents?: number;
  status?: string;
  deletedAt?: Date | null;
}

/** Counts rendered by the console for a single tenant. */
export interface TenantUsageCounts {
  accounts: number;
  agents: number;
  tickets: number;
}

/** One row of `GET /platform/tenants` (JSON-safe: ISO strings). */
export interface PlatformTenantView {
  id: string;
  slug: string;
  name: string;
  plan: TenantPlan;
  status: string;
  limits: PlanLimits;
  counts: TenantUsageCounts;
  onboardingCompletedAt: string | null;
  /** Soft-delete marker (null = live workspace). */
  deletedAt: string | null;
  createdAt: string;
  /* ---- Billing prefill (Fase 4): same values PATCH .../billing returns. ---- */
  billingStatus: BillingStatus;
  /** End of the trial window; null when the workspace is not time-boxed. */
  trialEndsAt: string | null;
  /** Billing contact e-mail (null when the console has not set one). */
  billingEmail: string | null;
}

export interface PlatformTenantListResult {
  items: PlatformTenantView[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Query of `GET /platform/tenants`: pagination + optional server-side search.
 *
 * `search` is the trimmed term (1..120 chars) matched with a case-insensitive
 * `contains` against `name` OR `slug`. `total`/`totalPages` always reflect the
 * filtered set, never the whole table.
 */
export interface PlatformTenantListQuery extends PageRequest {
  search?: string;
}

/** Body of `PATCH /platform/tenants/:id`. */
export interface PlatformTenantUpdateCommand {
  plan?: TenantPlan;
  maxAccounts?: number;
  maxAgents?: number;
  /** ACTIVE or SUSPENDED; DELETED is reserved for the LGPD delete flow. */
  status?: 'ACTIVE' | 'SUSPENDED';
}

/** `GET /platform/metrics` - global, cross-tenant operational totals. */
export interface PlatformMetrics {
  generatedAt: string;
  totalTenants: number;
  /** Tenants with `status = ACTIVE` and no soft delete. */
  activeTenants: number;
  accountsByMarketplace: Record<Marketplace, number>;
  totalAccounts: number;
  openTickets: number;
  /** Messages of every tenant inserted in the last 24h. */
  messagesLast24h: number;
  /** Open, not-yet-breached tickets whose SLA deadline is inside the horizon. */
  slaAtRisk: number;
  slaRiskHorizonMinutes: number;
}

/**
 * `GET /platform/tenants/:id/metrics` - operational snapshot of ONE workspace.
 *
 * Every number is aggregated with a `tenant_id` filter, so a platform admin can
 * compare workspaces without loading business rows.
 */
export interface TenantMetrics {
  accounts: number;
  agents: number;
  /** Count per ticket status, including the statuses with zero tickets. */
  ticketsByStatus: Record<TicketStatus, number>;
  /** Sum of the non-terminal statuses (UNREAD/OPEN_WAITING_AGENT/WAITING_BUYER/MEDIATION). */
  openTickets: number;
  /** Open, not-yet-breached tickets whose deadline is inside the warning horizon. */
  slaAtRisk: number;
  /** Tickets flagged as breached (any status). */
  slaBreached: number;
  /** Average minutes between ticket creation and the first agent response. */
  avgFirstResponseMinutes: number | null;
  /** Tenant messages created in the last 7 days. */
  messagesLast7d: number;
  /** Calendar-day series (UTC), always 14 entries, oldest first. */
  ticketsLast14d: Array<{ date: string; count: number }>;
  plan: TenantPlan;
  limits: PlanLimits;
  /** Percentage of each plan quota in use (rounded; can exceed 100). */
  usagePct: { accounts: number; agents: number };
}

/** Severity of an operational alert rendered by the platform console. */
export type PlatformAlertSeverity = 'info' | 'warning' | 'critical';

/**
 * Stable alert kinds derived from live data (no alert table).
 *
 * Quota alerts use one type per resource and encode the 80%/100% threshold in
 * `severity`; `value` carries the relevant number (percentage for quotas,
 * count for SLA/invitations and 1 for binary states).
 */
export type PlatformAlertType =
  | 'TENANT_SUSPENDED'
  | 'ACCOUNT_STATUS'
  | 'ACCOUNT_ERROR'
  | 'AGENTS_QUOTA'
  | 'ACCOUNTS_QUOTA'
  | 'SLA_AT_RISK'
  | 'INVITATIONS_EXPIRING';

export interface PlatformAlert {
  severity: PlatformAlertSeverity;
  tenantId: string;
  tenantSlug: string;
  type: PlatformAlertType;
  message: string;
  value: number;
}

/** `GET /platform/alerts` - derived list, already ordered by urgency. */
export interface PlatformAlertsResult {
  generatedAt: string;
  total: number;
  alerts: PlatformAlert[];
}

/** `GET /platform/billing/summary` - MRR base for the future gateway. */
export interface PlatformBillingSummary {
  /** Sum of the monthly list price of ACTIVE tenants (BRL). */
  mrr: number;
  /** Paying (ACTIVE) tenants per plan; `mrr` is the plan contribution. */
  byPlan: Array<{ plan: TenantPlan; tenants: number; mrr: number }>;
  trialing: number;
  pastDue: number;
}

/** Body of `PATCH /platform/tenants/:id/billing` (at least one field). */
export interface TenantBillingUpdateCommand {
  billingStatus?: BillingStatus;
  /** `null` clears the trial end date; a Date sets it. */
  trialEndsAt?: Date | null;
  /** `null` clears the billing e-mail. */
  billingEmail?: string | null;
}

/** `PATCH /platform/tenants/:id/billing` response. */
export interface TenantBillingView {
  tenantId: string;
  slug: string;
  plan: TenantPlan;
  billingStatus: BillingStatus;
  trialEndsAt: string | null;
  billingEmail: string | null;
  /** Monthly list price of the current plan (BRL); 0 for FREE. */
  monthlyPriceBrl: number;
  updatedAt: string;
}

/** Rows physically removed for one workspace, per table (LGPD purge audit). */
export interface TenantPurgeCounts {
  sessions: number;
  invitations: number;
  passwordResets: number;
  emailVerifications: number;
  twoFactorRecoveryCodes: number;
  buyerPiiVault: number;
  messageAttachments: number;
  messages: number;
  ticketEvents: number;
  outboundAttempts: number;
  tickets: number;
  orders: number;
  webhookEvents: number;
  slaPolicies: number;
  accounts: number;
  agents: number;
  tenant: number;
}

/**
 * Outcome of one physical purge.
 *
 * `deletedAt` is the soft-delete marker that triggered the purge (null only
 * when the tenant row had none) and `counts` is the per-table audit trail the
 * job logs.
 */
export interface TenantPurgeResult {
  tenantId: string;
  slug: string;
  deletedAt: string | null;
  purgedAt: string;
  counts: TenantPurgeCounts;
  /**
   * S3 objects removed BEFORE the transactional delete. Missing objects
   * (NoSuchKey) count as deleted because the desired end state was achieved.
   */
  s3ObjectsDeleted: number;
  /**
   * S3 objects that could not be removed. The DB purge still runs; these
   * orphans are reported so the operator can retry/clean them manually.
   */
  s3Failed: number;
  /** True when a platform administrator ran it manually instead of the cron. */
  manual: boolean;
}

/** Outcome of one scheduled sweep (bounded by `TENANT_PURGE_BATCH_SIZE`). */
export interface TenantPurgeRunResult {
  startedAt: string;
  finishedAt: string;
  scanned: number;
  purged: TenantPurgeResult[];
  failures: Array<{ tenantId: string; error: string }>;
}

/** Output of `IPlanLimitService.usage` (upgrade prompt / console detail). */
export interface PlanUsageView {
  plan: TenantPlan;
  limits: PlanLimits;
  usage: { agents: number; accounts: number };
}

/** `DELETE /tenants/me` body: explicit, double confirmation of the LGPD delete. */
export interface DeleteTenantCommand {
  /** Current password of the authenticated ADMIN (bcrypt-checked). */
  password: string;
  /** Must match `tenants.slug` exactly (case-insensitive, trimmed). */
  confirmSlug: string;
}

export interface DeleteTenantResult {
  tenantId: string;
  slug: string;
  status: 'DELETED';
  deletedAt: string;
  /**
   * Physical purge handled by the daily `queue.tenant.purge` job after the
   * retention grace period (`TENANT_PURGE_RETENTION_DAYS`, 30 days) or by a
   * platform admin (`POST /platform/tenants/:id/purge`).
   */
  purge: {
    scheduled: boolean;
    note: string;
  };
}

export interface TenantExportMeta {
  formatVersion: string;
  exportedAt: string;
  exportedBy: string;
  tenantId: string;
  limits: PlanLimits;
  ticketLimit: number;
  messageLimit: number;
  truncated: { tickets: boolean; messages: boolean };
  notes: string[];
}

/** LGPD export: operator projection WITHOUT `passwordHash`/`twoFactorSecretEnc`. */
export interface TenantExportAgent {
  id: string;
  email: string;
  name: string;
  role: AgentRole;
  presence: AgentPresenceStatus;
  isActive: boolean;
  isPlatformAdmin: boolean;
  emailVerifiedAt: string | null;
  twoFactorEnabled: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

/** LGPD export: account projection WITHOUT access/refresh tokens. */
export interface TenantExportAccount {
  id: string;
  marketplace: Marketplace;
  displayName: string;
  externalSellerId: string;
  marketplaceSiteId: string;
  status: AccountStatus;
  channelConfig: Record<string, unknown>;
  tokenExpiresAt: string | null;
  authExpiresAt: string | null;
  createdAt: string;
}

/** LGPD export: ticket projection WITHOUT raw buyer PII. */
export interface TenantExportTicket {
  id: string;
  marketplace: Marketplace;
  accountId: string;
  ticketType: TicketType;
  status: TicketStatus;
  priority: TicketPriority;
  externalReferenceId: string;
  externalOrderId: string | null;
  subject: string | null;
  hasActiveClaim: boolean;
  slaDeadlineAt: string;
  slaState: SlaState;
  slaBreached: boolean;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  assignedAgentId: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** LGPD export: message projection WITHOUT HTML/raw artifacts/content payloads. */
export interface TenantExportMessage {
  id: string;
  ticketId: string;
  direction: MessageDirection;
  channelRouteUsed: ChannelRoute;
  messageType: string;
  bodyCleanText: string;
  deliveryStatus: DeliveryStatus;
  isInternalNote: boolean;
  authorAgentId: string | null;
  marketplaceCreatedAt: string;
  sentAt: string | null;
  createdAt: string;
}

export interface TenantExportEvent {
  id: string;
  ticketId: string;
  eventType: string;
  actorLabel: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Body of `GET /tenants/me/export` (`Content-Disposition: attachment`). */
export interface TenantExportPayload {
  meta: TenantExportMeta;
  tenant: {
    id: string;
    slug: string;
    name: string;
    status: string;
    plan: TenantPlan;
    limits: PlanLimits;
    onboardingCompletedAt: string | null;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  agents: TenantExportAgent[];
  accounts: TenantExportAccount[];
  tickets: TenantExportTicket[];
  messages: TenantExportMessage[];
  events: TenantExportEvent[];
}

export interface EmailVerificationRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

/** Single-use password reset token (only the SHA-256 hash is persisted). */
export interface PasswordResetRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

/**
 * Rotating refresh-token session. `refreshTokenHash` is the SHA-256 of a random
 * 48-byte token; the raw value only ever exists in the client.
 */
export interface SessionRecord {
  id: string;
  userId: string;
  tenantId: string;
  refreshTokenHash: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

/** Lifecycle of an operator invitation, derived from `accepted_at`/`expires_at`. */
export type InvitationStatus = 'pending' | 'accepted' | 'expired';

/**
 * Single-use operator invitation. Only the SHA-256 of the 32-byte token is
 * persisted (`tokenHash`); the raw token exists solely in the e-mail link.
 */
export interface InvitationRecord {
  id: string;
  tenantId: string;
  email: string;
  role: AgentRole;
  tokenHash: string;
  invitedBy: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
}

export interface WebhookEventRecord {
  id: string;
  marketplace: Marketplace;
  accountId: string | null;
  eventId: string | null;
  topic: string | null;
  resource: string | null;
  status: 'RECEIVED' | 'DUPLICATE' | 'PROCESSED' | 'FAILED' | 'DEAD_LETTER';
  signatureValid: boolean;
  payload: Record<string, unknown>;
  payloadS3Uri: string | null;
  attempts: number;
  error: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface BuyerPiiRecord {
  id: string;
  ticketId: string;
  marketplace: Marketplace;
  buyerName: string | null;
  buyerEmail: string | null;
  buyerDocument: string | null;
  buyerPhone: string | null;
  shippingAddress: Record<string, unknown>;
  sourceEndpoints: string[];
  collectedAt: Date;
  expiresAt: Date;
  purgedAt: Date | null;
}

export interface SlaPolicyRecord {
  id: string;
  accountId: string | null;
  marketplace: Marketplace;
  ticketType: TicketType;
  firstResponseMinutes: number;
  targetMinutes: number;
  warningMinutes: number;
  businessHoursOnly: boolean;
  isActive: boolean;
}

/* ==========================================================================
 * Repository query / command shapes
 * ========================================================================== */

export interface PageRequest {
  page: number;
  pageSize: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export type QueueFilterKey = 'ALL' | 'SLA_CRITICAL' | 'CLAIMS' | 'PRE_SALE' | 'WAITING_ME' | 'UNASSIGNED';

export interface TicketListFilter {
  tenantId?: string | null;
  search?: string;
  marketplace?: Marketplace[];
  accountId?: string;
  status?: TicketStatus[];
  ticketType?: TicketType[];
  priority?: TicketPriority[];
  queueKey?: QueueFilterKey;
  assignedAgentId?: string | null;
  onlyUnassigned?: boolean;
  onlySlaCritical?: boolean;
  hasActiveClaim?: boolean;
}

export interface TicketStats {
  total: number;
  unread: number;
  openWaitingAgent: number;
  atRisk: number;
  breached: number;
  avgFirstResponseMinutes: number | null;
  avgResolutionMinutes: number | null;
  byMarketplace: Record<Marketplace, number>;
}

export interface AgentLoad {
  agentId: string;
  agentName: string;
  presence: AgentPresenceStatus;
  activeTickets: number;
  maxConcurrent: number;
}

/* ==========================================================================
 * API projections (JSON-safe: dates are ISO strings) - mirrored by the web app
 * ========================================================================== */

export interface AttachmentView {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  s3Uri: string;
  isEvidence: boolean;
  downloadUrl?: string | null;
}

export interface MessageView {
  id: string;
  externalMessageId: string | null;
  direction: MessageDirection;
  channelRouteUsed: ChannelRoute;
  messageType: string;
  bodyCleanText: string;
  bodyHtml: string | null;
  deliveryStatus: DeliveryStatus;
  isInternalNote: boolean;
  authorAgentId: string | null;
  marketplaceCreatedAt: string;
  attachments: AttachmentView[];
  contentPayload: Record<string, unknown>;
}

export interface OrderView {
  externalOrderId: string;
  packId: string | null;
  orderStatus: string;
  fulfillmentType: string | null;
  totalAmount: number;
  currency: string;
  trackingNumber: string | null;
  carrierName: string | null;
  items: OrderItemSnapshot[];
  allowedActions: Record<string, unknown>;
  shipping: Record<string, unknown>;
  estimatedDeliveryAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  lastSyncedAt: string;
}

export interface CustomerView {
  externalId: string | null;
  displayName: string | null;
  anonymizedEmail: string | null;
  document: string | null;
  phone: string | null;
  email: string | null;
  shippingAddress: Record<string, unknown> | null;
  /** Amazon: restricted data is RDT-gated and auto-purged. */
  piiProtection: 'RDT_30D_PURGE' | 'STANDARD';
  consents: Record<string, unknown>;
}

export interface TicketListItem {
  id: string;
  marketplace: Marketplace;
  accountId: string;
  accountDisplayName: string;
  ticketType: TicketType;
  subject: string | null;
  externalReferenceId: string;
  externalOrderId: string | null;
  buyerDisplayName: string | null;
  buyerAnonymizedEmail: string | null;
  hasActiveClaim: boolean;
  status: TicketStatus;
  priority: TicketPriority;
  slaDeadlineAt: string;
  slaState: SlaState;
  slaBreached: boolean;
  firstResponseAt: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  assignedQueue: string | null;
  channelMetadata: Record<string, unknown>;
  tags: string[];
}

export interface TicketDetail {
  ticket: TicketListItem;
  order: OrderView | null;
  customer: CustomerView;
  messages: MessageView[];
  events: Array<{
    id: string;
    eventType: string;
    actorLabel: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
  routing: RoutePreview;
  allowedActions: AvailableActionView[];
  crr: CrrStatusView | null;
}

export interface RoutePreview {
  route: ChannelRoute;
  label: string;
  reason: string;
  blocked: boolean;
  warnings: string[];
  recipient: 'BUYER' | 'MEDIATOR';
  requiresAttachmentUpload: boolean;
  forcedImportant: boolean;
}

export interface AvailableActionView {
  kind: string;
  label: string;
  description: string;
  route: ChannelRoute;
  enabled: boolean;
  destructive: boolean;
  requiresConfirmation: boolean;
  source: string;
}

export interface CrrStatusView {
  safe: boolean;
  targetHours: number;
  hoursSinceLastInbound: number | null;
  lastMessageDirection: MessageDirection | null;
  label: string;
}

export interface QueueSnapshot {
  stats: TicketStats;
  generatedAt: string;
}

export interface ChannelHealthView {
  marketplace: Marketplace;
  accountId: string;
  accountDisplayName: string;
  status: AccountStatus;
  inboundHealthy: boolean;
  outboundHealthy: boolean;
  tokenExpiresAt: string | null;
  detail: string;
  crrPercent: number | null;
}

/* ==========================================================================
 * Public status page (`GET /status` and `GET /api/v1/status`)
 *
 * Anonymous, PII-free snapshot: only infrastructure probes (database, Redis,
 * object storage) and AGGREGATED per-marketplace account counters are exposed.
 * No account id, display name, operator e-mail, error message or secret ever
 * crosses this contract.
 * ========================================================================== */

/** Overall level rendered by the public status page. */
export type SystemStatusLevel = 'operational' | 'degraded' | 'down';

/** Dependency probed for the status page (the API itself is implicit). */
export type SystemStatusServiceName = 'api' | 'database' | 'redis' | 'storage';

export interface SystemStatusService {
  name: SystemStatusServiceName;
  /** `operational` when the probe passed; `down` when it failed. */
  status: SystemStatusLevel;
  /** Probe duration in milliseconds (null when it could not be measured). */
  latencyMs: number | null;
}

/** Per-marketplace aggregate; counts only, never account identifiers. */
export interface SystemStatusChannel {
  marketplace: Marketplace;
  /** Accounts of this marketplace known to the API (connected or not). */
  accounts: number;
  /** Accounts considered healthy from their stored state (no live API call). */
  healthy: number;
  /** Most recent `last_error_at` among the accounts (null = no error). */
  lastErrorAt: string | null;
}

export interface SystemStatusSnapshot {
  status: SystemStatusLevel;
  checkedAt: string;
  services: SystemStatusService[];
  channels: SystemStatusChannel[];
}

export interface ConnectAccountView {
  account: {
    id: string;
    marketplace: Marketplace;
    displayName: string;
    externalSellerId: string;
    marketplaceSiteId: string;
    status: AccountStatus;
    channelConfig: Record<string, unknown>;
    tokenExpiresAt: string | null;
    authExpiresAt: string | null;
  };
}

export interface ConnectorDescriptor {
  marketplace: Marketplace;
  authMode: 'OAUTH2' | 'TOKEN_EXCHANGE' | 'SMTP_SES' | 'HYBRID';
  fields: Array<{
    key: string;
    label: string;
    type: 'text' | 'password' | 'url' | 'email' | 'select';
    required: boolean;
    placeholder?: string;
    helpText?: string;
    options?: Array<{ value: string; label: string }>;
    secret?: boolean;
  }>;
  authorizeUrlTemplate?: string | null;
  webhookPath: string;
  docsUrl: string;
  notes: string[];
}

export interface AuthResponse {
  token: string;
  /** Present when the session store accepted the login (Fase 1 refresh rotation). */
  refreshToken?: string;
  agent: {
    id: string;
    name: string;
    email: string;
    role: AgentRole;
    presence: AgentPresenceStatus; tenantId: string | null;
  };
}

export interface ApiEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/* ==========================================================================
 * Live channel diagnostics (real credentials, no simulation)
 * ========================================================================== */

export type DiagnosisStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface DiagnosisCheck {
  /** Stable id used by the UI and by `npm run doctor` (e.g. `amazon.lwa`). */
  id: string;
  label: string;
  status: DiagnosisStatus;
  detail: string;
  latencyMs?: number;
  /** What to do when the check fails (operator-facing, actionable). */
  remediation?: string;
}

export interface AccountDiagnosis {
  accountId: string;
  marketplace: Marketplace;
  displayName: string;
  overall: DiagnosisStatus;
  checks: DiagnosisCheck[];
  testedAt: string;
}

export interface SystemDiagnosis {
  overall: DiagnosisStatus;
  version: string;
  testedAt: string;
  infrastructure: DiagnosisCheck[];
  channels: AccountDiagnosis[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}
