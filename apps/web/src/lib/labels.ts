/**
 * Runtime labels + SLA formatting. Local copies only: never import runtime
 * values from `@sac/shared` into the browser bundle (docs/UI_SPEC.md §Types).
 */
import type {
  AccountStatus,
  AgentPresenceStatus,
  ChannelRoute,
  DeliveryStatus,
  Marketplace,
  MessageDirection,
  SlaState,
  TicketPriority,
  TicketStatus,
  TicketType,
} from '@sac/shared';

import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDurationMinutes,
  initials,
} from './format';

export {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDurationMinutes,
  initials,
};

/* ==========================================================================
 * Marketplace
 * ========================================================================== */

export const MARKETPLACE_LABEL: Record<Marketplace, string> = {
  AMAZON: 'Amazon',
  MERCADO_LIVRE: 'Mercado Livre',
  SHOPEE: 'Shopee',
};

export const MARKETPLACE_SHORT: Record<Marketplace, string> = {
  AMAZON: 'AMZ',
  MERCADO_LIVRE: 'MELI',
  SHOPEE: 'SHOPEE',
};

/** Tailwind color token for the brand accent (text/border helpers). */
export function marketplaceColor(marketplace: Marketplace): string {
  switch (marketplace) {
    case 'AMAZON':
      return 'text-amazon';
    case 'MERCADO_LIVRE':
      return 'text-meli';
    case 'SHOPEE':
      return 'text-shopee';
    default:
      return 'text-secondary';
  }
}

export const MARKETPLACE_ORDER: Marketplace[] = ['AMAZON', 'MERCADO_LIVRE', 'SHOPEE'];

/* ==========================================================================
 * Ticket taxonomy
 * ========================================================================== */

export const TICKET_TYPE_LABEL: Record<TicketType, string> = {
  PRE_SALE: 'PRÉ-VENDA',
  POST_SALE_ORDER: 'PÓS-VENDA',
  CLAIM_DISPUTE: 'RECLAMAÇÃO',
  RETURN_REFUND: 'DEVOLUÇÃO',
  CANCELLATION: 'CANCELAMENTO',
  PROACTIVE: 'PROATIVO',
};

export const STATUS_LABEL: Record<TicketStatus, string> = {
  UNREAD: 'Não lido',
  OPEN_WAITING_AGENT: 'Aguardando agente',
  WAITING_BUYER: 'Aguardando comprador',
  NO_RESPONSE_NEEDED: 'Sem resposta necessária',
  MEDIATION: 'Em mediação',
  RESOLVED: 'Resolvido',
};

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  LOW: 'Baixa',
  MEDIUM: 'Média',
  HIGH: 'Alta',
  CRITICAL_SLA: 'SLA crítico',
};

export const PRIORITY_RANK: Record<TicketPriority, number> = {
  CRITICAL_SLA: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

export const SLA_STATE_LABEL: Record<SlaState, string> = {
  ON_TRACK: 'No prazo',
  AT_RISK: 'Em risco',
  BREACHED: 'Violado',
  MET: 'Cumprido',
};

export const PRESENCE_LABEL: Record<AgentPresenceStatus, string> = {
  ONLINE: 'Online',
  PAUSED: 'Pausa',
  OFFLINE: 'Offline',
};

export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  ACTIVE: 'Conectado',
  TOKEN_EXPIRED: 'Token expirado',
  DISCONNECTED: 'Desconectado',
};

/* ==========================================================================
 * Messaging
 * ========================================================================== */

export const ROUTE_LABEL: Record<ChannelRoute, string> = {
  AMAZON_EMAIL_RELAY: 'Buyer-Seller Relay (SMTP)',
  AMAZON_SP_API_MESSAGING: 'SP-API Messaging',
  MELI_QUESTIONS_API: 'Meli Questions API',
  MELI_MESSAGES_API: 'Meli Messages API',
  MELI_CLAIMS_API: 'Meli Claims API',
  SHOPEE_CHAT_API: 'Shopee Chat API',
  SHOPEE_RETURNS_API: 'Shopee Returns API',
};

export const DIRECTION_LABEL: Record<MessageDirection, string> = {
  INBOUND_BUYER: 'ENTRADA',
  OUTBOUND_AGENT: 'SAÍDA',
  OUTBOUND_SYSTEM: 'SISTEMA',
  EXTERNAL_SELLER_PANEL: 'SELLER CENTRAL',
  MEDIATOR: 'MEDIADOR',
};

export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  QUEUED: 'Na fila',
  SENT: 'Enviado',
  DELIVERED: 'Entregue',
  READ: 'Lido',
  BOUNCED_BLOCKED: 'Bloqueado',
  MODERATION_REJECTED: 'Rejeitado',
  FAILED: 'Falhou',
};

export const QUEUE_KEY_LABEL: Record<string, string> = {
  ALL: 'Todos',
  SLA_CRITICAL: 'SLA crítico',
  CLAIMS: 'Claims/Disputas',
  PRE_SALE: 'Pré-venda',
  WAITING_ME: 'Aguardando mim',
  UNASSIGNED: 'Não atribuídos',
};

/* ==========================================================================
 * SLA clock
 * ========================================================================== */

export type SlaTone = 'ok' | 'warn' | 'danger';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Live SLA countdown. `<2h` is amber, `<=0` is red/VIOLADO (docs/UI_SPEC.md §3).
 * Pure aside from `Date.now()`; callers re-render every second.
 */
export function formatSlaRemaining(
  deadlineIso: string,
  now: number = Date.now(),
): {
  text: string;
  tone: SlaTone;
  msLeft: number;
} {
  const deadline = new Date(deadlineIso).getTime();
  if (!Number.isFinite(deadline)) return { text: '—', tone: 'ok', msLeft: 0 };
  const msLeft = deadline - now;
  if (msLeft <= 0) return { text: 'VIOLADO', tone: 'danger', msLeft };
  const tone: SlaTone = msLeft < 2 * HOUR ? 'warn' : 'ok';
  return { text: compactRemaining(msLeft), tone, msLeft };
}

function compactRemaining(msLeft: number): string {
  const totalSeconds = Math.floor(msLeft / SECOND);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  if (days > 0) return `${days}d ${pad(hours)}h`;
  if (hours > 0) return `${hours}h${pad(minutes)}`;
  return `${minutes}m`;
}
