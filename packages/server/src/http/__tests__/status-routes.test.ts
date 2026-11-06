import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { IClock, ILogger, IStatusService, SystemStatusSnapshot } from '@sac/shared';

import type { HttpRouteContext } from '../types';
import { statusRoutes } from '../routes/status.routes';
import { isPublicRoute } from '../middleware/auth';
import { registerErrorHandler } from '../middleware/error-handler';

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

const clock: IClock = { now: () => new Date('2026-11-05T12:00:00.000Z') };

const SNAPSHOT: SystemStatusSnapshot = {
  status: 'degraded',
  checkedAt: '2026-11-05T12:00:00.000Z',
  services: [
    { name: 'api', status: 'operational', latencyMs: 2 },
    { name: 'database', status: 'operational', latencyMs: 4 },
    { name: 'redis', status: 'operational', latencyMs: 1 },
    { name: 'storage', status: 'down', latencyMs: 30 },
  ],
  channels: [
    { marketplace: 'MERCADO_LIVRE', accounts: 2, healthy: 1, lastErrorAt: null },
  ],
};

describe('public status routes', () => {
  let app: FastifyInstance;
  let snapshot: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    snapshot = vi.fn(async () => SNAPSHOT);

    const ctx = {
      services: {
        status: { snapshot } as unknown as IStatusService,
        clock,
        logger: noopLogger,
      },
      hub: {},
      options: {},
    } as unknown as HttpRouteContext;

    app = Fastify();
    registerErrorHandler(app, { logger: noopLogger, exposeDetails: true });
    await app.register(statusRoutes, ctx);
    await app.register(statusRoutes, { prefix: '/api/v1', ...ctx });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    snapshot.mockClear();
  });

  it('is in the auth allowlist on both public paths', () => {
    expect(isPublicRoute('GET', '/status')).toBe(true);
    expect(isPublicRoute('GET', '/api/v1/status')).toBe(true);
    expect(isPublicRoute('GET', '/api/v1/status?probe=1')).toBe(true);
    // Exact paths only: neighboring routes must still require a JWT.
    expect(isPublicRoute('GET', '/status/private')).toBe(false);
    expect(isPublicRoute('GET', '/api/v1/statuses')).toBe(false);
    expect(isPublicRoute('GET', '/api/v1/platform/status')).toBe(false);
  });

  it('answers the flat public snapshot without authentication', async () => {
    for (const url of ['/status', '/api/v1/status']) {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(200);
      // Flat body (no `{ data }` envelope): the status page reads it directly.
      expect(response.json()).toEqual(SNAPSHOT);
      expect(response.json().data).toBeUndefined();
    }
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('publishes no account identifiers, names or error details', async () => {
    const response = await app.inject({ method: 'GET', url: '/status' });
    const body = response.body;

    for (const forbidden of ['accountId', 'accountDisplayName', 'detail', 'password', 'token']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('answers a conservative down snapshot (HTTP 200) when the service throws', async () => {
    snapshot.mockRejectedValueOnce(new Error('unexpected snapshot failure'));

    const response = await app.inject({ method: 'GET', url: '/status' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'down',
      checkedAt: '2026-11-05T12:00:00.000Z',
      channels: [],
    });
    expect(response.json().services.map((service: { name: string }) => service.name)).toEqual([
      'api',
      'database',
      'redis',
      'storage',
    ]);
    expect(response.body).not.toContain('unexpected snapshot failure');
  });
});
