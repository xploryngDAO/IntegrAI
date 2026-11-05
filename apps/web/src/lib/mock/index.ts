/**
 * In-memory mock implementation of the API client.
 *
 * Mutations act on a module-level copy of the fixtures so replies, closes and
 * status changes persist for the whole browser session (docs/UI_SPEC.md §7).
 * No React / store imports here — this module is pure data.
 */
import type {
  AgentPresenceStatus,
  AttachmentView,
  AuthResponse,
  ChannelActionResult,
  ChannelActionKind,
  ChannelHealthView,
  ChannelRoute,
  ConnectorDescriptor,
  CrrStatusView,
  IAgentSummary,
  Marketplace,
  MessageView,
  PolicyEvaluation,
  PolicyViolation,
  QueueSnapshot,
  RouteDecision,
  TicketDetail,
  TicketListItem,
  TicketStats,
} from '@sac/shared';

import type {
  AccountRow,
  ActionBody,
  ConnectAccountPayload,
  PolicyCheckBody,
  SendMessageBody,
  UploadedFile,
  WorkspaceFilters,
} from '../types';
import {
  buildTicketStats,
  mockAccounts,
  mockAgents,
  mockChannelHealth,
  mockConnectors,
  mockCurrentAgent,
  mockDetails,
  mockTickets,
} from './fixtures';

/* ==========================================================================
 * Helpers
 * ========================================================================== */

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sleep(minMs: number, maxMs: number): Promise<void> {
  const duration = minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs));
  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
}

function latency(): Promise<void> {
  return sleep(150, 400);
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/* ==========================================================================
 * Mutable state
 * ========================================================================== */

interface MockState {
  tickets: TicketListItem[];
  details: Record<string, TicketDetail>;
  agents: IAgentSummary[];
  accounts: AccountRow[];
  connectors: ConnectorDescriptor[];
  health: ChannelHealthView[];
  currentAgent: IAgentSummary;
}

const state: MockState = {
  tickets: clone(mockTickets),
  details: clone(mockDetails),
  agents: clone(mockAgents),
  accounts: clone(mockAccounts),
  connectors: clone(mockConnectors),
  health: clone(mockChannelHealth),
  currentAgent: clone(mockCurrentAgent),
};

/* ==========================================================================
 * Internal mutations
 * ========================================================================== */

function requireDetail(ticketId: string): TicketDetail {
  const detail = state.details[ticketId];
  if (!detail) throw new Error(`NOT_FOUND: ticket ${ticketId}`);
  return detail;
}

function syncTicket(ticket: TicketListItem): void {
  state.tickets = state.tickets.map((entry) => (entry.id === ticket.id ? ticket : entry));
  const detail = state.details[ticket.id];
  if (detail) {
    detail.ticket = ticket;
    state.details[ticket.id] = detail;
  }
}

function patchTicket(ticket: TicketListItem, patch: Partial<TicketListItem>): TicketListItem {
  const next: TicketListItem = { ...ticket, ...patch };
  syncTicket(next);
  return next;
}

function addEvent(ticketId: string, eventType: string, actorLabel: string, payload: Record<string, unknown> = {}): void {
  const detail = state.details[ticketId];
  if (!detail) return;
  detail.events = [
    ...detail.events,
    {
      id: uid('ev'),
      eventType,
      actorLabel,
      payload,
      createdAt: nowIso(),
    },
  ];
}

function sortedTickets(items: TicketListItem[]): TicketListItem[] {
  return [...items].sort(
    (left, right) =>
      new Date(left.slaDeadlineAt).getTime() - new Date(right.slaDeadlineAt).getTime(),
  );
}

function matchesFilters(ticket: TicketListItem, filters: WorkspaceFilters | undefined): boolean {
  if (!filters) return true;

  if (filters.marketplaces.length > 0 && !filters.marketplaces.includes(ticket.marketplace)) {
    return false;
  }
  if (filters.accountId && ticket.accountId !== filters.accountId) return false;

  switch (filters.queueKey) {
    case 'SLA_CRITICAL':
      if (ticket.slaState !== 'AT_RISK' && ticket.slaState !== 'BREACHED') return false;
      break;
    case 'CLAIMS':
      if (!ticket.hasActiveClaim && ticket.ticketType !== 'CLAIM_DISPUTE' && ticket.ticketType !== 'RETURN_REFUND') {
        return false;
      }
      break;
    case 'PRE_SALE':
      if (ticket.ticketType !== 'PRE_SALE') return false;
      break;
    case 'WAITING_ME':
      if (ticket.assignedAgentId !== state.currentAgent.id) return false;
      if (ticket.status !== 'OPEN_WAITING_AGENT' && ticket.status !== 'UNREAD' && ticket.status !== 'MEDIATION') {
        return false;
      }
      break;
    case 'UNASSIGNED':
      if (ticket.assignedAgentId !== null) return false;
      break;
    case 'ALL':
    default:
      break;
  }

  const search = filters.search.trim().toLowerCase();
  if (search.length > 0) {
    const haystack = [
      ticket.buyerDisplayName ?? '',
      ticket.externalOrderId ?? '',
      ticket.externalReferenceId,
      ticket.subject ?? '',
      ticket.assignedQueue ?? '',
      ticket.tags.join(' '),
      ticket.buyerAnonymizedEmail ?? '',
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(search)) return false;
  }

  return true;
}

function routeForTicket(ticket: TicketListItem): ChannelRoute {
  switch (ticket.marketplace) {
    case 'AMAZON':
      return 'AMAZON_EMAIL_RELAY';
    case 'MERCADO_LIVRE':
      if (ticket.ticketType === 'PRE_SALE') return 'MELI_QUESTIONS_API';
      if (ticket.hasActiveClaim || ticket.ticketType === 'CLAIM_DISPUTE') return 'MELI_CLAIMS_API';
      return 'MELI_MESSAGES_API';
    case 'SHOPEE':
      return ticket.ticketType === 'RETURN_REFUND' ? 'SHOPEE_RETURNS_API' : 'SHOPEE_CHAT_API';
    default:
      return 'AMAZON_EMAIL_RELAY';
  }
}

function toRouteDecision(routing: TicketDetail['routing'], recipient?: 'BUYER' | 'MEDIATOR'): RouteDecision {
  return {
    route: routing.route,
    label: routing.label,
    reason: routing.reason,
    recipient: recipient ?? routing.recipient,
    requiresAttachmentUpload: routing.requiresAttachmentUpload,
    blocked: routing.blocked,
    actionName: null,
  };
}

function statsFrom(items: TicketListItem[]): TicketStats {
  return buildTicketStats(items);
}

function emptyPolicy(detail: TicketDetail, text: string, recipient?: 'BUYER' | 'MEDIATOR'): PolicyEvaluation {
  return {
    violations: [],
    blocked: false,
    sanitizedText: text,
    sanitizedHtml: null,
    notes: [],
    routePreview: toRouteDecision(detail.routing, recipient),
  };
}

/* ==========================================================================
 * Policy guardrail (mirrors @sac/shared/compliance behaviour closely enough
 * for the demo: e-mail, phone, private contact channels and external links)
 * ========================================================================== */

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/gi;
const PHONE_RE = /(?:\+?55[\s-]*)?(?:\(?\d{2}\)?[\s-]*)?(?:9[\s-]*)?\d{4}[-\s]?\d{4}/g;
const PRIVATE_CONTACT_RE = /\b(?:whats\s*app|whatsapp|telegram|instagram|signal|wa\.me|t\.me)\b/gi;
const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>"')]+/gi;

const ALLOWED_LINK_DOMAINS = [
  'amazon.com',
  'amazon.com.br',
  'mercadolivre.com.br',
  'mercadolibre.com',
  'shopee.com.br',
  'shopee.com',
];

function isAllowedLink(raw: string): boolean {
  const withoutScheme = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const host = withoutScheme.split('/')[0].toLowerCase();
  return ALLOWED_LINK_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function buildPolicy(detail: TicketDetail, body: PolicyCheckBody): PolicyEvaluation {
  const marketplace = detail.ticket.marketplace;
  const text = body.bodyText;
  const violations: PolicyViolation[] = [];

  const emails = text.match(EMAIL_RE) ?? [];
  for (const match of emails) {
    violations.push({
      code: 'EMAIL_NOT_ALLOWED',
      severity: 'BLOCK',
      message: 'Não inclua e-mails na mensagem. A comunicação deve ocorrer dentro do canal do marketplace.',
      field: 'body',
      match,
    });
  }

  const phones = text.match(PHONE_RE) ?? [];
  for (const match of phones) {
    violations.push({
      code: 'PHONE_NOT_ALLOWED',
      severity: 'WARN',
      message: 'Evite telefone/WhatsApp: o marketplace restringe contato fora da plataforma.',
      field: 'body',
      match,
    });
  }

  const privateContacts = text.match(PRIVATE_CONTACT_RE) ?? [];
  for (const match of privateContacts) {
    violations.push({
      code: 'PRIVATE_CONTACT_BLOCKED',
      severity: 'BLOCK',
      message: 'Mencionar WhatsApp/Telegram/Instagram viola a política do canal.',
      field: 'body',
      match,
    });
  }

  const links = text.match(LINK_RE) ?? [];
  for (const match of links) {
    if (isAllowedLink(match)) continue;
    violations.push({
      code: 'EXTERNAL_LINK_BLOCKED',
      severity: 'BLOCK',
      message: `Links externos não são permitidos em mensagens da ${marketplace === 'AMAZON' ? 'Amazon' : marketplace === 'MERCADO_LIVRE' ? 'Mercado Livre' : 'Shopee'}.`,
      field: 'body',
      match,
    });
  }

  const blocked = violations.some((violation) => violation.severity === 'BLOCK');
  let sanitizedText = text;
  for (const violation of violations) {
    if (violation.match) sanitizedText = sanitizedText.split(violation.match).join('[removido]');
  }

  const notes: string[] = [];
  if (violations.length === 0) {
    notes.push('Mensagem dentro das políticas do canal. Pronta para envio.');
  } else {
    notes.push('A política do canal foi aplicada — revise os trechos destacados.');
  }
  if (detail.ticket.marketplace === 'MERCADO_LIVRE' && detail.ticket.hasActiveClaim) {
    notes.push('Reclamação ativa: a resposta seguirá pela API de Claims.');
  }
  if (detail.ticket.marketplace === 'SHOPEE' && detail.crr && !detail.crr.safe) {
    notes.push('CRR em risco: responder agora protege o índice de 12h.');
  }

  return {
    violations,
    blocked,
    sanitizedText,
    sanitizedHtml: null,
    notes,
    routePreview: toRouteDecision(detail.routing, body.recipient),
  };
}

/* ==========================================================================
 * Ticket mutations
 * ========================================================================== */

function applyAction(ticketId: string, body: ActionBody): { message: string; statusChanged: boolean } {
  const detail = requireDetail(ticketId);
  const ticket = detail.ticket;
  const kind = body.kind;

  const markRead = () => {
    if (ticket.unreadCount > 0) {
      const next = patchTicket(ticket, {
        unreadCount: 0,
        status: ticket.status === 'UNREAD' ? 'OPEN_WAITING_AGENT' : ticket.status,
        channelMetadata:
          ticket.marketplace === 'SHOPEE'
            ? { ...ticket.channelMetadata, crr_safe: true, unread_count: 0 }
            : ticket.channelMetadata,
      });
      if (ticket.marketplace === 'SHOPEE' && detail.crr) {
        detail.crr = { ...detail.crr, safe: true, label: 'CRR OK · protegido' };
      }
      return next;
    }
    return ticket;
  };

  switch (kind) {
    case 'AMAZON_NO_RESPONSE_NEEDED':
      patchTicket(ticket, { status: 'NO_RESPONSE_NEEDED', unreadCount: 0 });
      addEvent(ticketId, 'CLOSED_WITHOUT_RESPONSE', state.currentAgent.name, { kind });
      return { message: 'Ticket finalizado sem resposta (Route 3).', statusChanged: true };
    case 'MELI_ALLOW_RETURN':
      patchTicket(ticket, { status: 'RESOLVED', unreadCount: 0 });
      addEvent(ticketId, 'ACTION_EXECUTED', state.currentAgent.name, { kind, result: 'allow_return' });
      return { message: 'Devolução autorizada e etiqueta gerada (simulado).', statusChanged: true };
    case 'MELI_REFUND':
      patchTicket(ticket, { status: 'RESOLVED', unreadCount: 0 });
      addEvent(ticketId, 'ACTION_EXECUTED', state.currentAgent.name, { kind, result: 'refund' });
      return { message: 'Reembolso integral registrado (simulado).', statusChanged: true };
    case 'MELI_OPEN_DISPUTE':
      patchTicket(ticket, { status: 'MEDIATION' });
      addEvent(ticketId, 'ACTION_EXECUTED', state.currentAgent.name, { kind, result: 'open_dispute' });
      return { message: 'Mediação do Mercado Livre solicitada (simulado).', statusChanged: true };
    case 'MELI_ANSWER_QUESTION':
      patchTicket(ticket, { status: 'WAITING_BUYER', unreadCount: 0 });
      addEvent(ticketId, 'ACTION_EXECUTED', state.currentAgent.name, { kind });
      return { message: 'Pergunta respondida na página do anúncio (simulado).', statusChanged: true };
    case 'SHOPEE_CONFIRM_RETURN':
      patchTicket(ticket, { status: 'RESOLVED', unreadCount: 0 });
      addEvent(ticketId, 'ACTION_EXECUTED', state.currentAgent.name, { kind, result: 'confirm_return' });
      return { message: 'Devolução confirmada e reembolso liberado (simulado).', statusChanged: true };
    case 'SHOPEE_DISPUTE_RETURN':
      patchTicket(ticket, { status: 'MEDIATION' });
      addEvent(ticketId, 'ACTION_EXECUTED', state.currentAgent.name, { kind, result: 'dispute_return' });
      return { message: 'Disputa N2 de devolução aberta (simulado).', statusChanged: true };
    case 'SHOPEE_ACCEPT_CANCELLATION':
      patchTicket(ticket, { status: 'RESOLVED', unreadCount: 0 });
      addEvent(ticketId, 'ACTION_EXECUTED', state.currentAgent.name, { kind, result: 'accept_cancellation' });
      return { message: 'Cancelamento aceito (simulado).', statusChanged: true };
    case 'SHOPEE_MARK_READ': {
      markRead();
      addEvent(ticketId, 'CRR_PROTECTED', state.currentAgent.name, { conversationId: ticket.channelMetadata.conversation_id });
      return { message: 'Conversa lida — CRR protegido (simulado).', statusChanged: false };
    }
    default: {
      markRead();
      addEvent(ticketId, 'ACTION_EXECUTED', state.currentAgent.name, { kind });
      return { message: 'Ação executada com sucesso (simulado).', statusChanged: false };
    }
  }
}

/* ==========================================================================
 * Mock API surface (structurally identical to the real `api` client)
 * ========================================================================== */

export const mockApi = {
  async login(email: string, _password: string): Promise<AuthResponse> {
    await latency();
    return {
      token: 'mock-jwt-token',
      agent: {
        id: state.currentAgent.id,
        name: state.currentAgent.name,
        email: email || state.currentAgent.email,
        role: state.currentAgent.role as AuthResponse['agent']['role'],
        presence: state.currentAgent.presence,
      },
    };
  },

  async me(): Promise<IAgentSummary> {
    await latency();
    return clone(state.currentAgent);
  },

  async listTickets(
    filters: WorkspaceFilters,
    page = 1,
  ): Promise<{ items: TicketListItem[]; total: number; totalPages: number }> {
    await latency();
    const filtered = sortedTickets(state.tickets.filter((ticket) => matchesFilters(ticket, filters)));
    const pageSize = 40;
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    return {
      items: clone(filtered.slice((safePage - 1) * pageSize, safePage * pageSize)),
      total: filtered.length,
      totalPages,
    };
  },

  async getTicket(id: string): Promise<TicketDetail> {
    await latency();
    return clone(requireDetail(id));
  },

  async sendMessage(
    ticketId: string,
    body: SendMessageBody,
  ): Promise<{ messageId: string; routeUsed: string; deliveryStatus: string; warnings: string[] }> {
    await sleep(550, 750);
    const detail = requireDetail(ticketId);
    const route = routeForTicket(detail.ticket);
    const createdAt = nowIso();
    const message: MessageView = {
      id: uid('msg'),
      externalMessageId: null,
      direction: 'OUTBOUND_AGENT',
      channelRouteUsed: route,
      messageType: body.shopeeMessageType === 'order' || body.shopeeMessageType === 'item' ? body.shopeeMessageType : 'text',
      bodyCleanText: body.bodyText,
      bodyHtml: body.bodyHtml ?? null,
      deliveryStatus: 'QUEUED',
      isInternalNote: false,
      authorAgentId: state.currentAgent.id,
      marketplaceCreatedAt: createdAt,
      attachments: [],
      contentPayload: {
        order_sn: body.shopeeOrderCardOrderSn ?? null,
        item_id: body.shopeeItemCardItemId ?? null,
        recipient: body.recipient ?? 'BUYER',
      },
    };

    detail.messages = [...detail.messages, message];
    const updated = patchTicket(detail.ticket, {
      status: 'WAITING_BUYER',
      lastMessageAt: createdAt,
      unreadCount: 0,
      firstResponseAt: detail.ticket.firstResponseAt ?? createdAt,
      channelMetadata:
        detail.ticket.marketplace === 'SHOPEE'
          ? { ...detail.ticket.channelMetadata, crr_safe: true, unread_count: 0 }
          : detail.ticket.channelMetadata,
    });
    if (detail.ticket.marketplace === 'SHOPEE' && detail.crr) {
      detail.crr = { ...detail.crr, safe: true, lastMessageDirection: 'OUTBOUND_AGENT', label: 'CRR OK · protegido' };
    }
    if (updated.id) {
      addEvent(ticketId, 'MESSAGE_SENT', state.currentAgent.name, { route });
    }

    const warnings = detail.routing.warnings;
    return {
      messageId: message.id,
      routeUsed: route,
      deliveryStatus: 'QUEUED',
      warnings,
    };
  },

  async policyCheck(ticketId: string, body: PolicyCheckBody): Promise<PolicyEvaluation> {
    await sleep(120, 260);
    const detail = requireDetail(ticketId);
    if (!body.bodyText.trim()) return emptyPolicy(detail, body.bodyText, body.recipient);
    return buildPolicy(detail, body);
  },

  async resolveRoute(ticketId: string, recipient?: 'BUYER' | 'MEDIATOR'): Promise<RouteDecision> {
    await latency();
    const detail = requireDetail(ticketId);
    return toRouteDecision(detail.routing, recipient);
  },

  async runAction(ticketId: string, body: ActionBody): Promise<ChannelActionResult> {
    await sleep(380, 680);
    const detail = requireDetail(ticketId);
    const outcome = applyAction(ticketId, body);
    return {
      action: body.kind as ChannelActionKind,
      ok: true,
      message: outcome.message,
      routeUsed: routeForTicket(detail.ticket),
      externalId: uid('ext'),
      data: { simulated: true },
    };
  },

  async assignTicket(ticketId: string, agentId: string): Promise<TicketListItem> {
    await latency();
    const agent = state.agents.find((entry) => entry.id === agentId) ?? null;
    const detail = requireDetail(ticketId);
    const updated = patchTicket(detail.ticket, {
      assignedAgentId: agent ? agent.id : null,
      assignedAgentName: agent ? agent.name : null,
    });
    addEvent(ticketId, agent ? 'TICKET_ASSIGNED' : 'TICKET_UNASSIGNED', state.currentAgent.name, {
      agentId,
      agentName: agent?.name ?? null,
    });
    return clone(updated);
  },

  async changeStatus(ticketId: string, status: TicketListItem['status']): Promise<TicketListItem> {
    await latency();
    const detail = requireDetail(ticketId);
    const updated = patchTicket(detail.ticket, { status });
    addEvent(ticketId, 'STATUS_CHANGED', state.currentAgent.name, { status });
    return clone(updated);
  },

  async closeWithoutResponse(ticketId: string): Promise<TicketListItem> {
    await latency();
    const detail = requireDetail(ticketId);
    const updated = patchTicket(detail.ticket, { status: 'NO_RESPONSE_NEEDED', unreadCount: 0 });
    addEvent(ticketId, 'CLOSED_WITHOUT_RESPONSE', state.currentAgent.name, {
      route: 'AMAZON_EMAIL_RELAY',
    });
    return clone(updated);
  },

  async markRead(ticketId: string): Promise<TicketListItem> {
    await latency();
    const detail = requireDetail(ticketId);
    const updated = patchTicket(detail.ticket, {
      unreadCount: 0,
      status: detail.ticket.status === 'UNREAD' ? 'OPEN_WAITING_AGENT' : detail.ticket.status,
      channelMetadata:
        detail.ticket.marketplace === 'SHOPEE'
          ? { ...detail.ticket.channelMetadata, crr_safe: true, unread_count: 0 }
          : detail.ticket.channelMetadata,
    });
    if (detail.ticket.marketplace === 'SHOPEE' && detail.crr) {
      detail.crr = { ...detail.crr, safe: true, label: 'CRR OK · protegido' };
    }
    addEvent(ticketId, 'TICKET_READ', state.currentAgent.name, {});
    return clone(updated);
  },

  async addNote(ticketId: string, text: string): Promise<MessageView> {
    await latency();
    const detail = requireDetail(ticketId);
    const note: MessageView = {
      id: uid('note'),
      externalMessageId: null,
      direction: 'OUTBOUND_AGENT',
      channelRouteUsed: routeForTicket(detail.ticket),
      messageType: 'internal_note',
      bodyCleanText: text,
      bodyHtml: null,
      deliveryStatus: 'SENT',
      isInternalNote: true,
      authorAgentId: state.currentAgent.id,
      marketplaceCreatedAt: nowIso(),
      attachments: [],
      contentPayload: {},
    };
    detail.messages = [...detail.messages, note];
    addEvent(ticketId, 'INTERNAL_NOTE', state.currentAgent.name, { length: text.length });
    return clone(note);
  },

  async queueSnapshot(filters?: WorkspaceFilters): Promise<QueueSnapshot> {
    await latency();
    const items = filters
      ? state.tickets.filter((ticket) => matchesFilters(ticket, filters))
      : state.tickets;
    return { stats: statsFrom(items), generatedAt: nowIso() };
  },

  async stats(): Promise<TicketStats> {
    await latency();
    return statsFrom(state.tickets);
  },

  async channelHealth(): Promise<ChannelHealthView[]> {
    await latency();
    return clone(state.health);
  },

  async listAgents(): Promise<IAgentSummary[]> {
    await latency();
    return clone(state.agents);
  },

  async setPresence(presence: AgentPresenceStatus): Promise<IAgentSummary> {
    await latency();
    state.currentAgent = { ...state.currentAgent, presence };
    state.agents = state.agents.map((agent) =>
      agent.id === state.currentAgent.id ? { ...agent, presence } : agent,
    );
    return clone(state.currentAgent);
  },

  async listAccounts(): Promise<AccountRow[]> {
    await latency();
    return clone(state.accounts);
  },

  async connectors(): Promise<ConnectorDescriptor[]> {
    await latency();
    return clone(state.connectors);
  },

  async startOAuth(
    marketplace: 'mercadolivre' | 'shopee',
    displayName: string,
  ): Promise<{ authorizeUrl: string; state: string }> {
    await sleep(500, 800);
    const target: Marketplace = marketplace === 'mercadolivre' ? 'MERCADO_LIVRE' : 'SHOPEE';
    const connector = state.connectors.find((entry) => entry.marketplace === target);
    const oauthState = uid('state');
    const rawTemplate =
      connector?.authorizeUrlTemplate ??
      'https://example.com/oauth/authorize?state={{state}}&display={{displayName}}';
    const authorizeUrl = rawTemplate
      .replace('{{state}}', oauthState)
      .replace('{{clientId}}', 'demo-client-id')
      .replace('{{partnerId}}', '1000000')
      .replace('{{redirectUri}}', encodeURIComponent('http://localhost:4000/api/v1/accounts/oauth/callback'))
      .replace('{{timestamp}}', String(Math.floor(Date.now() / 1000)))
      .replace('{{sign}}', 'demo-signature')
      .replace('{{displayName}}', encodeURIComponent(displayName));
    return { authorizeUrl, state: oauthState };
  },

  async connectAccount(payload: ConnectAccountPayload): Promise<{ accountId: string; displayName: string }> {
    await sleep(900, 1300);
    const existing = state.accounts.find(
      (account) =>
        account.marketplace === payload.marketplace &&
        account.externalSellerId === payload.externalSellerId,
    );
    if (existing) {
      state.accounts = state.accounts.map((account) =>
        account.id === existing.id
          ? {
              ...account,
              displayName: payload.displayName,
              status: 'ACTIVE',
              channelConfig: { ...account.channelConfig, ...(payload.channelConfig ?? {}) },
              tokenExpiresAt: new Date(Date.now() + 24 * 3_600_000 * 30).toISOString(),
            }
          : account,
      );
      return { accountId: existing.id, displayName: payload.displayName };
    }
    const accountId = uid('acc');
    const created: AccountRow = {
      id: accountId,
      marketplace: payload.marketplace,
      displayName: payload.displayName,
      externalSellerId: payload.externalSellerId,
      marketplaceSiteId: payload.marketplaceSiteId,
      status: 'ACTIVE',
      channelConfig: payload.channelConfig ?? {},
      tokenExpiresAt: new Date(Date.now() + 24 * 3_600_000 * 30).toISOString(),
      authExpiresAt: new Date(Date.now() + 24 * 3_600_000 * 180).toISOString(),
    };
    state.accounts = [...state.accounts, created];
    return { accountId, displayName: payload.displayName };
  },

  async disconnectAccount(id: string): Promise<void> {
    await sleep(500, 800);
    state.accounts = state.accounts.map((account) =>
      account.id === id ? { ...account, status: 'DISCONNECTED' } : account,
    );
    state.health = state.health.map((entry) =>
      entry.accountId === id
        ? {
            ...entry,
            status: 'DISCONNECTED',
            inboundHealthy: false,
            outboundHealthy: false,
            detail: 'Conta desconectada pelo operador',
          }
        : entry,
    );
  },

  async refreshAccount(id: string): Promise<{ ok: boolean; detail: string }> {
    await sleep(600, 900);
    const account = state.accounts.find((entry) => entry.id === id);
    if (!account) return { ok: false, detail: 'Conta não encontrada' };
    state.accounts = state.accounts.map((entry) =>
      entry.id === id
        ? {
            ...entry,
            status: 'ACTIVE',
            tokenExpiresAt: new Date(Date.now() + 24 * 3_600_000 * 30).toISOString(),
          }
        : entry,
    );
    state.health = state.health.map((entry) =>
      entry.accountId === id
        ? {
            ...entry,
            status: 'ACTIVE',
            inboundHealthy: true,
            outboundHealthy: true,
            tokenExpiresAt: new Date(Date.now() + 24 * 3_600_000 * 30).toISOString(),
            detail: 'Token renovado com sucesso (simulado)',
          }
        : entry,
    );
    return { ok: true, detail: 'Token renovado com sucesso (simulado).' };
  },

  async uploadFile(file: File): Promise<UploadedFile> {
    await sleep(400, 900);
    const key = `mock/uploads/${Date.now()}-${file.name.replace(/\s+/g, '-')}`;
    return {
      key,
      uri: `s3://sac-hub-attachments/${key}`,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      sha256: '0'.repeat(64),
    };
  },

  async signedUrl(key: string): Promise<{ url: string }> {
    await sleep(80, 160);
    return { url: `https://files.sachub.local/${encodeURIComponent(key)}?signature=mock` };
  },
};

/** Exposed for tests/debugging only. */
export const mockState = state;
export type MockApi = typeof mockApi;
export type { AttachmentView, CrrStatusView, PolicyViolation };
