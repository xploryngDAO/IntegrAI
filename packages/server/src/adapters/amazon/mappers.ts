import type {
  BuyerPiiSnapshot,
  NormalizedOrderSnapshot,
  OrderItemSnapshot,
  UpsertOrderInput,
} from '@sac/shared';
import { asRecord, normalizeDomain, readDate, readNumber, readString, readStringArray, sha256Hex, uniqueStrings } from './guards';
import { normalizeEmailAddress } from './inbound/EmailThreading';
import { readAllowedActionNames } from './outbound/routeDecision';
import type {
  AmazonAccountSettings,
  AmazonOrderItemJson,
  AmazonOrderJson,
  JsonRecord,
} from './types';

/**
 * Mapping helpers shared by the inbound parser and the order enrichment service:
 * account channel_config -> typed settings, SP-API orders -> normalized snapshot,
 * restricted order -> PII vault payload, storage key builders.
 */

export function parseChannelSettings(raw: JsonRecord): AmazonAccountSettings {
  const rawRoutes = [
    ...readStringArray(raw.inbound_email_route),
    ...readStringArray(raw.inbound_email_routes),
    ...readStringArray(raw.inbound_email_aliases),
  ];
  const inboundEmailRoutes = uniqueStrings(
    rawRoutes
      .map((route) => {
        const email = normalizeEmailAddress(route);
        if (email) return email;
        return normalizeDomain(route);
      })
      .filter((route): route is string => route !== null),
  );

  const approvedSenderDomains = uniqueStrings(
    [
      ...readStringArray(raw.approved_sender_domains),
      ...readStringArray(raw.approved_sender_domain),
      ...readStringArray(raw.sender_domains),
    ]
      .map((domain) => normalizeDomain(domain))
      .filter((domain): domain is string => domain !== null),
  );

  return {
    inboundEmailRoutes,
    smtpSenderEmail: normalizeEmailAddress(readString(raw.smtp_sender_email)),
    approvedSenderDomains,
    sellerCentralRegion: readString(raw.seller_central_region),
    allowedActionsCache: readAllowedActionNames(raw.allowed_actions_cache),
  };
}

/**
 * `IObjectStorage` accepts keys; callers sometimes hand us a full `s3://bucket/key`
 * URI. Normalize both to the key form used by `putObject`/`getObject`.
 */
export function keyFromUri(value: string): string {
  const match = /^s3:\/\/[^/]+\/(.+)$/i.exec(value);
  if (match && match[1]) return match[1];
  return value.replace(/^\/+/, '');
}

export function safePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function safeFileName(value: string, fallback: string): string {
  const base = value.split(/[\\/]/).pop() ?? '';
  return safePathSegment(base, fallback);
}

function dateSegments(at: Date): { year: string; month: string; day: string } {
  const iso = Number.isNaN(at.getTime()) ? new Date(0).toISOString() : at.toISOString();
  return { year: iso.slice(0, 4), month: iso.slice(5, 7), day: iso.slice(8, 10) };
}

/** `amazon/inbound/YYYY/MM/DD/<messageId>.eml` (immutable raw artifact). */
export function buildEmlStorageKey(at: Date, messageId: string): string {
  const { year, month, day } = dateSegments(at);
  const segment = safePathSegment(messageId, sha256Hex(messageId).slice(0, 16));
  return `amazon/inbound/${year}/${month}/${day}/${segment}.eml`;
}

/** `amazon/inbound/YYYY/MM/DD/attachments/<messageId>/<idx>-<file>` */
export function buildInboundAttachmentKey(
  at: Date,
  messageId: string,
  fileName: string,
  index: number,
): string {
  const { year, month, day } = dateSegments(at);
  const messageSegment = safePathSegment(messageId, sha256Hex(messageId).slice(0, 16));
  const fileNameSegment = safeFileName(fileName, `anexo-${index}`);
  return `amazon/inbound/${year}/${month}/${day}/attachments/${messageSegment}/${index}-${fileNameSegment}`;
}

/** AFN (Amazon fulfilled) -> FBA, MFN (merchant fulfilled) -> FBM. */
export function mapFulfillmentType(channel: string | null): string | null {
  if (!channel) return null;
  const normalized = channel.trim().toUpperCase();
  if (normalized === 'AFN' || normalized === 'FBA' || normalized === 'AMAZON') return 'FBA';
  if (normalized === 'MFN' || normalized === 'FBM' || normalized === 'SELLER') return 'FBM';
  return channel.trim();
}

function mapOrderItems(items: readonly AmazonOrderItemJson[]): OrderItemSnapshot[] {
  return items.map((item) => ({
    sku: readString(item.SellerSKU),
    asin: readString(item.ASIN),
    itemId: readString(item.OrderItemId),
    title: readString(item.Title) ?? 'Item',
    quantity: readNumber(item.QuantityOrdered) ?? 1,
    unitPrice: readNumber(item.ItemPrice?.Amount) ?? 0,
    imageUrl: null,
    variation: null,
  }));
}

/**
 * Builds the non-restricted order snapshot. Buyer name/address/phone are NOT
 * copied here: they live only in `buyer_pii_vault` (RDT-gated, 30-day purge).
 */
export function toOrderSnapshot(
  order: AmazonOrderJson,
  items: readonly AmazonOrderItemJson[],
  allowedActions: readonly string[],
  buyerAnonymizedEmail: string | null,
  restricted: AmazonOrderJson | null,
  fallbackOrderId: string,
): NormalizedOrderSnapshot {
  const externalOrderId = readString(order.AmazonOrderId) ?? fallbackOrderId;
  const fulfillmentChannel = readString(order.FulfillmentChannel);
  const shippingAddress = asRecord(restricted?.ShippingAddress ?? order.ShippingAddress);
  const fulfillment = asRecord(order.Fulfillment);
  const shipping: Record<string, unknown> = {
    fulfillmentChannel,
    shipServiceLevel: readString(order.ShipServiceLevel),
    shipmentServiceLevelCategory: readString(order.ShipmentServiceLevelCategory),
    orderType: readString(order.OrderType),
    shipmentServiceLevel:
      readString(order.ShipServiceLevel) ?? readString(order.ShipmentServiceLevelCategory),
    addressOnFile: Object.keys(shippingAddress).length > 0,
  };
  return {
    externalOrderId,
    packId: null,
    buyerExternalId: null,
    buyerNameOrNick: null,
    buyerAnonymizedEmail,
    orderStatus: readString(order.OrderStatus) ?? 'UNKNOWN',
    fulfillmentType: mapFulfillmentType(fulfillmentChannel),
    totalAmount: readNumber(order.OrderTotal?.Amount) ?? 0,
    currency: readString(order.OrderTotal?.CurrencyCode) ?? 'BRL',
    trackingNumber:
      readString(order.TrackingNumber) ??
      readString(order.ShipmentTrackingNumber) ??
      readString(fulfillment.TrackingNumber) ??
      null,
    carrierName: readString(order.CarrierName) ?? readString(fulfillment.CarrierName) ?? null,
    items: mapOrderItems(items),
    allowedActions: { actions: [...allowedActions] },
    shipping,
    estimatedDeliveryAt:
      readDate(order.LatestDeliveryDate) ?? readDate(order.EarliestDeliveryDate) ?? null,
    shippedAt: readDate(order.ShipDate) ?? readDate(fulfillment.ShipDate) ?? null,
    deliveredAt: readDate(order.DeliveryDate) ?? readDate(order.ActualDeliveryDate) ?? null,
  };
}

function readTaxDocument(buyerInfo: JsonRecord): string | null {
  const taxInfo = asRecord(buyerInfo.BuyerTaxInfo);
  const classifications = Array.isArray(taxInfo.TaxClassifications) ? taxInfo.TaxClassifications : [];
  for (const entry of classifications) {
    const record = asRecord(entry);
    const classification = (readString(record.ClassificationName) ?? '').toUpperCase();
    const value = readString(record.ClassificationValue);
    if (!value) continue;
    if (classification.includes('CPF') || classification.includes('CNPJ') || classification.includes('TAX')) {
      return value;
    }
  }
  return null;
}

/**
 * Maps the RDT-protected order read into the volatile PII snapshot. Returns
 * `null` when Amazon did not return any restricted member.
 */
export function toBuyerPii(
  restricted: AmazonOrderJson | null,
  buyerAnonymizedEmail: string | null,
): BuyerPiiSnapshot | null {
  if (!restricted) return null;
  const buyerInfo = asRecord(restricted.BuyerInfo);
  const shipping = asRecord(restricted.ShippingAddress);
  const name = readString(buyerInfo.BuyerName) ?? readString(shipping.Name);
  const email = readString(buyerInfo.BuyerEmail) ?? buyerAnonymizedEmail;
  const phone = readString(shipping.Phone);
  const document = readTaxDocument(buyerInfo);
  const hasShippingAddress = Object.keys(shipping).length > 0;
  if (!name && !email && !phone && !document && !hasShippingAddress) return null;
  return {
    name: name ?? null,
    email: email ?? null,
    document,
    phone: phone ?? null,
    shippingAddress: hasShippingAddress ? shipping : null,
    sourceEndpoints: ['GET /orders/v0/orders/{orderId} (RDT: buyerInfo, shippingAddress)'],
  };
}

export function toUpsertOrderInput(
  accountId: string,
  order: NormalizedOrderSnapshot,
): UpsertOrderInput {
  return {
    accountId,
    marketplace: 'AMAZON',
    externalOrderId: order.externalOrderId,
    packId: order.packId ?? null,
    buyerExternalId: order.buyerExternalId ?? null,
    buyerNameOrNick: order.buyerNameOrNick ?? null,
    buyerAnonymizedEmail: order.buyerAnonymizedEmail ?? null,
    orderStatus: order.orderStatus,
    fulfillmentType: order.fulfillmentType ?? null,
    totalAmount: order.totalAmount,
    currency: order.currency,
    trackingNumber: order.trackingNumber ?? null,
    carrierName: order.carrierName ?? null,
    itemsSnapshot: order.items,
    allowedActionsCache: order.allowedActions,
    shippingSnapshot: order.shipping,
    estimatedDeliveryAt: order.estimatedDeliveryAt ?? null,
    shippedAt: order.shippedAt ?? null,
    deliveredAt: order.deliveredAt ?? null,
  };
}

export function readStringCandidate(
  candidates: readonly unknown[],
): string | null {
  for (const candidate of candidates) {
    const value = readString(candidate);
    if (value) return value;
  }
  return null;
}
