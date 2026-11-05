import type {
  AgentPresenceStatus,
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
  ChannelHealthView,
  ConnectorDescriptor,
  PageRequest,
  Paginated,
  QueueSnapshot,
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
 * Agents / auth
 * ========================================================================== */

export interface LoginResult {
  token: string;
  /** Rotating refresh token; absent when the session store is unavailable. */
  refreshToken?: string;
  agent: { id: string; name: string; email: string; role: string; presence: AgentPresenceStatus; tenantId: string | null };
}

/** Optional device fingerprint captured on login/refresh (no PII beyond the UA). */
export interface SessionDeviceInfo {
  userAgent?: string | null;
  ip?: string | null;
}

export interface IAgentService {
  login(email: string, password: string, device?: SessionDeviceInfo): Promise<LoginResult>;
  verifyToken(token: string): Promise<{ agentId: string; email: string; name: string; role: string; tenantId: string | null }>;
  setPresence(agentId: string, presence: AgentPresenceStatus): Promise<IAgentSummary>;
  heartbeat(agentId: string): Promise<void>;
  list(tenantId?: string | null): Promise<IAgentSummary[]>;
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
 * Sessions (Fase 1: rotating refresh tokens)
 * ========================================================================== */

export interface IssuedSession {
  refreshToken: string;
  expiresAt: Date;
}

export interface RefreshSessionResult {
  token: string;
  refreshToken: string;
  agent: LoginResult['agent'];
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

export interface IHealthService {
  health(): Promise<HealthReport>;
  channels(): Promise<ChannelHealthView[]>;
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
  readonly tickets: ITicketQueryService;
  readonly ticketCommands: IUnifiedTicketService;
  readonly outbound: IOutboundRouterService;
  readonly agents: IAgentService;
  readonly auth: IAuthService;
  readonly sessions: IAuthSessionService;
  readonly webhooks: IWebhookIngressService;
  readonly health: IHealthService;
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
