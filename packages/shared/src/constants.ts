import type { ChannelRoute, Marketplace, QueueName, TicketPriority, TicketType } from './enums';

/**
 * Redis key builders. Every component (core, adapters, cron) MUST use these so
 * locks, caches and idempotency guards address the same keys.
 */
export const CACHE_KEYS = {
  amazonLwaToken: (accountId: string): string => `sac:token:amazon:lwa:${accountId}`,
  amazonRdt: (accountId: string, dataHash: string): string =>
    `sac:token:amazon:rdt:${accountId}:${dataHash}`,
  meliToken: (accountId: string): string => `sac:token:meli:access:${accountId}`,
  meliRefreshLock: (accountId: string): string => `lock:meli:refresh:${accountId}`,
  shopeeToken: (accountId: string): string => `sac:token:shopee:access:${accountId}`,
  shopeeRefreshLock: (accountId: string): string => `lock:shopee:refresh:${accountId}`,
  shopeeRefreshGate: (accountId: string): string => `sac:token:shopee:refresh-gate:${accountId}`,
  webhookIdempotency: (marketplace: Marketplace, eventId: string): string =>
    `sac:webhook:idemp:${marketplace}:${eventId}`,
  webhookEvent: (marketplace: Marketplace, eventId: string): string =>
    `sac:webhook:event:${marketplace}:${eventId}`,
  rateBucket: (bucket: string): string => `sac:ratelimit:${bucket}`,
  lock: (resource: string): string => `lock:sac:${resource}`,
  agentPresence: (agentId: string): string => `sac:presence:agent:${agentId}`,
  presenceIndex: (): string => 'sac:presence:index',
  piiTicket: (ticketId: string): string => `sac:pii:ticket:${ticketId}`,
  piiOrder: (marketplace: Marketplace, orderId: string): string =>
    `sac:pii:order:${marketplace}:${orderId}`,
  stickyAgent: (conversationKey: string): string => `sac:sticky:${conversationKey}`,
  conversationRead: (conversationId: string): string => `sac:shopee:read:${conversationId}`,
  slaTicketClock: (ticketId: string): string => `sac:sla:${ticketId}`,
  lastLostPushCursor: (accountId: string): string => `sac:shopee:lostpush:cursor:${accountId}`,
  outboundDedupe: (ticketId: string, key: string): string => `sac:outbound:dedupe:${ticketId}:${key}`,
  healthChannel: (marketplace: Marketplace, accountId: string): string =>
    `sac:health:${marketplace}:${accountId}`,
  /** Fixed-window throttle for `POST /auth/resend-verification` (1/min). */
  emailVerificationResend: (email: string): string =>
    `sac:auth:email-verification:resend:${email}`,
  /** Single-use guard for a 2FA challenge JWT (`jti`, 5 min TTL). */
  twoFactorChallenge: (jti: string): string => `sac:auth:2fa:challenge:${jti}`,
  /** Last accepted TOTP time-step per operator (replay protection). */
  twoFactorTotpStep: (userId: string): string => `sac:auth:2fa:totp-step:${userId}`,
} as const;

/** BullMQ job names (stable - used for metrics and DLQ replay). */
export const JOB_NAMES = {
  inboundHydrate: 'inbound.hydrate',
  spapiEnrichOrder: 'spapi.enrich-order',
  outboundSend: 'outbound.send',
  outboundRetry: 'outbound.retry',
  slaScan: 'sla.scan',
  slaMarkBreached: 'sla.mark-breached',
  piiPurge: 'pii.purge',
  shopeeLostPushRecover: 'shopee.lost-push.recover',
  tokenRefresh: 'token.refresh',
} as const;

/** Exponential backoff + jitter defaults (base, cap, attempts). */
export const RETRY_POLICY = {
  default: { attempts: 6, baseDelayMs: 1_000, maxDelayMs: 300_000, jitterRatio: 0.35 },
  webhookIngest: { attempts: 8, baseDelayMs: 500, maxDelayMs: 120_000, jitterRatio: 0.3 },
  outbound: { attempts: 5, baseDelayMs: 2_000, maxDelayMs: 180_000, jitterRatio: 0.25 },
  tokenRefresh: { attempts: 4, baseDelayMs: 5_000, maxDelayMs: 120_000, jitterRatio: 0.2 },
} as const;

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

/** Full-jitter exponential backoff used by both BullMQ workers and inline retries. */
export function computeBackoffDelay(attempt: number, policy: RetryPolicy): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exp * policy.jitterRatio * Math.random();
  return Math.min(policy.maxDelayMs, Math.round(exp + jitter));
}

/**
 * SLA defaults (minutes). Amazon relies on the 24h buyer-seller messaging window
 * (internal target 18h); Meli questions are 24h but we set a tight 2h first
 * response; claims follow `due_date` from the API when available; Shopee CRR is
 * a 12h chat response rate.
 */
export const SLA_DEFAULTS: Record<Marketplace, Record<TicketType, { targetMinutes: number; warningMinutes: number }>> = {
  AMAZON: {
    PRE_SALE: { targetMinutes: 1080, warningMinutes: 240 },
    POST_SALE_ORDER: { targetMinutes: 1080, warningMinutes: 240 },
    CLAIM_DISPUTE: { targetMinutes: 1440, warningMinutes: 360 },
    RETURN_REFUND: { targetMinutes: 1440, warningMinutes: 360 },
    CANCELLATION: { targetMinutes: 720, warningMinutes: 180 },
    PROACTIVE: { targetMinutes: 1440, warningMinutes: 360 },
  },
  MERCADO_LIVRE: {
    PRE_SALE: { targetMinutes: 120, warningMinutes: 45 },
    POST_SALE_ORDER: { targetMinutes: 720, warningMinutes: 180 },
    CLAIM_DISPUTE: { targetMinutes: 1440, warningMinutes: 240 },
    RETURN_REFUND: { targetMinutes: 1440, warningMinutes: 240 },
    CANCELLATION: { targetMinutes: 720, warningMinutes: 120 },
    PROACTIVE: { targetMinutes: 1440, warningMinutes: 240 },
  },
  SHOPEE: {
    PRE_SALE: { targetMinutes: 240, warningMinutes: 60 },
    POST_SALE_ORDER: { targetMinutes: 720, warningMinutes: 120 },
    CLAIM_DISPUTE: { targetMinutes: 720, warningMinutes: 120 },
    RETURN_REFUND: { targetMinutes: 720, warningMinutes: 120 },
    CANCELLATION: { targetMinutes: 360, warningMinutes: 90 },
    PROACTIVE: { targetMinutes: 720, warningMinutes: 120 },
  },
};

export const PRIORITY_BY_TICKET_TYPE: Record<TicketType, TicketPriority> = {
  PRE_SALE: 'MEDIUM',
  POST_SALE_ORDER: 'HIGH',
  CLAIM_DISPUTE: 'CRITICAL_SLA',
  RETURN_REFUND: 'HIGH',
  CANCELLATION: 'CRITICAL_SLA',
  PROACTIVE: 'LOW',
};

/** Amazon inbound subject/body order-id regex (3-7-7 digits). */
export const AMAZON_ORDER_ID_REGEX = /\b\d{3}-\d{7}-\d{7}\b/;
/** Amazon restricted-data elements required for buyer PII. */
export const AMAZON_RDT_DATA_ELEMENTS = ['buyerInfo', 'shippingAddress'] as const;
/** Amazon RDT token lifetime is 60 minutes; refresh 10 minutes early. */
export const AMAZON_RDT_TTL_SECONDS = 3_000;
/** LWA access token TTL mandated by the blueprint (55 minutes). */
export const AMAZON_LWA_TTL_SECONDS = 3_300;
/** Meli access tokens live 6h; refresh before expiry. */
export const MELI_TOKEN_TTL_SECONDS = 21_600;
/** Shopee access tokens live 4h; refreshed centrally every 3h30m. */
export const SHOPEE_TOKEN_TTL_SECONDS = 14_400;
export const SHOPEE_REFRESH_INTERVAL_SECONDS = 12_600;

/** Webhook SLA budgets (ms) - used by the controller and by health metrics. */
export const WEBHOOK_BUDGET_MS = {
  MERCADO_LIVRE: 500,
  SHOPEE: 100,
  AMAZON: 1_000,
} as const;

/** Route labels shown in the message timeline. */
export const ROUTE_TIMELINE_LABEL: Record<ChannelRoute, string> = {
  AMAZON_EMAIL_RELAY: 'INBOUND • Buyer-Seller Relay',
  AMAZON_SP_API_MESSAGING: 'OUTBOUND • SP-API Messaging',
  MELI_QUESTIONS_API: 'MELI • Questions API',
  MELI_MESSAGES_API: 'MELI • Messages API',
  MELI_CLAIMS_API: 'MELI • Claims API',
  SHOPEE_CHAT_API: 'SHOPEE • Chat API',
  SHOPEE_RETURNS_API: 'SHOPEE • Returns API',
};

/** Amazon proactive messaging actions allowed by `getMessagingActionsForOrder`. */
export const AMAZON_PROACTIVE_ACTIONS = [
  'confirmDeliveryDetails',
  'unexpectedProblem',
  'warranty',
  'confirmCustomizationDetails',
] as const;

export type AmazonProactiveAction = (typeof AMAZON_PROACTIVE_ACTIONS)[number];

/** Queue names bound to each marketplace inbound webhook. */
export const MARKETPLACE_INBOUND_QUEUE: Record<Marketplace, QueueName> = {
  AMAZON: 'queue.inbound.amazon',
  MERCADO_LIVRE: 'queue.inbound.meli',
  SHOPEE: 'queue.inbound.shopee',
};

export const DEFAULT_QUEUE_BY_MARKETPLACE: Record<Marketplace, string> = {
  AMAZON: 'SAC::Amazon',
  MERCADO_LIVRE: 'SAC::Meli',
  SHOPEE: 'SAC::Shopee-N1',
};

export const SHOPEE_SPECIALIZED_QUEUE = 'SAC::Shopee-N2-Retencao';
export const SHOPEE_COMMERCIAL_QUEUE = 'COMERCIAL::Pre-Venda';
