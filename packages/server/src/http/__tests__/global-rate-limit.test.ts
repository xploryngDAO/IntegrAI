import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './http-test-harness';

/**
 * Global per-IP shield. It is configurable (`RATE_LIMIT_GLOBAL_PER_MINUTE`)
 * because a support team behind one corporate NAT legitimately bursts above the
 * old fixed 600/min. Probes/status/metrics stay exempt.
 */
const CLEANUP: FastifyInstance[] = [];

async function withApp(rateLimitGlobalPerMinute: number): Promise<FastifyInstance> {
  const app = await buildTestApp({ server: { rateLimitGlobalPerMinute } });
  CLEANUP.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map((app) => app.close()));
});

describe('global per-IP rate limit', () => {
  it('blocks the request after the configured limit and answers 429 RATE_LIMITED', async () => {
    const app = await withApp(3);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
      expect(response.statusCode).toBe(401);
    }

    const blocked = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error?.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('does not charge the exempt health probe', async () => {
    const app = await withApp(1);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(response.statusCode).toBe(200);
    }
  });
});
