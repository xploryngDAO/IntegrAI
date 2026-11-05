import {
  type AdapterDependencies,
  type ILogger,
  type NormalizedOrderSnapshot,
  type SupportTicketRecord,
} from '@sac/shared';
import type { MeliClient } from '../client/MeliClient';
import { asString, buildOrderSnapshot, errorMessage } from '../mappers';
import type { MeliOrder, MeliShipment } from '../types';

export interface FetchedOrder {
  order: MeliOrder;
  shipment: MeliShipment | null;
  snapshot: NormalizedOrderSnapshot;
}

/**
 * Fetches `/orders/{id}` plus `/shipments/{shipping_id}` (when present) and maps
 * them to the normalized snapshot the core persists in `orders_cache`.
 *
 * Returns `null` when the order cannot be read: order enrichment is optional for
 * an inbound message and must never discard the message itself.
 */
export async function fetchOrderWithShipment(
  client: MeliClient,
  accountId: string,
  externalOrderId: string,
  options: { knownShipment?: MeliShipment | null } = {},
): Promise<FetchedOrder | null> {
  try {
    const order = await client.get<MeliOrder>(accountId, `/orders/${externalOrderId}`);
    let shipment: MeliShipment | null = options.knownShipment ?? null;
    const shippingId = asString(order.shipping?.id) ?? asString(order.shipping_id);
    if (shippingId && options.knownShipment === undefined) {
      try {
        shipment = await client.get<MeliShipment>(accountId, `/shipments/${shippingId}`);
      } catch {
        shipment = null;
      }
    }
    return {
      order,
      shipment,
      snapshot: buildOrderSnapshot(externalOrderId, order, shipment),
    };
  } catch {
    return null;
  }
}

/** Upserts `orders_cache`; failures are logged, never fatal. */
export async function upsertOrderCache(
  deps: AdapterDependencies,
  logger: ILogger,
  accountId: string,
  snapshot: NormalizedOrderSnapshot,
): Promise<void> {
  try {
    await deps.repos.orders.upsert({
      accountId,
      marketplace: 'MERCADO_LIVRE',
      externalOrderId: snapshot.externalOrderId,
      packId: snapshot.packId,
      buyerExternalId: snapshot.buyerExternalId,
      buyerNameOrNick: snapshot.buyerNameOrNick,
      buyerAnonymizedEmail: snapshot.buyerAnonymizedEmail,
      orderStatus: snapshot.orderStatus,
      fulfillmentType: snapshot.fulfillmentType,
      totalAmount: snapshot.totalAmount,
      currency: snapshot.currency,
      trackingNumber: snapshot.trackingNumber,
      carrierName: snapshot.carrierName,
      itemsSnapshot: snapshot.items,
      allowedActionsCache: snapshot.allowedActions,
      shippingSnapshot: snapshot.shipping,
      estimatedDeliveryAt: snapshot.estimatedDeliveryAt,
      shippedAt: snapshot.shippedAt,
      deliveredAt: snapshot.deliveredAt,
    });
  } catch (error) {
    logger.warn('meli.orders.cache_upsert_failed', {
      accountId,
      externalOrderId: snapshot.externalOrderId,
      error: errorMessage(error),
    });
  }
}

export async function findActiveTicketForOrder(
  deps: AdapterDependencies,
  externalOrderId: string | null,
): Promise<SupportTicketRecord | null> {
  if (!externalOrderId) return null;
  return deps.repos.tickets.findActiveByExternalOrderId('MERCADO_LIVRE', externalOrderId);
}
