import {
  AMAZON_PROACTIVE_ACTIONS,
  CACHE_KEYS,
  MARKETPLACES,
  OPEN_TICKET_STATUSES,
} from '@sac/shared';
import type {
  AgentLoad,
  IAccountRepository,
  IAdapterRegistry,
  IAgentRepository,
  IAttachmentRepository,
  ICache,
  IClock,
  ILogger,
  IMessageRepository,
  IOrderRepository,
  IPiiVaultRepository,
  ITicketEventRepository,
  ITicketQueryService,
  ITicketRepository,
  AvailableActionView,
  BuyerPiiRecord,
  ChannelHealthView,
  ChannelRoute,
  CrrStatusView,
  CustomerView,
  IAgentSummary,
  Marketplace,
  MarketplaceAccountRecord,
  MessageAttachmentRecord,
  MessageView,
  OrderCacheRecord,
  OrderView,
  PageRequest,
  Paginated,
  QueueSnapshot,
  RoutePreview,
  SupportTicketRecord,
  TicketDetail,
  TicketEventRecord,
  TicketListItem,
  TicketListFilter,
  TicketMessageRecord,
  TicketStats,
  TicketStatus,
  TicketType,
  OutboundValidationInput,
} from '@sac/shared';
import { NotFoundError } from '@sac/shared';

import {
  asRecord,
  asStringArray,
  iso,
  toAgentLoad,
  toAgentSummary,
  toCustomerView,
  toMessageView,
  toOrderView,
  toTicketEventView,
  toTicketListItem,
} from './mappers';

/**
 * ============================================================================
 * TicketQueryService
 * ============================================================================
 *
 * Read-side service for the single pane of glass.
 *
 * Highlights:
 *  - queue filters (`ALL`, `SLA_CRITICAL`, `CLAIMS`, `PRE_SALE`, `WAITING_ME`,
 *    `UNASSIGNED`) are translated into repository filters, so the heavy lifting
 *    (index-friendly SQL, SLA ordering, pagination) stays in the repository;
 *  - PII is gated: the vault row is only projected while `expiresAt > now` and
 *    the row has not been purged. Amazon additionally reports `RDT_30D_PURGE`;
 *  - the thread is ordered by `marketplace_created_at` (marketplace clock), never
 *    by local ingestion time;
 *  - routing/allowed actions are produced by the channel adapter so the cockpit
 *    can never offer an action the API would reject.
 */

const CRR_TARGET_HOURS = 12;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 40;

export interface TicketQueryServiceDependencies {
  logger: ILogger;
  clock: IClock;
  cache: ICache;
  adapters: IAdapterRegistry;
  repos: {
    accounts: IAccountRepository;
    agents: IAgentRepository;
    tickets: ITicketRepository;
    messages: IMessageRepository;
    attachments: IAttachmentRepository;
    orders: IOrderRepository;
    piiVault: IPiiVaultRepository;
    ticketEvents: ITicketEventRepository;
  };
}

export class TicketQueryService implements ITicketQueryService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly cache: ICache;
  private readonly adapters: IAdapterRegistry;
  private readonly repos: TicketQueryServiceDependencies['repos'];

  constructor(deps: TicketQueryServiceDependencies) {
    this.logger = deps.logger.child({ component: 'TicketQueryService' });
    this.clock = deps.clock;
    this.cache = deps.cache;
    this.adapters = deps.adapters;
    this.repos = deps.repos;
  }

  /* ==================================================================== */
  /* Queue                                                                */
  /* ==================================================================== */

  async listQueue(filter: TicketListFilter, page: PageRequest): Promise<Paginated<TicketListItem>> {
    const safePage = normalizePage(page);
    if (filter.tenantId === null) {
      return { items: [], total: 0, page: safePage.page, pageSize: safePage.pageSize, totalPages: 0 };
    }
    const repoFilter = { ...this.mapQueueFilter(filter), tenantId: filter.tenantId };
    const result = await this.repos.tickets.list(repoFilter, safePage);

    const [accounts, agents] = await Promise.all([this.loadAccountMap(), this.loadAgentMap()]);

    const items = result.items.map((ticket) =>
      toTicketListItem(ticket, {
        accountDisplayName: accounts.get(ticket.accountId) ?? null,
        assignedAgentName: ticket.assignedAgentId ? agents.get(ticket.assignedAgentId) ?? null : null,
      }),
    );

    return {
      items,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    };
  }

  private mapQueueFilter(filter: TicketListFilter): TicketListFilter {
    const normalized: TicketListFilter = { ...filter };
    switch (filter.queueKey) {
      case 'SLA_CRITICAL':
        normalized.onlySlaCritical = true;
        if (!normalized.status?.length) normalized.status = [...OPEN_TICKET_STATUSES];
        break;
      case 'CLAIMS':
        normalized.hasActiveClaim = true;
        break;
      case 'PRE_SALE':
        normalized.ticketType = ['PRE_SALE'];
        break;
      case 'WAITING_ME':
        normalized.status = ['UNREAD', 'OPEN_WAITING_AGENT'];
        break;
      case 'UNASSIGNED':
        normalized.onlyUnassigned = true;
        break;
      case 'ALL':
      case undefined:
      default:
        break;
    }

    if (normalized.search) {
      normalized.search = normalized.search.trim().slice(0, 200);
      if (normalized.search === '') delete normalized.search;
    }
    return normalized;
  }

  /* ==================================================================== */
  /* Detail                                                               */
  /* ==================================================================== */

  async getDetail(ticketId: string, tenantId?: string | null): Promise<TicketDetail> {
    const ticket = await this.repos.tickets.findById(ticketId);
    if (!ticket) throw new NotFoundError('SupportTicket', ticketId);
    if (tenantId !== undefined && (tenantId === null || ticket.tenantId !== tenantId)) {
      throw new NotFoundError('SupportTicket', ticketId);
    }

    const [account, agent, order, messages, events, pii] = await Promise.all([
      this.repos.accounts.findById(ticket.accountId),
      ticket.assignedAgentId ? this.repos.agents.findById(ticket.assignedAgentId) : Promise.resolve(null),
      this.resolveOrder(ticket),
      this.repos.messages.listByTicket(ticketId, { includeInternal: true, limit: 500 }),
      this.repos.ticketEvents.listByTicket(ticketId),
      this.repos.piiVault.findByTicketId(ticketId),
    ]);

    const orderedMessages = [...messages].sort(compareMessages);
    const attachmentRows = await this.safeAttachments(orderedMessages.map((message) => message.id));
    const attachmentsByMessage = groupAttachments(attachmentRows);

    const views: MessageView[] = orderedMessages.map((message) =>
      toMessageView(message, attachmentsByMessage.get(message.id) ?? []),
    );

    const validPii = this.isPiiUsable(pii);
    const customer = toCustomerView({ ticket, pii: validPii ? pii : null });
    const hasPriorBuyerInbound =
      (await this.repos.messages.lastByDirection(ticket.id, 'INBOUND_BUYER')) !== null;
    const routing = this.buildRoutePreview(ticket, account, order, hasPriorBuyerInbound);
    const allowedActions = this.buildAvailableActions(ticket, order);
    const crr = this.buildCrr(ticket, orderedMessages);

    return {
      ticket: toTicketListItem(ticket, {
        accountDisplayName: account?.displayName ?? null,
        assignedAgentName: agent?.name ?? null,
      }),
      order: order ? toOrderView(order) : null,
      customer,
      messages: views,
      events: events.map(toTicketEventView),
      routing,
      allowedActions,
      crr,
    };
  }

  private async resolveOrder(ticket: SupportTicketRecord): Promise<OrderCacheRecord | null> {
    if (ticket.orderCacheId) {
      const byId = await this.repos.orders.findById(ticket.orderCacheId);
      if (byId) return byId;
    }
    const linked = await this.repos.orders.listByTicket(ticket.id);
    if (linked.length > 0) return linked[0] ?? null;
    if (ticket.externalOrderId) {
      return this.repos.orders.findByExternalOrderId(ticket.marketplace, ticket.externalOrderId);
    }
    return null;
  }

  private async safeAttachments(messageIds: string[]): Promise<MessageAttachmentRecord[]> {
    if (messageIds.length === 0) return [];
    try {
      return await this.repos.attachments.listByMessageIds(messageIds);
    } catch (error) {
      this.logger.warn('ticket.detail.attachments_failed', {
        messageCount: messageIds.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private isPiiUsable(pii: BuyerPiiRecord | null): pii is BuyerPiiRecord {
    if (!pii) return false;
    if (pii.purgedAt) return false;
    const now = this.clock.now();
    return pii.expiresAt.getTime() > now.getTime();
  }

  private buildRoutePreview(
    ticket: SupportTicketRecord,
    account: MarketplaceAccountRecord | null,
    order: OrderCacheRecord | null,
    hasPriorBuyerInbound: boolean,
  ): RoutePreview {
    const adapter = this.adapters.get(ticket.marketplace);
    const channelMetadata = asRecord(ticket.channelMetadata);
    const input: OutboundValidationInput = {
      marketplace: ticket.marketplace,
      ticketType: ticket.ticketType,
      hasActiveClaim: ticket.hasActiveClaim,
      bodyText: '',
      bodyHtml: null,
      subject: null,
      recipient: 'BUYER',
      attachments: [],
      forceImportant: channelMetadata.buyer_opt_out === true,
      hasPriorInbound: hasPriorBuyerInbound,
      allowedActions: order?.allowedActionsCache ?? {},
      closeWithoutResponse: false,
      accountId: ticket.accountId,
      allowedLinkDomains: readStringArray(account?.channelConfig?.approved_sender_domains),
      smtpSenderEmail: readString(account?.channelConfig?.smtp_sender_email),
      buyerOptOut: channelMetadata.buyer_opt_out === true,
      channelMetadata,
    };

    try {
      const decision = adapter.resolveRoute(input);
      const warnings: string[] = [];
      if (decision.blocked && decision.blockedReason) warnings.push(decision.blockedReason);
      if (channelMetadata.buyer_opt_out === true) {
        warnings.push('Opt-out do comprador: use a tag [Important] em mensagens críticas.');
      }
      return {
        route: decision.route,
        label: decision.label,
        reason: decision.reason,
        blocked: decision.blocked,
        warnings,
        recipient: decision.recipient,
        requiresAttachmentUpload: decision.requiresAttachmentUpload,
        forcedImportant: channelMetadata.buyer_opt_out === true,
      };
    } catch (error) {
      this.logger.warn('ticket.detail.route_failed', {
        ticketId: ticket.id,
        marketplace: ticket.marketplace,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        route: fallbackRoute(ticket.marketplace),
        label: 'Rota indisponível',
        reason: 'Não foi possível resolver a rota para este ticket.',
        blocked: true,
        warnings: ['ROUTE_RESOLUTION_FAILED'],
        recipient: 'BUYER',
        requiresAttachmentUpload: false,
        forcedImportant: channelMetadata.buyer_opt_out === true,
      };
    }
  }

  /* ==================================================================== */
  /* Stats                                                                */
  /* ==================================================================== */

  async getStats(filter?: TicketListFilter): Promise<TicketStats> {
    const stats = await this.repos.tickets.stats(filter);
    const byMarketplace = { ...stats.byMarketplace } as Record<Marketplace, number>;
    for (const marketplace of MARKETPLACES) {
      if (typeof byMarketplace[marketplace] !== 'number') byMarketplace[marketplace] = 0;
    }
    return {
      total: stats.total ?? 0,
      unread: stats.unread ?? 0,
      openWaitingAgent: stats.openWaitingAgent ?? 0,
      atRisk: stats.atRisk ?? 0,
      breached: stats.breached ?? 0,
      avgFirstResponseMinutes: stats.avgFirstResponseMinutes ?? null,
      avgResolutionMinutes: stats.avgResolutionMinutes ?? null,
      byMarketplace,
    };
  }

  async getQueueSnapshot(filter?: TicketListFilter): Promise<QueueSnapshot> {
    return {
      stats: await this.getStats(filter),
      generatedAt: this.clock.now().toISOString(),
    };
  }

  /* ==================================================================== */
  /* Allowed actions                                                      */
  /* ==================================================================== */

  async getAvailableActions(ticketId: string): Promise<AvailableActionView[]> {
    const ticket = await this.repos.tickets.findById(ticketId);
    if (!ticket) throw new NotFoundError('SupportTicket', ticketId);
    const order = await this.resolveOrder(ticket);
    return this.buildAvailableActions(ticket, order);
  }

  private buildAvailableActions(
    ticket: SupportTicketRecord,
    order: OrderCacheRecord | null,
  ): AvailableActionView[] {
    switch (ticket.marketplace) {
      case 'AMAZON':
        return this.buildAmazonActions(ticket, order);
      case 'MERCADO_LIVRE':
        return this.buildMeliActions(ticket);
      case 'SHOPEE':
        return this.buildShopeeActions(ticket);
      default:
        return [];
    }
  }

  private buildAmazonActions(
    ticket: SupportTicketRecord,
    order: OrderCacheRecord | null,
  ): AvailableActionView[] {
    const metadata = asRecord(ticket.channelMetadata);
    const orderActions = asRecord(order?.allowedActionsCache ?? {});
    const allowed = new Set<string>([
      ...asStringArray(orderActions.allowed_spapi_actions),
      ...asStringArray(orderActions.allowedActions),
      ...asStringArray(orderActions.messagingActions),
      ...extractActionKeys(metadata.available_actions),
    ]);

    const actions: AvailableActionView[] = [];
    const catalog: Array<{ action: string; kind: string; label: string; description: string }> = [
      {
        action: 'confirmDeliveryDetails',
        kind: 'AMAZON_CONFIRM_DELIVERY_DETAILS',
        label: 'Confirmar detalhes da entrega',
        description: 'Mensagem proativa da Buyer-Seller Messaging sobre a entrega.',
      },
      {
        action: 'unexpectedProblem',
        kind: 'AMAZON_UNEXPECTED_PROBLEM',
        label: 'Problema inesperado',
        description: 'Informa o comprador sobre um problema inesperado no pedido.',
      },
      {
        action: 'warranty',
        kind: 'AMAZON_WARRANTY',
        label: 'Garantia',
        description: 'Envia informações de garantia do produto.',
      },
      {
        action: 'confirmCustomizationDetails',
        kind: 'AMAZON_CONFIRM_CUSTOMIZATION',
        label: 'Confirmar personalização',
        description: 'Confirma detalhes de personalização do item.',
      },
    ];

    for (const entry of catalog) {
      const isAllowed =
        allowed.size === 0
          ? (AMAZON_PROACTIVE_ACTIONS as readonly string[]).includes(entry.action) && ticket.lastInboundAt === null
          : allowed.has(entry.action);
      actions.push({
        kind: entry.kind,
        label: entry.label,
        description: entry.description,
        route: 'AMAZON_SP_API_MESSAGING',
        enabled: isAllowed,
        destructive: entry.action === 'unexpectedProblem',
        requiresConfirmation: true,
        source: allowed.size > 0 ? 'ORDER_ALLOWED_ACTIONS' : 'SP_API_MESSAGING_ACTIONS',
      });
    }

    actions.push({
      kind: 'AMAZON_NO_RESPONSE_NEEDED',
      label: 'Encerrar sem resposta',
      description:
        'Fecha o ticket sem enviar nada (Route 3). Use quando o e-mail não exige resposta do vendedor.',
      route: 'AMAZON_EMAIL_RELAY',
      enabled: true,
      destructive: false,
      requiresConfirmation: true,
      source: 'AMAZON_ROUTE_3',
    });

    return actions;
  }

  private buildMeliActions(ticket: SupportTicketRecord): AvailableActionView[] {
    const metadata = asRecord(ticket.channelMetadata);
    const available = new Set<string>(
      extractActionKeys(metadata.available_actions).map((value) => value.toLowerCase()),
    );
    const actions: AvailableActionView[] = [];

    const claimCatalog: Array<{
      keys: string[];
      kind: string;
      label: string;
      description: string;
      destructive: boolean;
    }> = [
      {
        keys: ['allow_return', 'allow-return', 'return'],
        kind: 'MELI_ALLOW_RETURN',
        label: 'Permitir devolução',
        description: 'Aceita a devolução do pedido no fluxo de pós-venda do Mercado Livre.',
        destructive: false,
      },
      {
        keys: ['refund', 'refund_buyer'],
        kind: 'MELI_REFUND',
        label: 'Reembolsar comprador',
        description: 'Executa o reembolso total no Mercado Pago.',
        destructive: true,
      },
      {
        keys: ['open_dispute', 'open-dispute', 'dispute'],
        kind: 'MELI_OPEN_DISPUTE',
        label: 'Abrir disputa',
        description: 'Abre uma disputa formal na reclamação.',
        destructive: true,
      },
    ];

    if (ticket.hasActiveClaim || ticket.ticketType === 'CLAIM_DISPUTE') {
      for (const entry of claimCatalog) {
        const allowedByApi = entry.keys.some((key) => available.has(key));
        if (!allowedByApi && available.size > 0) continue;
        actions.push({
          kind: entry.kind,
          label: entry.label,
          description: entry.description,
          route: 'MELI_CLAIMS_API',
          enabled: Boolean(ticket.claimId) && (allowedByApi || available.size === 0),
          destructive: entry.destructive,
          requiresConfirmation: true,
          source: 'CLAIM_AVAILABLE_ACTIONS',
        });
      }

      actions.push({
        kind: 'MELI_SEND_CLAIM_MESSAGE',
        label: 'Responder na reclamação',
        description: 'Envia mensagem no chat da reclamação (para o comprador ou mediador).',
        route: 'MELI_CLAIMS_API',
        enabled: Boolean(ticket.claimId),
        destructive: false,
        requiresConfirmation: false,
        source: 'CLAIM_CHAT',
      });
    }

    if (ticket.ticketType === 'PRE_SALE') {
      actions.push({
        kind: 'MELI_ANSWER_QUESTION',
        label: 'Responder pergunta',
        description: 'Responde a pergunta pré-venda pela Questions API.',
        route: 'MELI_QUESTIONS_API',
        enabled: true,
        destructive: false,
        requiresConfirmation: false,
        source: 'PRE_SALE_QUESTION',
      });
    } else if (!ticket.hasActiveClaim) {
      actions.push({
        kind: 'MELI_SEND_POST_SALE_MESSAGE',
        label: 'Mensagem pós-venda',
        description: 'Envia mensagem no chat pós-venda do pack.',
        route: 'MELI_MESSAGES_API',
        enabled: Boolean(ticket.packId || ticket.externalOrderId),
        destructive: false,
        requiresConfirmation: false,
        source: 'POST_SALE_CHAT',
      });
    }

    return actions;
  }

  private buildShopeeActions(ticket: SupportTicketRecord): AvailableActionView[] {
    const metadata = asRecord(ticket.channelMetadata);
    const actions: AvailableActionView[] = [];
    const hasReturn = Boolean(ticket.returnSn);

    if (ticket.ticketType === 'RETURN_REFUND') {
      actions.push({
        kind: 'SHOPEE_CONFIRM_RETURN',
        label: 'Confirmar devolução',
        description: 'Confirma o recebimento da devolução (v2.returns.confirm).',
        route: 'SHOPEE_RETURNS_API',
        enabled: hasReturn,
        destructive: false,
        requiresConfirmation: true,
        source: 'CHANNEL_RULES',
      });
      actions.push({
        kind: 'SHOPEE_DISPUTE_RETURN',
        label: 'Disputar devolução',
        description: 'Abre disputa sobre a devolução recebida.',
        route: 'SHOPEE_RETURNS_API',
        enabled: hasReturn,
        destructive: true,
        requiresConfirmation: true,
        source: 'CHANNEL_RULES',
      });
    }

    if (ticket.ticketType === 'CANCELLATION') {
      actions.push({
        kind: 'SHOPEE_ACCEPT_CANCELLATION',
        label: 'Aceitar cancelamento',
        description: 'Aceita o cancelamento solicitado pelo comprador.',
        route: 'SHOPEE_RETURNS_API',
        enabled: Boolean(ticket.externalOrderId),
        destructive: true,
        requiresConfirmation: true,
        source: 'CHANNEL_RULES',
      });
    }

    actions.push({
      kind: 'SHOPEE_MARK_READ',
      label: 'Marcar como lida',
      description:
        'Sincroniza a leitura da conversa na Shopee e protege o índice CRR de 12h.',
      route: 'SHOPEE_CHAT_API',
      enabled: Boolean(ticket.conversationId) || metadata.crr_safe === false,
      destructive: false,
      requiresConfirmation: false,
      source: 'CRR_PROTECTION',
    });

    return actions;
  }

  /* ==================================================================== */
  /* CRR                                                                  */
  /* ==================================================================== */

  private buildCrr(
    ticket: SupportTicketRecord,
    messages: TicketMessageRecord[],
  ): CrrStatusView | null {
    if (ticket.marketplace !== 'SHOPEE') return null;

    const lastInbound = [...messages]
      .reverse()
      .find((message) => message.direction === 'INBOUND_BUYER' || message.direction === 'MEDIATOR');
    const lastMessage = messages[messages.length - 1] ?? null;
    const now = this.clock.now();

    const hoursSinceLastInbound = lastInbound
      ? Math.max(
          0,
          Math.round(
            ((now.getTime() - lastInbound.marketplaceCreatedAt.getTime()) / 3_600_000) * 10,
          ) / 10,
        )
      : null;

    const safe =
      !lastInbound ||
      lastMessage?.direction === 'OUTBOUND_AGENT' ||
      lastMessage?.direction === 'OUTBOUND_SYSTEM';

    const remaining =
      hoursSinceLastInbound === null ? CRR_TARGET_HOURS : Math.max(0, CRR_TARGET_HOURS - hoursSinceLastInbound);

    return {
      safe,
      targetHours: CRR_TARGET_HOURS,
      hoursSinceLastInbound,
      lastMessageDirection: lastMessage?.direction ?? null,
      label: safe
        ? 'CRR protegido — última mensagem é do vendedor.'
        : `Responder em até ${remaining.toFixed(1)}h para manter o CRR.`,
    };
  }

  /* ==================================================================== */
  /* Agents                                                               */
  /* ==================================================================== */

  async listAgents(): Promise<IAgentSummary[]> {
    const agents = await this.repos.agents.list({ activeOnly: true });
    const summaries = await Promise.all(
      agents.map(async (agent) => {
        const activeTickets = await this.safeActiveTickets(agent.id);
        return toAgentSummary(agent, activeTickets);
      }),
    );
    return summaries.sort((a, b) => {
      const presenceRank: Record<string, number> = { ONLINE: 0, PAUSED: 1, OFFLINE: 2 };
      const rank = (presenceRank[a.presence] ?? 3) - (presenceRank[b.presence] ?? 3);
      if (rank !== 0) return rank;
      return b.activeTickets - a.activeTickets || a.name.localeCompare(b.name, 'pt-BR');
    });
  }

  async agentLoads(): Promise<AgentLoad[]> {
    const agents = await this.repos.agents.list({ activeOnly: true });
    const loads = await Promise.all(
      agents.map(async (agent) => toAgentLoad(agent, await this.safeActiveTickets(agent.id))),
    );
    return loads.sort((a, b) => b.activeTickets - a.activeTickets);
  }

  private async safeActiveTickets(agentId: string): Promise<number> {
    try {
      return await this.repos.tickets.countActiveByAgent(agentId);
    } catch (error) {
      this.logger.warn('ticket.agent_load_failed', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /* ==================================================================== */
  /* Lookups + cache                                                      */
  /* ==================================================================== */

  private async loadAccountMap(): Promise<Map<string, string>> {
    try {
      const accounts = await this.repos.accounts.list();
      return new Map(accounts.map((account) => [account.id, account.displayName]));
    } catch (error) {
      this.logger.warn('ticket.account_map_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Map();
    }
  }

  private async loadAgentMap(): Promise<Map<string, string>> {
    try {
      const agents = await this.repos.agents.list({ activeOnly: false });
      return new Map(agents.map((agent) => [agent.id, agent.name]));
    } catch (error) {
      this.logger.warn('ticket.agent_map_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Map();
    }
  }


  /** Exposed for potential callers that only need the queue counts. */
  async openCountByMarketplace(): Promise<Record<Marketplace, number>> {
    const stats = await this.getStats({ status: [...OPEN_TICKET_STATUSES] });
    return stats.byMarketplace;
  }
}

/* ---------------------------------------------------------------------- */
/* Helpers                                                                */
/* ---------------------------------------------------------------------- */

function normalizePage(page: PageRequest | undefined): PageRequest {
  const rawPage = Number(page?.page);
  const rawSize = Number(page?.pageSize);
  const safePage = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const safeSize = Number.isFinite(rawSize)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(rawSize)))
    : DEFAULT_PAGE_SIZE;
  return { page: safePage, pageSize: safeSize };
}

function compareMessages(a: TicketMessageRecord, b: TicketMessageRecord): number {
  const byMarketplace =
    a.marketplaceCreatedAt.getTime() - b.marketplaceCreatedAt.getTime();
  if (byMarketplace !== 0) return byMarketplace;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

function groupAttachments(
  attachments: MessageAttachmentRecord[],
): Map<string, MessageAttachmentRecord[]> {
  const grouped = new Map<string, MessageAttachmentRecord[]>();
  for (const attachment of attachments) {
    const bucket = grouped.get(attachment.messageId);
    if (bucket) bucket.push(attachment);
    else grouped.set(attachment.messageId, [attachment]);
  }
  return grouped;
}

function extractActionKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim() !== '') {
      keys.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      for (const candidate of [record.action, record.id, record.name, record.type, record.code]) {
        if (typeof candidate === 'string' && candidate.trim() !== '') {
          keys.push(candidate);
          break;
        }
      }
    }
  }
  return keys;
}

function readString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  return null;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
  );
  return strings.length > 0 ? strings : undefined;
}

function fallbackRoute(marketplace: Marketplace): ChannelRoute {
  switch (marketplace) {
    case 'AMAZON':
      return 'AMAZON_EMAIL_RELAY';
    case 'MERCADO_LIVRE':
      return 'MELI_MESSAGES_API';
    case 'SHOPEE':
      return 'SHOPEE_CHAT_API';
    default:
      return 'AMAZON_EMAIL_RELAY';
  }
}
