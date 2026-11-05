import type { FastifyPluginAsync } from 'fastify';
import type { HealthReport } from '@sac/shared';
import type { HttpRouteContext } from '../types';
import { ok } from '../responses';

/**
 * Public health probe (`GET /health`).
 *
 * Mounted twice: bare (`/health`, for load balancers / container probes) and
 * under the API prefix (`/api/v1/health`, contract §4). `status: 'down'` answers
 * 503 so orchestrators can restart the container, but the body keeps the same
 * `{ data: HealthReport }` envelope.
 */
export const healthRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const { services } = ctx;
  const log = services.logger.child({ component: 'http.health' });

  app.get('/health', async (request, reply) => {
    try {
      const report = await services.health.health();
      reply.code(report.status === 'down' ? 503 : 200);
      return ok(report);
    } catch (error) {
      log.error('health.check_failed', {
        requestId: request.id,
        error: error instanceof Error ? error.message : 'unknown error',
      });

      const fallback: HealthReport = {
        status: 'down',
        uptimeSeconds: Math.round(process.uptime()),
        checks: [{ name: 'health_service', ok: false, detail: 'health service unavailable' }],
        channels: [],
      };
      reply.code(503);
      return ok(fallback);
    }
  });
};
