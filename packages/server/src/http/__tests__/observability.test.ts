import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ILogger } from '@sac/shared';

import { buildTestApp } from './http-test-harness';
import { isGlobalRateLimitExemptPath } from '../app';
import {
  REQUEST_ID_PATTERN,
  normalizeRequestId,
  resolveRequestId,
} from '../middleware/request-id';

/**
 * Observability regression suite.
 *
 * Runs the real application in-process (`buildHttpApp` + `app.inject`): request
 * correlation, the readiness gate and the Prometheus scrape endpoint. No
 * network, no database, no Redis - only the service ports are faked.
 */

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type LogEntry = {
  bindings: Record<string, unknown>;
  message: string;
  meta?: Record<string, unknown>;
};

/** Logger double that keeps every line + the bindings of its child chain. */
function createCaptureLogger(): { logger: ILogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const make = (bindings: Record<string, unknown>): ILogger => ({
    child(next: Record<string, unknown>): ILogger {
      return make({ ...bindings, ...next });
    },
    trace(message: string, meta?: Record<string, unknown>): void {
      entries.push({ bindings, message, meta });
    },
    debug(message: string, meta?: Record<string, unknown>): void {
      entries.push({ bindings, message, meta });
    },
    info(message: string, meta?: Record<string, unknown>): void {
      entries.push({ bindings, message, meta });
    },
    warn(message: string, meta?: Record<string, unknown>): void {
      entries.push({ bindings, message, meta });
    },
    error(message: string, meta?: Record<string, unknown>): void {
      entries.push({ bindings, message, meta });
    },
  });
  return { logger: make({}), entries };
}

const CLEANUP: FastifyInstance[] = [];

async function appFor(
  options: Parameters<typeof buildTestApp>[0] = {},
): Promise<FastifyInstance> {
  const app = await buildTestApp(options);
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
/* Request id                                                               */
/* ======================================================================== */

describe('request id', () => {
  it('accepts a well-formed client id and echoes it in the header + error body', async () => {
    const app = await appFor();
    const clientId = 'trace_abc-123.4';

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/me',
      headers: { 'x-request-id': clientId },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['x-request-id']).toBe(clientId);
    expect(response.json()).toMatchObject({
      error: { code: 'AUTHENTICATION_ERROR', requestId: clientId },
    });
  });

  it('generates a UUID when the header is missing', async () => {
    const app = await appFor();

    const ok = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ok.headers['x-request-id']).toMatch(UUID_V4);
    expect(ok.json().requestId).toBe(ok.headers['x-request-id']);

    const failure = await app.inject({ method: 'GET', url: '/api/v1/tenants/me' });
    expect(failure.headers['x-request-id']).toMatch(UUID_V4);
    expect(failure.json().error.requestId).toBe(failure.headers['x-request-id']);
  });

  it.each([
    ['too short', 'abc1234'],
    ['too long', 'a'.repeat(129)],
    ['space', 'bad request id'],
    ['html', '<script>alert(1)</script>'],
    ['slash', 'abcd1234/other'],
    ['empty', ''],
  ])('discards a %s id and generates a UUID', async (_label, candidate) => {
    const app = await appFor();

    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
      headers: { 'x-request-id': candidate },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toMatch(UUID_V4);
    expect(response.headers['x-request-id']).not.toBe(candidate);
    expect(response.json().requestId).toBe(response.headers['x-request-id']);
  });

  it('ignores the legacy Fastify `request-id` header (no unvalidated shortcut)', async () => {
    const app = await appFor();

    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
      headers: { 'request-id': 'request id with spaces' },
    });

    expect(response.headers['x-request-id']).toMatch(UUID_V4);
  });

  it('sends the header and body id on not-found responses too', async () => {
    const app = await appFor();
    const clientId = 'routeprobe-0001';

    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/does-not-exist',
      headers: { 'x-request-id': clientId },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['x-request-id']).toBe(clientId);
    expect(response.json()).toMatchObject({
      error: { code: 'NOT_FOUND', requestId: clientId },
    });
  });

  it('binds requestId to the access-log child logger and line', async () => {
    const { logger, entries } = createCaptureLogger();
    const app = await appFor({ server: { logger } });
    const clientId = 'logtrace-123456';

    await app.inject({
      method: 'GET',
      url: '/health/ready',
      headers: { 'x-request-id': clientId },
    });

    const accessLine = entries.find((entry) => entry.message === 'http.response');
    expect(accessLine).toBeDefined();
    expect(accessLine?.meta?.requestId).toBe(clientId);
    // The per-request child logger itself carries the id (not only the meta).
    expect(accessLine?.bindings.requestId).toBe(clientId);
  });

  it('validates ids at the function level', () => {
    expect(REQUEST_ID_PATTERN.test('abcdefgh')).toBe(true);
    expect(REQUEST_ID_PATTERN.test('a.b_c-d')).toBe(false); // 7 chars
    expect(normalizeRequestId('a.b_c-d1')).toBe('a.b_c-d1');
    expect(normalizeRequestId('has space')).toBeNull();
    expect(normalizeRequestId(['valid-id-1', 'other-id-2'])).toBe('valid-id-1');
    expect(resolveRequestId('bad id')).toMatch(UUID_V4);
    expect(resolveRequestId('client-id-123')).toBe('client-id-123');
  });
});

/* ======================================================================== */
/* Readiness                                                                */
/* ======================================================================== */

describe('GET /health/ready', () => {
  it('answers 200 ready with every check ok (API-prefixed and root)', async () => {
    const app = await appFor();

    for (const url of ['/api/v1/health/ready', '/health/ready']) {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'ready',
        checks: { database: 'ok', redis: 'ok', storage: 'ok' },
      });
      expect(response.json().requestId).toBe(response.headers['x-request-id']);
      expect(response.headers['cache-control']).toContain('no-store');
    }
  });

  it('answers 503 degraded with an error marker per failing service', async () => {
    const app = await appFor({
      services: {
        health: {
          readiness: async () => ({
            status: 'degraded',
            checks: { database: 'ok', redis: 'error', storage: 'ok' },
            errors: { redis: 'redis connection refused' },
          }),
        },
      },
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      checks: { database: 'ok', redis: 'error', storage: 'ok' },
      errors: { redis: 'redis connection refused' },
    });
    expect(response.json().requestId).toBe(response.headers['x-request-id']);
  });

  it('keeps answering (503, no crash) when the readiness service throws', async () => {
    const app = await appFor({
      services: {
        health: {
          readiness: async () => {
            throw new Error('unexpected readiness failure');
          },
        },
      },
    });

    const failing = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(failing.statusCode).toBe(503);
    expect(failing.json()).toMatchObject({
      status: 'degraded',
      checks: { database: 'error', redis: 'error', storage: 'error' },
    });
    expect(failing.body).not.toContain('unexpected readiness failure');

    // The process/app is still usable after the failure.
    const after = await app.inject({ method: 'GET', url: '/status' });
    expect(after.statusCode).toBe(200);
  });
});

/* ======================================================================== */
/* Metrics                                                                  */
/* ======================================================================== */

describe('GET /api/v1/metrics', () => {
  it('answers 404 when METRICS_TOKEN is not configured', async () => {
    vi.stubEnv('METRICS_TOKEN', '');
    const app = await appFor();

    const response = await app.inject({ method: 'GET', url: '/api/v1/metrics' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('answers 401 for a missing or wrong token when configured', async () => {
    vi.stubEnv('METRICS_TOKEN', 'scrape-secret');
    const app = await appFor();

    const missing = await app.inject({ method: 'GET', url: '/api/v1/metrics' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe('AUTHENTICATION_ERROR');

    const wrongBearer = await app.inject({
      method: 'GET',
      url: '/api/v1/metrics',
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(wrongBearer.statusCode).toBe(401);

    const wrongHeader = await app.inject({
      method: 'GET',
      url: '/api/v1/metrics',
      headers: { 'x-metrics-token': 'not-the-token' },
    });
    expect(wrongHeader.statusCode).toBe(401);
  });

  it('answers 200 with Prometheus text format for the bearer token', async () => {
    const app = await appFor({ server: { metricsToken: 'scrape-secret' } });

    // One 2xx and one 4xx so the bounded counter has real series.
    await app.inject({ method: 'GET', url: '/health/ready' });
    await app.inject({ method: 'GET', url: '/health/ready/nope' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/metrics',
      headers: { authorization: 'Bearer scrape-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.headers['content-type']).toContain('version=0.0.4');
    expect(response.headers['cache-control']).toContain('no-store');

    const body = response.body;
    expect(body).toContain('# TYPE sac_http_requests_total counter');
    expect(body).toMatch(
      /sac_http_requests_total\{method="GET",status_class="2xx"\} \d+/,
    );
    expect(body).toMatch(
      /sac_http_requests_total\{method="GET",status_class="4xx"\} \d+/,
    );
    expect(body).toContain('# TYPE sac_http_request_duration_seconds histogram');
    expect(body).toMatch(/sac_http_request_duration_seconds_bucket\{le="0\.005"\} \d+/);
    expect(body).toMatch(/sac_http_request_duration_seconds_bucket\{le="\+Inf"\} \d+/);
    expect(body).toMatch(/sac_http_request_duration_seconds_sum \d+\.\d+/);
    expect(body).toMatch(/sac_http_request_duration_seconds_count \d+/);
    expect(body).toMatch(/sac_process_uptime_seconds \d+\.\d+/);
    // The ready probe just ran and fed the dependency gauges.
    expect(body).toContain('sac_db_up 1');
    expect(body).toContain('sac_redis_up 1');
    expect(body).toContain('sac_storage_up 1');
  });

  it('accepts the x-metrics-token alternative', async () => {
    const app = await appFor({ server: { metricsToken: 'scrape-secret' } });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/metrics',
      headers: { 'x-metrics-token': 'scrape-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('sac_process_uptime_seconds');
  });

  it('never exposes the metrics route without a configured token', async () => {
    vi.stubEnv('METRICS_TOKEN', '   ');
    const app = await appFor();

    const response = await app.inject({ method: 'GET', url: '/api/v1/metrics' });
    expect(response.statusCode).toBe(404);
  });
});

/* ======================================================================== */
/* Global rate-limit exemptions                                            */
/* ======================================================================== */

describe('global rate-limit exemptions', () => {
  it('exempts the probes, the status page and the scrape path (exact paths only)', () => {
    for (const path of [
      '/health',
      '/health/ready',
      '/api/v1/health',
      '/api/v1/health/ready',
      '/status',
      '/api/v1/status',
      '/metrics',
      '/api/v1/metrics',
      '/socket.io/?EIO=4',
    ]) {
      expect(isGlobalRateLimitExemptPath(path)).toBe(true);
    }

    for (const path of [
      '/api/v1/agents',
      '/status/private',
      '/api/v1/health/ready/extra',
      '/api/v1/metrics/extra',
    ]) {
      expect(isGlobalRateLimitExemptPath(path)).toBe(false);
    }
  });

  it('does not consume the global bucket on health probes', async () => {
    const incr = vi.fn(async () => 1);
    const cache = {
      incr,
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
      ttl: async () => 0,
    };
    const app = await appFor({ services: { cache } });

    for (const url of ['/health', '/health/ready', '/api/v1/health/ready', '/status']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
    }
    expect(incr).not.toHaveBeenCalled();

    // Any other route still passes through the global shield.
    const limited = await app.inject({ method: 'GET', url: '/api/v1/agents' });
    expect(limited.statusCode).toBe(401);
    expect(incr).toHaveBeenCalledTimes(1);
  });
});
