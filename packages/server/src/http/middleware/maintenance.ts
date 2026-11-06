import type { FastifyInstance } from 'fastify';
import { MaintenanceError, type ILogger, type MaintenanceState } from '@sac/shared';

import { API_PREFIX } from '../constants';
import { stripQuery } from '../utils/query';

/**
 * ============================================================================
 * Controlled maintenance window (`MAINTENANCE_MODE`)
 * ============================================================================
 *
 * One `onRequest` hook in front of the API surface. While the window is open,
 * every route under `/api/v1` is refused with `503 MAINTENANCE` + `Retry-After`
 * BEFORE the rate limiter, the body parsers, the auth guard or any controller
 * runs, so a blocked request is as cheap as a header write.
 *
 * Deliberate exemptions (exact paths, mirroring the global rate-limit shield):
 *
 *  - `/health`, `/health/ready` (bare + `/api/v1/...`): an orchestrator must
 *    keep probing and restarting; a maintenance window is not an outage;
 *  - `/status` (bare + `/api/v1/status`): the public status page must be able to
 *    announce the window;
 *  - `/metrics` + `/api/v1/metrics`: the Prometheus scrape must keep observing
 *    the process (and its own 503 ratio) while operators are locked out.
 *
 * Everything else OUTSIDE `/api/v1` is untouched on purpose: marketplace
 * webhooks (`/webhooks/*`) carry events that cannot be replayed at will, so
 * they keep flowing and being enqueued while the operator UI is blocked.
 * `/socket.io` never reaches Fastify - the realtime hub refuses the handshake at
 * the Engine.IO layer (see `realtime-hub.ts`).
 *
 * The hook is registered AFTER `@fastify/cors` and helmet: a cross-origin SPA
 * must still READ the 503 body (CORS headers) and the security headers, and it
 * runs BEFORE the content-type guard / global rate limiter, which therefore
 * never consume a bucket for traffic that cannot succeed anyway.
 */

/**
 * Paths that keep answering during maintenance.
 *
 * Exact match only: `/api/v1/health/ready/extra` is NOT exempt and falls back to
 * the 503 (there is nothing to serve there anyway). The bare probes/`/status`
 * are outside `/api/v1` and therefore never guarded, but they are listed for
 * symmetry with `isGlobalRateLimitExemptPath`.
 */
export const MAINTENANCE_EXEMPT_PATHS: readonly string[] = [
  '/health',
  '/health/ready',
  '/status',
  '/metrics',
  '/api/v1/health',
  '/api/v1/health/ready',
  '/api/v1/status',
  '/api/v1/metrics',
];

/** True when the path is one of the monitoring surfaces kept alive. */
export function isMaintenanceExemptPath(pathname: string): boolean {
  return MAINTENANCE_EXEMPT_PATHS.includes(pathname);
}

/**
 * True when a request to `pathname` must be refused with `503 MAINTENANCE`.
 *
 * Only the `/api/v1` surface is guarded - including its OAuth callbacks and the
 * billing webhook; `/webhooks/*` and the bare probes are not.
 */
export function isMaintenanceBlockedPath(pathname: string): boolean {
  if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) return false;
  return !isMaintenanceExemptPath(pathname);
}

export interface MaintenanceGuardOptions {
  /** Resolved `MAINTENANCE_MODE` + `MAINTENANCE_MESSAGE` (see `resolveMaintenanceState`). */
  state: MaintenanceState;
  logger: ILogger;
}

/**
 * Registers the guard. The hook is always installed and short-circuits when the
 * window is closed, so the exact same wiring is exercised by tests in both
 * modes (and a future runtime toggle only has to mutate `state.enabled`).
 */
export function registerMaintenanceGuard(
  app: FastifyInstance,
  options: MaintenanceGuardOptions,
): void {
  app.addHook('onRequest', async (request) => {
    if (!options.state.enabled) return;
    // CORS preflight is answered by `@fastify/cors` before this hook; skipping
    // OPTIONS defensively keeps a browser preflight from turning into a 503
    // (the ACTUAL request that follows is still refused).
    if (request.method === 'OPTIONS') return;

    const path = stripQuery(request.url);
    if (!isMaintenanceBlockedPath(path)) return;

    (request.logContext ?? options.logger).debug('http.maintenance_blocked', {
      requestId: request.id,
      method: request.method,
      path,
    });

    // Thrown, not sent here: the global error handler renders the contract body
    // (`{ error: { code, message, requestId } }`) and the `Retry-After` header.
    throw new MaintenanceError(options.state.message);
  });
}
