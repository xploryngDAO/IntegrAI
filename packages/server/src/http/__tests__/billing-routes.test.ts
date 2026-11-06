import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ILogger, IPlatformService } from '@sac/shared';
import { AuthorizationError } from '@sac/shared';

import type { HttpRouteContext } from '../types';
import { BillingService } from '../../application/BillingService';
import { billingRoutes } from '../routes/billing.routes';
import { platformRoutes } from '../routes/platform.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { isPublicRoute } from '../middleware/auth';
import { FrozenClock, silentLogger } from '../../application/__tests__/accountFakes';
import {
  InMemoryBillingEventRepository,
  signedBillingDelivery,
} from '../../application/__tests__/billingFakes';
import {
  InMemoryPlatformTenantRepository,
  InMemoryTenantRepository,
} from '../../application/__tests__/platformFakes';

/**
 * HTTP wiring of the Fase 4 billing gateway contract:
 *  - `POST /api/v1/billing/webhook` is public and verifies the raw-body HMAC;
 *  - `POST /api/v1/platform/tenants/:id/checkout` is platform-admin only;
 *  - `GET /api/v1/platform/billing/events` lists the audit trail.
 *
 * The app uses the SAME raw-body JSON parser as `buildHttpApp`, so the signature
 * tests prove the exact bytes reach `BillingService`.
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');
const SECRET = 'http-billing-secret';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SUCCESS_URL = 'https://app.integrai.test/billing/success';
const CANCEL_URL = 'https://app.integrai.test/billing/cancel';

describe('billing HTTP routes', () => {
  let app: FastifyInstance;
  let tenantRepository: InMemoryTenantRepository;
  let billingRepository: InMemoryBillingEventRepository;
  let requirePlatformAdmin: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const clock = new FrozenClock(NOW);
    tenantRepository = new InMemoryTenantRepository(() => clock.now());
    const platformTenants = new InMemoryPlatformTenantRepository(
      tenantRepository,
      () => clock.now(),
    );
    billingRepository = new InMemoryBillingEventRepository(() => clock.now());
    billingRepository.slugFor = (tenantId) =>
      tenantId === TENANT_ID ? 'acme' : null;

    const billing = new BillingService({
      logger: silentLogger,
      clock,
      billing: {
        webhookSecret: SECRET,
        checkoutUrlTemplate:
          'https://pay.example.test/checkout?tenant={tenantId}&slug={slug}&plan={plan}&email={email}&success={successUrl}&cancel={cancelUrl}',
        successUrl: SUCCESS_URL,
        cancelUrl: CANCEL_URL,
      },
      repos: { tenants: tenantRepository, platformTenants, billingEvents: billingRepository },
    });

    requirePlatformAdmin = vi.fn(async (actorId: string) => {
      if (actorId === 'platform-admin') return;
      throw new AuthorizationError('Platform administrator privileges are required');
    });

    const ctx = {
      services: {
        billing,
        platform: { requirePlatformAdmin } as unknown as IPlatformService,
        logger: silentLogger,
      },
      hub: {},
      options: {},
    } as unknown as HttpRouteContext;

    app = Fastify();
    // Same contract as `buildHttpApp`: exact bytes are kept for the HMAC.
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (request: FastifyRequest, body: Buffer, done) => {
        request.rawBody = body;
        if (body.length === 0) {
          done(null, null);
          return;
        }
        try {
          done(null, JSON.parse(body.toString('utf8')));
        } catch {
          done(new Error('Malformed JSON request body'), undefined);
        }
      },
    );
    registerErrorHandler(app, { logger: silentLogger, exposeDetails: true });
    // Stand-in for the global JWT guard: the header chooses the principal.
    app.addHook('preHandler', async (request) => {
      const actorId = request.headers['x-test-agent'];
      if (typeof actorId === 'string' && actorId.length > 0) {
        request.agent = {
          id: actorId,
          email: `${actorId}@acme.test`,
          name: 'Ana',
          role: 'ADMIN',
          tenantId: TENANT_ID,
          isPlatformAdmin: actorId === 'platform-admin',
        };
      }
    });

    await app.register(billingRoutes, { prefix: '/billing', ...ctx });
    await app.register(platformRoutes, { prefix: '/platform', ...ctx });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function seedTenant(overrides: Parameters<InMemoryTenantRepository['seed']>[0] = {}) {
    return tenantRepository.seed({
      id: TENANT_ID,
      slug: 'acme',
      name: 'Acme',
      billingEmail: 'finance@acme.test',
      ...overrides,
    });
  }

  async function postSigned(body: unknown, signature?: string) {
    const delivery = signedBillingDelivery(body, SECRET);
    return app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: {
        'content-type': 'application/json',
        ...(signature === undefined
          ? { 'x-billing-signature': delivery.signature }
          : { 'x-billing-signature': signature }),
      },
      payload: delivery.rawBody,
    });
  }

  it('marks only the billing webhook as public', () => {
    expect(isPublicRoute('POST', '/api/v1/billing/webhook')).toBe(true);
    expect(isPublicRoute('POST', '/api/v1/platform/tenants/11111111-1111-4111-8111-111111111111/checkout')).toBe(false);
    expect(isPublicRoute('GET', '/api/v1/platform/billing/events')).toBe(false);
  });

  it('POST /billing/webhook applies the event and answers 200 PROCESSED', async () => {
    seedTenant();

    const response = await postSigned({
      type: 'subscription.activated',
      tenantId: TENANT_ID,
      plan: 'PRO',
      amountBrl: 299,
      externalId: 'http-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'PROCESSED',
      type: 'subscription.activated',
      tenantId: TENANT_ID,
      billingStatus: 'ACTIVE',
    });
    expect(tenantRepository.rows[0]).toMatchObject({ billingStatus: 'ACTIVE', plan: 'PRO' });
  });

  it('POST /billing/webhook answers 200 DUPLICATE for a replayed externalId', async () => {
    seedTenant({ id: '33333333-3333-4333-8333-333333333333', slug: 'dup' });

    const payload = {
      type: 'subscription.canceled',
      tenantId: '33333333-3333-4333-8333-333333333333',
      externalId: 'http-dup-1',
    };
    const first = await postSigned(payload);
    const second = await postSigned(payload);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'PROCESSED', billingStatus: 'CANCELED' });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'DUPLICATE', billingStatus: 'CANCELED' });
  });

  it('POST /billing/webhook answers 401 for an invalid signature', async () => {
    seedTenant({ id: '44444444-4444-4444-8444-444444444444', slug: 'sig' });

    const response = await postSigned(
      { type: 'subscription.activated', tenantId: '44444444-4444-4444-8444-444444444444' },
      'a'.repeat(64),
    );

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });
  });

  it('POST /billing/webhook answers 401 without the signature header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'subscription.activated', tenantId: TENANT_ID }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });
  });

  it('POST /billing/webhook answers 503 BILLING_NOT_CONFIGURED when the secret is absent', async () => {
    const clock = new FrozenClock(NOW);
    const tenants = new InMemoryTenantRepository(() => clock.now());
    const platformTenants = new InMemoryPlatformTenantRepository(tenants, () => clock.now());
    const unconfiguredApp = Fastify();
    unconfiguredApp.removeContentTypeParser('application/json');
    unconfiguredApp.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (request: FastifyRequest, body: Buffer, done) => {
        request.rawBody = body;
        done(null, JSON.parse(body.toString('utf8')));
      },
    );
    registerErrorHandler(unconfiguredApp, { logger: silentLogger, exposeDetails: true });
    const billing = new BillingService({
      logger: silentLogger,
      clock,
      billing: {},
      repos: {
        tenants,
        platformTenants,
        billingEvents: new InMemoryBillingEventRepository(() => clock.now()),
      },
    });
    const ctx = {
      services: { billing, logger: silentLogger },
      hub: {},
      options: {},
    } as unknown as HttpRouteContext;
    await unconfiguredApp.register(billingRoutes, { prefix: '/billing', ...ctx });

    const response = await unconfiguredApp.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: { 'content-type': 'application/json', 'x-billing-signature': 'a'.repeat(64) },
      payload: JSON.stringify({ type: 'subscription.activated', tenantId: TENANT_ID }),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: 'BILLING_NOT_CONFIGURED', details: { missing: ['BILLING_WEBHOOK_SECRET'] } },
    });
    await unconfiguredApp.close();
  });

  it('POST /billing/webhook answers 404 for an unknown workspace', async () => {
    const response = await postSigned({
      type: 'subscription.activated',
      tenantId: '99999999-9999-4999-8999-999999999999',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('POST /platform/tenants/:id/checkout returns the rendered checkout URL', async () => {
    seedTenant({ id: '55555555-5555-4555-8555-555555555555', slug: 'checkout', plan: 'PRO' });

    const response = await app.inject({
      method: 'POST',
      url: '/platform/tenants/55555555-5555-4555-8555-555555555555/checkout',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: { checkoutUrl: string } };
    expect(body.data.checkoutUrl).toContain('tenant=55555555-5555-4555-8555-555555555555');
    expect(body.data.checkoutUrl).toContain('slug=checkout');
    expect(body.data.checkoutUrl).toContain('plan=PRO');
    expect(body.data.checkoutUrl).toContain('email=finance%40acme.test');
    expect(body.data.checkoutUrl).toContain(`success=${encodeURIComponent(SUCCESS_URL)}`);
    expect(body.data.checkoutUrl).toContain(`cancel=${encodeURIComponent(CANCEL_URL)}`);
  });

  it('POST /platform/tenants/:id/checkout answers 403 for a non platform admin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/platform/tenants/${TENANT_ID}/checkout`,
      headers: { 'x-test-agent': 'tenant-admin' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_ERROR' } });
  });

  it('POST /platform/tenants/:id/checkout validates the tenant id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/platform/tenants/not-a-uuid/checkout',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('POST /platform/tenants/:id/checkout answers 503 without a template', async () => {
    const clock = new FrozenClock(NOW);
    const tenants = new InMemoryTenantRepository(() => clock.now());
    tenantRepository.seed({ id: TENANT_ID, slug: 'acme' });
    const platformTenants = new InMemoryPlatformTenantRepository(tenants, () => clock.now());
    const billing = new BillingService({
      logger: silentLogger,
      clock,
      billing: {},
      repos: {
        tenants,
        platformTenants,
        billingEvents: new InMemoryBillingEventRepository(() => clock.now()),
      },
    });
    const ctx = {
      services: {
        billing,
        platform: { requirePlatformAdmin } as unknown as IPlatformService,
        logger: silentLogger,
      },
      hub: {},
      options: {},
    } as unknown as HttpRouteContext;
    const noTemplateApp = Fastify();
    registerErrorHandler(noTemplateApp, { logger: silentLogger, exposeDetails: true });
    noTemplateApp.addHook('preHandler', async (request) => {
      request.agent = {
        id: 'platform-admin',
        email: 'admin@acme.test',
        name: 'Ana',
        role: 'ADMIN',
        tenantId: TENANT_ID,
        isPlatformAdmin: true,
      };
    });
    await noTemplateApp.register(platformRoutes, { prefix: '/platform', ...ctx });

    const response = await noTemplateApp.inject({
      method: 'POST',
      url: `/platform/tenants/${TENANT_ID}/checkout`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: 'BILLING_NOT_CONFIGURED',
        details: { missing: ['BILLING_CHECKOUT_URL_TEMPLATE'] },
      },
    });
    await noTemplateApp.close();
  });

  it('GET /platform/billing/events lists the audit trail with the limit', async () => {
    billingRepository.seed({
      eventId: 'billing:http-audit-1',
      tenantId: TENANT_ID,
      type: 'subscription.activated',
      status: 'PROCESSED',
      receivedAt: new Date('2026-11-06T10:00:00.000Z'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/platform/billing/events?limit=10',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: { limit: number; items: Array<Record<string, unknown>> };
    };
    expect(body.data.limit).toBe(10);
    expect(body.data.items[0]).toMatchObject({
      type: 'subscription.activated',
      tenantId: TENANT_ID,
      tenantSlug: 'acme',
      status: 'PROCESSED',
    });
  });

  it('GET /platform/billing/events defaults the limit to 50 and validates it', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/platform/billing/events',
      headers: { 'x-test-agent': 'platform-admin' },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { data: { limit: number } }).data.limit).toBe(50);

    for (const limit of ['0', '101', 'abc']) {
      const response = await app.inject({
        method: 'GET',
        url: `/platform/billing/events?limit=${limit}`,
        headers: { 'x-test-agent': 'platform-admin' },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
  });

  it('GET /platform/billing/events answers 403 for a non platform admin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/billing/events',
      headers: { 'x-test-agent': 'tenant-admin' },
    });

    expect(response.statusCode).toBe(403);
  });
});
