/**
 * Canonical enum values.
 *
 * These mirror the Prisma enums 1:1 but are expressed as string unions so the
 * same file is consumable by the server (CJS), tests and the web client without
 * pulling a Prisma runtime into the browser bundle.
 */

export type Marketplace = 'AMAZON' | 'MERCADO_LIVRE' | 'SHOPEE';
export const MARKETPLACES = ['AMAZON', 'MERCADO_LIVRE', 'SHOPEE'] as const;

export const MARKETPLACE_LABEL: Record<Marketplace, string> = {
  AMAZON: 'Amazon',
  MERCADO_LIVRE: 'Mercado Livre',
  SHOPEE: 'Shopee',
};

export const MARKETPLACE_TAG: Record<Marketplace, string> = {
  AMAZON: '[AMAZON]',
  MERCADO_LIVRE: '[MELI]',
  SHOPEE: '[SHOPEE]',
};

export type AccountStatus = 'ACTIVE' | 'TOKEN_EXPIRED' | 'DISCONNECTED';

export type TicketType =
  | 'PRE_SALE'
  | 'POST_SALE_ORDER'
  | 'CLAIM_DISPUTE'
  | 'RETURN_REFUND'
  | 'CANCELLATION'
  | 'PROACTIVE';

export const TICKET_TYPE_LABEL: Record<TicketType, string> = {
  PRE_SALE: 'PRÉ-VENDA',
  POST_SALE_ORDER: 'PÓS-VENDA',
  CLAIM_DISPUTE: 'RECLAMAÇÃO',
  RETURN_REFUND: 'DEVOLUÇÃO',
  CANCELLATION: 'CANCELAMENTO',
  PROACTIVE: 'PROATIVO',
};

export type TicketStatus =
  | 'UNREAD'
  | 'OPEN_WAITING_AGENT'
  | 'WAITING_BUYER'
  | 'NO_RESPONSE_NEEDED'
  | 'MEDIATION'
  | 'RESOLVED';

/** Every ticket status, in lifecycle order (used to zero-fill status counters). */
export const TICKET_STATUSES = [
  'UNREAD',
  'OPEN_WAITING_AGENT',
  'WAITING_BUYER',
  'NO_RESPONSE_NEEDED',
  'MEDIATION',
  'RESOLVED',
] as const satisfies readonly TicketStatus[];

export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = [
  'UNREAD',
  'OPEN_WAITING_AGENT',
  'WAITING_BUYER',
  'MEDIATION',
];
/** Statuses that stop the SLA clock. */
export const TERMINAL_TICKET_STATUSES: readonly TicketStatus[] = ['NO_RESPONSE_NEEDED', 'RESOLVED'];

export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL_SLA';

export const PRIORITY_RANK: Record<TicketPriority, number> = {
  CRITICAL_SLA: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

export type MessageDirection =
  | 'INBOUND_BUYER'
  | 'OUTBOUND_AGENT'
  | 'OUTBOUND_SYSTEM'
  | 'EXTERNAL_SELLER_PANEL'
  | 'MEDIATOR';

export type ChannelRoute =
  | 'AMAZON_EMAIL_RELAY'
  | 'AMAZON_SP_API_MESSAGING'
  | 'MELI_QUESTIONS_API'
  | 'MELI_MESSAGES_API'
  | 'MELI_CLAIMS_API'
  | 'SHOPEE_CHAT_API'
  | 'SHOPEE_RETURNS_API';

export const CHANNEL_ROUTE_LABEL: Record<ChannelRoute, string> = {
  AMAZON_EMAIL_RELAY: 'Buyer-Seller Relay (SMTP)',
  AMAZON_SP_API_MESSAGING: 'SP-API Messaging',
  MELI_QUESTIONS_API: 'Meli Questions API',
  MELI_MESSAGES_API: 'Meli Messages API',
  MELI_CLAIMS_API: 'Meli Claims API',
  SHOPEE_CHAT_API: 'Shopee Chat API',
  SHOPEE_RETURNS_API: 'Shopee Returns API',
};

export type DeliveryStatus =
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'BOUNCED_BLOCKED'
  | 'MODERATION_REJECTED'
  | 'FAILED';

export type AgentPresenceStatus = 'ONLINE' | 'PAUSED' | 'OFFLINE';
export type AgentRole = 'ADMIN' | 'SUPERVISOR' | 'AGENT';

export type SlaState = 'ON_TRACK' | 'AT_RISK' | 'BREACHED' | 'MET';

export type WebhookProcessingStatus =
  | 'RECEIVED'
  | 'DUPLICATE'
  | 'PROCESSED'
  | 'FAILED'
  | 'DEAD_LETTER';

/** BullMQ queue names. Prefix is part of the contract - workers bind to these. */
export type QueueName =
  | 'queue.inbound.amazon'
  | 'queue.inbound.meli'
  | 'queue.inbound.shopee'
  | 'queue.spapi.enrichment'
  | 'queue.outbound.dispatch'
  | 'queue.sla.scan'
  | 'queue.pii.purge'
  | 'queue.shopee.lost-push'
  | 'queue.token.refresh'
  | 'queue.tenant.purge'
  | 'queue.dlq';

export const QUEUE_NAMES: Record<string, QueueName> = {
  amazonInbound: 'queue.inbound.amazon',
  meliInbound: 'queue.inbound.meli',
  shopeeInbound: 'queue.inbound.shopee',
  spapiEnrichment: 'queue.spapi.enrichment',
  outboundDispatch: 'queue.outbound.dispatch',
  slaScan: 'queue.sla.scan',
  piiPurge: 'queue.pii.purge',
  shopeeLostPush: 'queue.shopee.lost-push',
  tokenRefresh: 'queue.token.refresh',
  /** Fase 4/LGPD: daily physical purge of soft-deleted workspaces. */
  tenantPurge: 'queue.tenant.purge',
  deadLetter: 'queue.dlq',
};

export type ChannelActionKind =
  // Amazon
  | 'AMAZON_CONFIRM_DELIVERY_DETAILS'
  | 'AMAZON_UNEXPECTED_PROBLEM'
  | 'AMAZON_WARRANTY'
  | 'AMAZON_CONFIRM_CUSTOMIZATION'
  | 'AMAZON_NO_RESPONSE_NEEDED'
  // Mercado Livre
  | 'MELI_ANSWER_QUESTION'
  | 'MELI_SEND_POST_SALE_MESSAGE'
  | 'MELI_SEND_CLAIM_MESSAGE'
  | 'MELI_ALLOW_RETURN'
  | 'MELI_REFUND'
  | 'MELI_OPEN_DISPUTE'
  // Shopee
  | 'SHOPEE_SEND_CHAT_MESSAGE'
  | 'SHOPEE_CONFIRM_RETURN'
  | 'SHOPEE_DISPUTE_RETURN'
  | 'SHOPEE_ACCEPT_CANCELLATION'
  | 'SHOPEE_MARK_READ';

export const TERMINAL_ACTION_KINDS: readonly ChannelActionKind[] = [
  'AMAZON_NO_RESPONSE_NEEDED',
  'MELI_ALLOW_RETURN',
  'MELI_REFUND',
  'MELI_OPEN_DISPUTE',
  'SHOPEE_CONFIRM_RETURN',
  'SHOPEE_DISPUTE_RETURN',
  'SHOPEE_ACCEPT_CANCELLATION',
  'SHOPEE_MARK_READ',
];

export function isMarketplace(value: unknown): value is Marketplace {
  return typeof value === 'string' && (MARKETPLACES as readonly string[]).includes(value);
}
