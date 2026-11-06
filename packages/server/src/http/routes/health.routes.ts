import type { FastifyPluginAsync } from 'fastify';
import type { HealthReport, ReadinessReport } from '@sac/shared';
import type { HttpRouteContext } from '../types';
import { ok } from '../responses';

/**
 * Public health probes.
 *
 * Mounted twice: bare (`/health`, `/health/ready` for load balancers / container
 * probes) and under the API prefix (`/api/v1/health`, `/api/v1/health/ready`,
 * contract §4).
 *
 *  - `/health` is the deep report: `status: 'down'` answers 503 so orchestrators
 *    can restart the container, but the body keeps the `{ data: HealthReport }`
 *    envelope.
 *  - `/health/ready` is the dependency readiness gate: 200 `ready` when
 *    Postgres/Redis/S3 all answer, 503 `degraded` with a per-dependency
 *    `ok`/`error` map otherwise. Each probe is bounded to ~2 s inside
 *    `HealthService.readiness()`, and the handler catches everything: a probe
 *    failure is data, never a crash or an unhandled rejection.
 */
export const healthRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const { services, metrics } = ctx;
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

  app.get('/health/ready', async (request, reply) => {
    // Never cache a readiness verdict: a stale 503/200 misleads the scheduler.
    reply.header('cache-control', 'no-store');

    let report: ReadinessReport;
    try {
      report = await services.health.readiness();
    } catch (error) {
      // The service is written not to throw; this is the last-resort boundary
      // that keeps the probe answering (and the process alive) if it ever does.
      log.error('health.readiness_failed', {
        requestId: request.id,
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown error',
      });
      report = {
        status: 'degraded',
        checks: { database: 'error', redis: 'error', storage: 'error' },
        errors: {
          database: 'readiness check failed',
          redis: 'readiness check failed',
          storage: 'readiness check failed',
        },
      };
    }

    // Feed the Prometheus gauges from the probe that just ran: the scrape stays
    // synchronous/cheap and always reports the latest known dependency state.
    metrics.setDependencyUp('db', report.checks.database === 'ok');
    metrics.setDependencyUp('redis', report.checks.redis === 'ok');
    metrics.setDependencyUp('storage', report.checks.storage === 'ok');

    reply.code(report.status === 'ready' ? 200 : 503);
    return { ...report, requestId: request.id };
  });

  /**
   * `GET /version` (bare + `/api/v1/version`) - which build is answering.
   *
   * Ops/deploy verification: the commit comes from GIT_SHA/VERCEL_GIT_COMMIT_SHA
   * (set by the image/CI); `uptimeSeconds` matches the health report. Public and
   * PII-free (no environment values beyond NODE_ENV).
   */
  app.get('/version', async () => {
    const uptimeSeconds = Math.round(process.uptime());
    return ok({
      version: process.env.npm_package_version ?? '1.0.0',
      commit:
        process.env.GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      node: process.version,
      env: process.env.NODE_ENV ?? 'development',
      uptimeSeconds,
      startedAt: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
    });
  });
};
