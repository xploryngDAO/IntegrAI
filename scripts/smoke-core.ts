/* Temporary runtime smoke test for core-engine services (not part of the build). */
import type {
  AccountStatus,
  AgentRecord,
  BuyerPiiRecord,
  CreateAttachmentInput,
  CreateMessageInput,
  CreateMessageResult,
  CreateTicketInput,
  MessageAttachmentRecord,
  OrderCacheRecord,
  PageRequest,
  Paginated,
  RawWebhookRequest,
  SlaPolicyRecord,
  SupportTicketRecord,
  TicketEventRecord,
  TicketListFilter,
  TicketMessageRecord,
  TicketStats,
  WebhookEventRecord,
} from '@sac/shared';
import type { IMarketplaceChannelAdapter } from '@sac/shared';

import { SlaEngine } from './packages/server/src/application/sla/SlaEngine';
import { UnifiedTicketService } from './packages/server/src/application/UnifiedTicketService';
import { OutboundRouterService } from './packages/server/src/application/OutboundRouterService';
import { WebhookIngressService } from './packages/server/src/application/WebhookIngressService';
import { TicketQueryService } from './packages/server/src/application/TicketQueryService';

const FIXED = new Date('2026-02-10T12:00:00.000Z');
const clock = { now: () => new Date(FIXED.getTime()) };
const logger: any = {
  child: () => logger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let failures = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    console.log('  ok -', label);
  } else {
    failures += 1;
    console.error('  FAIL -', label);
  }
}

/* ------------------------------------------------------------------ */
/* In-memory repositories                                              */
/* ------------------------------------------------------------------ */

const accounts: any[] = [
  {
    id: 'acc-amazon',
    marketplace: 'AMAZON',
    displayName: 'Amazon BR',
    externalSellerId: 'SELLER-1',
    marketplaceSiteId: 'SITE-1',
    accessTokenEnc: 'enc',
    refreshTokenEnc: 'enc',
    tokenExpiresAt: new Date(FIXED.getTime() + 3600_000),
    authExpiresAt: null,
    channelConfig: { smtp_sender_email: 'loja@marca.com', inbound_email_route: 'relay@inbound' },
    status: 'ACTIVE',
    lastTokenRefreshAt: null,
    lastErrorAt: null,
    lastError: null,
    createdAt: FIXED,
    updatedAt: FIXED,
  },
  {
    id: 'acc-meli',
    marketplace: 'MERCADO_LIVRE',
    displayName: 'Meli',
    externalSellerId: '123',
    marketplaceSiteId: 'MLB',
    accessTokenEnc: 'enc',
    refreshTokenEnc: 'enc',
    tokenExpiresAt: new Date(FIXED.getTime() + 3600_000),
    authExpiresAt: null,
    channelConfig: {},
    status: 'ACTIVE',
    lastTokenRefreshAt: null,
    lastErrorAt: null,
    lastError: null,
    createdAt: FIXED,
    updatedAt: FIXED,
  },
  {
    id: 'acc-shopee',
    marketplace: 'SHOPEE',
    displayName: 'Shopee',
    externalSellerId: '777',
    marketplaceSiteId: '777',
    accessTokenEnc: 'enc',
    refreshTokenEnc: 'enc',
    tokenExpiresAt: new Date(FIXED.getTime() + 3600_000),
    authExpiresAt: null,
    channelConfig: {},
    status: 'ACTIVE',
    lastTokenRefreshAt: null,
    lastErrorAt: null,
    lastError: null,
    createdAt: FIXED,
    updatedAt: FIXED,
  },
];

const agents: any[] = [];

const accountRepo: any = {
  findById: async (id: string) => accounts.find((a) => a.id === id) ?? null,
  findByExternalSeller: async (marketplace: string, seller: string) =>
    accounts.find((a) => a.marketplace === marketplace && a.externalSellerId === seller) ?? null,
  findFirstByMarketplace: async (m: string) => accounts.find((a) => a.marketplace === m) ?? null,
  list: async () => accounts.slice(),
  create: async (input: any) => {
    const record = { id: `acc-${accounts.length + 1}`, ...input, createdAt: FIXED, updatedAt: FIXED };
    accounts.push(record);
    return record;
  },
  updateTokens: async (id: string, patch: any) => Object.assign(accounts.find((a) => a.id === id), patch),
  updateChannelConfig: async (id: string, config: any) => Object.assign(accounts.find((a) => a.id === id), { channelConfig: config }),
  setStatus: async (id: string, status: AccountStatus, error: string | null) => Object.assign(accounts.find((a) => a.id === id), { status, lastError: error, lastErrorAt: error ? FIXED : null }),
  delete: async () => undefined,
};

const tickets: SupportTicketRecord[] = [];
const ticketMessages: TicketMessageRecord[] = [];
const attachments: MessageAttachmentRecord[] = [];
const piiRows: BuyerPiiRecord[] = [];
const events: TicketEventRecord[] = [];
const orders: OrderCacheRecord[] = [];
let ticketSeq = 0;
let messageSeq = 0;

const ticketRepo: any = {
  create: async (input: CreateTicketInput) => {
    const record: SupportTicketRecord = {
      id: `t-${++ticketSeq}`,
      ...input,
      externalOrderId: input.externalOrderId ?? null,
      orderCacheId: input.orderCacheId ?? null,
      packId: input.packId ?? null,
      claimId: input.claimId ?? null,
      conversationId: input.conversationId ?? null,
      returnSn: input.returnSn ?? null,
      subject: input.subject ?? null,
      buyerExternalId: input.buyerExternalId ?? null,
      buyerDisplayName: input.buyerDisplayName ?? null,
      buyerAnonymizedEmail: input.buyerAnonymizedEmail ?? null,
      buyerContactHash: input.buyerContactHash ?? null,
      hasActiveClaim: input.hasActiveClaim ?? false,
      status: input.status ?? 'UNREAD',
      priority: input.priority ?? 'MEDIUM',
      slaTargetAt: input.slaTargetAt ?? null,
      slaLegMinutes: input.slaLegMinutes ?? null,
      slaBreached: false,
      slaState: 'ON_TRACK',
      firstResponseAt: null,
      resolvedAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastMessageAt: null,
      unreadCount: 0,
      assignedAgentId: null,
      assignedQueue: input.assignedQueue ?? null,
      channelMetadata: input.channelMetadata ?? {},
      tags: input.tags ?? [],
      isDemo: false,
      createdAt: FIXED,
      updatedAt: FIXED,
    };
    tickets.push(record);
    return record;
  },
  findById: async (id: string) => tickets.find((t) => t.id === id) ?? null,
  findByExternalReference: async (m: string, ref: string) =>
    tickets.find((t) => t.marketplace === m && t.externalReferenceId === ref) ?? null,
  findActiveByExternalOrderId: async (m: string, orderId: string) =>
    tickets.find((t) => t.marketplace === m && t.externalOrderId === orderId) ?? null,
  findOpenPreSaleByBuyerEmail: async (m: string, email: string) =>
    tickets.find((t) => t.marketplace === m && t.ticketType === 'PRE_SALE' && t.buyerAnonymizedEmail === email) ?? null,
  findThreadingMatch: async (lookup: any) => {
    if (lookup.externalOrderId) {
      const byOrder = tickets.find((t) => t.marketplace === lookup.marketplace && t.externalOrderId === lookup.externalOrderId);
      if (byOrder) return byOrder;
    }
    if (lookup.buyerAnonymizedEmail) {
      return tickets.find((t) => t.marketplace === lookup.marketplace && t.buyerAnonymizedEmail === lookup.buyerAnonymizedEmail) ?? null;
    }
    return null;
  },
  update: async (id: string, patch: any, options?: any) => {
    const ticket = tickets.find((t) => t.id === id)!;
    if (patch.channelMetadata) {
      ticket.channelMetadata = options?.mergeChannelMetadata
        ? { ...ticket.channelMetadata, ...patch.channelMetadata }
        : patch.channelMetadata;
      delete patch.channelMetadata;
    }
    Object.assign(ticket, patch, { updatedAt: FIXED });
    return ticket;
  },
  list: async (filter: TicketListFilter, page: PageRequest): Promise<Paginated<SupportTicketRecord>> => {
    let rows = tickets.slice();
    if (filter.marketplace?.length) rows = rows.filter((t) => filter.marketplace!.includes(t.marketplace));
    if (filter.ticketType?.length) rows = rows.filter((t) => filter.ticketType!.includes(t.ticketType));
    if (filter.status?.length) rows = rows.filter((t) => filter.status!.includes(t.status));
    if (filter.onlyUnassigned) rows = rows.filter((t) => !t.assignedAgentId);
    return { items: rows, total: rows.length, page: page.page, pageSize: page.pageSize, totalPages: 1 };
  },
  findSlaDue: async () => tickets.filter((t) => !t.slaBreached && t.slaDeadlineAt.getTime() < FIXED.getTime()),
  findAtRisk: async () => tickets.slice(),
  markBreached: async (ids: string[]) => ids.length,
  incrementUnread: async (id: string, delta: number) => {
    const ticket = tickets.find((t) => t.id === id)!;
    ticket.unreadCount += delta;
    return ticket.unreadCount;
  },
  stats: async (): Promise<TicketStats> => ({
    total: tickets.length,
    unread: 0,
    openWaitingAgent: 0,
    atRisk: 0,
    breached: 0,
    avgFirstResponseMinutes: null,
    avgResolutionMinutes: null,
    byMarketplace: { AMAZON: 0, MERCADO_LIVRE: 0, SHOPEE: 0 },
  }),
  countActiveByAgent: async () => 0,
  findLeastLoadedAgent: async () => null,
};

const messageRepo: any = {
  createIdempotent: async (input: CreateMessageInput): Promise<CreateMessageResult> => {
    if (input.externalMessageId) {
      const existing = ticketMessages.find((m) => m.externalMessageId === input.externalMessageId);
      if (existing) return { record: existing, created: false };
    }
    const record: TicketMessageRecord = {
      id: `m-${++messageSeq}`,
      ...input,
      externalMessageId: input.externalMessageId ?? null,
      inReplyToId: input.inReplyToId ?? null,
      referencesIds: input.referencesIds ?? [],
      bodyHtml: input.bodyHtml ?? null,
      contentPayload: input.contentPayload ?? {},
      bodyRawS3Uri: input.bodyRawS3Uri ?? null,
      deliveryStatus: input.deliveryStatus ?? 'QUEUED',
      errorDetail: input.errorDetail ?? null,
      isInternalNote: input.isInternalNote ?? false,
      authorAgentId: input.authorAgentId ?? null,
      sentAt: input.sentAt ?? null,
      deliveredAt: input.deliveredAt ?? null,
      readAt: input.readAt ?? null,
      createdAt: FIXED,
      updatedAt: FIXED,
    };
    ticketMessages.push(record);
    return { record, created: true };
  },
  findById: async (id: string) => ticketMessages.find((m) => m.id === id) ?? null,
  findByExternalMessageId: async (id: string) => ticketMessages.find((m) => m.externalMessageId === id) ?? null,
  listByTicket: async (ticketId: string) => ticketMessages.filter((m) => m.ticketId === ticketId),
  updateDeliveryStatus: async (id: string, status: any, detail?: any) => {
    const m = ticketMessages.find((x) => x.id === id)!;
    m.deliveryStatus = status;
    if (detail?.errorDetail !== undefined) m.errorDetail = detail.errorDetail;
    return m;
  },
  lastByDirection: async (ticketId: string, direction: string) =>
    [...ticketMessages].reverse().find((m) => m.ticketId === ticketId && m.direction === direction) ?? null,
  latestMarketplaceCreatedAt: async () => null,
};

const attachmentRepo: any = {
  createMany: async (rows: CreateAttachmentInput[]): Promise<MessageAttachmentRecord[]> =>
    rows.map((row) => {
      const record = { id: `a-${attachments.length + 1}`, ...row, createdAt: FIXED } as MessageAttachmentRecord;
      attachments.push(record);
      return record;
    }),
  listByMessageIds: async (ids: string[]) => attachments.filter((a) => ids.includes(a.messageId)),
};

const orderRepo: any = {
  upsert: async (input: any): Promise<OrderCacheRecord> => {
    const existing = orders.find((o) => o.externalOrderId === input.externalOrderId);
    if (existing) {
      Object.assign(existing, input);
      return existing;
    }
    const record = {
      id: `o-${orders.length + 1}`,
      ...input,
      itemsSnapshot: input.itemsSnapshot ?? [],
      allowedActionsCache: input.allowedActionsCache ?? {},
      shippingSnapshot: input.shippingSnapshot ?? {},
      lastSyncedAt: FIXED,
      createdAt: FIXED,
      updatedAt: FIXED,
    } as OrderCacheRecord;
    orders.push(record);
    return record;
  },
  findById: async (id: string) => orders.find((o) => o.id === id) ?? null,
  findByExternalOrderId: async (m: string, id: string) => orders.find((o) => o.marketplace === m && o.externalOrderId === id) ?? null,
  findByPackId: async () => null,
  listByTicket: async () => [],
  updateActions: async () => orders[0],
};

const piiRepo: any = {
  upsert: async (input: any): Promise<BuyerPiiRecord> => {
    const existing = piiRows.find((p) => p.ticketId === input.ticketId);
    if (existing) {
      Object.assign(existing, input);
      return existing;
    }
    const record = { id: `pii-${piiRows.length + 1}`, ...input, collectedAt: FIXED, purgedAt: null } as BuyerPiiRecord;
    piiRows.push(record);
    return record;
  },
  findByTicketId: async (ticketId: string) => piiRows.find((p) => p.ticketId === ticketId) ?? null,
  purgeExpired: async () => 0,
  deleteByTicketId: async () => undefined,
};

const eventRepo: any = {
  append: async (input: any): Promise<TicketEventRecord> => {
    const record = { id: `e-${events.length + 1}`, ...input, payload: input.payload ?? {}, createdAt: FIXED };
    events.push(record);
    return record;
  },
  listByTicket: async (ticketId: string) => events.filter((e) => e.ticketId === ticketId),
};

const agentRepo: any = {
  findById: async () => agents[0] ?? null,
  findByEmail: async () => null,
  list: async () => agents.slice(),
  create: async () => agents[0],
  updatePresence: async () => agents[0],
  updatePassword: async () => undefined,
};

const slaPolicyRepo: any = {
  find: async (): Promise<SlaPolicyRecord | null> => null,
  listByMarketplace: async () => [],
};

const webhookRepo: any = {
  record: async (input: any): Promise<WebhookEventRecord> => {
    const record = { id: `wh-${Math.random()}`, ...input, attempts: 0, receivedAt: FIXED, processedAt: null } as WebhookEventRecord;
    webhookRepo.rows.push(record);
    return record;
  },
  markStatus: async (id: string, status: string, detail?: any) => {
    const row = webhookRepo.rows.find((r: any) => r.id === id);
    if (row) Object.assign(row, { status, ...(detail ?? {}) });
  },
  findByEventId: async () => null,
  incrementAttempts: async () => undefined,
  rows: [] as WebhookEventRecord[],
};

/* Cache / queue / realtime / storage ---------------------------------- */

const cacheStore = new Map<string, unknown>();
const cache: any = {
  get: async (key: string) => (cacheStore.has(key) ? cacheStore.get(key) : null),
  set: async (key: string, value: unknown) => cacheStore.set(key, value),
  setNx: async (key: string, value: string) => {
    if (cacheStore.has(key)) return false;
    cacheStore.set(key, value);
    return true;
  },
  del: async (key: string) => cacheStore.delete(key),
  exists: async (key: string) => cacheStore.has(key),
  ttl: async () => 1,
  incr: async () => 1,
  hset: async () => undefined,
  hgetall: async () => null,
  sadd: async () => undefined,
  srem: async () => undefined,
  smembers: async () => [],
};

const published: Array<{ queue: string; payload: unknown }> = [];
const queue: any = {
  publish: async (queueName: string, payload: unknown) => {
    published.push({ queue: queueName, payload });
    return 'job-1';
  },
  publishToDlq: async () => undefined,
};

const realtimeEvents: string[] = [];
const realtime: any = {
  ticketUpdated: () => realtimeEvents.push('ticketUpdated'),
  messageCreated: () => realtimeEvents.push('messageCreated'),
  queueChanged: () => realtimeEvents.push('queueChanged'),
  channelHealth: () => realtimeEvents.push('channelHealth'),
  agentPresence: () => realtimeEvents.push('agentPresence'),
};

const storage: any = {
  putObject: async ({ key, body }: any) => ({ key, uri: `s3://attachments-bucket/${key}`, size: body.length, sha256: 'a'.repeat(64) }),
  getObject: async () => Buffer.from('file'),
  putToPresignedUrl: async () => undefined,
  presignGet: async () => 'https://signed',
  buildUri: (key: string) => `s3://attachments-bucket/${key}`,
};

/* Adapters ------------------------------------------------------------ */

const fakeAdapter = (marketplace: string): IMarketplaceChannelAdapter => ({
  marketplace: marketplace as any,
  verifyInbound: async () => ({
    valid: true,
    reason: 'test',
    eventId: `evt-${marketplace}`,
    topic: 'messages',
    resource: 'r',
    accountLookup: { marketplace: marketplace as any, accountId: accounts.find((a) => a.marketplace === marketplace)?.id },
    payload: { ok: true },
  }),
  hydrate: async () => [],
  send: async () => ({
    routeUsed: (marketplace === 'SHOPEE' ? 'SHOPEE_CHAT_API' : marketplace === 'MERCADO_LIVRE' ? 'MELI_MESSAGES_API' : 'AMAZON_EMAIL_RELAY') as any,
    externalMessageId: '<out-1@example.com>',
    deliveryStatus: 'SENT' as any,
    contentPayload: {},
    marketplaceCreatedAt: FIXED,
    attachments: [],
  }),
  executeAction: async (request) => ({ action: request.kind, ok: true, message: 'ok', routeUsed: 'SHOPEE_CHAT_API' as any }),
  validateOutbound: (input: any) => ({
    violations: /\bwhatsapp\b/i.test(input.bodyText)
      ? [{ code: 'OFF_PLATFORM_CONTACT', severity: 'BLOCK' as const, message: 'blocked', field: 'body' as const }]
      : [],
    blocked: /\bwhatsapp\b/i.test(input.bodyText),
    sanitizedText: input.bodyText,
    sanitizedHtml: null,
    notes: [],
    routePreview: {
      route: 'AMAZON_EMAIL_RELAY' as any,
      label: 'relay',
      reason: 'prior inbound',
      recipient: input.recipient,
      requiresAttachmentUpload: false,
      blocked: false,
    },
  }),
  resolveRoute: (input: any) => ({
    route: 'AMAZON_EMAIL_RELAY' as any,
    label: 'relay',
    reason: 'prior inbound',
    recipient: input.recipient,
    requiresAttachmentUpload: false,
    blocked: false,
  }),
});
const adapters: any = {
  get: (marketplace: string) => fakeAdapter(marketplace),
};

const files: any = {
  upload: async () => ({ key: 'attachments/x', uri: 's3://b/attachments/x', fileName: 'x', mimeType: 'application/pdf', sizeBytes: 1, sha256: 'a' }),
  signedUrl: async () => 'https://signed',
  resolveAttachmentInputs: async () => [],
};

const config: any = {
  appBaseUrl: 'http://localhost:4000',
  piiRetentionDays: 30,
  s3: { bucket: 'raw', attachmentsBucket: 'attachments-bucket' },
  amazon: { region: 'na' },
  meli: {},
  shopee: {},
  smtp: {},
  rateLimits: {},
};

/* Services ----------------------------------------------------------- */

const slaEngine = new SlaEngine({
  clock: clock as any,
  logger,
  realtime,
  tickets: ticketRepo,
  slaPolicies: slaPolicyRepo,
  cache,
});

const ticketCommands = new UnifiedTicketService({
  logger,
  clock: clock as any,
  cache,
  queue,
  realtime,
  config,
  storage,
  slaEngine,
  adapters,
  repos: {
    accounts: accountRepo,
    agents: agentRepo,
    tickets: ticketRepo,
    messages: messageRepo,
    orders: orderRepo,
    attachments: attachmentRepo,
    piiVault: piiRepo,
    ticketEvents: eventRepo,
    slaPolicies: slaPolicyRepo,
  },
});

const attempts: any[] = [];
const outbound = new OutboundRouterService({
  logger,
  clock: clock as any,
  cache,
  queue,
  realtime,
  config,
  adapters,
  files,
  ticketCommands,
  attempts: { record: async (input: any) => attempts.push(input) },
  repos: {
    accounts: accountRepo,
    tickets: ticketRepo,
    messages: messageRepo,
    orders: orderRepo,
    attachments: attachmentRepo,
    ticketEvents: eventRepo,
  },
});

const queries = new TicketQueryService({
  logger,
  clock: clock as any,
  cache,
  adapters,
  repos: {
    accounts: accountRepo,
    agents: agentRepo,
    tickets: ticketRepo,
    messages: messageRepo,
    attachments: attachmentRepo,
    orders: orderRepo,
    piiVault: piiRepo,
    ticketEvents: eventRepo,
  },
});

const webhooks = new WebhookIngressService({
  logger,
  clock: clock as any,
  cache,
  queue,
  adapters,
  repos: { webhookEvents: webhookRepo, accounts: accountRepo },
});

/* ------------------------------------------------------------------ */
/* Scenarios                                                          */
/* ------------------------------------------------------------------ */

function inbound(overrides: Record<string, unknown>): any {
  return {
    accountId: 'acc-amazon',
    marketplace: 'AMAZON',
    externalReferenceId: '111-2222222-3333333',
    ticketType: 'POST_SALE_ORDER',
    externalOrderId: '111-2222222-3333333',
    externalMessageId: `msg-${Math.random()}`,
    direction: 'INBOUND_BUYER',
    channelRouteUsed: 'AMAZON_EMAIL_RELAY',
    messageType: 'text',
    bodyCleanText: 'Meu pedido não chegou',
    contentPayload: {},
    marketplaceCreatedAt: FIXED,
    buyer: { externalId: 'buyer-1', displayName: 'Ana', anonymizedEmail: 'abc@marketplace.amazon.com.br', contactHash: 'hash' },
    order: {
      externalOrderId: '111-2222222-3333333',
      orderStatus: 'SHIPPED',
      totalAmount: 199.9,
      currency: 'BRL',
      items: [{ title: 'Produto', quantity: 1, unitPrice: 199.9 }],
      allowedActions: { allowed_spapi_actions: ['confirmDeliveryDetails'] },
      shipping: { carrier: 'Correios' },
    },
    buyerPii: { name: 'Ana Souza', email: 'ana@example.com', document: '123.456.789-00', phone: '+5511999999999', shippingAddress: { city: 'São Paulo' }, sourceEndpoints: ['orders/v0'] },
    attachments: [{ fileName: 'nota.pdf', mimeType: 'application/pdf', sizeBytes: 10, s3Key: 'attachments/2026/02/abcd-nota.pdf', sha256: 'a'.repeat(64) }],
    channelMetadata: { subject: 'Pedido não chegou' },
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log('\n[1] Amazon inbound creates a ticket with SLA, order link, PII and attachment');
  const result1 = await ticketCommands.ingest(inbound({ externalMessageId: 'amz-1' }));
  const ticket1 = tickets.find((t) => t.id === result1.ticketId)!;
  assert(result1.created === true, 'ticket created');
  assert(result1.duplicate === false, 'message not duplicate');
  assert(ticket1.marketplace === 'AMAZON', 'marketplace AMAZON');
  assert(ticket1.priority === 'HIGH', 'priority HIGH for POST_SALE_ORDER');
  assert(ticket1.assignedQueue === 'SAC::Amazon', 'queue SAC::Amazon');
  const slaMinutes = Math.round((ticket1.slaDeadlineAt.getTime() - FIXED.getTime()) / 60_000);
  assert(slaMinutes === 1080, `Amazon SLA deadline is 18h (got ${slaMinutes}m)`);
  assert(ticket1.orderCacheId !== null, 'order cache linked');
  assert(ticket1.status === 'OPEN_WAITING_AGENT', `new unassigned inbound is OPEN_WAITING_AGENT (got ${ticket1.status})`);
  assert(ticket1.unreadCount === 1, 'unread count 1');
  assert(piiRows.length === 1 && piiRows[0]!.buyerDocument === '123.456.789-00', 'PII vault row stored');
  const piiExpiryDays = Math.round((piiRows[0]!.expiresAt.getTime() - FIXED.getTime()) / 86_400_000);
  assert(piiExpiryDays === 30, `PII expires in 30 days (got ${piiExpiryDays})`);
  assert(attachments.length === 1 && attachments[0]!.s3Uri.startsWith('s3://attachments-bucket/attachments/'), 'attachment row stored');
  assert(realtimeEvents.includes('ticketUpdated') && realtimeEvents.includes('messageCreated'), 'realtime emitted');
  assert(events.some((e) => e.eventType === 'TICKET_CREATED'), 'TICKET_CREATED event');
  assert(published.every((p) => !p.queue.includes('enrichment')), 'no enrichment needed when order came inline');

  console.log('\n[2] Replaying the same external message id is idempotent');
  const before = ticketMessages.length;
  const result2 = await ticketCommands.ingest(inbound({ externalMessageId: 'amz-1' }));
  assert(result2.duplicate === true, 'duplicate flagged');
  assert(ticketMessages.length === before, 'no extra message row');

  console.log('\n[3] Buyer reply threads via In-Reply-To and refreshes the SLA leg');
  const reply = await ticketCommands.ingest(inbound({
    externalMessageId: 'amz-2',
    externalReferenceId: 'reply-ref',
    inReplyToId: 'amz-1',
    marketplaceCreatedAt: new Date(FIXED.getTime() + 3_600_000),
    order: null,
    buyerPii: null,
    attachments: [],
    bodyCleanText: 'Alguém vai responder?',
  }));
  assert(reply.ticketId === ticket1.id, 'threaded onto the same ticket');
  assert(ticket1.unreadCount === 2, `unread incremented (got ${ticket1.unreadCount})`);

  console.log('\n[4] Meli claim honours the API due_date and CRITICAL priority');
  const claimDue = new Date(FIXED.getTime() + 5 * 3_600_000);
  const meli = await ticketCommands.ingest(inbound({
    accountId: 'acc-meli',
    marketplace: 'MERCADO_LIVRE',
    externalReferenceId: 'claim-1',
    ticketType: 'CLAIM_DISPUTE',
    externalOrderId: 'ML-ORDER-1',
    claimId: 'claim-1',
    externalMessageId: 'meli-1',
    channelRouteUsed: 'MELI_CLAIMS_API',
    buyer: { externalId: 'b2', displayName: 'João', anonymizedEmail: null },
    order: null,
    buyerPii: null,
    attachments: [],
    hasActiveClaim: true,
    slaDeadlineAt: claimDue,
    channelMetadata: { due_date: claimDue.toISOString(), available_actions: ['allow_return', 'refund'] },
  }));
  const meliTicket = tickets.find((t) => t.id === meli.ticketId)!;
  assert(meliTicket.hasActiveClaim === true, 'hasActiveClaim propagated');
  assert(meliTicket.priority === 'CRITICAL_SLA', 'claim priority CRITICAL_SLA');
  assert(meliTicket.slaDeadlineAt.getTime() === claimDue.getTime(), 'due_date overrides deadline');
  assert(meliTicket.assignedQueue === 'SAC::Meli', 'Meli queue');

  console.log('\n[5] Shopee pre-sale chat uses the 12h CRR cap and commercial queue');
  const shopee = await ticketCommands.ingest(inbound({
    accountId: 'acc-shopee',
    marketplace: 'SHOPEE',
    externalReferenceId: 'conv-1',
    ticketType: 'PRE_SALE',
    externalOrderId: null,
    conversationId: 'conv-1',
    externalMessageId: 'shopee-1',
    channelRouteUsed: 'SHOPEE_CHAT_API',
    buyer: { externalId: 'b3', displayName: 'Maria', anonymizedEmail: null },
    order: null,
    buyerPii: null,
    attachments: [],
    channelMetadata: { crr_safe: false },
  }));
  const shopeeTicket = tickets.find((t) => t.id === shopee.ticketId)!;
  const shopeeSla = Math.round((shopeeTicket.slaDeadlineAt.getTime() - FIXED.getTime()) / 60_000);
  assert(shopeeSla === 720, `Shopee CRR deadline 12h (got ${shopeeSla}m)`);
  assert(shopeeTicket.assignedQueue === 'COMERCIAL::Pre-Venda', `Shopee pre-sale queue (got ${shopeeTicket.assignedQueue})`);

  console.log('\n[6] Outbound send validates policy, sends and records the attempt');
  const sent = await outbound.send({
    ticketId: ticket1.id,
    agent: { id: 'agent-1', name: 'Bia', email: 'bia@sachub.app' },
    bodyText: 'Olá Ana, seu pedido está em trânsito.',
    recipient: 'BUYER',
  });
  assert(sent.deliveryStatus === 'SENT', 'delivery SENT');
  assert(ticket1.firstResponseAt !== null, 'firstResponseAt recorded');
  assert(ticket1.status === 'WAITING_BUYER', `status WAITING_BUYER (got ${ticket1.status})`);
  assert(attempts.length >= 1 && attempts[0]!.status === 'SENT', 'outbound_attempt recorded');
  const outbox = ticketMessages.find((m) => m.id === sent.messageId)!;
  assert(outbox.deliveryStatus === 'SENT', 'outbox row updated to SENT');

  console.log('\n[7] Outbound policy violation is blocked before any send');
  let blocked = false;
  try {
    await outbound.send({
      ticketId: ticket1.id,
      agent: { id: 'agent-1', name: 'Bia', email: 'bia@sachub.app' },
      bodyText: 'Fale comigo no whatsapp',
    });
  } catch (error: any) {
    blocked = error?.code === 'POLICY_VIOLATION' || error?.name === 'PolicyViolationError';
  }
  assert(blocked, 'PolicyViolationError thrown');

  console.log('\n[8] closeWithoutResponse closes without creating a message');
  const beforeMessages = ticketMessages.length;
  const closed = await outbound.send({
    ticketId: ticket1.id,
    agent: { id: 'agent-1', name: 'Bia', email: 'bia@sachub.app' },
    bodyText: '',
    closeWithoutResponse: true,
  });
  assert(closed.ticket.status === 'NO_RESPONSE_NEEDED', 'status NO_RESPONSE_NEEDED');
  assert(ticketMessages.length === beforeMessages, 'no message created');

  console.log('\n[9] Webhook ingress verifies, persists and enqueues; replay is duplicate');
  const request: RawWebhookRequest = {
    method: 'POST',
    url: 'http://localhost:4000/webhooks/amazon/ses',
    headers: {},
    query: {},
    rawBody: Buffer.from('payload'),
    receivedAt: FIXED,
  };
  const ack1 = await webhooks.accept('AMAZON', request);
  assert(ack1.accepted === true && ack1.httpStatus === 200, 'first webhook accepted');
  assert(ack1.body.status === 'OK', 'Amazon ack body OK');
  assert(webhookRepo.rows.length === 1 && webhookRepo.rows[0].signatureValid === true, 'webhook event persisted');
  assert(published.some((p) => p.queue === 'queue.inbound.amazon'), 'inbound job enqueued');
  const ack2 = await webhooks.accept('AMAZON', request);
  assert(ack2.duplicate === true && ack2.status === 'DUPLICATE', 'replay is duplicate');

  console.log('\n[10] Detail projection gates PII, exposes routing/actions/CRR');
  const detail = await queries.getDetail(ticket1.id);
  assert(detail.customer.document === '123.456.789-00', 'customer PII exposed while vault is valid');
  assert(detail.ticket.id === ticket1.id, 'detail ticket id');
  assert(detail.messages.length >= 3, `thread rendered (${detail.messages.length} messages)`);
  assert(detail.events.length > 0, 'events rendered');
  assert(detail.routing.route === 'AMAZON_EMAIL_RELAY', 'routing from adapter');
  assert(detail.allowedActions.some((a) => a.kind === 'AMAZON_NO_RESPONSE_NEEDED'), 'Amazon silent close action');
  assert(detail.crr === null, 'no CRR for Amazon');
  const shopeeDetail = await queries.getDetail(shopeeTicket.id);
  assert(shopeeDetail.crr !== null && shopeeDetail.crr.targetHours === 12, 'CRR for Shopee');
  assert(shopeeDetail.allowedActions.some((a) => a.kind === 'SHOPEE_MARK_READ'), 'Shopee mark-read action');

  console.log('\n[11] SLA sweep flags breaches and emits realtime');
  ticket1.slaBreached = false;
  ticket1.slaDeadlineAt = new Date(FIXED.getTime() - 60_000);
  ticket1.status = 'OPEN_WAITING_AGENT';
  const beforeBreach = realtimeEvents.filter((e) => e === 'ticketUpdated').length;
  const sweep = await slaEngine.sweep({ limit: 10 });
  assert(sweep.breached >= 1, `sweep flagged ${sweep.breached} breach(es)`);
  assert(ticket1.slaBreached === true, 'ticket marked breached');
  assert(ticket1.slaState === 'BREACHED', 'slaState BREACHED');
  assert(realtimeEvents.filter((e) => e === 'ticketUpdated').length > beforeBreach, 'realtime breach emitted');

  console.log('\n[12] Queue list/stats projections');
  const list = await queries.listQueue({ queueKey: 'ALL' }, { page: 1, pageSize: 10 });
  assert(list.items.length === tickets.length, `list returns all tickets (${list.items.length})`);
  const stats = await queries.getStats();
  assert(stats.total === tickets.length, 'stats total');

  console.log(failures === 0 ? '\nSMOKE OK — all assertions passed.' : `\nSMOKE FAILED — ${failures} assertion(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
