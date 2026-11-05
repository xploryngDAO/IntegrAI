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
  createdAt: Date;
  updatedAt: Date;
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
