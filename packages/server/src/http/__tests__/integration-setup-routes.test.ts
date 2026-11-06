import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { IAppServices, ILogger, IPlatformService } from '@sac/shared';
import { AuthorizationError } from '@sac/shared';

import type { HttpRouteContext } from '../types';
import { platformRoutes } from '../routes/platform.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { isPublicRoute } from '../middleware/auth';
import { IntegrationSetupService } from '../../application/IntegrationSetupService';
import { FrozenClock, testChannelConfig } from '../../application/__tests__/accountFakes';

/**
 * `GET /api/v1/platform/integration-setup` (Fase 2 onboarding).
 *
 * The real `IntegrationSetupService` is wired in: these tests cover the HTTP
 * contract on top of the environment-derived guide - JWT + platform-admin gate,
 * the `?marketplace=` filter, the 422 for an unknown channel, and the guarantee
 * that no secret value crosses the wire.
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');
const API_BASE = 'https://api.integrai.test';
const WEB_ORIGIN = 'https://app.integrai.test, https://admin.integrai.test';

const noopLogger: ILogger = {
  child(): ILogger {
    return this;
  },
  trace(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

const SECRET_VALUES = ['meli-secret', 'shopee-key', 'amzn1.oa2-cs.v1.test', 'ses-secret'];

describe('platform integration-setup route', () => {
  let app: FastifyInstance;
  let requirePlatformAdmin: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    requirePlatformAdmin = vi.fn(async (actorId: string) => {
      if (actorId === 'platform-admin') return;
      throw new AuthorizationError('Platform administrator privileges are required');
    });

    const integrationSetup = new IntegrationSetupService({
      clock: new FrozenClock(NOW),
      config: testChannelConfig(),
      webOrigin: WEB_ORIGIN,
    });

    const services = {
      platform: { requirePlatformAdmin } as unknown as IPlatformService,
      integrationSetup,
      logger: noopLogger,
    } as unknown as IAppServices;

    const ctx = {
      services,
      hub: {},
      options: { webOrigin: WEB_ORIGIN, appBaseUrl: API_BASE, logger: noopLogger },
    } as unknown as HttpRouteContext;

    app = Fastify();
    registerErrorHandler(app, { logger: noopLogger, exposeDetails: true });
    // Stand-in for the global JWT guard: the header chooses the principal.
    app.addHook('preHandler', async (request) => {
      const actorId = request.headers['x-test-agent'];
      if (typeof actorId === 'string' && actorId.length > 0) {
        request.agent = {
          id: actorId,
          email: `${actorId}@acme.test`,
          name: 'Ana',
          role: 'ADMIN',
          tenantId: 'tenant-1',
          isPlatformAdmin: actorId === 'platform-admin',
        };
      }
    });
    await app.register(platformRoutes, { prefix: '/platform', ...ctx });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    requirePlatformAdmin.mockClear();
  });

  it('is never a public route', () => {
    for (const path of [
      '/api/v1/platform/integration-setup',
      '/api/v1/platform/integration-setup?marketplace=SHOPEE',
    ]) {
      expect(isPublicRoute('GET', path)).toBe(false);
    }
  });

  it('answers 401 without a principal', async () => {
    const response = await app.inject({ method: 'GET', url: '/platform/integration-setup' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'AUTHENTICATION_ERROR' } });
    expect(requirePlatformAdmin).not.toHaveBeenCalled();
  });

  it('answers 403 for a regular tenant ADMIN', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/integration-setup',
      headers: { 'x-test-agent': 'tenant-admin' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_ERROR' } });
    expect(response.json()).not.toHaveProperty('data');
  });

  it('gates the filtered variant with the same 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/integration-setup?marketplace=AMAZON',
      headers: { 'x-test-agent': 'tenant-admin' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('returns the full guide for a platform admin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/integration-setup',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(requirePlatformAdmin).toHaveBeenCalledWith('platform-admin');

    const body = response.json();
    expect(body.data).toMatchObject({
      generatedAt: NOW.toISOString(),
      apiBaseUrl: API_BASE,
      webOrigin: 'https://app.integrai.test',
    });
    expect(body.data.channels.map((entry: { marketplace: string }) => entry.marketplace)).toEqual([
      'MERCADO_LIVRE',
      'SHOPEE',
      'AMAZON',
    ]);

    const [meli, shopee, amazon] = body.data.channels;
    expect(meli).toMatchObject({
      configured: true,
      missing: [],
      appIdPublic: 'meli-client',
      redirectUri: `${API_BASE}/api/v1/accounts/oauth/mercadolivre/callback`,
      webhookUrl: `${API_BASE}/webhooks/mercadolivre?secret=meli-webhook-secret`,
      portalUrl: 'https://developers.mercadolivre.com.br/devcenter',
    });
    expect(shopee).toMatchObject({
      configured: true,
      missing: [],
      appIdPublic: '1000000',
      webhookSecretEnv: 'SHOPEE_PARTNER_KEY',
    });
    expect(amazon).toMatchObject({
      configured: true,
      missing: [],
      appIdPublic: 'amzn1.application-oa2-client.test',
      webhookSecretEnv: 'AMAZON_SES_INBOUND_SHARED_SECRET',
    });
  });

  it('never puts a secret value in the response body', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/integration-setup',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    const raw = response.body;
    for (const secret of SECRET_VALUES) {
      expect(raw).not.toContain(secret);
    }
  });

  it('filters to a single channel with ?marketplace=', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/integration-setup?marketplace=SHOPEE',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.channels).toHaveLength(1);
    expect(response.json().data.channels[0]).toMatchObject({
      marketplace: 'SHOPEE',
      redirectUri: `${API_BASE}/api/v1/accounts/oauth/shopee/callback`,
      webhookUrl: `${API_BASE}/webhooks/shopee`,
    });
  });

  it('treats a blank ?marketplace= as "all channels"', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/integration-setup?marketplace=',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.channels).toHaveLength(3);
  });

  it('rejects an unknown or lowercase marketplace with 422', async () => {
    for (const value of ['MERCADO', 'shopee', 'INVALID']) {
      const response = await app.inject({
        method: 'GET',
        url: `/platform/integration-setup?marketplace=${value}`,
        headers: { 'x-test-agent': 'platform-admin' },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
  });
});
