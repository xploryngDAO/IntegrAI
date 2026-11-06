import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AuthenticationError, NotFoundError } from '@sac/shared';
import type { HttpRouteContext, HttpServerOptions } from '../types';
import { extractBearerToken } from '../middleware/auth';

/**
 * ============================================================================
 * Prometheus scrape endpoint (`GET /api/v1/metrics`)
 * ============================================================================
 *
 * Disabled by default: without `METRICS_TOKEN` the route answers 404, so a
 * deployment that never opted in does not advertise an operational surface.
 *
 * When the token IS configured, either credential is accepted:
 *   - `Authorization: Bearer <METRICS_TOKEN>` (Prometheus `authorization`);
 *   - `x-metrics-token: <METRICS_TOKEN>` (simpler scrape configs / curl).
 *
 * The comparison is constant-time over SHA-256 digests (equal-length inputs for
 * `timingSafeEqual`, and no early return on length), so a wrong token leaks
 * neither its length nor a byte-by-byte prefix.
 *
 * The body is Prometheus text format 0.0.4 and no dependency is involved: the
 * counters are in memory and the dependency gauges were recorded by the last
 * readiness probe.
 */

export const METRICS_PATH = '/metrics';
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * Resolves the configured token.
 *
 * `HttpServerOptions.metricsToken` (built from config) wins; the direct
 * `process.env` read is the fallback for callers that construct
 * `buildHttpApp` themselves (tests, scripts). Empty/whitespace disables.
 */
export function resolveMetricsToken(options: HttpServerOptions): string | null {
  const configured = (options.metricsToken ?? process.env.METRICS_TOKEN ?? '').trim();
  return configured.length > 0 ? configured : null;
}

/** Constant-time token equality (digests have a fixed 32-byte length). */
export function metricsTokenMatches(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/** Reads `x-metrics-token` (first value when duplicated/array). */
function readMetricsHeader(request: FastifyRequest): string | null {
  const raw = request.headers['x-metrics-token'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const metricsRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  app.get(METRICS_PATH, async (request, reply) => {
    const expected = resolveMetricsToken(ctx.options);
    // Not configured -> behave as if the route did not exist (no oracle).
    if (expected === null) {
      throw new NotFoundError('Metrics');
    }

    const provided =
      extractBearerToken(request.headers.authorization) ?? readMetricsHeader(request);
    if (provided === null || !metricsTokenMatches(provided, expected)) {
      throw new AuthenticationError('A valid metrics token is required');
    }

    const body = ctx.metrics.render();
    reply.type(METRICS_CONTENT_TYPE);
    // Scrapes must never be cached by an intermediate proxy.
    reply.header('cache-control', 'no-store');
    return body;
  });
};
