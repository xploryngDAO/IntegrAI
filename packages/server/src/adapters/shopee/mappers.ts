import {
  DEFAULT_QUEUE_BY_MARKETPLACE,
  SHOPEE_COMMERCIAL_QUEUE,
  SHOPEE_SPECIALIZED_QUEUE,
  type NormalizedOrderSnapshot,
  type OrderItemSnapshot,
  type TicketPriority,
  type TicketType,
} from '@sac/shared';
import type {
  ShopeeOrderContext,
  ShopeePushPayload,
  ShopeeTrackingSnapshot,
  ShopeeTriageDecision,
  ShopeeTriageInput,
} from './types';

/**
 * Pure mapping helpers for the Shopee adapter.
 *
 * Everything here is deterministic and side-effect free: it is used by the
 * hydrator, by the webhook parser and by `triage.test.ts` to lock the triage
 * matrix without touching the network.
 */

const TEXT_LIMIT = 200_000;

/* ==========================================================================
 * Primitive coercion (Shopee sends numbers as strings and vice versa)
 * ========================================================================== */

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function pickString(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== null) return value;
  }
  return null;
}

export function pickNumber(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

export function pickRecord(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!record) return null;
  for (const key of keys) {
    const value = asRecord(record[key]);
    if (value) return value;
  }
  return null;
}

export function pickArray(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): unknown[] {
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** Shopee `created_timestamp`/`update_time` may be seconds or milliseconds. */
export function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (/^\d+$/.test(trimmed)) return toEpochMs(Number(trimmed));
    const iso = Date.parse(trimmed);
    return Number.isNaN(iso) ? null : iso;
  }
  const numeric = asNumber(value);
  if (numeric === null || numeric <= 0) return null;
  // > 1e12 is already milliseconds (year ~2001+); otherwise unix seconds.
  if (numeric >= 1_000_000_000_000) return Math.round(numeric);
  if (numeric >= 1_000_000_000) return Math.round(numeric * 1000);
  return null;
}

export function toDate(value: unknown): Date | null {
  const ms = toEpochMs(value);
  return ms === null ? null : new Date(ms);
}

/** Unix seconds from either seconds or milliseconds input. */
export function toUnixSeconds(value: unknown): number | null {
  const ms = toEpochMs(value);
  return ms === null ? null : Math.floor(ms / 1000);
}

/** Persisted text must never exceed 200k chars (SAC-wide rule). */
export function clampText(value: string, limit = TEXT_LIMIT): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit);
}

/** Converts a Shopee identifier to a JSON number when it is safely representable. */
export function toShopeeId(value: string | number | null | undefined): number | string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^-?\d+$/.test(trimmed)) return trimmed;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : trimmed;
}

/* ==========================================================================
 * Identifier normalization
 * ========================================================================== */

const ORDER_KEYS = ['ordersn', 'order_sn', 'orderSn', 'order_id'] as const;
const RETURN_KEYS = ['return_sn', 'returnSn', 'return_id'] as const;
const CONVERSATION_KEYS = ['conversation_id', 'conversationId', 'conv_id'] as const;

export function normalizeOrderSn(data: Record<string, unknown> | null): string | null {
  return pickString(data, ORDER_KEYS);
}

export function normalizeReturnSn(data: Record<string, unknown> | null): string | null {
  return pickString(data, RETURN_KEYS);
}

export function normalizeConversationId(data: Record<string, unknown> | null): string | null {
  return pickString(data, CONVERSATION_KEYS);
}

/**
 * Idempotency key for a push:
 * `message_id` | `code:ordersn` | `code:return_sn`.
 */
export function normalizeEventId(
  code: number,
  data: Record<string, unknown> | null,
): string | null {
  const messageId = pickString(data, ['message_id', 'messageId', 'msg_id']);
  if (messageId) return messageId;
  const orderSn = normalizeOrderSn(data);
  if (orderSn) return `${code}:${orderSn}`;
  const returnSn = normalizeReturnSn(data);
  if (returnSn) return `${code}:${returnSn}`;
  const conversationId = normalizeConversationId(data);
  if (conversationId) return `${code}:${conversationId}`;
  return null;
}

/* ==========================================================================
 * Push parsing (JSON, URL-encoded and base64-encoded `data`)
 * ========================================================================== */

export function parseShopeePushBody(rawBody: string): ShopeePushPayload | null {
  const text = rawBody.trim();
  if (text.length === 0) return null;

  let parsed: unknown = null;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  } else {
    // Shopee may deliver the push form-encoded (`code=4&shop_id=...&data={...}`).
    try {
      const params = new URLSearchParams(text);
      const record: Record<string, unknown> = {};
      for (const [key, value] of params.entries()) record[key] = value;
      parsed = record;
    } catch {
      return null;
    }
  }

  return normalizePushRecord(asRecord(parsed));
}

export function normalizePushRecord(record: Record<string, unknown> | null): ShopeePushPayload | null {
  if (!record) return null;
  const code = asNumber(record.code) ?? asNumber(record.push_code) ?? asNumber(record.topic);
  if (code === null) return null;

  const rawShopId = record.shop_id ?? record.shopid ?? record.shopId;
  const shopId: number | string | null =
    typeof rawShopId === 'string' || typeof rawShopId === 'number' ? rawShopId : null;

  const timestamp = toUnixSeconds(record.timestamp ?? record.send_time ?? record.create_time);

  const data =
    decodePushDataValue(record.data ?? record.payload) ??
    pickResidualData(record);

  return { code, shop_id: shopId, timestamp, data };
}

function pickResidualData(record: Record<string, unknown>): Record<string, unknown> {
  const residual: Record<string, unknown> = { ...record };
  delete residual.code;
  delete residual.push_code;
  delete residual.topic;
  delete residual.shop_id;
  delete residual.shopid;
  delete residual.shopId;
  delete residual.timestamp;
  delete residual.send_time;
  delete residual.create_time;
  delete residual.data;
  delete residual.payload;
  return residual;
}

/**
 * Lost pushes may carry `data` base64-encoded (Shopee compresses large payloads).
 * Accepts plain objects, JSON strings and base64(JSON).
 */
export function decodePushDataValue(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('{')) {
    try {
      return asRecord(JSON.parse(trimmed) as unknown);
    } catch {
      return null;
    }
  }
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
    if (decoded.startsWith('{')) {
      return asRecord(JSON.parse(decoded) as unknown);
    }
  } catch {
    return null;
  }
  return null;
}

/* ==========================================================================
 * Triage matrix (the binding contract, pure)
 * ========================================================================== */

function chatTriageDecision(data: Record<string, unknown>): ShopeeTriageDecision {
  const orderSn = normalizeOrderSn(data);
  const itemId = pickNumber(data, ['item_id', 'itemid', 'product_id', 'productId']);

  if (orderSn) {
    return {
      ticketType: 'POST_SALE_ORDER',
      priority: 'HIGH',
      queueHint: DEFAULT_QUEUE_BY_MARKETPLACE.SHOPEE,
      orderSn,
      returnSn: null,
      requiresOrderEnrichment: true,
      requiresItemEnrichment: false,
      slaFatal: false,
      isChat: true,
      isReturn: false,
      isCancellation: false,
    };
  }

  return {
    ticketType: 'PRE_SALE',
    priority: 'MEDIUM',
    queueHint: SHOPEE_COMMERCIAL_QUEUE,
    orderSn: null,
    returnSn: null,
    requiresOrderEnrichment: false,
    requiresItemEnrichment: itemId !== null,
    slaFatal: false,
    isChat: true,
    isReturn: false,
    isCancellation: false,
  };
}

/** Sellerchat push (`code === 4`) triage: pre-sale vs post-sale. */
export function mapChatTriage(data: Record<string, unknown>): ShopeeTriageDecision {
  return chatTriageDecision(data);
}

function returnTriageDecision(
  decision: Omit<
    ShopeeTriageDecision,
    'queueHint' | 'returnSn' | 'requiresOrderEnrichment' | 'requiresItemEnrichment' | 'slaFatal'
  > & { orderSn: string | null; returnSn: string | null },
): ShopeeTriageDecision {
  return {
    ...decision,
    queueHint: SHOPEE_SPECIALIZED_QUEUE,
    requiresOrderEnrichment: decision.orderSn !== null,
    requiresItemEnrichment: false,
    slaFatal: true,
  };
}

/**
 * Maps a push code to its ticket type/priority/queue:
 * - `4`  sellerchat: with `order_sn` -> POST_SALE_ORDER/HIGH/N1, else PRE_SALE/MEDIUM/COMERCIAL;
 * - `6`  returns -> RETURN_REFUND/CRITICAL_SLA/N2;
 * - `7`  buyer cancellation (`IN_CANCEL`) -> CANCELLATION/CRITICAL_SLA/N2;
 * - `2`/`3` order status/tracking -> POST_SALE_ORDER/HIGH/N1 (system messages);
 * - `1`/`5`/`10` -> no ticket (authorization/item/shipping document events).
 */
export function triageShopeePush(input: ShopeeTriageInput): ShopeeTriageDecision | null {
  const { code, data } = input;
  const orderSn = normalizeOrderSn(data);
  const returnSn = normalizeReturnSn(data);

  switch (code) {
    case 4:
      return chatTriageDecision(data);

    case 6:
      return returnTriageDecision({
        ticketType: 'RETURN_REFUND',
        priority: 'CRITICAL_SLA',
        orderSn,
        returnSn,
        isChat: false,
        isReturn: true,
        isCancellation: false,
      });

    case 7:
      return returnTriageDecision({
        ticketType: 'CANCELLATION',
        priority: 'CRITICAL_SLA',
        orderSn,
        returnSn,
        isChat: false,
        isReturn: false,
        isCancellation: true,
      });

    case 2:
    case 3:
      return {
        ticketType: 'POST_SALE_ORDER',
        priority: 'HIGH',
        queueHint: DEFAULT_QUEUE_BY_MARKETPLACE.SHOPEE,
        orderSn,
        returnSn,
        requiresOrderEnrichment: orderSn !== null,
        requiresItemEnrichment: false,
        slaFatal: false,
        isChat: false,
        isReturn: false,
        isCancellation: false,
      };

    default:
      // Some return pushes arrive under a different code but always carry return_sn.
      if (returnSn) {
        return returnTriageDecision({
          ticketType: 'RETURN_REFUND',
          priority: 'CRITICAL_SLA',
          orderSn,
          returnSn,
          isChat: false,
          isReturn: true,
          isCancellation: false,
        });
      }
      return null;
  }
}

export type ShopeePushHandler =
  | 'chat'
  | 'return'
  | 'cancellation'
  | 'order_status'
  | 'tracking'
  | 'shipping_document'
  | 'none';

/**
 * Shape-first dispatch used by the hydrator.
 *
 * The project contract fixes its own push-code matrix, while the public Shopee
 * push documentation assigns different codes (e.g. webchat = 10, order status =
 * 3, tracking = 4). Dispatching first on the payload shape - and only then on the
 * few codes that carry no discriminating field - keeps real Shopee pushes working
 * under both contracts without creating spurious tickets for shop/item pushes.
 */
export function resolvePushHandler(
  code: number,
  data: Record<string, unknown>,
): ShopeePushHandler {
  const conversationId = normalizeConversationId(data);
  const messageId = pickString(data, ['message_id', 'messageId', 'msg_id']);
  const contentRecord = asRecord(data['content']);
  const contentText = asString(data['content']);
  const chatLike =
    conversationId !== null ||
    messageId !== null ||
    contentRecord !== null ||
    contentText !== null;

  if (chatLike) return 'chat';

  const orderSn = normalizeOrderSn(data);
  const returnSn = normalizeReturnSn(data);
  const status = pickString(data, ['status', 'order_status', 'current_status']);
  const logisticsStatus = pickString(data, ['logistics_status', 'logistics']);
  const trackingNumber = pickString(data, ['tracking_number', 'tracking_no']);
  const cancelReason =
    pickString(data, ['cancel_reason', 'buyer_cancel_reason', 'reason']) ?? null;
  const cancelMarker =
    code === 7 ||
    status?.toUpperCase() === 'IN_CANCEL' ||
    (cancelReason !== null && /cancel/i.test(cancelReason));

  if (returnSn !== null) return 'return';
  if (code === 6 && orderSn !== null) return 'return';

  if (orderSn !== null) {
    if (cancelMarker) return 'cancellation';
    if (logisticsStatus !== null || trackingNumber !== null) return 'tracking';
    if (status !== null) return 'order_status';
    if (code === 10) return 'shipping_document';
  }

  return 'none';
}

export function priorityForTicketType(ticketType: TicketType): TicketPriority {
  switch (ticketType) {
    case 'PRE_SALE':
      return 'MEDIUM';
    case 'POST_SALE_ORDER':
      return 'HIGH';
    case 'CLAIM_DISPUTE':
    case 'RETURN_REFUND':
    case 'CANCELLATION':
      return 'CRITICAL_SLA';
    case 'PROACTIVE':
      return 'LOW';
    default:
      return 'MEDIUM';
  }
}

/* ==========================================================================
 * Order / tracking / item snapshot builders
 * ========================================================================== */

const LOGISTICS_CHANNEL_LABELS: Record<string, string> = {
  '80001': 'Shopee Xpress',
  '80002': 'Standard Express',
  '80003': 'J&T Express',
  '80004': 'Ninja Van',
  '80005': 'Flash Express',
  '80006': 'SPX Standard',
};

function normalizeCarrierName(candidate: string | null): string | null {
  if (!candidate) return null;
  const value = candidate.trim();
  if (value.length === 0) return null;
  if (/shopee\s*xpress|spx/i.test(value)) return 'Shopee Xpress';
  if (/standard\s*express|standard/i.test(value)) return 'Standard Express';
  return value;
}

function resolveFulfillmentType(
  packages: Array<Record<string, unknown>>,
  carrierName: string | null,
): string | null {
  for (const pkg of packages) {
    const carrier = normalizeCarrierName(
      pickString(pkg, ['shipping_carrier', 'logistics_channel_name', 'logistics_channel']),
    );
    if (carrier) return carrier;

    const channelId = pickString(pkg, ['logistics_channel_id', 'logistics_channel']);
    if (channelId && LOGISTICS_CHANNEL_LABELS[channelId]) return LOGISTICS_CHANNEL_LABELS[channelId];
  }
  return normalizeCarrierName(carrierName);
}

function buildOrderItemSnapshot(raw: Record<string, unknown>): OrderItemSnapshot {
  const itemId = pickString(raw, ['item_id', 'itemid', 'product_id']);
  return {
    sku: pickString(raw, ['item_sku', 'model_sku', 'sku']),
    itemId,
    title: pickString(raw, ['item_name', 'name', 'title']) ?? (itemId ? `Item ${itemId}` : 'Item Shopee'),
    quantity: pickNumber(raw, ['model_quantity_purchased', 'quantity_purchased', 'quantity']) ?? 1,
    unitPrice:
      pickNumber(raw, ['model_discounted_price', 'model_original_price', 'price', 'unit_price']) ?? 0,
    imageUrl: pickString(raw, ['image_url', 'item_image', 'image']),
    variation: pickString(raw, ['model_name', 'variation_name', 'model_sku']),
  };
}

/** `v2.product.get_item_base_info` -> order item snapshot (quantity unknown => 1). */
export function buildItemSnapshot(raw: Record<string, unknown>): OrderItemSnapshot | null {
  const itemId = pickString(raw, ['item_id', 'itemid', 'product_id']);
  const title = pickString(raw, ['item_name', 'name', 'title']);
  if (!itemId && !title) return null;

  const priceInfo = pickArray(raw, ['price_info']).map(asRecord).find((entry) => entry !== null);
  const image = pickRecord(raw, ['image']);
  return {
    sku: pickString(raw, ['item_sku', 'sku']),
    itemId,
    title: title ?? (itemId ? `Item ${itemId}` : 'Item Shopee'),
    quantity: 1,
    unitPrice:
      pickNumber(priceInfo ?? null, ['current_price', 'original_price']) ??
      pickNumber(raw, ['price', 'current_price']) ??
      0,
    imageUrl:
      pickString(image ?? null, ['image_url']) ?? pickString(raw, ['image_url', 'item_image']),
    variation: pickString(raw, ['model_name', 'variation_name']),
  };
}

export function buildTrackingSnapshot(raw: Record<string, unknown> | null): ShopeeTrackingSnapshot | null {
  if (!raw) return null;
  const trackingEntries = pickArray(raw, ['tracking_info', 'tracking_list'])
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  const latest = trackingEntries.length > 0 ? trackingEntries[trackingEntries.length - 1] : null;

  const snapshot: ShopeeTrackingSnapshot = {
    logisticsStatus:
      pickString(raw, ['logistics_status', 'status', 'current_status']) ??
      pickString(latest, ['logistics_status', 'status']),
    trackingNumber:
      pickString(raw, ['tracking_number', 'tracking_no', 'trackingNumber']) ??
      pickString(latest, ['tracking_number', 'tracking_no']),
    carrierName: normalizeCarrierName(
      pickString(raw, ['logistics_channel_name', 'shipping_carrier', 'logistics_channel', 'carrier']),
    ),
    updateTimeMs: toEpochMs(
      pickNumber(raw, ['update_time', 'updateTime']) ??
        pickNumber(latest, ['update_time', 'create_time']),
    ),
    description:
      pickString(raw, ['description', 'logistics_description']) ??
      pickString(latest, ['description']),
    raw,
  };

  if (
    snapshot.logisticsStatus === null &&
    snapshot.trackingNumber === null &&
    snapshot.carrierName === null &&
    snapshot.description === null
  ) {
    return null;
  }
  return snapshot;
}

function buildAllowedActions(order: Record<string, unknown>): Record<string, unknown> {
  const status = pickString(order, ['order_status', 'status']) ?? '';
  return {
    can_send_chat: true,
    can_accept_cancellation: status === 'IN_CANCEL',
    can_confirm_return: status === 'TO_RETURN',
    order_status: status,
  };
}

/**
 * Maps `v2.order.get_order_detail` (+ optional tracking) into the normalized
 * order snapshot consumed by the ticket/order cache.
 */
export function buildOrderContext(input: {
  order: Record<string, unknown>;
  tracking?: ShopeeTrackingSnapshot | null;
  fallbackOrderId: string;
}): ShopeeOrderContext {
  const { order, tracking, fallbackOrderId } = input;
  const packages = pickArray(order, ['package_list', 'package_list_v2'])
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  const items = pickArray(order, ['item_list', 'items'])
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map(buildOrderItemSnapshot);

  const firstPackage = packages.length > 0 ? packages[0] : null;
  const externalOrderId =
    pickString(order, ['order_sn', 'orderSn']) ?? fallbackOrderId;
  const carrierName =
    tracking?.carrierName ??
    normalizeCarrierName(
      pickString(firstPackage, ['shipping_carrier', 'logistics_channel_name', 'logistics_channel']),
    );

  const snapshot: NormalizedOrderSnapshot = {
    externalOrderId,
    packId:
      pickString(firstPackage, ['package_number', 'package_id']) ??
      pickString(order, ['package_number']),
    buyerExternalId: pickString(order, ['buyer_user_id', 'buyer_id', 'user_id']),
    buyerNameOrNick: pickString(order, ['buyer_username', 'buyer_name']),
    buyerAnonymizedEmail: null,
    orderStatus: pickString(order, ['order_status', 'status']) ?? 'UNKNOWN',
    fulfillmentType: resolveFulfillmentType(packages, carrierName),
    totalAmount: pickNumber(order, ['total_amount', 'total_amount_before_discount']) ?? 0,
    currency: pickString(order, ['currency']) ?? 'BRL',
    trackingNumber:
      tracking?.trackingNumber ??
      pickString(firstPackage, ['tracking_number', 'tracking_no']) ??
      null,
    carrierName,
    items,
    allowedActions: buildAllowedActions(order),
    shipping: {
      packages: packages.map((pkg) => ({
        package_number: pickString(pkg, ['package_number', 'package_id']),
        logistics_status: pickString(pkg, ['logistics_status']),
        logistics_channel_id: pickString(pkg, ['logistics_channel_id', 'logistics_channel']),
        shipping_carrier: pickString(pkg, ['shipping_carrier']),
        tracking_number: pickString(pkg, ['tracking_number', 'tracking_no']),
      })),
      tracking: tracking?.raw ?? null,
      // NOTE: `recipient_address` is buyer PII and is deliberately never persisted.
    },
    estimatedDeliveryAt: toDate(pickNumber(order, ['estimated_delivery_time'])),
    shippedAt: toDate(pickNumber(order, ['pickup_done_time', 'shipped_time', 'ship_time'])),
    deliveredAt: toDate(pickNumber(order, ['delivered_time', 'delivery_time'])),
  };

  return { order: snapshot, tracking: tracking ?? null, rawOrder: order, items };
}

/* ==========================================================================
 * Human readable system-message bodies (PT-BR, no PII)
 * ========================================================================== */

const ORDER_STATUS_LABELS: Record<string, string> = {
  UNPAID: 'aguardando pagamento',
  READY_TO_SHIP: 'pronto para envio',
  PROCESSED: 'em processamento',
  RETRY_SHIP: 'reprocessando envio',
  SHIPPED: 'enviado',
  TO_CONFIRM_RECEIVE: 'aguardando confirmação de recebimento',
  IN_CANCEL: 'cancelamento solicitado pelo comprador',
  CANCELLED: 'cancelado',
  TO_RETURN: 'em devolução',
  COMPLETED: 'concluído',
  INVOICE_PENDING: 'nota fiscal pendente',
};

const LOGISTICS_STATUS_LABELS: Record<string, string> = {
  LOGISTICS_NOT_STARTED: 'logística não iniciada',
  LOGISTICS_REQUEST_CREATED: 'solicitação logística criada',
  LOGISTICS_PICKUP_DONE: 'objeto coletado',
  LOGISTICS_PICKUP_FAILED: 'falha na coleta',
  LOGISTICS_DELIVERY_DONE: 'entregue',
  LOGISTICS_DELIVERY_FAILED: 'falha na entrega',
  LOGISTICS_PENDING_ARRANGE: 'aguardando postagem',
  LOGISTICS_IN_TRANSIT: 'em trânsito',
};

export function describeOrderStatus(status: string | null): string {
  if (!status) return 'status desconhecido';
  return ORDER_STATUS_LABELS[status] ?? status;
}

export function describeLogisticsStatus(status: string | null): string {
  if (!status) return 'status desconhecido';
  return LOGISTICS_STATUS_LABELS[status] ?? status;
}

export function truncateForPreview(text: string, limit = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

/** Ticket priority helper for system events (kept pure for tests). */
export function systemEventPriority(ticketType: TicketType): TicketPriority {
  return priorityForTicketType(ticketType);
}
