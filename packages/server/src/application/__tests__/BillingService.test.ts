import { describe, expect, it } from 'vitest';

import { BillingService } from '../BillingService';
import { FrozenClock, silentLogger } from './accountFakes';
import { signedBillingDelivery, InMemoryBillingEventRepository } from './billingFakes';
import {
  InMemoryPlatformTenantRepository,
  InMemoryTenantRepository,
} from './platformFakes';

/**
 * Fase 4 - provider-agnostic billing gateway.
 *
 * Covers the HTTP-visible contract that lives in the service: HMAC signature,
 * `BILLING_NOT_CONFIGURED` (503), tenant validation, the subscription state
 * machine, externalId idempotency (including retry of a FAILED attempt) and the
 * checkout URL renderer. No payment provider is called anywhere.
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');
const SECRET = 'billing-test-secret';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const SUCCESS_URL = 'https://app.integrai.test/billing/success';
const CANCEL_URL = 'https://app.integrai.test/billing/cancel';

function createHarness(overrides: { withSecret?: boolean; withTemplate?: boolean } = {}) {
  const clock = new FrozenClock(NOW);
  const tenants = new InMemoryTenantRepository(() => clock.now());
  const platformTenants = new InMemoryPlatformTenantRepository(tenants, () => clock.now());
  const billingEvents = new InMemoryBillingEventRepository(() => clock.now());

  const service = new BillingService({
    logger: silentLogger,
    clock,
    billing: {
      ...(overrides.withSecret === false ? {} : { webhookSecret: SECRET }),
      ...(overrides.withTemplate === false
        ? {}
        : {
            checkoutUrlTemplate:
              'https://pay.example.test/checkout?tenant={tenantId}&slug={slug}&plan={plan}&email={email}&success={successUrl}&cancel={cancelUrl}',
          }),
      successUrl: SUCCESS_URL,
      cancelUrl: CANCEL_URL,
    },
    repos: { tenants, platformTenants, billingEvents },
  });

  return { clock, tenants, platformTenants, billingEvents, service };
}

function seedTenant(
  h: ReturnType<typeof createHarness>,
  overrides: Parameters<InMemoryTenantRepository['seed']>[0] = {},
) {
  return h.tenants.seed({
    id: TENANT_ID,
    slug: 'acme',
    name: 'Acme',
    billingEmail: 'finance@acme.test',
    ...overrides,
  });
}

describe('BillingService.handleWebhook - configuration and authenticity', () => {
  it('answers 503 BILLING_NOT_CONFIGURED when BILLING_WEBHOOK_SECRET is absent', async () => {
    const h = createHarness({ withSecret: false });
    seedTenant(h);

    const delivery = signedBillingDelivery(
      { type: 'subscription.activated', tenantId: TENANT_ID },
      SECRET,
    );

    await expect(
      h.service.handleWebhook({ rawBody: delivery.rawBody, signature: delivery.signature, body: delivery.body }),
    ).rejects.toMatchObject({
      code: 'BILLING_NOT_CONFIGURED',
      httpStatus: 503,
      details: { missing: ['BILLING_WEBHOOK_SECRET'] },
    });
    expect(h.billingEvents.rows).toHaveLength(0);
  });

  it('answers 401 INVALID_SIGNATURE for a wrong HMAC', async () => {
    const h = createHarness();
    seedTenant(h);

    const delivery = signedBillingDelivery(
      { type: 'subscription.activated', tenantId: TENANT_ID },
      SECRET,
    );

    await expect(
      h.service.handleWebhook({
        rawBody: delivery.rawBody,
        signature: 'f'.repeat(64),
        body: delivery.body,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE', httpStatus: 401 });
    expect(h.tenants.rows[0].billingStatus).toBe('TRIALING');
    expect(h.billingEvents.rows).toHaveLength(0);
  });

  it('answers 401 when the signature header is missing or malformed', async () => {
    const h = createHarness();
    seedTenant(h);
    const delivery = signedBillingDelivery(
      { type: 'subscription.activated', tenantId: TENANT_ID },
      SECRET,
    );

    for (const signature of [null, undefined, '', 'not-hex', 'sha256=zzz']) {
      await expect(
        h.service.handleWebhook({
          rawBody: delivery.rawBody,
          signature,
          body: delivery.body,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE', httpStatus: 401 });
    }
  });

  it('accepts the GitHub-style `sha256=<hex>` signature form', async () => {
    const h = createHarness();
    seedTenant(h);
    const delivery = signedBillingDelivery(
      { type: 'subscription.activated', tenantId: TENANT_ID },
      SECRET,
    );

    const result = await h.service.handleWebhook({
      rawBody: delivery.rawBody,
      signature: `sha256=${delivery.signature}`,
      body: delivery.body,
    });

    expect(result.billingStatus).toBe('ACTIVE');
  });

  it('rejects a body that was modified after signing', async () => {
    const h = createHarness();
    seedTenant(h);
    const delivery = signedBillingDelivery(
      { type: 'subscription.activated', tenantId: TENANT_ID },
      SECRET,
    );

    await expect(
      h.service.handleWebhook({
        rawBody: Buffer.from('{"type":"subscription.canceled","tenantId":"' + TENANT_ID + '"}'),
        signature: delivery.signature,
        body: { type: 'subscription.canceled', tenantId: TENANT_ID },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE', httpStatus: 401 });
  });
});

describe('BillingService.handleWebhook - subscription state machine', () => {
  it('TRIALING -> ACTIVE on subscription.activated', async () => {
    const h = createHarness();
    seedTenant(h);

    const delivery = signedBillingDelivery(
      {
        type: 'subscription.activated',
        tenantId: TENANT_ID,
        plan: 'PRO',
        amountBrl: 299,
        externalId: 'evt-1',
      },
      SECRET,
    );
    const result = await h.service.handleWebhook({
      rawBody: delivery.rawBody,
      signature: delivery.signature,
      body: delivery.body,
    });

    expect(result).toMatchObject({
      type: 'subscription.activated',
      tenantId: TENANT_ID,
      duplicate: false,
      previousBillingStatus: 'TRIALING',
      billingStatus: 'ACTIVE',
      eventId: 'billing:evt-1',
    });
    expect(h.tenants.rows[0]).toMatchObject({
      billingStatus: 'ACTIVE',
      plan: 'PRO',
      maxAccounts: 10,
      maxAgents: 25,
    });

    const event = h.billingEvents.rows[0];
    expect(event).toMatchObject({
      eventId: 'billing:evt-1',
      type: 'subscription.activated',
      tenantId: TENANT_ID,
      status: 'PROCESSED',
    });
    expect(event.payload).toMatchObject({ amountBrl: 299, plan: 'PRO', externalId: 'evt-1' });
    expect(event.processedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('TRIALING -> ACTIVE on payment.succeeded', async () => {
    const h = createHarness();
    seedTenant(h, { billingStatus: 'TRIALING' });

    const delivery = signedBillingDelivery(
      { type: 'payment.succeeded', tenantId: TENANT_ID, externalId: 'pay-trial-1' },
      SECRET,
    );
    const result = await h.service.handleWebhook({
      rawBody: delivery.rawBody,
      signature: delivery.signature,
      body: delivery.body,
    });

    expect(result.previousBillingStatus).toBe('TRIALING');
    expect(result.billingStatus).toBe('ACTIVE');
  });

  it('PAST_DUE -> ACTIVE on payment.succeeded', async () => {
    const h = createHarness();
    seedTenant(h, { billingStatus: 'PAST_DUE' });

    const delivery = signedBillingDelivery(
      { type: 'payment.succeeded', tenantId: TENANT_ID, externalId: 'pay-1' },
      SECRET,
    );
    const result = await h.service.handleWebhook({
      rawBody: delivery.rawBody,
      signature: delivery.signature,
      body: delivery.body,
    });

    expect(result.previousBillingStatus).toBe('PAST_DUE');
    expect(result.billingStatus).toBe('ACTIVE');
    expect(h.tenants.rows[0].billingStatus).toBe('ACTIVE');
  });

  it('ACTIVE/TRIALING -> PAST_DUE on payment.failed', async () => {
    const h = createHarness();
    seedTenant(h, { billingStatus: 'ACTIVE' });

    const delivery = signedBillingDelivery(
      { type: 'payment.failed', tenantId: TENANT_ID, amountBrl: 299, externalId: 'pay-2' },
      SECRET,
    );

    const result = await h.service.handleWebhook({
      rawBody: delivery.rawBody,
      signature: delivery.signature,
      body: delivery.body,
    });

    expect(result.billingStatus).toBe('PAST_DUE');
    expect(h.tenants.rows[0].billingStatus).toBe('PAST_DUE');
  });

  it('never revives a CANCELED subscription with a late payment.failed', async () => {
    const h = createHarness();
    seedTenant(h, { billingStatus: 'CANCELED' });

    const delivery = signedBillingDelivery(
      { type: 'payment.failed', tenantId: TENANT_ID, externalId: 'pay-3' },
      SECRET,
    );
    const result = await h.service.handleWebhook({
      rawBody: delivery.rawBody,
      signature: delivery.signature,
      body: delivery.body,
    });

    expect(result.billingStatus).toBe('CANCELED');
    expect(h.tenants.rows[0].billingStatus).toBe('CANCELED');
  });

  it('ACTIVE -> CANCELED on subscription.canceled', async () => {
    const h = createHarness();
    seedTenant(h, { billingStatus: 'ACTIVE' });

    const delivery = signedBillingDelivery(
      { type: 'subscription.canceled', tenantId: TENANT_ID, externalId: 'cancel-1' },
      SECRET,
    );
    const result = await h.service.handleWebhook({
      rawBody: delivery.rawBody,
      signature: delivery.signature,
      body: delivery.body,
    });

    expect(result.billingStatus).toBe('CANCELED');
    expect(h.tenants.rows[0].billingStatus).toBe('CANCELED');
  });

  it('subscription.updated keeps the status but moves plan and quotas', async () => {
    const h = createHarness();
    seedTenant(h, { plan: 'FREE', billingStatus: 'TRIALING', maxAccounts: 1, maxAgents: 3 });

    const delivery = signedBillingDelivery(
      {
        type: 'subscription.updated',
        tenantId: TENANT_ID,
        plan: 'ENTERPRISE',
        currentPeriodEnd: '2026-12-05T00:00:00.000Z',
        externalId: 'upd-1',
      },
      SECRET,
    );
    const result = await h.service.handleWebhook({
      rawBody: delivery.rawBody,
      signature: delivery.signature,
      body: delivery.body,
    });

    expect(result.billingStatus).toBe('TRIALING');
    expect(result.currentPeriodEnd).toBe('2026-12-05T00:00:00.000Z');
    expect(h.tenants.rows[0]).toMatchObject({
      plan: 'ENTERPRISE',
      billingStatus: 'TRIALING',
      maxAccounts: 1_000_000,
      maxAgents: 1_000_000,
    });
  });

  it('keeps custom quotas when the plan does not change', async () => {
    const h = createHarness();
    seedTenant(h, { plan: 'PRO', billingStatus: 'ACTIVE', maxAccounts: 42, maxAgents: 99 });

    const delivery = signedBillingDelivery(
      { type: 'subscription.updated', tenantId: TENANT_ID, plan: 'PRO', externalId: 'upd-2' },
      SECRET,
    );
    await h.service.handleWebhook({
      rawBody: delivery.rawBody,
      signature: delivery.signature,
      body: delivery.body,
    });

    expect(h.tenants.rows[0]).toMatchObject({ maxAccounts: 42, maxAgents: 99 });
  });

  it('resolves the workspace by slug when tenantId is absent', async () => {
    const h = createHarness();
    seedTenant(h);

    const delivery = signedBillingDelivery(
      { type: 'subscription.canceled', tenantSlug: 'acme', externalId: 'slug-1' },
      SECRET,
    );
    const result = await h.service.handleWebhook({
      rawBody: delivery.rawBody,
      signature: delivery.signature,
      body: delivery.body,
    });

    expect(result.tenantId).toBe(TENANT_ID);
    expect(h.tenants.rows[0].billingStatus).toBe('CANCELED');
  });
});

describe('BillingService.handleWebhook - tenant validation', () => {
  it('answers 404 for an unknown workspace', async () => {
    const h = createHarness();
    const delivery = signedBillingDelivery(
      { type: 'subscription.activated', tenantId: OTHER_TENANT_ID, externalId: 'unknown-1' },
      SECRET,
    );

    await expect(
      h.service.handleWebhook({
        rawBody: delivery.rawBody,
        signature: delivery.signature,
        body: delivery.body,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    expect(h.billingEvents.rows).toHaveLength(0);
  });

  it('answers 409 TENANT_INACTIVE for a suspended/deleted workspace', async () => {
    const h = createHarness();
    seedTenant(h, { status: 'SUSPENDED' });
    const delivery = signedBillingDelivery(
      { type: 'payment.succeeded', tenantId: TENANT_ID, externalId: 'susp-1' },
      SECRET,
    );

    await expect(
      h.service.handleWebhook({
        rawBody: delivery.rawBody,
        signature: delivery.signature,
        body: delivery.body,
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
      details: { code: 'TENANT_INACTIVE', status: 'SUSPENDED' },
    });
    expect(h.billingEvents.rows).toHaveLength(0);
  });

  it('rejects an unknown event type / missing tenant / bad tenantId with 422', async () => {
    const h = createHarness();
    seedTenant(h);

    for (const payload of [
      { type: 'invoice.paid', tenantId: TENANT_ID },
      { type: 'subscription.activated' },
      { type: 'subscription.activated', tenantId: 'not-a-uuid' },
      { type: 'subscription.activated', tenantId: TENANT_ID, plan: 'PLATINUM' },
      { type: 'subscription.activated', tenantId: TENANT_ID, amountBrl: -1 },
      { type: 'subscription.activated', tenantId: TENANT_ID, currentPeriodEnd: 'not-a-date' },
    ]) {
      const delivery = signedBillingDelivery(payload, SECRET);
      await expect(
        h.service.handleWebhook({
          rawBody: delivery.rawBody,
          signature: delivery.signature,
          body: delivery.body,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
    }
    expect(h.billingEvents.rows).toHaveLength(0);
  });

  it('rejects a tenantId/tenantSlug pair that points to different workspaces', async () => {
    const h = createHarness();
    seedTenant(h);
    seedTenant(h, { id: OTHER_TENANT_ID, slug: 'other' });

    const delivery = signedBillingDelivery(
      { type: 'subscription.activated', tenantId: TENANT_ID, tenantSlug: 'other' },
      SECRET,
    );

    await expect(
      h.service.handleWebhook({
        rawBody: delivery.rawBody,
        signature: delivery.signature,
        body: delivery.body,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
  });
});

describe('BillingService.handleWebhook - idempotency', () => {
  it('answers DUPLICATE (200) for a replayed externalId and does not re-apply', async () => {
    const h = createHarness();
    seedTenant(h);

    const activated = signedBillingDelivery(
      { type: 'subscription.activated', tenantId: TENANT_ID, externalId: 'idem-1' },
      SECRET,
    );
    await h.service.handleWebhook({
      rawBody: activated.rawBody,
      signature: activated.signature,
      body: activated.body,
    });

    // A different event reusing the same externalId (gateway retry) must not
    // revert the subscription to TRIALING or cancel it.
    const canceled = signedBillingDelivery(
      { type: 'subscription.canceled', tenantId: TENANT_ID, externalId: 'idem-1' },
      SECRET,
    );
    const duplicate = await h.service.handleWebhook({
      rawBody: canceled.rawBody,
      signature: canceled.signature,
      body: canceled.body,
    });

    expect(duplicate).toMatchObject({
      duplicate: true,
      tenantId: TENANT_ID,
      billingStatus: 'ACTIVE',
      eventId: 'billing:idem-1',
    });
    expect(h.tenants.rows[0].billingStatus).toBe('ACTIVE');
    expect(h.billingEvents.rows).toHaveLength(1);
  });

  it('processes events without externalId (no idempotency key)', async () => {
    const h = createHarness();
    seedTenant(h);

    for (const type of ['payment.succeeded', 'payment.failed'] as const) {
      const delivery = signedBillingDelivery({ type, tenantId: TENANT_ID }, SECRET);
      const result = await h.service.handleWebhook({
        rawBody: delivery.rawBody,
        signature: delivery.signature,
        body: delivery.body,
      });
      expect(result.duplicate).toBe(false);
    }

    expect(h.billingEvents.rows).toHaveLength(2);
    expect(h.tenants.rows[0].billingStatus).toBe('PAST_DUE');
  });

  it('refuses to reuse an externalId that belongs to another workspace', async () => {
    const h = createHarness();
    seedTenant(h);
    seedTenant(h, { id: OTHER_TENANT_ID, slug: 'other' });
    h.billingEvents.seed({
      eventId: 'billing:shared-1',
      tenantId: TENANT_ID,
      type: 'subscription.activated',
      status: 'PROCESSED',
    });

    const delivery = signedBillingDelivery(
      { type: 'subscription.canceled', tenantId: OTHER_TENANT_ID, externalId: 'shared-1' },
      SECRET,
    );

    await expect(
      h.service.handleWebhook({
        rawBody: delivery.rawBody,
        signature: delivery.signature,
        body: delivery.body,
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
      details: { code: 'BILLING_EVENT_TENANT_MISMATCH' },
    });
    expect(
      h.tenants.rows.find((row) => row.id === OTHER_TENANT_ID)?.billingStatus,
    ).toBe('TRIALING');
  });

  it('retries a previously FAILED event instead of treating it as duplicate', async () => {
    const h = createHarness();
    seedTenant(h);
    h.billingEvents.seed({
      eventId: 'billing:retry-1',
      tenantId: TENANT_ID,
      type: 'payment.succeeded',
      status: 'FAILED',
      error: 'INTERNAL_ERROR',
    });

    const delivery = signedBillingDelivery(
      { type: 'payment.succeeded', tenantId: TENANT_ID, externalId: 'retry-1' },
      SECRET,
    );
    const result = await h.service.handleWebhook({
      rawBody: delivery.rawBody,
      signature: delivery.signature,
      body: delivery.body,
    });

    expect(result.duplicate).toBe(false);
    expect(h.tenants.rows[0].billingStatus).toBe('ACTIVE');
    expect(h.billingEvents.rows[0]).toMatchObject({ status: 'PROCESSED', error: null });
  });
});

describe('BillingService.checkout', () => {
  it('renders every placeholder from the tenant + env, URL-encoded', async () => {
    const h = createHarness();
    seedTenant(h, { plan: 'PRO', billingEmail: 'finance@acme.test' });

    const { checkoutUrl } = await h.service.checkout(TENANT_ID);

    expect(checkoutUrl).toBe(
      'https://pay.example.test/checkout' +
        `?tenant=${TENANT_ID}` +
        '&slug=acme' +
        '&plan=PRO' +
        '&email=finance%40acme.test' +
        `&success=${encodeURIComponent(SUCCESS_URL)}` +
        `&cancel=${encodeURIComponent(CANCEL_URL)}`,
    );
  });

  it('answers 503 BILLING_NOT_CONFIGURED when the template is absent', async () => {
    const h = createHarness({ withTemplate: false });
    seedTenant(h);

    await expect(h.service.checkout(TENANT_ID)).rejects.toMatchObject({
      code: 'BILLING_NOT_CONFIGURED',
      httpStatus: 503,
      details: { missing: ['BILLING_CHECKOUT_URL_TEMPLATE'] },
    });
  });

  it('answers 503 when the rendered template is not an absolute URL', async () => {
    const h = createHarness();
    seedTenant(h);
    const broken = new BillingService({
      logger: silentLogger,
      clock: h.clock,
      billing: { checkoutUrlTemplate: 'not-a-url/{tenantId}' },
      repos: {
        tenants: h.tenants,
        platformTenants: h.platformTenants,
        billingEvents: h.billingEvents,
      },
    });

    await expect(broken.checkout(TENANT_ID)).rejects.toMatchObject({
      code: 'BILLING_NOT_CONFIGURED',
      httpStatus: 503,
    });
  });

  it('answers 404 for an unknown workspace and 409 for a deleted one', async () => {
    const h = createHarness();

    await expect(h.service.checkout(TENANT_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });

    seedTenant(h, {
      status: 'DELETED',
      deletedAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    await expect(h.service.checkout(TENANT_ID)).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
      details: { code: 'TENANT_DELETED' },
    });
  });

  it('sends nothing to a provider (pure template rendering)', async () => {
    const h = createHarness();
    seedTenant(h);

    await h.service.checkout(TENANT_ID);

    // The only side effect is the console log; no repository row is created.
    expect(h.billingEvents.rows).toHaveLength(0);
    expect(h.tenants.rows[0].billingStatus).toBe('TRIALING');
  });
});

describe('BillingService.listEvents', () => {
  it('returns the newest billing events, with the workspace slug', async () => {
    const h = createHarness();
    seedTenant(h);
    h.billingEvents.slugFor = (tenantId) => (tenantId === TENANT_ID ? 'acme' : null);

    const older = h.billingEvents.seed({
      eventId: 'billing:old',
      tenantId: TENANT_ID,
      type: 'subscription.activated',
      status: 'PROCESSED',
      receivedAt: new Date('2026-11-01T10:00:00.000Z'),
    });
    const newer = h.billingEvents.seed({
      eventId: 'billing:new',
      tenantId: TENANT_ID,
      type: 'payment.failed',
      status: 'FAILED',
      receivedAt: new Date('2026-11-05T10:00:00.000Z'),
    });

    const result = await h.service.listEvents(1);

    expect(result.limit).toBe(1);
    expect(result.items).toEqual([
      {
        id: newer.id,
        type: 'payment.failed',
        tenantId: TENANT_ID,
        tenantSlug: 'acme',
        status: 'FAILED',
        receivedAt: '2026-11-05T10:00:00.000Z',
      },
    ]);
    expect(result.items.some((item) => item.id === older.id)).toBe(false);
  });

  it('defaults to 50 and clamps the limit to 1..100', async () => {
    const h = createHarness();

    expect((await h.service.listEvents()).limit).toBe(50);
    expect((await h.service.listEvents(0)).limit).toBe(1);
    expect((await h.service.listEvents(500)).limit).toBe(100);
  });
});
