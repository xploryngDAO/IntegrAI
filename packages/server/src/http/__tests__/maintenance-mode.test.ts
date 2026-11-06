import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_MAINTENANCE_MESSAGE,
  MAINTENANCE_ERROR_CODE,
  MaintenanceError,
  resolveMaintenanceState,
} from '@sac/shared';

import { buildHttpApp } from '../app';
import { loadConfig } from '../../config';
import {
  isMaintenanceBlockedPath,
  isMaintenanceExemptPath,
} from '../middleware/maintenance';
import { createRealtimeHub } from '../realtime-hub';
import type { HttpServerOptions } from '../types';
import {
  buildTestApp,
  createServerOptions,
  createServiceTree,
  noopLogger,
} from './http-test-harness';

/**
 * Controlled maintenance window (`MAINTENANCE_MODE`).
 *
 * The real `buildHttpApp` graph is exercised through `app.inject` (same hooks
 * and routes as production, only the service ports are faked) plus one real
 * loopback listener for the Engine.IO handshake, which lives outside Fastify's
 * router and therefore cannot be reached with `inject`.
 */

const CLEANUP: FastifyInstance[] = [];

async function appFor(server: Partial<HttpServerOptions> = {}): Promise<FastifyInstance> {
  const app = await buildTestApp({ server });
  CLEANUP.push(app);
  return app;
}

afterEach(async () => {
  while (CLEANUP.length > 0) {
    const app = CLEANUP.pop();
    if (app !== undefined) await app.close();
  }
  vi.unstubAllEnvs();
});

/* ======================================================================== */
/* Path policy                                                              */
/* ======================================================================== */

describe('maintenance path policy', () => {
  it('guards every /api/v1 route except the monitoring surfaces', () => {
    for (const path of [
      '/api/v1',
      '/api/v1/auth/login',
      '/api/v1/accounts',
      '/api/v1/agents',
      '/api/v1/billing/webhook',
      '/api/v1/health/ready/extra',
    ]) {
      expect(isMaintenanceBlockedPath(path), path).toBe(true);
    }

    for (const path of [
      '/health',
      '/health/ready',
      '/status',
      '/metrics',
      '/api/v1/health',
      '/api/v1/health/ready',
      '/api/v1/status',
      '/api/v1/metrics',
    ]) {
      expect(isMaintenanceExemptPath(path), path).toBe(true);
      expect(isMaintenanceBlockedPath(path), path).toBe(false);
    }
  });

  it('never blocks anything outside /api/v1 (webhooks, realtime, public pages)', () => {
    for (const path of [
      '/webhooks/shopee',
      '/webhooks/mercadolivre',
      '/webhooks/amazon/ses',
      '/socket.io/',
      '/',
      '/docs',
    ]) {
      expect(isMaintenanceBlockedPath(path), path).toBe(false);
    }
  });
});

/* ======================================================================== */
/* MAINTENANCE_MODE on                                                      */
/* ======================================================================== */

describe('MAINTENANCE_MODE on', () => {
  it.each([
    ['POST', '/api/v1/auth/login'],
    ['GET', '/api/v1/accounts'],
    ['GET', '/api/v1/accounts?page=2'],
    ['GET', '/api/v1/agents'],
    ['GET', '/api/v1/tenants/me'],
    ['POST', '/api/v1/billing/webhook'],
  ] as const)('blocks %s %s with 503 MAINTENANCE + Retry-After', async (method, url) => {
    const app = await appFor({ maintenanceMode: true });
    const clientId = 'maintenance-check-01';
    const response = await app.inject({
      method,
      url,
      headers:
        method === 'POST'
          ? { 'content-type': 'application/json', 'x-request-id': clientId }
          : { 'x-request-id': clientId },
      payload: method === 'POST' ? {} : undefined,
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('60');
    expect(response.headers['x-request-id']).toBe(clientId);
    expect(response.json()).toMatchObject({
      error: {
        code: MAINTENANCE_ERROR_CODE,
        message: DEFAULT_MAINTENANCE_MESSAGE,
        requestId: clientId,
      },
    });
    // The correlation id is also generated when the client sends none.
    const generated = await app.inject({ method: 'GET', url });
    expect(generated.json().error.requestId).toBe(generated.headers['x-request-id']);
  });

  it('uses MAINTENANCE_MESSAGE when configured', async () => {
    const app = await appFor({ maintenanceMode: true, maintenanceMessage: 'Voltamos as 18h' });

    const response = await app.inject({ method: 'GET', url: '/api/v1/accounts' });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({
      code: MAINTENANCE_ERROR_CODE,
      message: 'Voltamos as 18h',
    });
  });

  it('keeps the health probes, the status page and the metrics scrape answering', async () => {
    const app = await appFor({ maintenanceMode: true, metricsToken: 'scrape-secret' });

    for (const url of [
      '/health',
      '/health/ready',
      '/status',
      '/api/v1/health',
      '/api/v1/health/ready',
      '/api/v1/status',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
    }

    const metrics = await app.inject({
      method: 'GET',
      url: '/api/v1/metrics',
      headers: { authorization: 'Bearer scrape-secret' },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('sac_http_requests_total');

    // The scrape route is API-prefixed (`/api/v1/metrics`). The bare `/metrics`
    // is exempt from the guard too (never a maintenance 503); this app has no
    // root route for it, so the request follows the regular auth/404 path.
    const rootMetrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(rootMetrics.statusCode).not.toBe(503);
  });

  it('lets the metrics route keep its own policy (404 without a token, not 503)', async () => {
    vi.stubEnv('METRICS_TOKEN', '');
    const app = await appFor({ maintenanceMode: true });

    const response = await app.inject({ method: 'GET', url: '/api/v1/metrics' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('keeps marketplace webhooks reachable and signature-independent', async () => {
    const app = await appFor({ maintenanceMode: true });

    for (const url of ['/webhooks/shopee', '/webhooks/mercadolivre', '/webhooks/amazon/ses']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'text/plain' },
        payload: 'raw-marketplace-event',
      });

      expect(response.statusCode, url).toBe(200);
      expect(response.headers['retry-after'], url).toBeUndefined();
      expect(response.json(), url).not.toHaveProperty('error');
    }
  });

  it('rejects before the global rate limiter is charged', async () => {
    const incr = vi.fn(async () => 1);
    const cache = {
      incr,
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
      ttl: async () => 0,
    };
    const app = await buildTestApp({ services: { cache }, server: { maintenanceMode: true } });
    CLEANUP.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/accounts' });

    expect(response.statusCode).toBe(503);
    expect(incr).not.toHaveBeenCalled();
  });

  it('keeps the CORS headers on the 503 so the SPA can read the message', async () => {
    const app = await appFor({ maintenanceMode: true });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts',
      headers: { origin: 'https://app.example.test' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.test');
  });

  it('leaves the browser preflight to CORS (no 503 on OPTIONS)', async () => {
    const app = await appFor({ maintenanceMode: true });

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/accounts',
      headers: {
        origin: 'https://app.example.test',
        'access-control-request-method': 'GET',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.test');
  });
});

/* ======================================================================== */
/* MAINTENANCE_MODE off                                                     */
/* ======================================================================== */

describe('MAINTENANCE_MODE off', () => {
  it('does not block the API surface (default configuration)', async () => {
    const app = await appFor();

    const accounts = await app.inject({ method: 'GET', url: '/api/v1/accounts' });
    expect(accounts.statusCode).toBe(401);
    expect(accounts.json().error.code).toBe('AUTHENTICATION_ERROR');

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(login.statusCode).not.toBe(503);

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
  });

  it('does not block when explicitly disabled', async () => {
    const app = await appFor({ maintenanceMode: false });

    const response = await app.inject({ method: 'GET', url: '/api/v1/accounts' });

    expect(response.statusCode).toBe(401);
    expect(response.headers['retry-after']).toBeUndefined();
  });
});

/* ======================================================================== */
/* Configuration                                                            */
/* ======================================================================== */

describe('MAINTENANCE_MODE / MAINTENANCE_MESSAGE configuration', () => {
  it('defaults to off with the shared message', () => {
    const config = loadConfig({ NODE_ENV: 'test' });

    expect(config.maintenanceMode).toBe(false);
    expect(config.maintenanceMessage).toBe(DEFAULT_MAINTENANCE_MESSAGE);
  });

  it('parses boolean-like MAINTENANCE_MODE values', () => {
    expect(loadConfig({ NODE_ENV: 'test', MAINTENANCE_MODE: 'true' }).maintenanceMode).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test', MAINTENANCE_MODE: '1' }).maintenanceMode).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test', MAINTENANCE_MODE: 'yes' }).maintenanceMode).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test', MAINTENANCE_MODE: 'false' }).maintenanceMode).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test', MAINTENANCE_MODE: '0' }).maintenanceMode).toBe(false);
    // Empty/absent -> the documented default (`false`).
    expect(loadConfig({ NODE_ENV: 'test', MAINTENANCE_MODE: '' }).maintenanceMode).toBe(false);
  });

  it('trims a custom message and falls back to the default when empty', () => {
    expect(
      loadConfig({
        NODE_ENV: 'test',
        MAINTENANCE_MODE: 'on',
        MAINTENANCE_MESSAGE: '  Voltamos as 18h  ',
      }).maintenanceMessage,
    ).toBe('Voltamos as 18h');

    expect(
      loadConfig({ NODE_ENV: 'test', MAINTENANCE_MESSAGE: '   ' }).maintenanceMessage,
    ).toBe(DEFAULT_MAINTENANCE_MESSAGE);
  });
});

/* ======================================================================== */
/* Shared contract                                                          */
/* ======================================================================== */

describe('shared maintenance contract', () => {
  it('normalizes the resolved state', () => {
    expect(resolveMaintenanceState()).toEqual({
      enabled: false,
      message: DEFAULT_MAINTENANCE_MESSAGE,
    });
    expect(resolveMaintenanceState({ enabled: true, message: '   ' })).toEqual({
      enabled: true,
      message: DEFAULT_MAINTENANCE_MESSAGE,
    });
    expect(resolveMaintenanceState({ enabled: true, message: ' Manutencao ' })).toEqual({
      enabled: true,
      message: 'Manutencao',
    });
  });

  it('carries the 503 MAINTENANCE contract in the error class', () => {
    const error = new MaintenanceError('Fechado para manutencao');

    expect(error.code).toBe(MAINTENANCE_ERROR_CODE);
    expect(error.httpStatus).toBe(503);
    expect(error.message).toBe('Fechado para manutencao');
    expect(error.details).toEqual({ retryAfterSeconds: 60 });
    expect(error.retryable).toBe(true);
  });
});

/* ======================================================================== */
/* Socket.IO handshake                                                      */
/* ======================================================================== */

async function listenRealtime(
  enabled: boolean,
  message: string = DEFAULT_MAINTENANCE_MESSAGE,
): Promise<string> {
  const hub = createRealtimeHub({
    logger: noopLogger,
    clock: { now: () => new Date('2026-11-05T12:00:00.000Z') },
    jwtSecret: 'unit-test-secret-with-32-characters!!',
    webOrigin: 'https://app.example.test',
    maintenance: { enabled, message },
  });
  const app = await buildHttpApp(createServiceTree(), hub, createServerOptions());
  // `buildHttpApp` already attached the hub; listening is what lets the
  // Engine.IO request listener (outside Fastify's router) be reached.
  CLEANUP.push(app);
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('Socket.IO handshake during maintenance', () => {
  it('refuses the handshake with 503 MAINTENANCE + Retry-After', async () => {
    const baseUrl = await listenRealtime(true, 'Manutencao em curso');

    const response = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`, {
      headers: { connection: 'close' },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toMatchObject({
      error: { code: MAINTENANCE_ERROR_CODE, message: 'Manutencao em curso' },
    });
  });

  it('completes the Engine.IO handshake when the window is closed', async () => {
    const baseUrl = await listenRealtime(false);

    const response = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`, {
      headers: { connection: 'close' },
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    // Engine.IO OPEN packet: `0{"sid":"...", ...}`.
    expect(body.startsWith('0')).toBe(true);
    expect(body).toContain('sid');
  });
});
