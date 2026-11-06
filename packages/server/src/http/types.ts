import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IAppServices, ILogger } from '@sac/shared';
import type { RealtimeHub } from './realtime-hub';
import type { MetricsRegistry } from './metrics/registry';

/**
 * The authenticated principal attached by the JWT preHandler.
 * Mirrors `IAgentService.verifyToken` claims - never carries the raw token.
 */
export interface AuthenticatedAgent {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string | null;
  /** Fase 4: JWT claim for UI gating; `/platform/*` re-checks the database. */
  isPlatformAdmin: boolean;
  /**
   * P0: access-token id (`jti`) and expiry (`exp`, Unix seconds) so
   * `POST /auth/logout` can denylist THIS token for what is left of its life.
   * Optional for legacy tokens minted before the revocation feature.
   */
  jti?: string;
  tokenExpiresAt?: number;
  /** Refresh-session row that issued this token (`GET /auth/sessions`). */
  sessionId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Present on every route except the public allowlist (see middleware/auth.ts). */
    agent?: AuthenticatedAgent;
    /** Exact request bytes captured by the content-type parsers (webhook HMAC). */
    rawBody?: Buffer;
    /**
     * Per-request child logger bound with `requestId` (see middleware/request-id).
     * Decorated with `null` so Fastify's prototype stays clean.
     */
    logContext?: ILogger | null;
  }
}

/** Constructor options for `buildHttpApp`; frozen by the core-engine integration. */
export interface HttpServerOptions {
  jwtSecret: string;
  webOrigin: string;
  appBaseUrl: string;
  logger: ILogger;
  maxUploadBytes?: number;
  /**
   * Fastify `trustProxy` (client IP behind an edge).
   *
   * Defaults to `false` (socket address) - see `TRUST_PROXY` in
   * `config/env.schema.ts` and `docs/SECURITY.md` §6.8. `true` is only safe when
   * the API cannot be reached except through a proxy that overwrites
   * `X-Forwarded-For`; prefer the explicit IP/CIDR list.
   */
  trustProxy?: boolean | string[];
  /**
   * Global per-IP HTTP shield in requests/minute (all routes except the
   * probes/status/metrics). Defaults to 1800 (~30 req/s), so an office behind
   * one corporate NAT does not trip the shield during normal bursts; the auth
   * routes keep their own stricter buckets on top of it.
   */
  rateLimitGlobalPerMinute?: number;
  /**
   * Prometheus scrape token (`METRICS_TOKEN`).
   *
   * `undefined`/empty disables `GET /api/v1/metrics` (404). When set, the route
   * requires `Authorization: Bearer <token>` or `x-metrics-token: <token>`.
   * `buildHttpApp` falls back to `process.env.METRICS_TOKEN` so a deployment
   * that only sets the environment variable works without extra wiring.
   */
  metricsToken?: string;
  /**
   * Controlled maintenance window (`MAINTENANCE_MODE`).
   *
   * While true, `buildHttpApp` answers `503 MAINTENANCE` for every `/api/v1`
   * route except the probes (`/health`, `/health/ready`), `/status` and the
   * Prometheus scrape (`/api/v1/metrics`). The marketplace webhooks
   * (`/webhooks/*`, outside the prefix) are never blocked so push events are
   * not lost. Missing/false keeps normal operation.
   */
  maintenanceMode?: boolean;
  /**
   * Operator-facing text of the maintenance 503 (`MAINTENANCE_MESSAGE`).
   * Missing/empty falls back to `DEFAULT_MAINTENANCE_MESSAGE`.
   */
  maintenanceMessage?: string;
}

/** Everything a route module needs; also the Fastify plugin options contract. */
export interface HttpRouteContext {
  services: IAppServices;
  hub: RealtimeHub;
  options: HttpServerOptions;
  /** Process-wide HTTP/dependency metrics scraped by `GET /api/v1/metrics`. */
  metrics: MetricsRegistry;
}

/**
 * Framework-agnostic handler signature used by the controller factories so the
 * route modules stay pure wiring.
 */
export type RouteHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
