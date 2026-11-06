import { describe, expect, it } from 'vitest';
import type { HydratedInboundMessage } from '@sac/shared';
import { MercadoLivreChannelAdapter } from '../MercadoLivreChannelAdapter';
import { createFakeDeps, jsonResponse, type FakeHttpHandler } from './fakeDeps';

const MESSAGE_HASH = '3f6da1e35ac84f70a24af7360d24c7bc';

const claimFixture = {
  id: '777',
  resource: 'order',
  resource_id: 2002,
  status: 'opened',
  stage: 'claim',
  type: 'mediations',
  due_date: '2026-02-08T18:00:00.000Z',
  players: [
    { role: 'complainant', user_id: 999, available_actions: [{ action: 'send_message' }] },
    {
      role: 'respondent',
      user_id: 42,
      available_actions: [{ action: 'send_message_to_complainant' }, { action: 'refund' }],
    },
  ],
};

const orderFixture = {
  id: 2002,
  pack_id: 2001,
  status: 'paid',
  total_amount: 49.9,
  currency_id: 'BRL',
  buyer: { id: 999, nickname: 'COMPRADOR' },
  order_items: [
    { item: { id: 'MLB1', title: 'Camiseta', seller_sku: 'SKU1' }, quantity: 1, unit_price: 49.9 },
  ],
  shipping: { id: 'SHIP1' },
  tags: ['fulfillment'],
};

const shipmentFixture = {
  id: 'SHIP1',
  order_id: 2002,
  status: 'shipped',
  tracking_number: 'TRK1',
  tracking_method: 'Meli',
  logistic_type: 'fulfillment',
};

const handler: FakeHttpHandler = (request) => {
  const url = request.url;
  if (url.endsWith('/oauth/token')) {
    return jsonResponse({ access_token: 'AT-1', refresh_token: 'RT2', expires_in: 21_600 });
  }
  if (url.endsWith(`/messages/${MESSAGE_HASH}`)) {
    return jsonResponse({
      message_id: MESSAGE_HASH,
      message_resources: [{ id: '2001', name: 'packs' }],
      resource: 'orders',
      resource_id: '2002',
    });
  }
  if (url.endsWith('/messages/packs/2001/sellers/42')) {
    return jsonResponse({
      conversation_status: { status: 'active', path: '/packs/2001/sellers/42' },
      messages: [
        {
          id: 'm1',
          text: 'Chegou errado',
          from: { user_id: 999 },
          message_date: { created: '2026-02-02T10:00:00.000Z' },
        },
      ],
    });
  }
  if (url.endsWith('/orders/2002')) return jsonResponse(orderFixture);
  if (url.endsWith('/shipments/SHIP1')) return jsonResponse(shipmentFixture);
  if (url.endsWith('/post-purchase/v1/claims/777/messages')) {
    return jsonResponse([
      {
        sender_role: 'complainant',
        receiver_role: 'respondent',
        message: 'Quero devolver',
        date_created: '2026-02-04T10:00:00.000Z',
      },
    ]);
  }
  if (url.endsWith('/post-purchase/v1/claims/777')) return jsonResponse(claimFixture);
  throw new Error(`unexpected ${request.method} ${url}`);
};

function envelopeFor(
  verification: Awaited<ReturnType<MercadoLivreChannelAdapter['verifyInbound']>>,
): Parameters<MercadoLivreChannelAdapter['hydrate']>[0] {
  return {
    marketplace: 'MERCADO_LIVRE',
    accountId: 'acc-1',
    payload: verification.payload,
    topic: verification.topic,
    resource: verification.resource,
    receivedAt: new Date('2026-02-05T12:00:00.000Z'),
  };
}

describe('Meli notification conformance', () => {
  it('resolves a messages hash resource through GET /messages/{resource}', async () => {
    const fake = createFakeDeps({ httpHandler: handler });
    const adapter = new MercadoLivreChannelAdapter(fake.deps);
    const rawBody = Buffer.from(
      JSON.stringify({
        id: '5e2827f2-99b7-474e-b68b-6a86e934cc7e',
        resource: MESSAGE_HASH,
        user_id: 42,
        topic: 'messages',
        actions: ['created'],
        application_id: 987,
        attempts: 1,
        sent: '2026-02-05T11:00:00.000Z',
        received: '2026-02-05T11:00:00.000Z',
      }),
    );

    const verification = await adapter.verifyInbound({
      method: 'POST',
      url: 'http://localhost/webhooks/meli',
      headers: {},
      query: { secret: 'test-webhook-secret' },
      rawBody,
      receivedAt: new Date('2026-02-05T12:00:00.000Z'),
    });

    expect(verification.valid).toBe(true);
    expect(verification.reason).toBe('MELI_NO_SIGNATURE');
    expect(verification.eventId).toBe('5e2827f2-99b7-474e-b68b-6a86e934cc7e');
    expect(verification.topic).toBe('messages');
    expect(verification.resource).toBe(MESSAGE_HASH);

    const hydrated: HydratedInboundMessage[] = await adapter.hydrate(envelopeFor(verification));

    expect(fake.httpCalls.some((call) => call.url.endsWith(`/messages/${MESSAGE_HASH}`))).toBe(true);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].externalReferenceId).toBe('2001');
    expect(hydrated[0].externalOrderId).toBe('2002');
    expect(hydrated[0].externalMessageId).toBe('m1');
    expect(hydrated[0].direction).toBe('INBOUND_BUYER');
    expect(hydrated[0].channelMetadata.pack_id).toBe('2001');

    const packCall = fake.httpCalls.find((call) => call.url.includes('/messages/packs/2001/sellers/42'));
    expect(packCall?.query).toMatchObject({ tag: 'post_sale', mark_as_read: false });
  });

  it('hydrates a post_purchase notification whose resource carries the full claims path', async () => {
    const fake = createFakeDeps({ httpHandler: handler });
    const adapter = new MercadoLivreChannelAdapter(fake.deps);
    const rawBody = Buffer.from(
      JSON.stringify({
        id: '9e2b4a11-1111-2222-3333-444455556666',
        resource: 'post-purchase/v1/claims/777',
        user_id: 42,
        topic: 'post_purchase',
        actions: ['claims_actions'],
        attempts: 1,
        sent: '2026-02-05T11:00:00.000Z',
        received: '2026-02-05T11:00:00.000Z',
      }),
    );

    const verification = await adapter.verifyInbound({
      method: 'POST',
      url: 'http://localhost/webhooks/meli',
      headers: {},
      query: { secret: 'test-webhook-secret' },
      rawBody,
      receivedAt: new Date('2026-02-05T12:00:00.000Z'),
    });

    const hydrated = await adapter.hydrate(envelopeFor(verification));

    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].ticketType).toBe('CLAIM_DISPUTE');
    expect(hydrated[0].externalReferenceId).toBe('777');
    expect(hydrated[0].claimId).toBe('777');
    expect(hydrated[0].externalOrderId).toBe('2002');
    expect(hydrated[0].hasActiveClaim).toBe(true);
    expect(hydrated[0].direction).toBe('INBOUND_BUYER');
    expect(hydrated[0].externalMessageId).toBe('claim:777:2026-02-04T10:00:00.000Z:complainant');
    expect(hydrated[0].bodyCleanText).toBe('Quero devolver');
    expect(hydrated[0].slaDeadlineAt?.toISOString()).toBe('2026-02-08T18:00:00.000Z');
    const actions = hydrated[0].channelMetadata.available_actions as Array<{ action: string }>;
    expect(actions.map((action) => action.action)).toEqual([
      'send_message_to_complainant',
      'refund',
    ]);
  });
});

describe('meli missed feeds recovery', () => {
  function missedFeedsHandler(feeds: unknown[]): FakeHttpHandler {
    return (request) => {
      if (request.url.endsWith('/oauth/token')) {
        return jsonResponse({ access_token: 'AT-1', refresh_token: 'RT2', expires_in: 21_600 });
      }
      if (request.url.endsWith('/missed_feeds')) return jsonResponse(feeds);
      throw new Error(`unexpected ${request.method} ${request.url}`);
    };
  }

  const feed = {
    _id: 'miss-1',
    resource: MESSAGE_HASH,
    user_id: 42,
    topic: 'messages',
    actions: ['created'],
    attempts: 8,
    sent: '2026-02-05T10:00:00.000Z',
    received: '2026-02-05T10:00:00.000Z',
  };

  it('publishes missed feeds to queue.inbound.meli and advances the cursor', async () => {
    const fake = createFakeDeps({ httpHandler: missedFeedsHandler([feed]) });
    const adapter = new MercadoLivreChannelAdapter(fake.deps);

    const results = await adapter.runMaintenance();
    const recovery = results.find((entry) => entry.task === 'meli.missed_feed.recover');

    expect(recovery?.ok).toBe(true);
    expect(recovery?.detail).toContain('1 notificação(ões)');
    expect(fake.queueCalls).toHaveLength(1);
    expect(fake.queueCalls[0].queue).toBe('queue.inbound.meli');
    expect(fake.queueCalls[0].payload).toMatchObject({
      marketplace: 'MERCADO_LIVRE',
      accountId: 'acc-1',
      topic: 'messages',
      resource: MESSAGE_HASH,
      eventId: 'miss-1',
    });

    const missedCall = fake.httpCalls.find((call) => call.url.endsWith('/missed_feeds'));
    expect(missedCall?.query).toMatchObject({ app_id: 'app-1234' });

    const cursorRaw = fake.cacheStore.get('sac:meli:missed:cursor');
    expect(typeof cursorRaw).toBe('string');
    expect(String(cursorRaw)).toContain('miss-1');

    // Second maintenance run must be idempotent (cursor + _id dedupe).
    const second = await adapter.runMaintenance();
    const secondRecovery = second.find((entry) => entry.task === 'meli.missed_feed.recover');
    expect(secondRecovery?.detail).toContain('0 notificação(ões)');
    expect(fake.queueCalls).toHaveLength(1);
  });
});
