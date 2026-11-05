import type {
  Marketplace,
  NormalizedOrderSnapshot,
  OrderItemSnapshot,
  TicketPriority,
  TicketType,
} from '@sac/shared';

/**
 * Shopee Open Platform v2 adapter - internal type surface.
 *
 * Nothing in this file performs I/O: it only describes the shapes that cross the
 * adapter boundary (HTTP envelopes, token sets, push payloads and the pure
 * triage decision consumed by the hydrator and by the unit tests).
 */

export const SHOPEE_MARKETPLACE: Marketplace = 'SHOPEE';

/** Every v2 path used by this adapter. `apiPath` is the path-only value signed. */
export const SHOPEE_API_PATHS = {
  /** Public: signed with partner id + timestamp only. */
  tokenGet: '/api/v2/auth/token/get',
  /** Public: the store authorization hand-off URL. */
  authPartner: '/api/v2/shop/auth_partner',
  /** Private (partner scoped): lost push recovery, no shop_id in the signature. */
  getLostPushMessage: '/api/v2/push/get_lost_push_message',
  /** Private: sellerchat. */
  sendMessage: '/api/v2/sellerchat/send_message',
  uploadImage: '/api/v2/sellerchat/upload_image',
  readConversation: '/api/v2/sellerchat/read_conversation',
  getMessage: '/api/v2/sellerchat/get_message',
  getConversationList: '/api/v2/sellerchat/get_conversation_list',
  /** Private: catalogue / order / logistics. */
  getItemBaseInfo: '/api/v2/product/get_item_base_info',
  getOrderDetail: '/api/v2/order/get_order_detail',
  getTrackingInfo: '/api/v2/logistics/get_tracking_info',
  /** Private: post-sale retention flows. */
  getReturnDetail: '/api/v2/returns/get_return_detail',
  confirmReturn: '/api/v2/returns/confirm',
  disputeReturn: '/api/v2/returns/dispute',
  handleBuyerCancellation: '/api/v2/order/handle_buyer_cancellation',
} as const;

export type ShopeeApiPath = (typeof SHOPEE_API_PATHS)[keyof typeof SHOPEE_API_PATHS];

export type ShopeeHttpMethod = 'GET' | 'POST';

/** Standard Shopee v2 response envelope. `error === ''` means success. */
export interface ShopeeApiEnvelope<TResponse = Record<string, unknown>> {
  error?: string;
  message?: string;
  warning?: string;
  request_id?: string;
  response?: TResponse;
  [key: string]: unknown;
}

export interface ShopeeCallResult<TResponse = Record<string, unknown>> {
  /** Unwrapped `response` payload, or the envelope itself for flat endpoints. */
  data: TResponse;
  envelope: ShopeeApiEnvelope<unknown>;
  requestId: string | null;
  status: number;
}

export interface ShopeeRequestSpec {
  apiPath: string;
  method?: ShopeeHttpMethod;
  body?: Record<string, unknown>;
  /** Extra non-signature query params (rare; most endpoints carry a JSON body). */
  extraQuery?: Record<string, string | number | boolean | undefined | null>;
  formData?: FormData;
  accountId?: string;
  /** Public endpoints omit `access_token`/`shop_id` from the signature query. */
  publicCall?: boolean;
  /** Partner-scoped private endpoints (lost push) omit `shop_id`. */
  includeShopId?: boolean;
  /** Per-store partner overrides (default to the runtime config values). */
  partnerId?: string;
  partnerKey?: string;
  /** Explicit timestamp (unix seconds). Defaults to the injected clock. */
  timestamp?: number;
  timeoutMs?: number;
}

/** Credentials needed to sign a private call for a given connected store. */
export interface ShopeeAccessToken {
  accountId: string;
  shopId: string;
  partnerId: string;
  partnerKey: string;
  accessToken: string;
}

/**
 * Lets the low-level client obtain a valid token without depending on the auth
 * module at construction time (avoids a circular import).
 */
export interface ShopeeTokenProvider {
  /** Cached token, or a refreshed one when the cached value is missing/expired. */
  getCredentials(accountId: string): Promise<ShopeeAccessToken>;
  /** Forces a rotation after Shopee rejects a token as invalid. */
  forceRefresh(accountId: string): Promise<ShopeeAccessToken>;
}

/** Normalized result of `POST /api/v2/auth/token/get`. */
export interface ShopeeTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires (Shopee sends `expire_in`). */
  expiresIn: number;
  /** Seconds until the shop authorization expires, when the API provides it. */
  authExpiresIn: number | null;
  shopId: string | null;
  requestId: string | null;
}

/** A recovered/verified Shopee push payload. */
export interface ShopeePushPayload {
  code: number;
  shop_id: number | string | null;
  /** Unix seconds as sent by Shopee (may be absent on lost pushes). */
  timestamp: number | null;
  data: Record<string, unknown>;
}

/** Logistics snapshot extracted from `v2.logistics.get_tracking_info`. */
export interface ShopeeTrackingSnapshot {
  logisticsStatus: string | null;
  trackingNumber: string | null;
  carrierName: string | null;
  updateTimeMs: number | null;
  description: string | null;
  raw: Record<string, unknown>;
}

/** Order + tracking enriched in parallel. */
export interface ShopeeOrderContext {
  order: NormalizedOrderSnapshot;
  tracking: ShopeeTrackingSnapshot | null;
  rawOrder: Record<string, unknown>;
  items: OrderItemSnapshot[];
}

/**
 * Pure triage decision: which ticket type/priority/queue a push maps to and
 * whether network enrichment is required. Extracted from the hydrator so the
 * matrix is unit-testable without any network/cache dependency.
 */
export interface ShopeeTriageDecision {
  ticketType: TicketType;
  priority: TicketPriority;
  queueHint: string;
  orderSn: string | null;
  returnSn: string | null;
  requiresOrderEnrichment: boolean;
  requiresItemEnrichment: boolean;
  /** Cancellation/return flows are fatal for Shopee's SLA and CRR metrics. */
  slaFatal: boolean;
  isChat: boolean;
  isReturn: boolean;
  isCancellation: boolean;
}

export interface ShopeeTriageInput {
  code: number;
  data: Record<string, unknown>;
}

/** Cursor persisted in Redis for `v2.push.get_lost_push_message` pagination. */
export interface ShopeeLostPushCursor {
  offset: number;
  updatedAt: string;
}

/**
 * Optional runtime hints the composer/router may attach to `OutboundValidationInput`
 * so `validateOutbound` can raise the CRR risk note without doing I/O (the method
 * is contractually synchronous and pure).
 */
export interface ShopeeCrrHints {
  lastMessageDirection: string | null;
  lastInboundAt: Date | null;
}

/** Extra keys accepted in `OutboundValidationInput.allowedActions` for Shopee. */
export const SHOPEE_CRR_METADATA_KEYS = {
  lastMessageDirection: 'last_message_direction',
  lastInboundAt: 'last_inbound_at',
  hoursSinceLastInbound: 'hours_since_last_inbound',
  crrSafe: 'crr_safe',
} as const;
