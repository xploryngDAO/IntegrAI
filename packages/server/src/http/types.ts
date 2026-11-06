import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IAppServices, ILogger } from '@sac/shared';
import type { RealtimeHub } from './realtime-hub';

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
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Present on every route except the public allowlist (see middleware/auth.ts). */
    agent?: AuthenticatedAgent;
    /** Exact request bytes captured by the content-type parsers (webhook HMAC). */
    rawBody?: Buffer;
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
}

/** Everything a route module needs; also the Fastify plugin options contract. */
export interface HttpRouteContext {
  services: IAppServices;
  hub: RealtimeHub;
  options: HttpServerOptions;
}

/**
 * Framework-agnostic handler signature used by the controller factories so the
 * route modules stay pure wiring.
 */
export type RouteHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
