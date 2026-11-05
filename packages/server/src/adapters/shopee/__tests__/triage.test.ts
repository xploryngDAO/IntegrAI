import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUEUE_BY_MARKETPLACE,
  SHOPEE_COMMERCIAL_QUEUE,
  SHOPEE_SPECIALIZED_QUEUE,
} from '@sac/shared';
import {
  buildOrderContext,
  buildTrackingSnapshot,
  mapChatTriage,
  normalizeEventId,
  parseShopeePushBody,
  resolvePushHandler,
  triageShopeePush,
} from '../mappers';

/**
 * The triage matrix from `CHANNEL_CONTRACTS.md` is the heart of the Shopee
 * adapter (queue/priority/SLA routing). It is pure, so it is locked here without
 * any network, cache or database dependency.
 */
describe('triage matrix', () => {
  it('routes sellerchat without order_sn to PRE_SALE / COMERCIAL::Pre-Venda', () => {
    const triage = mapChatTriage({
      conversation_id: 'c-1',
      message_id: 'm-1',
      content: { text: 'Vocês têm em estoque?' },
    });

    expect(triage).toMatchObject({
      ticketType: 'PRE_SALE',
      priority: 'MEDIUM',
      queueHint: SHOPEE_COMMERCIAL_QUEUE,
      orderSn: null,
      requiresOrderEnrichment: false,
      requiresItemEnrichment: false,
      isChat: true,
      slaFatal: false,
    });
    expect(triage.queueHint).toBe('COMERCIAL::Pre-Venda');
  });

  it('requests item enrichment for pre-sale chats carrying item_id', () => {
    const triage = mapChatTriage({ conversation_id: 'c-1', item_id: 555, content: { text: 'oi' } });
    expect(triage.ticketType).toBe('PRE_SALE');
    expect(triage.requiresItemEnrichment).toBe(true);
    expect(triage.orderSn).toBeNull();
  });

  it('routes sellerchat with order_sn to POST_SALE_ORDER / N1', () => {
    const triage = mapChatTriage({
      conversation_id: 'c-2',
      order_sn: '240101ABCDEF',
      content: { text: 'Onde está meu pedido?' },
    });

    expect(triage).toMatchObject({
      ticketType: 'POST_SALE_ORDER',
      priority: 'HIGH',
      queueHint: DEFAULT_QUEUE_BY_MARKETPLACE.SHOPEE,
      orderSn: '240101ABCDEF',
      requiresOrderEnrichment: true,
      isChat: true,
    });
    expect(triage.queueHint).toBe('SAC::Shopee-N1');
  });

  it('maps buyer cancellation (code 7) to CANCELLATION / CRITICAL_SLA / N2', () => {
    const triage = triageShopeePush({ code: 7, data: { ordersn: 'SN-7', status: 'IN_CANCEL' } });
    expect(triage).toMatchObject({
      ticketType: 'CANCELLATION',
      priority: 'CRITICAL_SLA',
      queueHint: SHOPEE_SPECIALIZED_QUEUE,
      orderSn: 'SN-7',
      requiresOrderEnrichment: true,
      slaFatal: true,
      isCancellation: true,
    });
  });

  it('maps returns (code 6) to RETURN_REFUND / CRITICAL_SLA / N2', () => {
    const triage = triageShopeePush({
      code: 6,
      data: { return_sn: 'RET-1', ordersn: 'SN-6', status: 'REQUESTED' },
    });
    expect(triage).toMatchObject({
      ticketType: 'RETURN_REFUND',
      priority: 'CRITICAL_SLA',
      queueHint: SHOPEE_SPECIALIZED_QUEUE,
      orderSn: 'SN-6',
      returnSn: 'RET-1',
      requiresOrderEnrichment: true,
      slaFatal: true,
      isReturn: true,
    });
  });

  it('maps order status (2) and tracking (3) to POST_SALE_ORDER system events', () => {
    for (const code of [2, 3]) {
      const triage = triageShopeePush({ code, data: { ordersn: 'SN-STATUS' } });
      expect(triage).toMatchObject({
        ticketType: 'POST_SALE_ORDER',
        priority: 'HIGH',
        queueHint: DEFAULT_QUEUE_BY_MARKETPLACE.SHOPEE,
        orderSn: 'SN-STATUS',
        requiresOrderEnrichment: true,
      });
    }
  });

  it('returns null for pushes that do not open tickets', () => {
    expect(triageShopeePush({ code: 1, data: {} })).toBeNull();
    expect(triageShopeePush({ code: 5, data: { item_id: 1 } })).toBeNull();
    expect(triageShopeePush({ code: 10, data: {} })).toBeNull();
  });
});

describe('shape-first push dispatch', () => {
  it('routes sellerchat payloads by shape (project code 4 and official webchat code 10)', () => {
    expect(resolvePushHandler(4, { conversation_id: 1, message_id: 2 })).toBe('chat');
    expect(resolvePushHandler(10, { conversation_id: 1, message_id: 2 })).toBe('chat');
  });

  it('routes tracking payloads by shape (project code 3 and official code 4)', () => {
    expect(
      resolvePushHandler(3, { ordersn: 'SN-1', logistics_status: 'LOGISTICS_PICKUP_DONE' }),
    ).toBe('tracking');
    expect(resolvePushHandler(4, { ordersn: 'SN-1', tracking_number: 'SPX123' })).toBe('tracking');
  });

  it('routes order-status payloads by shape (project code 2 and official code 3)', () => {
    expect(resolvePushHandler(2, { ordersn: 'SN-1', status: 'SHIPPED' })).toBe('order_status');
    expect(resolvePushHandler(3, { ordersn: 'SN-1', status: 'SHIPPED' })).toBe('order_status');
  });

  it('routes IN_CANCEL to cancellation and return_sn to return', () => {
    expect(resolvePushHandler(7, { ordersn: 'SN-1', status: 'IN_CANCEL' })).toBe('cancellation');
    expect(resolvePushHandler(3, { ordersn: 'SN-1', status: 'IN_CANCEL' })).toBe('cancellation');
    expect(resolvePushHandler(6, { return_sn: 'RET-1', ordersn: 'SN-1' })).toBe('return');
  });

  it('does not create tickets for shop/item/promotion pushes', () => {
    expect(resolvePushHandler(1, { shop_id: 123 })).toBe('none');
    expect(resolvePushHandler(2, { shop_id: 123, shop_status: 'BANNED' })).toBe('none');
    expect(resolvePushHandler(5, { item_id: 1, item_name: 'x' })).toBe('none');
    expect(resolvePushHandler(6, { item_id: 1, item_name: 'banned item' })).toBe('none');
    expect(resolvePushHandler(7, { item_id: 1, promotion_id: 9 })).toBe('none');
    expect(resolvePushHandler(10, { item_id: 1 })).toBe('none');
  });

  it('keeps the project shipping-document code as cache-only', () => {
    expect(resolvePushHandler(10, { ordersn: 'SN-1' })).toBe('shipping_document');
  });
});

describe('event id (webhook idempotency)', () => {
  it('prefers data.message_id', () => {
    expect(normalizeEventId(4, { message_id: 'm-9', ordersn: 'SN' })).toBe('m-9');
  });

  it('composes code + ordersn when there is no message id', () => {
    expect(normalizeEventId(2, { ordersn: 'SN-1' })).toBe('2:SN-1');
  });

  it('composes code + return_sn for return pushes', () => {
    expect(normalizeEventId(6, { return_sn: 'RET-9' })).toBe('6:RET-9');
  });

  it('falls back to null when the payload has no identifier', () => {
    expect(normalizeEventId(2, { status: 'SHIPPED' })).toBeNull();
  });
});

describe('push parsing', () => {
  it('parses URL-encoded pushes with JSON data', () => {
    const raw =
      'code=4&shop_id=123&timestamp=1700000000&data=' +
      encodeURIComponent(JSON.stringify({ message_id: 'm-1', content: { text: 'olá' } }));

    const payload = parseShopeePushBody(raw);
    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({ code: 4, shop_id: '123', timestamp: 1_700_000_000 });
    expect(payload?.data['message_id']).toBe('m-1');
  });

  it('decodes base64-encoded data payloads (lost pushes)', () => {
    const encoded = Buffer.from(
      JSON.stringify({ ordersn: 'SN-B64', status: 'READY_TO_SHIP' }),
      'utf8',
    ).toString('base64');
    const raw = JSON.stringify({ code: 2, shop_id: 77, timestamp: 1_700_000_000, data: encoded });

    const payload = parseShopeePushBody(raw);
    expect(payload?.data['ordersn']).toBe('SN-B64');
  });

  it('returns null for malformed bodies', () => {
    expect(parseShopeePushBody('not-a-push')).toBeNull();
    expect(parseShopeePushBody('{"shop_id":1}')).toBeNull();
  });
});

describe('order snapshot', () => {
  it('maps package_list logistics channel, tracking and items', () => {
    const tracking = buildTrackingSnapshot({
      logistics_status: 'LOGISTICS_DELIVERY_DONE',
      tracking_number: 'SPX123',
      logistics_channel_name: 'Shopee Xpress',
    });

    const context = buildOrderContext({
      order: {
        order_sn: 'SN-1',
        order_status: 'SHIPPED',
        total_amount: 129.9,
        currency: 'BRL',
        buyer_user_id: 321,
        buyer_username: 'comprador',
        item_list: [
          {
            item_id: 555,
            item_name: 'Camiseta',
            model_quantity_purchased: 2,
            model_discounted_price: 64.95,
            image_url: 'https://cf.shopee.com.br/file/x',
          },
        ],
        package_list: [
          {
            package_number: 'PKG-1',
            logistics_status: 'LOGISTICS_DELIVERY_DONE',
            logistics_channel_id: 80001,
            tracking_number: 'SPX123',
          },
        ],
      },
      tracking,
      fallbackOrderId: 'SN-1',
    });

    expect(context.order.fulfillmentType).toBe('Shopee Xpress');
    expect(context.order.packId).toBe('PKG-1');
    expect(context.order.trackingNumber).toBe('SPX123');
    expect(context.order.buyerExternalId).toBe('321');
    expect(context.order.totalAmount).toBe(129.9);
    expect(context.order.items).toHaveLength(1);
    expect(context.order.items[0]).toMatchObject({
      itemId: '555',
      title: 'Camiseta',
      quantity: 2,
      unitPrice: 64.95,
    });
    // PII never crosses into the persisted shipping snapshot.
    expect(JSON.stringify(context.order.shipping)).not.toContain('recipient_address');
  });
});
