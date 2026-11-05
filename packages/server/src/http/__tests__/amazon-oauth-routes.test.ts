import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { IAccountService, ILogger } from '@sac/shared';
import { AmazonOAuthNotConfiguredError, AppError } from '@sac/shared';

import type { HttpRouteContext } from '../types';
import { accountRoutes } from '../routes/accounts.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { isPublicRoute } from '../middleware/auth';
import { AccountService } from '../../application/AccountService';
import {
  FakeCipher,
  FrozenClock,
  InMemoryAccountRepository,
  InMemoryCache,
  RecordingHttpClient,
  fakeAdapterRegistry,
  silentLogger,
  testChannelConfig,
} from '../../application/__tests__/accountFakes';

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

const WEB_ORIGIN = 'https://app.integrai.test,http://localhost:5173';

describe('Amazon OAuth route surface', () => {
  let app: FastifyInstance;
  let startOAuth: ReturnType<typeof vi.fn>;
  let completeOAuth: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    startOAuth = vi.fn(async () => ({
      authorizeUrl:
        'https://sellercentral.amazon.com/apps/authorize/consent?application_id=app-1&state=signed&version=beta',
      state: 'signed',
      marketplace: 'AMAZON' as const,
    }));
    completeOAuth = vi.fn(async () => ({ accountId: 'account-1', displayName: 'Amazon BR' }));

    const ctx = {
      services: {
        logger: noopLogger,
        accounts: { startOAuth, completeOAuth } as unknown as IAccountService,
      },
      hub: {},
      options: { webOrigin: WEB_ORIGIN },
    } as unknown as HttpRouteContext;

    app = Fastify();
    registerErrorHandler(app, { logger: noopLogger, exposeDetails: true });
    // Stand-in for the global JWT guard.
    app.addHook('preHandler', async (request) => {
      const tenantId = request.headers['x-test-tenant'];
      if (typeof tenantId === 'string' && tenantId.length > 0) {
        request.agent = {
          id: 'agent-1',
          email: 'admin@acme.test',
          name: 'Ana',
          role: 'ADMIN',
          tenantId,
        };
      }
    });
    await app.register(accountRoutes, { prefix: '/accounts', ...ctx });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    startOAuth.mockClear();
    completeOAuth.mockClear();
  });

  it('keeps /oauth/amazon/start authenticated and /oauth/amazon/callback public', () => {
    expect(isPublicRoute('POST', '/api/v1/accounts/oauth/amazon/start')).toBe(false);
    expect(isPublicRoute('GET', '/api/v1/accounts/oauth/amazon/callback?state=x')).toBe(true);
  });

  it('POST /accounts/oauth/amazon/start returns the consent URL for the JWT tenant', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/accounts/oauth/amazon/start',
      headers: { 'x-test-tenant': 'tenant-1' },
      payload: { displayName: 'Amazon BR' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        authorizeUrl:
          'https://sellercentral.amazon.com/apps/authorize/consent?application_id=app-1&state=signed&version=beta',
        state: 'signed',
        marketplace: 'AMAZON',
      },
    });
    expect(startOAuth).toHaveBeenCalledWith('AMAZON', 'Amazon BR', 'tenant-1');
  });

  it('POST /accounts/oauth/amazon/start answers 401 without a principal', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/accounts/oauth/amazon/start',
      payload: { displayName: 'Amazon BR' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'AUTHENTICATION_ERROR' } });
    expect(startOAuth).not.toHaveBeenCalled();
  });

  it('maps AMAZON_OAUTH_NOT_CONFIGURED to 409 with remediation details', async () => {
    startOAuth.mockRejectedValueOnce(
      new AmazonOAuthNotConfiguredError(
        ['AMAZON_APP_ID'],
        'Configure AMAZON_APP_ID and restart the API.',
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/accounts/oauth/amazon/start',
      headers: { 'x-test-tenant': 'tenant-1' },
      payload: { displayName: 'Amazon BR' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: 'AMAZON_OAUTH_NOT_CONFIGURED',
        details: { provider: 'AMAZON', missing: ['AMAZON_APP_ID'] },
      },
    });
  });

  it('GET /accounts/oauth/amazon/callback redirects to /accounts?connected=amazon', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/accounts/oauth/amazon/callback?state=signed&spapi_oauth_code=code-1&selling_partner_id=A2SELLER',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://app.integrai.test/accounts?connected=amazon');
    expect(completeOAuth).toHaveBeenCalledWith('AMAZON', {
      code: 'code-1',
      state: 'signed',
      sellingPartnerId: 'A2SELLER',
      rawQuery: {
        state: 'signed',
        spapi_oauth_code: 'code-1',
        selling_partner_id: 'A2SELLER',
      },
    });
  });

  it('redirects with ?error=VALIDATION_ERROR when Amazon omits required params', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/accounts/oauth/amazon/callback?state=signed&spapi_oauth_code=code-1',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      'https://app.integrai.test/accounts?error=VALIDATION_ERROR',
    );
    expect(completeOAuth).not.toHaveBeenCalled();
  });

  it('redirects with ?error=<code> when the token exchange fails', async () => {
    completeOAuth.mockRejectedValueOnce(
      new AppError('MARKETPLACE_API_ERROR', '[AMAZON] LWA exchange failed', 502),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/accounts/oauth/amazon/callback?state=signed&spapi_oauth_code=code-1&selling_partner_id=A2SELLER',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      'https://app.integrai.test/accounts?error=MARKETPLACE_API_ERROR',
    );
  });

  it('keeps the Meli/Shopee parametric routes working', async () => {
    startOAuth.mockResolvedValueOnce({
      authorizeUrl: 'https://auth.mercadolivre.com.br/authorization?x=1',
      state: 'meli-state',
      marketplace: 'MERCADO_LIVRE',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/accounts/oauth/mercadolivre/start',
      headers: { 'x-test-tenant': 'tenant-1' },
      payload: { displayName: 'Meli BR' },
    });

    expect(response.statusCode).toBe(200);
    expect(startOAuth).toHaveBeenCalledWith('MERCADO_LIVRE', 'Meli BR', 'tenant-1');
  });
});

/* ==========================================================================
 * End-to-end wiring: route -> real AccountService -> stubbed LWA -> redirect
 * ========================================================================== */

describe('Amazon OAuth end-to-end (route + AccountService + LWA stub)', () => {
  let app: FastifyInstance;
  let accounts: InMemoryAccountRepository;
  let http: RecordingHttpClient;
  let cipher: FakeCipher;

  beforeAll(async () => {
    const clock = new FrozenClock(new Date('2026-11-05T12:00:00.000Z'));
    cipher = new FakeCipher();
    accounts = new InMemoryAccountRepository(clock);
    http = new RecordingHttpClient((request) => {
      expect(request.url).toBe('https://api.amazon.com/auth/o2/token');
      return {
        status: 200,
        body: {
          access_token: 'Atza|e2e-access',
          refresh_token: 'Atzr|e2e-refresh',
          expires_in: 3_600,
          token_type: 'bearer',
        },
      };
    });

    const service = new AccountService({
      logger: silentLogger,
      clock,
      cache: new InMemoryCache(),
      cipher,
      http,
      config: testChannelConfig(),
      adapters: fakeAdapterRegistry,
      repos: { accounts },
    });

    const ctx = {
      services: { logger: noopLogger, accounts: service },
      hub: {},
      options: { webOrigin: WEB_ORIGIN },
    } as unknown as HttpRouteContext;

    app = Fastify();
    registerErrorHandler(app, { logger: noopLogger, exposeDetails: true });
    app.addHook('preHandler', async (request) => {
      const tenantId = request.headers['x-test-tenant'];
      if (typeof tenantId === 'string' && tenantId.length > 0) {
        request.agent = {
          id: 'agent-1',
          email: 'admin@acme.test',
          name: 'Ana',
          role: 'ADMIN',
          tenantId,
        };
      }
    });
    await app.register(accountRoutes, { prefix: '/accounts', ...ctx });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs start -> consent -> callback and persists the AMAZON account for the JWT tenant', async () => {
    const started = await app.inject({
      method: 'POST',
      url: '/accounts/oauth/amazon/start',
      headers: { 'x-test-tenant': 'tenant-e2e' },
      payload: { displayName: 'Amazon E2E' },
    });

    expect(started.statusCode).toBe(200);
    const startBody = started.json<{ data: { state: string; authorizeUrl: string } }>();
    expect(startBody.data.authorizeUrl).toContain('application_id=');
    expect(startBody.data.state).toContain('.');

    const callback = await app.inject({
      method: 'GET',
      url:
        '/accounts/oauth/amazon/callback?state=' +
        encodeURIComponent(startBody.data.state) +
        '&spapi_oauth_code=spapi-e2e&selling_partner_id=A2E2ESELLER',
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('https://app.integrai.test/accounts?connected=amazon');

    const row = accounts.rows[0];
    expect(row).toMatchObject({
      tenantId: 'tenant-e2e',
      marketplace: 'AMAZON',
      displayName: 'Amazon E2E',
      externalSellerId: 'A2E2ESELLER',
      refreshTokenEnc: cipher.encrypt('Atzr|e2e-refresh'),
    });
    expect(http.requests).toHaveLength(1);
  });
});
