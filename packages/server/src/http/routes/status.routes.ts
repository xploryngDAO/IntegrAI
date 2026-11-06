import type { FastifyPluginAsync } from 'fastify';
import type { SystemStatusSnapshot } from '@sac/shared';
import type { HttpRouteContext } from '../types';

/**
 * Public status page endpoints.
 *
 * Mounted twice (same plugin, like `/health`):
 *  - bare `/status` for the public page / external monitors;
 *  - `/api/v1/status` because the SPA's API client is prefixed with `/api/v1`.
 *
 * Both are in the auth allowlist (no JWT): the page must render for an
 * anonymous visitor and even when the credential gate is unreachable. The
 * payload is flat (no `{ data }` envelope) because it is a public contract
 * consumed by the status page, not an internal console endpoint.
 *
 * Always HTTP 200: the availability is carried in `status`, and an anonymous
 * monitor should not treat "degraded" as a transport failure. The body is
 * PII-free (aggregated channel counters + infra probe results only).
 */
export const statusRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const { services } = ctx;
  const log = services.logger.child({ component: 'http.status' });

  app.get('/status', async (request, reply) => {
    try {
      const snapshot = await services.status.snapshot();
      reply.header('cache-control', 'public, max-age=30');
      return snapshot;
    } catch (error) {
      // The service already degrades per probe; reaching this branch means the
      // snapshot itself failed. Answer a conservative `down` instead of a 500
      // so the public page keeps working.
      log.error('status.snapshot_failed', {
        requestId: request.id,
        error: error instanceof Error ? error.message.slice(0, 300) : 'unknown error',
      });

      const fallback: SystemStatusSnapshot = {
        status: 'down',
        checkedAt: services.clock.now().toISOString(),
        services: [
          { name: 'api', status: 'operational', latencyMs: null },
          { name: 'database', status: 'down', latencyMs: null },
          { name: 'redis', status: 'down', latencyMs: null },
          { name: 'storage', status: 'down', latencyMs: null },
        ],
        channels: [],
      };
      reply.header('cache-control', 'no-store');
      return fallback;
    }
  });
};
