import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  RateLimitError,
  type IAgentService,
  type IAppServices,
  type ILogger,
  type ITicketQueryService,
} from '@sac/shared';

import { buildHttpApp, resolveAllowedOrigins } from '../app';
import { MAX_API_JSON_BYTES } from '../constants';
import { registerAuthGuard, requireTenantId } from '../middleware/auth';
import { registerErrorHandler } from '../middleware/error-handler';
import type { RealtimeHub } from '../realtime-hub';
import type { HttpServerOptions } from '../types';

/**
 * HTTP hardening regression suite.
 *
 * Runs entirely in-process (`app.inject`): no network, no database, no Redis.
 * The route graph is the real one built by `buildHttpApp`; only the service
 * ports are faked, so the assertions cover the same plugin/hook order production
 * uses (helmet -> permissions-policy -> cors -> auth guard -> routes).
 */

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

const WEB_ORIGIN = 'https://app.example.test,https://admin.example.test';

/**
 * Deep service double.
 *
 * Any unknown property resolves to itself, which keeps the real route
 * registration working without a 60-method mock; the paths an assertion
 * actually exercises (logger, health, status, webhooks, clock) are supplied
 * explicitly.
 */
function serviceTree(overrides: Record<string, unknown> = {}): IAppServices {
  const makeNode = (bag: Record<string, unknown>): unknown => {
    let node: unknown;
    const handler: ProxyHandler<(...args: unknown[]) => void> = {
      get(_target, property) {
        if (property === 'then') return undefined;
        if (typeof property === 'string' && Object.prototype.hasOwnProperty.call(bag, property)) {
          return bag[property];
        }
        return node;
      },
      apply() {
        return node;
      },
    };
    node = new Proxy(function noop(): void {}, handler);
    return node;
  };

  return makeNode({
    logger: noopLogger,
    clock: { now: () => new Date('2026-11-05T12:00:00.000Z') },
    health: {
      health: async () => ({
        status: 'ok',
        uptimeSeconds: 1,
        checks: [],
        channels: [],
      }),
    },
    status: {
      snapshot: async () => ({
        status: 'ok',
        checkedAt: '2026-11-05T12:00:00.000Z',
        services: [],
        channels: [],
      }),
    },
    webhooks: {
      accept: async () => ({
        accepted: true,
        duplicate: false,
        status: 'RECEIVED',
        httpStatus: 200,
        body: { status: 'OK' },
        eventId: null,
        durationMs: 1,
      }),
    },
    ...overrides,
  }) as IAppServices;
}

const fakeHub = {
  attach: (): void => undefined,
  close: async (): Promise<void> => undefined,
  publish: (): void => undefined,
} as unknown as RealtimeHub;

function serverOptions(): HttpServerOptions {
  return {
    jwtSecret: 'unit-test-secret-with-32-characters!!',
    webOrigin: WEB_ORIGIN,
    appBaseUrl: 'https://api.example.test',
    logger: noopLogger,
  };
}

async function buildApp(overrides: Record<string, unknown> = {}): Promise<FastifyInstance> {
  const app = await buildHttpApp(serviceTree(overrides), fakeHub, serverOptions());
  await app.ready();
  return app;
}

describe('security headers (API)', () => {
  let app: FastifyInstance;
  const productionApps: FastifyInstance[] = [];

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    for (const productionApp of productionApps) await productionApp.close();
    vi.unstubAllEnvs();
  });

  it('sends the restrictive header set on a public route', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['x-dns-prefetch-control']).toBe('off');
    expect(response.headers['x-permitted-cross-domain-policies']).toBe('none');
    expect(response.headers['permissions-policy']).toContain('camera=()');
    expect(response.headers['permissions-policy']).toContain('geolocation=()');
  });

  it('serves JSON with a CSP that can never execute or frame anything', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const csp = response.headers['content-security-policy'];

    expect(typeof csp).toBe('string');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain('unsafe-eval');
  });

  it('does not send HSTS outside production (localhost/dev safety)', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('sends HSTS when NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const productionApp = await buildApp();
    productionApps.push(productionApp);

    const response = await productionApp.inject({ method: 'GET', url: '/health' });
    expect(response.headers['strict-transport-security']).toBe(
      'max-age=15552000; includeSubDomains',
    );
  });

  it('keeps the headers on error responses (401) and forbids caching', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/tenants/me' });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['permissions-policy']).toContain('microphone=()');
    expect(response.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    expect(response.headers['pragma']).toBe('no-cache');
  });
});

describe('CORS allowlist', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('echoes an allowlisted origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.example.test' },
    });

    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.test');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not answer CORS for an unknown origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });

    // `Access-Control-Allow-Origin` is the grant: without it the browser
    // discards the response. (`allow-credentials` alone grants nothing, and
    // @fastify/cors emits it unconditionally when credentials are enabled.)
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects an unknown origin on preflight', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    // Same rule on preflight: no allow-origin => the browser never sends POST.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never reflects a wildcard configured in WEB_ORIGIN', async () => {
    expect(resolveAllowedOrigins(' https://app.example.test/ , * ')).toEqual([
      'https://app.example.test',
    ]);

    const permissive = await buildApp();
    try {
      const response = await permissive.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://anything.example' },
      });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await permissive.close();
    }
  });
});

describe('request size limits', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a JSON body above the API cap with 413', async () => {
    const oversized = JSON.stringify({ pad: 'a'.repeat(MAX_API_JSON_BYTES + 1024) });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: oversized,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: 'Request payload exceeds the allowed size limit' },
    });
  });

  it('keeps the larger webhook allowance for the SES/MIME ingress', async () => {
    // 2 MiB: above the API JSON cap, below the 12 MiB webhook ceiling.
    const payload = JSON.stringify({ pad: 'a'.repeat(2 * 1024 * 1024) });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/amazon/ses',
      headers: { 'content-type': 'application/json', 'x-sac-signature': 'ignored-by-fake' },
      payload,
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('webhook authentication', () => {
  it('answers 401 when the signature is missing/invalid', async () => {
    const app = await buildApp({
      webhooks: {
        accept: async () => {
          throw new AppError('INVALID_SIGNATURE', 'missing signature', 401);
        },
      },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/shopee',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ event: 'x' }),
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ status: 'REJECTED', message: 'invalid signature' });
    } finally {
      await app.close();
    }
  });
});

describe('error mapping and rate limiting', () => {
  it('maps RateLimitError to 429 with a Retry-After header', async () => {
    const app = Fastify();
    registerErrorHandler(app, { logger: noopLogger, exposeDetails: true });
    app.get('/limited', async () => {
      throw new RateLimitError('auth.login', 90_000);
    });
    await app.ready();

    try {
      const response = await app.inject({ method: 'GET', url: '/limited' });

      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('90');
      expect(response.json()).toMatchObject({
        error: { code: 'RATE_LIMITED', details: { bucket: 'auth.login' } },
      });
    } finally {
      await app.close();
    }
  });
});

describe('JWT without tenant', () => {
  it('rejects a valid session that has no workspace with 403', async () => {
    const agents = {
      verifyToken: vi.fn(async () => ({
        agentId: 'agent-1',
        email: 'op@example.test',
        name: 'Op',
        role: 'AGENT',
        tenantId: null,
        isPlatformAdmin: false,
      })),
    } as unknown as IAgentService;

    const app = Fastify();
    registerErrorHandler(app, { logger: noopLogger, exposeDetails: true });
    registerAuthGuard(app, {
      agents,
      tickets: {} as unknown as ITicketQueryService,
      logger: noopLogger,
    });
    app.get('/api/v1/invitations', async (request) => requireTenantId(request));
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/invitations',
        headers: { authorization: 'Bearer tenantless-token' },
      });

      expect(agents.verifyToken).toHaveBeenCalledWith('tenantless-token');
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTHORIZATION_ERROR' },
      });
    } finally {
      await app.close();
    }
  });
});
