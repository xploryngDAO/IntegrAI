import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './http-test-harness';
import { MAINTENANCE_EXEMPT_PATHS } from '../middleware/maintenance';

/**
 * Public build identity used by deploy verification (`/version`). It must be
 * reachable without a token, mounted both bare and under `/api/v1`, and stay
 * exempt from maintenance mode like the other probes.
 */
const CLEANUP: FastifyInstance[] = [];

async function withApp(): Promise<FastifyInstance> {
  const app = await buildTestApp();
  CLEANUP.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map((app) => app.close()));
});

describe('GET /version', () => {
  it('answers the build identity on the bare and API-prefixed paths', async () => {
    const app = await withApp();

    for (const url of ['/version', '/api/v1/version']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);

      const data = response.json().data;
      expect(typeof data.version).toBe('string');
      expect(data.version.length).toBeGreaterThan(0);
      expect(typeof data.node).toBe('string');
      expect(data.node).toMatch(/^v\d+/);
      expect(typeof data.env).toBe('string');
      expect(typeof data.uptimeSeconds).toBe('number');
      expect(data.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(typeof data.startedAt).toBe('string');
      expect(Number.isNaN(Date.parse(data.startedAt))).toBe(false);
      expect(data.commit === null || typeof data.commit === 'string').toBe(true);
    }
  });

  it('is exempt from maintenance mode', () => {
    expect(MAINTENANCE_EXEMPT_PATHS).toEqual(
      expect.arrayContaining(['/version', '/api/v1/version']),
    );
  });

  it('does not expose environment values beyond NODE_ENV', async () => {
    process.env.GIT_SHA = 'test-sha-123';
    try {
      const app = await withApp();
      const data = (await app.inject({ method: 'GET', url: '/api/v1/version' })).json().data;
      expect(data.commit).toBe('test-sha-123');
      expect(Object.keys(data).sort()).toEqual(
        ['commit', 'env', 'node', 'startedAt', 'uptimeSeconds', 'version'].sort(),
      );
    } finally {
      delete process.env.GIT_SHA;
    }
  });
});
