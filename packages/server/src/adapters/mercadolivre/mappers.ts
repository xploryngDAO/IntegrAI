/**
 * Pure mapping / narrowing helpers for the Mercado Livre adapter.
 *
 * Nothing in this module performs I/O: it is shared by the inbound hydrators,
 * the outbound sender and the unit tests, and it is the only place that reads
 * untrusted marketplace JSON.
 */

import type {
  InboundAttachmentDescriptor,
  MessageDirection,
  NormalizedOrderSnapshot,
  OrderItemSnapshot,
} from '@sac/shared';
import type {
  MeliActionGuide,
  MeliActionGuideOption,
  MeliClaim,
  MeliClaimAvailableAction,
  MeliClaimPlayer,
  MeliFileAttachment,
  MeliItem,
  MeliMessageResourceRef,
  MeliOrder,
  MeliOrderItemDetail,
  MeliQuestion,
  MeliShipment,
  MeliShipmentStatusHistoryEntry,
} from './types';

/* ------------------------------ Narrowing --------------------------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? value : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function parseDate(value: unknown): Date | null {
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Human readable detail extracted from a marketplace error payload. */
export function describeHttpFailure(body: unknown): string {
  if (isRecord(body)) {
    const message =
      asString(body.message) ??
      asString(body.error_description) ??
      asString(body.error) ??
      asString(body.cause);
    if (message) return message;
    try {
      return JSON.stringify(body).slice(0, 500);
    } catch {
      return 'payload não serializável';
    }
  }
  if (typeof body === 'string') return body.slice(0, 500);
  return 'resposta sem detalhes';
}

/**
 * Defensive JSON parse of a raw webhook body. Mercado Livre pushes are JSON but
 * the raw bytes are what we must trust, so malformed bodies never throw here.
 */
export function parseJsonBody(rawBody: Buffer | null | undefined): Record<string, unknown> | null {
  if (!rawBody || rawBody.length === 0) return null;
  const text = rawBody.toString('utf8').trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* ------------------------------- Resources -------------------------------- */

/** Extracts the id following a path segment, e.g. `/questions/123` -> `123`. */
export function extractResourceSegment(resource: string | null | undefined, segment: string): string | null {
  if (!resource) return null;
  const clean = resource.split('?')[0]?.split('#')[0] ?? '';
  const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|/)${escaped}/([^/]+)`).exec(clean);
  const value = match?.[1];
  return value && value !== 'packs' ? value : null;
}

export function extractPackIdFromMessageResources(
  resources: MeliMessageResourceRef[] | null | undefined,
): string | null {
  const pack = asArray<MeliMessageResourceRef>(resources).find(
    (entry) => (asString(entry.name) ?? '').toLowerCase() === 'packs',
  );
  return asString(pack?.id);
}

/** Removes the `tag=` query and trailing slash so ids can be compared. */
export function normalizeResource(resource: string | null | undefined): string | null {
  if (!resource) return null;
  return resource.split('?')[0]?.split('#')[0]?.replace(/\/+$/, '') ?? null;
}

/**
 * Tolerant claim id extraction. Official `post_purchase` notifications now send
 * `resource: "post-purchase/v1/claims/{id}"` (with or without leading slash, and
 * with or without the legacy `/claims/` prefix), so a segment regex alone is not
 * enough.
 */
export function extractClaimIdFromResource(resource: string | null | undefined): string | null {
  if (!resource) return null;
  const clean = resource.split('?')[0]?.split('#')[0] ?? '';
  const fromPath = /(?:^|\/)claims\/(\d+)/.exec(clean);
  if (fromPath?.[1]) return fromPath[1];
  const fromPostPurchase = /post-purchase\/v1\/claims\/(\d+)/i.exec(clean);
  if (fromPostPurchase?.[1]) return fromPostPurchase[1];
  const numeric = /^\d+$/.test(clean) ? clean : null;
  return numeric;
}

/**
 * `messages` notifications send an opaque hash as `resource` (no path). A value
 * that is not a known resource path/URI must be resolved with
 * `GET /messages/{resource}`.
 */
export function isOpaqueMessageResource(resource: string | null | undefined): boolean {
  if (!resource) return true;
  const clean = resource.split('?')[0]?.split('#')[0] ?? '';
  return !clean.includes('/') && !/^\d+$/.test(clean) && clean.length > 0;
}

/* ------------------------------- Questions -------------------------------- */

export function isQuestionAnswered(question: MeliQuestion): boolean {
  return (asString(question.status) ?? '').toUpperCase() === 'ANSWERED';
}

export function questionItemSnapshot(item: MeliItem | null, fallbackItemId: string | null): Record<string, unknown> | null {
  if (!item) return null;
  return {
    id: asString(item.id) ?? fallbackItemId,
    title: asString(item.title),
    price: asNumber(item.price),
    permalink: asString(item.permalink),
    thumbnail: asString(item.thumbnail),
  };
}

/* --------------------------------- Claims --------------------------------- */

export function findClaimPlayer(claim: MeliClaim, role: MeliClaimPlayer['role']): MeliClaimPlayer | null {
  const wanted = (role ?? '').toLowerCase();
  return (
    asArray<MeliClaimPlayer>(claim.players).find(
      (player) => (asString(player.role) ?? '').toLowerCase() === wanted,
    ) ?? null
  );
}

/** `available_actions` of the seller (`respondent`) in a claim. */
export function extractRespondentActions(claim: MeliClaim): MeliClaimAvailableAction[] {
  const respondent = findClaimPlayer(claim, 'respondent');
  return asArray<MeliClaimAvailableAction>(respondent?.available_actions);
}

export function extractAvailableActionNames(actions: MeliClaimAvailableAction[]): string[] {
  return actions
    .map((entry) => asString(entry.action))
    .filter((action): action is string => action !== null);
}

export function isSendMessageAction(actionName: string): boolean {
  const normalized = actionName.toLowerCase();
  return (
    normalized === 'send_message' ||
    normalized.includes('send_message') ||
    normalized.includes('send-message') ||
    normalized.includes('send_message_to') ||
    normalized === 'respond'
  );
}

export function extractClaimOrderId(claim: MeliClaim): string | null {
  const direct = asString(claim.resource_id) ?? asString(claim.order_id);
  if (direct) return direct;
  const resource = asString(claim.resource);
  return resource && /^\d+$/.test(resource) ? resource : null;
}

export function claimHasMediator(claim: MeliClaim): boolean {
  return findClaimPlayer(claim, 'mediator') !== null;
}

/** Serializable projection of the claim players used in `channel_metadata`. */
export function claimPlayersMetadata(claim: MeliClaim): Array<Record<string, unknown>> {
  return asArray<MeliClaimPlayer>(claim.players).map((player) => ({
    role: asString(player.role),
    user_id: asString(player.user_id),
    available_actions: asArray<MeliClaimAvailableAction>(player.available_actions).map((action) => ({
      action: asString(action.action),
      due_date: asString(action.due_date),
      status: asString(action.status),
    })),
  }));
}

/**
 * Normalizes the official action guide (`GET /messages/action_guide/packs/{id}
 * ?tag=post_sale`). Options are keyed by `id` (e.g. `OTHER`,
 * `REQUEST_BILLING_INFO`) and carry `internal_description`, `type`, templates and
 * `cap_available`; the composer needs `option_id` + description to send
 * `POST .../option`.
 */
export function normalizeActionGuide(guide: MeliActionGuide | null): Record<string, unknown> | null {
  if (!guide) return null;
  const options = asArray<MeliActionGuideOption>(guide.options).map((option) => ({
    option_id: asString(option.id) ?? asString(option.option_id),
    description:
      asString(option.internal_description) ??
      asString(option.description) ??
      asString(option.title) ??
      asString(option.text),
    type: asString(option.type),
    enabled: option.enabled ?? null,
    actionable: option.actionable ?? null,
    char_limit: asNumber(option.char_limit),
    cap_available: asNumber(option.cap_available),
    templates: asArray<{ id?: string | null; vars?: unknown }>(option.templates),
    child_options: option.child_options ?? null,
  }));
  return {
    blocked: true,
    pack_id: asString(guide.pack_id),
    options,
  };
}

/* ------------------------------- Messages --------------------------------- */

export function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    const plain = asString(value.plain);
    if (plain) return plain;
    const text = asString(value.text);
    if (text) return text;
  }
  return '';
}

export function truncateText(value: string, limit = 200_000): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

export function normalizeAttachments(
  files: MeliFileAttachment[] | null | undefined,
): InboundAttachmentDescriptor[] {
  return asArray<MeliFileAttachment>(files).map((file) => ({
    fileName: asString(file.filename) ?? asString(file.original_filename) ?? 'anexo',
    mimeType: asString(file.type) ?? 'application/octet-stream',
    sizeBytes: asNumber(file.size) ?? 0,
    sourceUrl: asString(file.url),
    externalUploadId: asString(file.id),
  }));
}

/**
 * Direction of a pack message. The seller is checked first so a seller reply is
 * never misclassified when the buyer snapshot is unavailable; an unknown sender
 * (neither buyer nor seller) is a mediator.
 */
export function directionFromUserIds(
  fromUserId: string | null,
  buyerId: string | null,
  sellerId: string | null,
): MessageDirection {
  if (fromUserId && sellerId && fromUserId === sellerId) return 'EXTERNAL_SELLER_PANEL';
  if (buyerId) return fromUserId === buyerId ? 'INBOUND_BUYER' : 'MEDIATOR';
  return 'INBOUND_BUYER';
}

export function directionFromClaimUserIds(
  fromUserId: string | null,
  complainantId: string | null,
  respondentId: string | null,
  mediatorId: string | null,
): MessageDirection {
  if (fromUserId && mediatorId && fromUserId === mediatorId) return 'MEDIATOR';
  if (fromUserId && respondentId && fromUserId === respondentId) return 'EXTERNAL_SELLER_PANEL';
  if (fromUserId && complainantId && fromUserId === complainantId) return 'INBOUND_BUYER';
  return 'MEDIATOR';
}

/**
 * Claim message direction from the official `sender_role` field (claim messages
 * expose roles, not user ids): complainant = buyer, respondent = seller panel.
 */
export function directionFromClaimSenderRole(senderRole: string | null): MessageDirection | null {
  switch ((senderRole ?? '').toLowerCase()) {
    case 'complainant':
      return 'INBOUND_BUYER';
    case 'respondent':
      return 'EXTERNAL_SELLER_PANEL';
    case 'mediator':
      return 'MEDIATOR';
    default:
      return null;
  }
}

/** Claim messages use `message`; older payloads used `text`. */
export function extractClaimMessageText(message: { message?: unknown; text?: unknown }): string {
  return extractText(message.message) || extractText(message.text);
}

/**
 * Idempotency key for a claim message. Official claim messages have no `id`, so
 * fall back to the authoritative date plus sender role (stable across replays).
 */
export function claimMessageExternalId(
  claimId: string,
  message: { id?: unknown; message_id?: unknown; sender_role?: unknown; date_created?: unknown; date?: unknown; message_date?: unknown },
  index: number,
): string {
  const directId = asString(message.id) ?? asString(message.message_id);
  if (directId) return `claim:${claimId}:${directId}`;
  const role = asString(message.sender_role) ?? 'unknown';
  const date =
    asString(message.date_created) ??
    asString(message.date) ??
    asString(message.message_date) ??
    `idx-${index}`;
  return `claim:${claimId}:${date}:${role}`.slice(0, 400);
}

/* --------------------------------- Orders --------------------------------- */

export function deriveFulfillmentType(
  tags: string[] | null | undefined,
  logisticType?: string | null,
): string | null {
  const normalizedTags = (tags ?? []).map((tag) => tag.toLowerCase());
  const logistic = (logisticType ?? '').toLowerCase();
  if (normalizedTags.includes('not_delivered')) return 'NOT_DELIVERED';
  if (normalizedTags.includes('fulfillment') || logistic === 'fulfillment') return 'FULL';
  if (normalizedTags.includes('self_service') || logistic === 'self_service') return 'FLEX';
  if (normalizedTags.includes('cross_docking') || logistic === 'cross_docking') return 'CROSS_DOCKING';
  if (normalizedTags.includes('drop_off') || logistic === 'drop_off') return 'DROP_OFF';
  return logisticType ?? null;
}

function orderItems(order: MeliOrder): OrderItemSnapshot[] {
  return asArray<MeliOrderItemDetail>(order.order_items).map((entry) => {
    const item = entry.item ?? {};
    const itemId = asString(item.id);
    return {
      itemId,
      mlb: itemId,
      sku: asString(item.seller_sku),
      title: asString(item.title) ?? 'Item Mercado Livre',
      quantity: asNumber(entry.quantity) ?? 1,
      unitPrice: asNumber(entry.unit_price) ?? asNumber(entry.full_unit_price) ?? 0,
      imageUrl: asString(item.thumbnail),
      variation: null,
    };
  });
}

function orderTotal(order: MeliOrder, items: OrderItemSnapshot[]): number {
  const total = asNumber(order.total_amount) ?? asNumber(order.paid_amount);
  if (total !== null) return total;
  return items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
}

function shippingIdOf(order: MeliOrder): string | null {
  return asString(order.shipping?.id) ?? asString(order.shipping_id);
}

function shipmentHistoryDate(shipment: MeliShipment | null, statuses: string[]): Date | null {
  const history = asArray<MeliShipmentStatusHistoryEntry>(shipment?.status_history);
  const wanted = statuses.map((status) => status.toLowerCase());
  for (const entry of history) {
    const status = (asString(entry.status) ?? '').toLowerCase();
    if (wanted.includes(status)) return parseDate(entry.date);
  }
  return null;
}

function shippedAtOf(shipment: MeliShipment | null): Date | null {
  return shipmentHistoryDate(shipment, ['shipped', 'ready_to_ship', 'dispatched', 'in_transit']);
}

function deliveredAtOf(shipment: MeliShipment | null): Date | null {
  const fromHistory = shipmentHistoryDate(shipment, ['delivered']);
  if (fromHistory) return fromHistory;
  const status = (asString(shipment?.status) ?? '').toLowerCase();
  return status === 'delivered' ? parseDate(shipment?.last_updated) : null;
}

export function buildOrderSnapshot(
  externalOrderId: string,
  order: MeliOrder,
  shipment: MeliShipment | null,
  extraAllowedActions: Record<string, unknown> = {},
): NormalizedOrderSnapshot {
  const items = orderItems(order);
  const buyer = order.buyer ?? null;
  const fullName = [asString(buyer?.first_name), asString(buyer?.last_name)]
    .filter((part): part is string => part !== null)
    .join(' ')
    .trim();
  const shippingId = shippingIdOf(order);
  const shipmentTags = asArray<string>(shipment?.tags);
  const tags = [...asArray<string>(order.tags), ...shipmentTags];
  const estimatedDeliveryAt = parseDate(shipment?.shipping_option?.estimated_delivery_time?.date);

  return {
    externalOrderId,
    packId: asString(order.pack_id),
    buyerExternalId: asString(buyer?.id),
    buyerNameOrNick: asString(buyer?.nickname) ?? (fullName.length > 0 ? fullName : null),
    buyerAnonymizedEmail: null,
    orderStatus: asString(order.status) ?? 'unknown',
    fulfillmentType: deriveFulfillmentType(
      tags,
      asString(shipment?.logistic_type),
    ),
    totalAmount: orderTotal(order, items),
    currency: asString(order.currency_id) ?? 'BRL',
    trackingNumber: asString(shipment?.tracking_number),
    carrierName: asString(shipment?.tracking_method) ?? asString(shipment?.carrier?.name),
    items,
    allowedActions: {
      tags,
      shipping_id: shippingId,
      seller_id: asString(order.seller?.user_id),
      order_status_detail: asString(order.status_detail),
      ...extraAllowedActions,
    },
    shipping: {
      id: shippingId,
      status: asString(shipment?.status),
      substatus: asString(shipment?.substatus),
      tracking_number: asString(shipment?.tracking_number),
      tracking_method: asString(shipment?.tracking_method),
      logistic_type: asString(shipment?.logistic_type),
      carrier: asString(shipment?.carrier?.name),
      shipping_option: asString(shipment?.shipping_option?.name),
      estimated_delivery_at: estimatedDeliveryAt ? estimatedDeliveryAt.toISOString() : null,
    },
    estimatedDeliveryAt,
    shippedAt: shippedAtOf(shipment),
    deliveredAt: deliveredAtOf(shipment),
  };
}

/** Id extracted from any marketplace write response. */
export function extractResponseId(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const direct = asString(body.message_id) ?? asString(body.id) ?? asString(body.messageId);
  if (direct) return direct;
  for (const entry of asArray<unknown>(body.messages)) {
    if (isRecord(entry)) {
      const nested = asString(entry.id) ?? asString(entry.message_id);
      if (nested) return nested;
    }
  }
  return null;
}
