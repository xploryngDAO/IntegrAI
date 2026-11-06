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
} from '../enums';
import type { BillingStatus, BillingWebhookType, TenantPlan } from '../plans';
import type {
  AgentRecord,
  BillingEventStatus,
  BuyerPiiRecord,
  EmailVerificationRecord,
  InvitationRecord,
  MarketplaceAccountRecord,
  MessageAttachmentRecord,
  OrderCacheRecord,
  OrderItemSnapshot,
  OutboundAttemptRecord,
  PageRequest,
  Paginated,
  PasswordResetRecord,
  PlatformTenantListQuery,
  SessionRecord,
  SlaPolicyRecord,
  SupportTicketRecord,
  TenantBackupCounts,
  TenantBackupPayload,
  TenantPolicyPatch,
  TenantPurgeCounts,
  TenantRecord,
  TenantUsageCounts,
  TicketEventRecord,
  TicketListFilter,
  TicketMessageRecord,
  TicketStats,
  WebhookEventRecord,
} from '../dto';

/* ==========================================================================
 * ACCOUNTS
 * ========================================================================== */

export interface CreateAccountInput {
  tenantId?: string | null;
  marketplace: Marketplace;
  displayName: string;
  externalSellerId: string;
  marketplaceSiteId: string;
  accessTokenEnc?: string | null;
  refreshTokenEnc?: string | null;
  tokenExpiresAt?: Date | null;
  authExpiresAt?: Date | null;
  channelConfig?: Record<string, unknown>;
  status?: AccountStatus;
}

export interface AccountTokenPatch {
  accessTokenEnc?: string | null;
  refreshTokenEnc?: string | null;
  tokenExpiresAt?: Date | null;
  authExpiresAt?: Date | null;
  status?: AccountStatus;
  lastTokenRefreshAt?: Date;
  lastError?: string | null;
  lastErrorAt?: Date | null;
  /** Used when an OAuth reconnect attaches a legacy (tenantless) account. */
  tenantId?: string | null;
}

export interface IAccountRepository {
  create(input: CreateAccountInput): Promise<MarketplaceAccountRecord>;
  findById(id: string): Promise<MarketplaceAccountRecord | null>;
  findByExternalSeller(
    marketplace: Marketplace,
    externalSellerId: string,
    marketplaceSiteId?: string,
  ): Promise<MarketplaceAccountRecord | null>;
  findFirstByMarketplace(marketplace: Marketplace): Promise<MarketplaceAccountRecord | null>;
  list(filter?: { marketplace?: Marketplace; status?: AccountStatus; tenantId?: string | null }): Promise<MarketplaceAccountRecord[]>;
  updateTokens(id: string, patch: AccountTokenPatch): Promise<MarketplaceAccountRecord>;
  updateChannelConfig(id: string, config: Record<string, unknown>): Promise<MarketplaceAccountRecord>;
  setStatus(id: string, status: AccountStatus, error?: string | null): Promise<MarketplaceAccountRecord>;
  delete(id: string): Promise<void>;
}

/* ==========================================================================
 * TICKETS
 * ========================================================================== */

export interface CreateTicketInput {
  tenantId?: string | null;
  accountId: string;
  marketplace: Marketplace;
  ticketType: TicketType;
  externalReferenceId: string;
  externalOrderId?: string | null;
  orderCacheId?: string | null;
  packId?: string | null;
  claimId?: string | null;
  conversationId?: string | null;
  returnSn?: string | null;
  subject?: string | null;
  buyerExternalId?: string | null;
  buyerDisplayName?: string | null;
  buyerAnonymizedEmail?: string | null;
  buyerContactHash?: string | null;
  hasActiveClaim?: boolean;
  status?: TicketStatus;
  priority?: TicketPriority;
  slaDeadlineAt: Date;
  slaTargetAt?: Date | null;
  slaLegMinutes?: number | null;
  assignedQueue?: string | null;
  channelMetadata?: Record<string, unknown>;
  tags?: string[];
}

export interface TicketUpdatePatch {
  status?: TicketStatus;
  priority?: TicketPriority;
  slaDeadlineAt?: Date;
  slaTargetAt?: Date | null;
  slaLegMinutes?: number | null;
  slaBreached?: boolean;
  slaState?: SlaState;
  firstResponseAt?: Date | null;
  resolvedAt?: Date | null;
  lastInboundAt?: Date | null;
  lastOutboundAt?: Date | null;
  lastMessageAt?: Date | null;
  unreadCount?: number;
  assignedAgentId?: string | null;
  assignedQueue?: string | null;
  hasActiveClaim?: boolean;
  channelMetadata?: Record<string, unknown>;
  subject?: string | null;
  buyerDisplayName?: string | null;
  buyerAnonymizedEmail?: string | null;
  externalOrderId?: string | null;
  orderCacheId?: string | null;
  packId?: string | null;
  claimId?: string | null;
  conversationId?: string | null;
  returnSn?: string | null;
  tags?: string[];
}

export interface ThreadingLookup {
  marketplace: Marketplace;
  accountId: string;
  inReplyToIds?: string[];
  externalOrderId?: string | null;
  buyerAnonymizedEmail?: string | null;
  activeWithinDays?: number;
}

export interface ITicketRepository {
  create(input: CreateTicketInput): Promise<SupportTicketRecord>;
  findById(id: string): Promise<SupportTicketRecord | null>;
  findByExternalReference(
    marketplace: Marketplace,
    externalReferenceId: string,
  ): Promise<SupportTicketRecord | null>;
  findActiveByExternalOrderId(
    marketplace: Marketplace,
    externalOrderId: string,
    withinDays?: number,
  ): Promise<SupportTicketRecord | null>;
  findOpenPreSaleByBuyerEmail(
    marketplace: Marketplace,
    buyerAnonymizedEmail: string,
  ): Promise<SupportTicketRecord | null>;
  /** Resolves the Amazon inbound threading order: In-Reply-To -> order -> email. */
  findThreadingMatch(lookup: ThreadingLookup): Promise<SupportTicketRecord | null>;
  update(id: string, patch: TicketUpdatePatch, options?: { mergeChannelMetadata?: boolean }): Promise<SupportTicketRecord>;
  list(filter: TicketListFilter, page: PageRequest): Promise<Paginated<SupportTicketRecord>>;
  /** Open tickets whose SLA deadline has passed and are not yet flagged. */
  findSlaDue(now: Date, limit: number): Promise<SupportTicketRecord[]>;
  findAtRisk(now: Date, warningWindowMs: number, limit: number): Promise<SupportTicketRecord[]>;
  markBreached(ids: string[], at: Date): Promise<number>;
  incrementUnread(id: string, delta: number): Promise<number>;
  stats(filter?: TicketListFilter): Promise<TicketStats>;
  countActiveByAgent(agentId: string): Promise<number>;
  /** FIFO assignment: least-loaded online agent for the given queue. */
  findLeastLoadedAgent(queue: string): Promise<AgentRecord | null>;
}

/* ==========================================================================
 * MESSAGES
 * ========================================================================== */

export interface CreateMessageInput {
  ticketId: string;
  externalMessageId?: string | null;
  inReplyToId?: string | null;
  referencesIds?: string[];
  direction: MessageDirection;
  channelRouteUsed: ChannelRoute;
  messageType?: string;
  bodyCleanText: string;
  bodyHtml?: string | null;
  contentPayload?: Record<string, unknown>;
  bodyRawS3Uri?: string | null;
  deliveryStatus?: DeliveryStatus;
  errorDetail?: string | null;
  isInternalNote?: boolean;
  authorAgentId?: string | null;
  marketplaceCreatedAt: Date;
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  readAt?: Date | null;
}

export interface CreateMessageResult {
  record: TicketMessageRecord;
  created: boolean;
}

export interface IMessageRepository {
  /** Idempotent insert on `external_message_id`; returns created=false on replay. */
  createIdempotent(input: CreateMessageInput): Promise<CreateMessageResult>;
  findById(id: string): Promise<TicketMessageRecord | null>;
  findByExternalMessageId(externalMessageId: string): Promise<TicketMessageRecord | null>;
  listByTicket(ticketId: string, options?: { includeInternal?: boolean; limit?: number }): Promise<TicketMessageRecord[]>;
  updateDeliveryStatus(
    id: string,
    status: DeliveryStatus,
    detail?: { errorDetail?: string | null; sentAt?: Date | null; deliveredAt?: Date | null; readAt?: Date | null },
  ): Promise<TicketMessageRecord>;
  lastByDirection(ticketId: string, direction: MessageDirection): Promise<TicketMessageRecord | null>;
  latestMarketplaceCreatedAt(ticketId: string): Promise<Date | null>;
}

/* ==========================================================================
 * ORDERS
 * ========================================================================== */

export interface UpsertOrderInput {
  accountId: string;
  marketplace: Marketplace;
  externalOrderId: string;
  packId?: string | null;
  buyerExternalId?: string | null;
  buyerNameOrNick?: string | null;
  buyerAnonymizedEmail?: string | null;
  orderStatus: string;
  fulfillmentType?: string | null;
  totalAmount: number;
  currency?: string;
  trackingNumber?: string | null;
  carrierName?: string | null;
  itemsSnapshot?: OrderItemSnapshot[];
  allowedActionsCache?: Record<string, unknown>;
  shippingSnapshot?: Record<string, unknown>;
  estimatedDeliveryAt?: Date | null;
  shippedAt?: Date | null;
  deliveredAt?: Date | null;
}

export interface IOrderRepository {
  upsert(input: UpsertOrderInput): Promise<OrderCacheRecord>;
  findById(id: string): Promise<OrderCacheRecord | null>;
  findByExternalOrderId(marketplace: Marketplace, externalOrderId: string): Promise<OrderCacheRecord | null>;
  findByPackId(accountId: string, packId: string): Promise<OrderCacheRecord | null>;
  listByTicket(ticketId: string): Promise<OrderCacheRecord[]>;
  updateActions(id: string, actions: Record<string, unknown>): Promise<OrderCacheRecord>;
}

/* ==========================================================================
 * ATTACHMENTS
 * ========================================================================== */

export interface CreateAttachmentInput {
  messageId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string | null;
  s3Uri: string;
  externalUploadId?: string | null;
  isEvidence?: boolean;
}

export interface IAttachmentRepository {
  createMany(inputs: CreateAttachmentInput[]): Promise<MessageAttachmentRecord[]>;
  listByMessageIds(messageIds: string[]): Promise<MessageAttachmentRecord[]>;
}

/* ==========================================================================
 * WEBHOOK EVENTS
 * ========================================================================== */

export interface RecordWebhookInput {
  tenantId?: string | null;
  marketplace: Marketplace;
  accountId?: string | null;
  eventId?: string | null;
  topic?: string | null;
  resource?: string | null;
  status?: 'RECEIVED' | 'DUPLICATE' | 'PROCESSED' | 'FAILED' | 'DEAD_LETTER';
  signatureValid?: boolean;
  payload?: Record<string, unknown>;
  payloadS3Uri?: string | null;
  error?: string | null;
}

export interface IWebhookEventRepository {
  record(input: RecordWebhookInput): Promise<WebhookEventRecord>;
  markStatus(
    id: string,
    status: 'RECEIVED' | 'DUPLICATE' | 'PROCESSED' | 'FAILED' | 'DEAD_LETTER',
    detail?: { error?: string | null; processedAt?: Date },
  ): Promise<void>;
  findByEventId(marketplace: Marketplace, eventId: string): Promise<WebhookEventRecord | null>;
  incrementAttempts(id: string): Promise<void>;
}

/* ==========================================================================
 * BILLING EVENTS (Fase 4 - reuse of `webhook_events`)
 * ========================================================================== */

/** Persisted billing audit row, mapped from `webhook_events` (`BILLING`). */
export interface BillingEventAuditRecord {
  id: string;
  /** `billing:<externalId>`; null when the gateway did not send one. */
  eventId: string | null;
  type: BillingWebhookType | null;
  tenantId: string | null;
  /** Resolved only by list queries (console); null on writes. */
  tenantSlug: string | null;
  status: BillingEventStatus;
  payload: Record<string, unknown>;
  error: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface RecordBillingEventInput {
  eventId: string | null;
  tenantId: string;
  type: BillingWebhookType;
  payload: Record<string, unknown>;
  error?: string | null;
}

/**
 * Result of recording an event: `created: false` means the
 * `(marketplace, event_id)` unique index already had the row (concurrent or
 * replayed delivery), which the service answers as a duplicate.
 */
export interface RecordBillingEventResult {
  record: BillingEventAuditRecord;
  created: boolean;
}

export interface IBillingEventRepository {
  /** Finds a billing event by `billing:<externalId>` (idempotency probe). */
  findByEventId(eventId: string): Promise<BillingEventAuditRecord | null>;
  record(input: RecordBillingEventInput): Promise<RecordBillingEventResult>;
  markStatus(
    id: string,
    status: BillingEventStatus,
    detail?: { error?: string | null; processedAt?: Date },
  ): Promise<void>;
  /** Newest-first billing events, bounded by `limit`. */
  listRecent(limit: number): Promise<BillingEventAuditRecord[]>;
}

/* ==========================================================================
 * PII VAULT
 * ========================================================================== */

export interface UpsertPiiInput {
  ticketId: string;
  marketplace: Marketplace;
  buyerName?: string | null;
  buyerEmail?: string | null;
  buyerDocument?: string | null;
  buyerPhone?: string | null;
  shippingAddress?: Record<string, unknown>;
  sourceEndpoints?: string[];
  expiresAt: Date;
}

export interface IPiiVaultRepository {
  upsert(input: UpsertPiiInput): Promise<BuyerPiiRecord>;
  findByTicketId(ticketId: string): Promise<BuyerPiiRecord | null>;
  /** Hard-purges rows whose `expires_at` has passed; returns affected count. */
  purgeExpired(now: Date): Promise<number>;
  deleteByTicketId(ticketId: string): Promise<void>;
}

/* ==========================================================================
 * TICKET EVENTS (audit timeline)
 * ========================================================================== */

export interface AppendTicketEventInput {
  ticketId: string;
  eventType: string;
  actorAgentId?: string | null;
  actorLabel?: string | null;
  payload?: Record<string, unknown>;
}

export interface ITicketEventRepository {
  append(input: AppendTicketEventInput): Promise<TicketEventRecord>;
  listByTicket(ticketId: string): Promise<TicketEventRecord[]>;
}

/* ==========================================================================
 * AGENTS + SLA POLICIES
 * ========================================================================== */

export interface CreateAgentInput {
  email: string;
  name: string;
  passwordHash: string;
  tenantId?: string | null;
  role?: AgentRole;
  avatarColor?: string;
  maxConcurrent?: number;
  /** `null` for self-service signup; set for the verified bootstrap ADMIN. */
  emailVerifiedAt?: Date | null;
}

export interface IAgentRepository {
  create(input: CreateAgentInput): Promise<AgentRecord>;
  findByEmail(email: string): Promise<AgentRecord | null>;
  findById(id: string): Promise<AgentRecord | null>;
  list(filter?: { presence?: AgentPresenceStatus; activeOnly?: boolean; tenantId?: string | null }): Promise<AgentRecord[]>;
  updatePresence(id: string, presence: AgentPresenceStatus, at: Date): Promise<AgentRecord>;
  updatePassword(id: string, passwordHash: string): Promise<void>;
  /** Marks the operator e-mail as verified (idempotent, `null` -> `at`). */
  markEmailVerified(id: string, at: Date): Promise<void>;
}

/* ==========================================================================
 * TENANTS + E-MAIL VERIFICATIONS (Fase 1 self-service signup)
 * ========================================================================== */

export interface CreateTenantInput {
  slug: string;
  name: string;
  status?: string;
  /** Fase 4: plan applied at signup (defaults to FREE when omitted). */
  plan?: TenantPlan;
}

/** Fields an operator may change on its own workspace (Fase 2 onboarding). */
export interface UpdateTenantInput {
  name?: string;
  /** `null` clears the completion marker; a `Date` stamps it. */
  onboardingCompletedAt?: Date | null;
}

export interface ITenantRepository {
  create(input: CreateTenantInput): Promise<TenantRecord>;
  findBySlug(slug: string): Promise<TenantRecord | null>;
  findById(id: string): Promise<TenantRecord | null>;
  /** Tenant-scoped update (the id comes from the JWT, never from the body). */
  update(id: string, input: UpdateTenantInput): Promise<TenantRecord>;
  /** Compensating delete used when the ADMIN insert fails after tenant creation. */
  delete(id: string): Promise<void>;
}

export interface CreateEmailVerificationInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface IEmailVerificationRepository {
  create(input: CreateEmailVerificationInput): Promise<EmailVerificationRecord>;
  findByTokenHash(tokenHash: string): Promise<EmailVerificationRecord | null>;
  markUsed(id: string, at: Date): Promise<void>;
  /** Single-use guarantee: burns every still-unused token of the operator. */
  invalidateUnused(userId: string, at: Date): Promise<number>;
}

export interface ISlaPolicyRepository {
  find(accountId: string | null, marketplace: Marketplace, ticketType: TicketType): Promise<SlaPolicyRecord | null>;
  listByMarketplace(marketplace: Marketplace): Promise<SlaPolicyRecord[]>;
}

/* ==========================================================================
 * PASSWORD RESETS + SESSIONS (Fase 1: reset de senha + refresh rotativo)
 * ========================================================================== */

export interface CreatePasswordResetInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface IPasswordResetRepository {
  create(input: CreatePasswordResetInput): Promise<PasswordResetRecord>;
  findByTokenHash(tokenHash: string): Promise<PasswordResetRecord | null>;
  markUsed(id: string, at: Date): Promise<void>;
  /** Single-use guarantee: burns every still-unused reset token of the user. */
  invalidateUnused(userId: string, at: Date): Promise<number>;
}

export interface UpsertInvitationInput {
  tenantId: string;
  email: string;
  role: AgentRole;
  tokenHash: string;
  invitedBy?: string | null;
  expiresAt: Date;
}

export interface IInvitationRepository {
  /**
   * Creates the invitation, or refreshes the pending one for the same
   * `(tenantId, email)`: the token hash and the TTL are replaced, so a resend
   * never duplicates the row and never leaves an older link usable.
   */
  upsert(input: UpsertInvitationInput): Promise<InvitationRecord>;
  findByTokenHash(tokenHash: string): Promise<InvitationRecord | null>;
  findById(id: string): Promise<InvitationRecord | null>;
  /** Newest first; the service derives pending/accepted/expired from the clock. */
  listByTenant(tenantId: string): Promise<InvitationRecord[]>;
  /**
   * Single-use marker. Returns `null` when another request already accepted it
   * (conditional `accepted_at IS NULL`, mirroring the session revocation).
   */
  accept(id: string, at: Date): Promise<InvitationRecord | null>;
  /**
   * Revokes a still-pending invitation by moving `expires_at` to `at`, so the
   * link stops working immediately and the row stays visible as expired.
   */
  revoke(id: string, tenantId: string, at: Date): Promise<boolean>;
}

/* ==========================================================================
 * TWO-FACTOR AUTHENTICATION (Fase 1: TOTP + recovery codes)
 * ========================================================================== */

/**
 * Persistence port for the 2FA slice. Kept separate from `IAgentRepository` so
 * the profile/team repositories stay untouched: only `TwoFactorService` mutates
 * `two_factor_secret_enc` / `two_factor_enabled` and the recovery-code table.
 */
export interface ITwoFactorRepository {
  /** Stores a freshly generated secret, leaving 2FA disabled (pending setup). */
  setPendingSecret(userId: string, secretEnc: string): Promise<void>;
  /**
   * Atomically flips `two_factor_enabled` and replaces the whole recovery-code
   * set: an operator can never end up enabled without usable backup codes.
   */
  enable(userId: string, codeHashes: string[]): Promise<void>;
  /** Atomically disables 2FA, wipes the secret and deletes every recovery code. */
  disable(userId: string): Promise<void>;
  /**
   * Replaces the recovery-code set in one transaction: the old hashes are
   * deleted and the new ones inserted together, so a failed write never leaves
   * the operator with a partially regenerated (or empty) break-glass set.
   */
  replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<void>;
  /** Recovery codes that are still redeemable (`used_at IS NULL`). */
  countUnusedRecoveryCodes(userId: string): Promise<number>;
  /**
   * Single-use consumption scoped to the operator: conditional `updateMany`
   * (`used_at IS NULL`) so two concurrent requests cannot redeem the same code.
   */
  consumeRecoveryCode(userId: string, codeHash: string, at: Date): Promise<boolean>;
}

export interface CreateSessionInput {
  userId: string;
  tenantId: string;
  refreshTokenHash: string;
  userAgent?: string | null;
  ip?: string | null;
  expiresAt: Date;
}

export interface ISessionRepository {
  create(input: CreateSessionInput): Promise<SessionRecord>;
  findByRefreshTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  /**
   * Revokes a single session. Returns `false` when another request already
   * revoked it (concurrent refresh must not mint two token pairs).
   */
  revoke(id: string, at: Date): Promise<boolean>;
  /** Password reset / "logout everywhere" path. Returns the revoked count. */
  revokeAllForUser(userId: string, at: Date): Promise<number>;
}

/* ==========================================================================
 * FASE 4 - PLATFORM CONSOLE, PLAN QUOTAS AND LGPD TENANT PRIVACY
 * ========================================================================== */

/** Global, cross-tenant operational snapshot rendered by `/platform/metrics`. */
export interface PlatformMetricsRecord {
  totalTenants: number;
  activeTenants: number;
  accountsByMarketplace: Record<Marketplace, number>;
  openTickets: number;
  messagesLast24h: number;
  slaAtRisk: number;
}

/** Input of the per-tenant operational aggregates. */
export interface TenantMetricsQuery {
  /** Lower bound of the rolling 7-day message window. */
  messagesSince: Date;
  /** First calendar day (UTC) of the 14-day ticket series. */
  ticketsSince: Date;
  /** Max SLA deadline considered "at risk" (now + warning horizon). */
  slaHorizon: Date;
}

/** Raw per-tenant aggregates mapped by `PlatformService.tenantMetrics`. */
export interface TenantMetricsRecord {
  accounts: number;
  agents: number;
  ticketsByStatus: Record<TicketStatus, number>;
  slaAtRisk: number;
  slaBreached: number;
  avgFirstResponseMinutes: number | null;
  messagesLast7d: number;
  /** Days that actually have tickets; the service zero-fills the 14-day window. */
  ticketsByDay: Array<{ date: string; count: number }>;
}

/** Minimal tenant row read by the alert derivation (no business rows). */
export interface PlatformAlertTenantRecord {
  id: string;
  slug: string;
  name: string;
  status: string;
  plan: TenantPlan;
  maxAccounts: number;
  maxAgents: number;
}

/** Marketplace account signals used by `/platform/alerts`. */
export interface PlatformAlertAccountRecord {
  id: string;
  tenantId: string | null;
  marketplace: Marketplace;
  displayName: string;
  status: AccountStatus;
  lastErrorAt: Date | null;
  lastError: string | null;
}

/** Cross-tenant raw data behind `/platform/alerts` (no alert table). */
export interface PlatformAlertSnapshot {
  tenants: PlatformAlertTenantRecord[];
  accounts: PlatformAlertAccountRecord[];
  usage: Record<string, { accounts: number; agents: number }>;
  /** Open, non-breached tickets inside the SLA warning horizon, per tenant. */
  slaAtRisk: Record<string, number>;
  /** Pending invitations that expire inside the alert horizon, per tenant. */
  expiringInvitations: Record<string, number>;
}

export interface PlatformAlertQuery {
  /** Only errors at/after this instant are considered recent. */
  errorSince: Date;
  /** SLA warning horizon (`now + 120 min`). */
  slaHorizon: Date;
  /** Pending invitations expiring before this instant are flagged. */
  invitationHorizon: Date;
  /** Lower bound so an already-expired invitation is not reported as "expiring". */
  now: Date;
}

/** One (plan, billing status) bucket of the billing summary. */
export interface PlatformBillingPlanCount {
  plan: TenantPlan;
  billingStatus: BillingStatus;
  tenants: number;
}

/**
 * Cross-tenant aggregates.
 *
 * Kept apart from the per-entity repositories (accounts/tickets/agents) on
 * purpose: the console and the plan-limit gate need COUNTS across tables and
 * none of the domain repositories should grow an admin-only read shape.
 */
export interface IPlatformRepository {
  /** Usage counts per tenant; unknown ids resolve to `{ 0, 0, 0 }`. */
  usageFor(tenantIds: string[]): Promise<Record<string, TenantUsageCounts>>;
  metrics(input: { messagesSince: Date; slaHorizon: Date }): Promise<PlatformMetricsRecord>;
  /** Per-tenant metrics; every query is filtered by `tenantId`. */
  tenantMetrics(tenantId: string, input: TenantMetricsQuery): Promise<TenantMetricsRecord>;
  /** Cross-tenant snapshot for the alert derivation (read-only, no new table). */
  alertSnapshot(input: PlatformAlertQuery): Promise<PlatformAlertSnapshot>;
  /** (plan, billing status) buckets for `GET /platform/billing/summary`. */
  billingByPlanAndStatus(): Promise<PlatformBillingPlanCount[]>;
}

/** Fields the console may change on the subscription of a workspace. */
export interface TenantBillingPatch {
  billingStatus?: BillingStatus;
  trialEndsAt?: Date | null;
  billingEmail?: string | null;
}

/**
 * Subscription write applied by the provider-agnostic billing webhook.
 *
 * Like `TenantBillingPatch` it can change `billingStatus`, but it may also move
 * the commercial `plan` and realign the effective quotas, so a gateway upgrade
 * lands in one row update.
 */
export interface TenantSubscriptionPatch {
  billingStatus?: BillingStatus;
  plan?: TenantPlan;
  maxAccounts?: number;
  maxAgents?: number;
  trialEndsAt?: Date | null;
}

/** Admin-only tenant writes (plan, quota, status, billing, soft delete). */
export interface IPlatformTenantRepository {
  /**
   * Newest first, tenant-level pagination (the console list).
   *
   * When `query.search` is present the page AND the total are scoped to rows
   * whose `name` or `slug` contains the term (case-insensitive).
   */
  list(query: PlatformTenantListQuery): Promise<Paginated<TenantRecord>>;
  /** Applies plan/quota/status; unknown id throws (Prisma P2025). */
  applyPolicies(id: string, patch: TenantPolicyPatch): Promise<TenantRecord>;
  /**
   * Applies billing fields only (subscription status, trial end, billing
   * e-mail). Kept out of `applyPolicies` so the plan/quota console path cannot
   * change billing by accident.
   */
  applyBilling(id: string, patch: TenantBillingPatch): Promise<TenantRecord>;
  /**
   * Applies the subscription transition of a billing webhook (status + plan +
   * quotas in a single update). Kept apart from the console paths so only the
   * gateway contract can move plan and billing together.
   */
  applySubscription(id: string, patch: TenantSubscriptionPatch): Promise<TenantRecord>;
  /** Soft delete: `status='DELETED'`, `deleted_at=at`; data is preserved. */
  softDelete(id: string, at: Date): Promise<TenantRecord>;
}

/**
 * Object-storage artifacts owned by one workspace, grouped by their source.
 *
 * Values are whatever the column stores (`s3://bucket/key` URI or a bare key);
 * the purge service normalizes them before calling `IObjectStorage`.
 *
 * Schema note: `message_attachments` has a single `s3_uri` column (no
 * `s3_key`/`storage_key`), and outbox metadata keeps its keys in
 * `ticket_messages.content_payload.attachment_keys`.
 */
export interface TenantObjectKeys {
  /** `webhook_events.payload_s3_uri` (raw payload dumps). */
  webhookPayloads: string[];
  /** `ticket_messages.body_raw_s3_uri` (immutable raw artifacts, `.eml`, ...). */
  messageBodies: string[];
  /** `message_attachments.s3_uri` (evidence, NF-e, dispute media). */
  attachments: string[];
  /** `ticket_messages.content_payload.attachment_keys` (outbox metadata). */
  metadataAttachments: string[];
}

/**
 * Physical (LGPD) purge of a soft-deleted workspace.
 *
 * The repository owns the FK-safe delete order; the service owns the retention
 * policy (grace period, batch size, logging). Everything happens in ONE
 * transaction so a partially purged workspace can never exist.
 */
export interface ITenantPurgeRepository {
  /** Soft-deleted tenants whose `deleted_at` is older than `cutoff`, oldest first. */
  findPurgeable(cutoff: Date, limit: number): Promise<TenantRecord[]>;
  /**
   * Reads the workspace's object-storage keys WITHOUT mutating any row.
   *
   * Called before `purge` so the service can delete the S3 objects first; it
   * uses the exact same tenant/account scope as the transactional delete.
   */
  collectObjectKeys(tenantId: string): Promise<TenantObjectKeys>;
  /** Deletes every row owned by the tenant and returns the per-table counts. */
  purge(tenantId: string): Promise<TenantPurgeCounts>;
}

export interface TenantDataSnapshotOptions {
  /** Max tickets exported (newest first). Default 1_000. */
  ticketLimit?: number;
  /** Max messages exported in total. Default 5_000. */
  messageLimit?: number;
  /** Max ticket events exported in total. Default 5_000. */
  eventLimit?: number;
}

/** Raw rows backing the LGPD tenant export (mapped by the service). */
export interface TenantDataSnapshot {
  agents: AgentRecord[];
  accounts: MarketplaceAccountRecord[];
  tickets: SupportTicketRecord[];
  messages: TicketMessageRecord[];
  events: TicketEventRecord[];
  truncated: { tickets: boolean; messages: boolean };
}

/**
 * LGPD read/erase side of a tenant. The service decides the projection (no
 * secrets, no raw buyer PII) and this port only guarantees tenant-scoped rows.
 */
export interface ITenantDataRepository {
  snapshot(tenantId: string, options?: TenantDataSnapshotOptions): Promise<TenantDataSnapshot>;
  /** Revokes every live refresh session of the tenant; returns the count. */
  revokeSessions(tenantId: string, at: Date): Promise<number>;
}

/* ==========================================================================
 * FASE 4 - BACKUP / RESTORE POR WORKSPACE
 * ========================================================================== */

/**
 * Raw rows backing one tenant backup.
 *
 * The repository only guarantees tenant scope; the service owns the projection
 * (drops password hashes, encrypted tokens and raw webhook payloads) and the
 * artifact format.
 */
export interface TenantBackupSnapshot {
  agents: AgentRecord[];
  accounts: MarketplaceAccountRecord[];
  tickets: SupportTicketRecord[];
  messages: TicketMessageRecord[];
  attachments: MessageAttachmentRecord[];
  events: TicketEventRecord[];
  outboundAttempts: OutboundAttemptRecord[];
  orders: OrderCacheRecord[];
  slaPolicies: SlaPolicyRecord[];
  webhookEvents: WebhookEventRecord[];
}

/** Insert of one index row after the JSON object was persisted in S3. */
export interface RecordTenantBackupInput {
  tenantId: string;
  s3Key: string;
  sizeBytes: number;
  counts: TenantBackupCounts;
  createdBy: string | null;
  createdAt: Date;
}

/** `tenant_backups` row (Date-based; mapped to a JSON view by the service). */
export interface TenantBackupRecord {
  id: string;
  tenantId: string;
  backupKey: string;
  sizeBytes: number;
  counts: TenantBackupCounts;
  createdBy: string | null;
  createdAt: Date;
}

/**
 * Index + read side of the backup feature.
 *
 * `IObjectStorage` deliberately has no ListObjects, so `tenant_backups` is the
 * single source of truth for `GET /platform/tenants/:id/backups`.
 */
export interface ITenantBackupRepository {
  /** Every row owned by the workspace (no limits: the backup is complete). */
  snapshot(tenantId: string): Promise<TenantBackupSnapshot>;
  /** Persists the index row AFTER the object was written (never before). */
  record(input: RecordTenantBackupInput): Promise<TenantBackupRecord>;
  /** Newest first. */
  listByTenant(tenantId: string): Promise<TenantBackupRecord[]>;
}

/**
 * Everything needed to restore a backup into a NEW workspace.
 *
 * `passwordHashes` is aligned by index with `payload.agents`: the service
 * generates the random temporary password and hashes it BEFORE opening the
 * transaction, keeping bcrypt out of the database transaction.
 */
export interface RestoreTenantInput {
  payload: TenantBackupPayload;
  newSlug: string;
  newName: string;
  /** Source S3 key, re-indexed under the new workspace after the restore. */
  backupKey: string;
  sizeBytes: number;
  createdBy: string;
  now: Date;
  passwordHashes: string[];
}

/** Outcome of the transactional restore. */
export interface RestoreTenantOutcome {
  tenantId: string;
  slug: string;
  counts: TenantBackupCounts;
}

/**
 * Transactional restore of ONE backup into a brand-new tenant.
 *
 * Contract:
 *  - the tenant row is always created (never updated/overwritten);
 *  - every business row gets a NEW uuid and references are remapped;
 *  - agents are recreated with `mustResetPassword=true`, passwords supplied by
 *    the service, no 2FA secret and `isPlatformAdmin=false`;
 *  - accounts are recreated DISCONNECTED with no access/refresh token;
 *  - globally unique natural keys that already exist (agent e-mail, order
 *    external id, message external id, webhook event id) are disambiguated or
 *    cleared, so restoring a workspace that still exists cannot hit a unique
 *    constraint.
 */
export interface ITenantRestoreRepository {
  restore(input: RestoreTenantInput): Promise<RestoreTenantOutcome>;
}
