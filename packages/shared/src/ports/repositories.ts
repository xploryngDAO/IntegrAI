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
import type {
  AgentRecord,
  BuyerPiiRecord,
  MarketplaceAccountRecord,
  MessageAttachmentRecord,
  OrderCacheRecord,
  OrderItemSnapshot,
  PageRequest,
  Paginated,
  SlaPolicyRecord,
  SupportTicketRecord,
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
  list(filter?: { marketplace?: Marketplace; status?: AccountStatus }): Promise<MarketplaceAccountRecord[]>;
  updateTokens(id: string, patch: AccountTokenPatch): Promise<MarketplaceAccountRecord>;
  updateChannelConfig(id: string, config: Record<string, unknown>): Promise<MarketplaceAccountRecord>;
  setStatus(id: string, status: AccountStatus, error?: string | null): Promise<MarketplaceAccountRecord>;
  delete(id: string): Promise<void>;
}

/* ==========================================================================
 * TICKETS
 * ========================================================================== */

export interface CreateTicketInput {
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
  isDemo?: boolean;
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
  role?: AgentRole;
  avatarColor?: string;
  maxConcurrent?: number;
}

export interface IAgentRepository {
  create(input: CreateAgentInput): Promise<AgentRecord>;
  findByEmail(email: string): Promise<AgentRecord | null>;
  findById(id: string): Promise<AgentRecord | null>;
  list(filter?: { presence?: AgentPresenceStatus; activeOnly?: boolean }): Promise<AgentRecord[]>;
  updatePresence(id: string, presence: AgentPresenceStatus, at: Date): Promise<AgentRecord>;
  updatePassword(id: string, passwordHash: string): Promise<void>;
}

export interface ISlaPolicyRepository {
  find(accountId: string | null, marketplace: Marketplace, ticketType: TicketType): Promise<SlaPolicyRecord | null>;
  listByMarketplace(marketplace: Marketplace): Promise<SlaPolicyRecord[]>;
}
