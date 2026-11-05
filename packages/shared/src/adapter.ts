import type {
  ChannelActionKind,
  ChannelRoute,
  DeliveryStatus,
  Marketplace,
  MessageDirection,
  TicketPriority,
  TicketStatus,
  TicketType,
} from './enums';
import type { OrderItemSnapshot } from './dto';
import type { PolicyViolation } from './compliance';

/* ==========================================================================
 * Channel runtime configuration passed to every adapter
 * ========================================================================== */

export interface AmazonChannelConfig {
  lwaClientId: string;
  lwaClientSecret: string;
  spApiEndpoint: string;
  lwaTokenUrl: string;
  rdtEndpoint: string;
  region: string;
  sesInboundSharedSecret: string;
  emailDomainAllowlist: string[];
  /**
   * Public SP-API application id (`AMAZON_APP_ID`). Optional: when it is empty
   * the Amazon "authorize in Seller Central" OAuth flow is unavailable and the
   * API answers `AMAZON_OAUTH_NOT_CONFIGURED` with remediation.
   */
  appId?: string;
  /** Consent redirect registered in Seller Central (`AMAZON_APP_REDIRECT_URI`). */
  appRedirectUri?: string;
  /** Regional consent page (`AMAZON_OAUTH_AUTHORIZE_URL`). */
  oauthAuthorizeUrl?: string;
}

export interface MeliChannelConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiBase: string;
  refreshIntervalSeconds: number;
  webhookTopics: string[];
}

export interface ShopeeChannelConfig {
  partnerId: number;
  partnerKey: string;
  redirectUri: string;
  apiBase: string;
  refreshIntervalSeconds: number;
  lostPushCron: string;
  lostPushLookbackMinutes: number;
  webhookToleranceSeconds: number;
}

export interface SmtpRelayConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
}

export interface ChannelRateLimits {
  amazonMessagingPerSecond: number;
  amazonOrdersPerSecond: number;
  amazonOrdersBurst: number;
  amazonRdtPerSecond: number;
  meliPerSecond: number;
  shopeePerSecond: number;
}

export interface ChannelRuntimeConfig {
  appBaseUrl: string;
  amazon: AmazonChannelConfig;
  meli: MeliChannelConfig;
  shopee: ShopeeChannelConfig;
  smtp: SmtpRelayConfig;
  s3: { bucket: string; attachmentsBucket: string };
  piiRetentionDays: number;
  rateLimits: ChannelRateLimits;
}

/* ==========================================================================
 * Inbound: raw envelope -> hydrated, normalized message
 * ========================================================================== */

export type RawHeaderValue = string | string[] | undefined;

export interface RawWebhookRequest {
  method: string;
  /** Full URL including scheme/host, query string as received. */
  url: string;
  headers: Record<string, RawHeaderValue>;
  query: Record<string, string>;
  /** EXACT bytes received - required for HMAC verification. */
  rawBody: Buffer;
  receivedAt: Date;
  remoteIp?: string;
}

export interface InboundEnvelope {
  marketplace: Marketplace;
  accountId: string;
  /** Raw webhook/push payload exactly as queued. */
  payload: Record<string, unknown>;
  /** S3 URI when the payload has a persisted raw artifact (`.eml`, JSON blob). */
  rawS3Uri?: string | null;
  receivedAt: Date;
  topic?: string | null;
  resource?: string | null;
  eventId?: string | null;
  attempt?: number;
}

export interface InboundAttachmentDescriptor {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Either the S3 key (already stored) or the remote URL to download. */
  s3Key?: string | null;
  sourceUrl?: string | null;
  contentBase64?: string | null;
  sha256?: string | null;
  externalUploadId?: string | null;
  isEvidence?: boolean;
}

export interface BuyerPiiSnapshot {
  name?: string | null;
  email?: string | null;
  document?: string | null;
  phone?: string | null;
  shippingAddress?: Record<string, unknown> | null;
  sourceEndpoints?: string[];
}

export interface NormalizedOrderSnapshot {
  externalOrderId: string;
  packId?: string | null;
  buyerExternalId?: string | null;
  buyerNameOrNick?: string | null;
  buyerAnonymizedEmail?: string | null;
  orderStatus: string;
  fulfillmentType?: string | null;
  totalAmount: number;
  currency: string;
  trackingNumber?: string | null;
  carrierName?: string | null;
  items: OrderItemSnapshot[];
  allowedActions: Record<string, unknown>;
  shipping: Record<string, unknown>;
  estimatedDeliveryAt?: Date | null;
  shippedAt?: Date | null;
  deliveredAt?: Date | null;
}

export interface HydratedInboundMessage {
  accountId: string;
  marketplace: Marketplace;
  /** question_id | pack_id | claim_id | conversation_id | return_sn | order id | email */
  externalReferenceId: string;
  ticketType: TicketType;
  externalOrderId?: string | null;
  packId?: string | null;
  claimId?: string | null;
  conversationId?: string | null;
  returnSn?: string | null;
  externalMessageId: string;
  inReplyToId?: string | null;
  references?: string[];
  direction: MessageDirection;
  channelRouteUsed: ChannelRoute;
  messageType: string;
  bodyCleanText: string;
  bodyHtml?: string | null;
  contentPayload: Record<string, unknown>;
  bodyRawS3Uri?: string | null;
  marketplaceCreatedAt: Date;
  buyer: {
    externalId?: string | null;
    displayName?: string | null;
    anonymizedEmail?: string | null;
    contactHash?: string | null;
  };
  order?: NormalizedOrderSnapshot | null;
  buyerPii?: BuyerPiiSnapshot | null;
  attachments: InboundAttachmentDescriptor[];
  channelMetadata: Record<string, unknown>;
  hasActiveClaim?: boolean;
  priority?: TicketPriority;
  slaDeadlineAt?: Date | null;
  statusHint?: TicketStatus;
  /** System notices (bounce, external seller central reply, moderation). */
  isSystemEvent?: boolean;
  /**
   * Optional per-message delivery state from the channel (bounce/block notices
   * must be persisted as BOUNCED_BLOCKED instead of DELIVERED).
   */
  deliveryStatus?: DeliveryStatus;
  warnings?: string[];
}

/* ==========================================================================
 * Outbound
 * ========================================================================== */

export interface OutboundAttachmentInput {
  fileName: string;
  mimeType: string;
  /** Object storage key already uploaded by the web app / agent. */
  s3Key: string;
  sizeBytes: number;
  sha256?: string | null;
  contentBase64?: string | null;
}

export interface OutboundDraft {
  ticketId: string;
  /** Internal outbox row id, used to correlate attempts and idempotency. */
  outboxMessageId?: string | null;
  accountId: string;
  marketplace: Marketplace;
  ticketType: TicketType;
  hasActiveClaim: boolean;
  externalReferenceId: string;
  externalOrderId?: string | null;
  packId?: string | null;
  claimId?: string | null;
  conversationId?: string | null;
  returnSn?: string | null;
  questionId?: string | null;
  buyerExternalId?: string | null;
  buyerDisplayName?: string | null;
  buyerAnonymizedEmail?: string | null;
  recipient: 'BUYER' | 'MEDIATOR';
  subject?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
  attachments: OutboundAttachmentInput[];
  forceImportant?: boolean;
  closeWithoutResponse?: boolean;
  inReplyToId?: string | null;
  references?: string[];
  /** Amazon: approved sender from `channel_config.smtp_sender_email`. */
  smtpSenderEmail?: string | null;
  /** Meli post-sale blocked-chat structured reason id from `action_guide`. */
  meliActionGuideReasonId?: string | null;
  /** Shopee chat payload type (`text` | `image` | `order` | `item`). */
  shopeeMessageType?: 'text' | 'image' | 'order' | 'item';
  shopeeOrderCardOrderSn?: string | null;
  shopeeItemCardItemId?: number | null;
  agent: { id: string; name: string; email: string };
  metadata?: Record<string, unknown>;
}

export interface OutboundResult {
  routeUsed: ChannelRoute;
  externalMessageId: string | null;
  deliveryStatus: DeliveryStatus;
  contentPayload: Record<string, unknown>;
  marketplaceCreatedAt: Date;
  attachments: Array<{
    fileName: string;
    mimeType: string;
    s3Uri: string;
    externalUploadId?: string | null;
  }>;
  rawResponse?: unknown;
}

export interface OutboundValidationInput {
  marketplace: Marketplace;
  ticketType: TicketType;
  hasActiveClaim: boolean;
  bodyText: string;
  bodyHtml?: string | null;
  subject?: string | null;
  recipient: 'BUYER' | 'MEDIATOR';
  attachments: OutboundAttachmentInput[];
  forceImportant?: boolean;
  hasPriorInbound: boolean;
  allowedActions?: Record<string, unknown>;
  closeWithoutResponse?: boolean;
  /** Account context so adapters can evaluate per-store allowlists without I/O. */
  accountId?: string;
  allowedLinkDomains?: string[];
  smtpSenderEmail?: string | null;
  buyerOptOut?: boolean;
  channelMetadata?: Record<string, unknown>;
}

export interface PolicyEvaluation {
  violations: PolicyViolation[];
  blocked: boolean;
  sanitizedText: string;
  sanitizedHtml: string | null;
  notes: string[];
  routePreview: RouteDecision;
}

export interface RouteDecision {
  route: ChannelRoute;
  label: string;
  reason: string;
  recipient: 'BUYER' | 'MEDIATOR';
  requiresAttachmentUpload: boolean;
  blocked: boolean;
  blockedReason?: string;
  actionName?: string | null;
}

/* ==========================================================================
 * Structured post-sale actions (cockpit buttons)
 * ========================================================================== */

export interface ChannelActionRequest {
  kind: ChannelActionKind;
  ticketId: string;
  accountId: string;
  marketplace: Marketplace;
  externalOrderId?: string | null;
  packId?: string | null;
  claimId?: string | null;
  conversationId?: string | null;
  returnSn?: string | null;
  questionId?: string | null;
  actionName?: string | null;
  bodyText?: string;
  attachments?: OutboundAttachmentInput[];
  lastReadMessageId?: string | null;
  agent?: { id: string; name: string; email: string };
  payload?: Record<string, unknown>;
}

export interface ChannelActionResult {
  action: ChannelActionKind;
  ok: boolean;
  message: string;
  routeUsed?: ChannelRoute;
  externalId?: string | null;
  data?: Record<string, unknown>;
}

/* ==========================================================================
 * Webhook verification
 * ========================================================================== */

export interface AccountLookup {
  marketplace: Marketplace;
  accountId?: string;
  externalSellerId?: string;
  marketplaceSiteId?: string;
}

export interface WebhookVerification {
  valid: boolean;
  reason: string;
  /** Idempotency key extracted from the payload (message_id, _id, event id). */
  eventId?: string | null;
  topic?: string | null;
  resource?: string | null;
  accountLookup: AccountLookup;
  /** Payload to persist/queue (may be normalized from the raw body). */
  payload: Record<string, unknown>;
}

/* ==========================================================================
 * Adapter dependency injection
 * ========================================================================== */

import type { ILogger, IClock, ICache, IDistributedLock, IRateLimiter, IObjectStorage, ISecretCipher, IRealtimePublisher, IHttpClient, IQueuePublisher } from './ports/infra';
import type {
  IAccountRepository,
  IAttachmentRepository,
  IMessageRepository,
  IOrderRepository,
  IPiiVaultRepository,
  ITicketEventRepository,
  ITicketRepository,
  IWebhookEventRepository,
} from './ports/repositories';

export interface AdapterRepositories {
  accounts: IAccountRepository;
  tickets: ITicketRepository;
  messages: IMessageRepository;
  orders: IOrderRepository;
  attachments: IAttachmentRepository;
  webhookEvents: IWebhookEventRepository;
  piiVault: IPiiVaultRepository;
  ticketEvents: ITicketEventRepository;
}

export interface AdapterDependencies {
  logger: ILogger;
  clock: IClock;
  config: ChannelRuntimeConfig;
  repos: AdapterRepositories;
  cache: ICache;
  lock: IDistributedLock;
  rateLimiter: IRateLimiter;
  storage: IObjectStorage;
  cipher: ISecretCipher;
  realtime: IRealtimePublisher;
  http: IHttpClient;
  queue: IQueuePublisher;
}

export interface IMarketplaceChannelAdapter {
  readonly marketplace: Marketplace;

  /** Verify signature/authenticity of a raw inbound webhook (fast, no network). */
  verifyInbound(request: RawWebhookRequest): Promise<WebhookVerification>;

  /** Expand a queued raw payload into zero or more normalized messages. */
  hydrate(envelope: InboundEnvelope): Promise<HydratedInboundMessage[]>;

  /**
   * Fetch/re-fetch the order (and restricted PII when the channel allows it)
   * for an existing ticket. Used by `queue.spapi.enrichment` fallback tickets,
   * by the cockpit refresh and by the Amazon 24h fallback path.
   */
  enrichOrder?(input: {
    accountId: string;
    externalOrderId: string;
    ticketId: string;
  }): Promise<{ order: NormalizedOrderSnapshot; buyerPii?: BuyerPiiSnapshot | null } | null>;

  /** Route and deliver an agent reply through the correct marketplace API. */
  send(draft: OutboundDraft): Promise<OutboundResult>;

  /** Execute a structured post-sale action requested from the cockpit. */
  executeAction(request: ChannelActionRequest): Promise<ChannelActionResult>;

  /** Pure policy check used by the composer (no network, must be fast). */
  validateOutbound(input: OutboundValidationInput): PolicyEvaluation;

  /** Route decision for the composer banner. */
  resolveRoute(input: OutboundValidationInput): RouteDecision;

  /** Optional periodic reconciliation (token refresh, lost push recovery). */
  runMaintenance?(): Promise<{ task: string; ok: boolean; detail: string }[]>;

  /**
   * Live credential/connectivity probe used by the cockpit diagnostics and by
   * `npm run doctor`. Must perform REAL marketplace calls (token exchange plus
   * the cheapest authenticated read) and never simulate success.
   */
  diagnose?(input: { accountId: string }): Promise<import('./dto').DiagnosisCheck[]>;
}
