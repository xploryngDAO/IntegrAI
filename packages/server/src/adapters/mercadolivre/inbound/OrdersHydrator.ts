import type {
  AdapterDependencies,
  HydratedInboundMessage,
  ILogger,
  MarketplaceAccountRecord,
  NormalizedOrderSnapshot,
} from '@sac/shared';
import type { MeliClient } from '../client/MeliClient';
import {
  asString,
  errorMessage,
  extractResourceSegment,
  parseDate,
  truncateText,
} from '../mappers';
import type { MeliOrder, MeliShipment } from '../types';
import { fetchOrderWithShipment, findActiveTicketForOrder, upsertOrderCache } from './common';

/**
 * `orders` / `shipments` pushes never create tickets: they refresh
 * `orders_cache` and, when a ticket already exists, append a system message for
 * a shipment status change.
 */
export class OrdersHydrator {
  private readonly logger: ILogger;

  constructor(
    private readonly deps: AdapterDependencies,
    private readonly client: MeliClient,
  ) {
    this.logger = deps.logger.child({ adapter: 'mercadolivre', component: 'orders' });
  }

  async hydrateOrders(
    account: MarketplaceAccountRecord,
    resource: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const orderId =
      extractResourceSegment(resource, 'orders') ??
      asString(payload.order_id) ??
      asString(payload.orderId) ??
      asString(payload.resource_id);
    if (!orderId) {
      this.logger.warn('meli.orders.unresolved_resource', { accountId: account.id, resource });
      return;
    }
    const fetched = await fetchOrderWithShipment(this.client, account.id, orderId);
    if (!fetched) {
      this.logger.warn('meli.orders.refresh_failed', { accountId: account.id, orderId });
      return;
    }
    await upsertOrderCache(this.deps, this.logger, account.id, fetched.snapshot);
  }

  async hydrateShipments(
    account: MarketplaceAccountRecord,
    resource: string | null,
    payload: Record<string, unknown>,
  ): Promise<HydratedInboundMessage[]> {
    const shipmentId =
      extractResourceSegment(resource, 'shipments') ??
      asString(payload.shipment_id) ??
      asString(payload.shipmentId) ??
      asString(payload.resource_id);
    if (!shipmentId) {
      this.logger.warn('meli.shipments.unresolved_resource', { accountId: account.id, resource });
      return [];
    }

    let shipment: MeliShipment;
    try {
      shipment = await this.client.get<MeliShipment>(account.id, `/shipments/${shipmentId}`);
    } catch (error) {
      this.logger.warn('meli.shipments.refresh_failed', {
        accountId: account.id,
        shipmentId,
        error: errorMessage(error),
      });
      return [];
    }

    const orderId =
      asString(shipment.order_id) ??
      asString(payload.order_id) ??
      asString(payload.orderId) ??
      asString(payload.resource_id);
    if (!orderId) {
      this.logger.warn('meli.shipments.order_unresolved', { accountId: account.id, shipmentId });
      return [];
    }

    let snapshot: NormalizedOrderSnapshot | null = null;
    let order: MeliOrder | null = null;
    const fetched = await fetchOrderWithShipment(this.client, account.id, orderId, {
      knownShipment: shipment,
    });
    if (fetched) {
      order = fetched.order;
      snapshot = fetched.snapshot;
      await upsertOrderCache(this.deps, this.logger, account.id, snapshot);
    } else {
      this.logger.warn('meli.shipments.order_snapshot_failed', {
        accountId: account.id,
        orderId,
        shipmentId,
      });
    }

    const ticket = await findActiveTicketForOrder(this.deps, orderId);
    if (!ticket) return [];

    const shipmentStatus = asString(shipment.status) ?? 'unknown';
    const trackingNumber = asString(shipment.tracking_number);
    const trackingMethod = asString(shipment.tracking_method);
    const updatedAt = parseDate(shipment.last_updated) ?? this.deps.clock.now();
    const messageKey = `shipment:${shipmentId}:${shipmentStatus}:${updatedAt.getTime()}`;

    const message: HydratedInboundMessage = {
      accountId: account.id,
      marketplace: 'MERCADO_LIVRE',
      externalReferenceId: ticket.externalReferenceId,
      ticketType: ticket.ticketType,
      externalOrderId: orderId,
      packId: ticket.packId ?? snapshot?.packId ?? null,
      claimId: ticket.claimId,
      conversationId: ticket.conversationId,
      returnSn: null,
      externalMessageId: messageKey,
      direction: 'OUTBOUND_SYSTEM',
      channelRouteUsed: 'MELI_MESSAGES_API',
      messageType: 'action_system',
      bodyCleanText: truncateText(
        `Atualização de envio ${shipmentId}: ${shipmentStatus}${
          trackingNumber ? ` — rastreio ${trackingNumber}` : ''
        }`,
      ),
      contentPayload: {
        shipment_id: shipmentId,
        shipment_status: shipmentStatus,
        shipment_substatus: asString(shipment.substatus),
        tracking_number: trackingNumber,
        tracking_method: trackingMethod,
        order_status: snapshot?.orderStatus ?? null,
        order_status_detail: order ? asString(order.status_detail) : null,
      },
      marketplaceCreatedAt: updatedAt,
      deliveryStatus: 'DELIVERED',
      buyer: {
        externalId: snapshot?.buyerExternalId ?? ticket.buyerExternalId,
        displayName: snapshot?.buyerNameOrNick ?? ticket.buyerDisplayName,
        anonymizedEmail: null,
      },
      order: snapshot,
      attachments: [],
      channelMetadata: {
        shipment_id: shipmentId,
        shipment_status: shipmentStatus,
        shipment_substatus: asString(shipment.substatus),
        tracking_number: trackingNumber,
        tracking_method: trackingMethod,
        logistic_type: asString(shipment.logistic_type),
      },
      hasActiveClaim: ticket.hasActiveClaim,
      isSystemEvent: true,
      warnings: snapshot ? undefined : ['MELI_ORDER_SNAPSHOT_UNAVAILABLE'],
    };

    this.logger.info('meli.shipments.hydrated', {
      accountId: account.id,
      shipmentId,
      orderId,
      status: shipmentStatus,
    });
    return [message];
  }
}
