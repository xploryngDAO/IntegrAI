import type { OrderCacheRecord, OrderItemSnapshot, OrderView } from '@sac/shared';

import { asRecord, iso } from './common';

export function toOrderView(order: OrderCacheRecord): OrderView {
  const items: OrderItemSnapshot[] = Array.isArray(order.itemsSnapshot) ? order.itemsSnapshot : [];

  return {
    externalOrderId: order.externalOrderId,
    packId: order.packId,
    orderStatus: order.orderStatus,
    fulfillmentType: order.fulfillmentType,
    totalAmount: typeof order.totalAmount === 'number' ? order.totalAmount : Number(order.totalAmount ?? 0),
    currency: order.currency ?? 'BRL',
    trackingNumber: order.trackingNumber,
    carrierName: order.carrierName,
    items,
    allowedActions: asRecord(order.allowedActionsCache),
    shipping: asRecord(order.shippingSnapshot),
    estimatedDeliveryAt: iso(order.estimatedDeliveryAt),
    shippedAt: iso(order.shippedAt),
    deliveredAt: iso(order.deliveredAt),
    lastSyncedAt: order.lastSyncedAt.toISOString(),
  };
}
