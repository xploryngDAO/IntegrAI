import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import {
  AuthenticationError,
  AuthorizationError,
  isAppError,
  type AgentRole,
  type IAgentService,
  type ILogger,
} from '@sac/shared';
import type { AuthenticatedAgent } from '../types';
import { stripQuery } from '../utils/query';

/** Routes reachable without a JWT (contract §7 + health probes + OAuth callback). */
const PUBLIC_EXACT_PATHS: readonly string[] = ['/health', '/api/v1/health', '/api/v1/auth/login'];

const OAUTH_CALLBACK_PATH = /^\/api\/v1\/accounts\/oauth\/[a-z]+\/callback$/;
const WEBHOOK_PREFIX = '/webhooks/';

function isPublicPath(path: string): boolean {
  if (PUBLIC_EXACT_PATHS.includes(path)) return true;
  if (path === '/webhooks' || path.startsWith(WEBHOOK_PREFIX)) return true;
  return OAUTH_CALLBACK_PATH.test(path);
}

/** Exposed for tests/greppability: decide whether a request skips authentication. */
export function isPublicRoute(method: string, url: string): boolean {
  if (method === 'OPTIONS') return true;
  return isPublicPath(stripQuery(url));
}

function extractBearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  const token = match?.[1]?.trim();
  return token !== undefined && token.length > 0 ? token : null;
}

export interface AuthGuardOptions {
  agents: IAgentService;
  logger: ILogger;
}

/**
 * Global JWT preHandler.
 *
 * `IAppServices.agents.verifyToken` is the single source of truth for token
 * validity (it owns the signing secret and revocation policy); the HTTP layer
 * only strips the bearer scheme and attaches the principal.
 */
export function registerAuthGuard(app: FastifyInstance, options: AuthGuardOptions): void {
  const log = options.logger.child({ component: 'http.auth' });

  app.addHook('preHandler', async (request) => {
    if (isPublicRoute(request.method, request.url)) return;

    const token = extractBearerToken(request.headers.authorization);
    if (token === null) {
      throw new AuthenticationError('Missing Authorization bearer token');
    }

    try {
      const claims = await options.agents.verifyToken(token);
      request.agent = {
        id: claims.agentId,
        email: claims.email,
        name: claims.name,
        role: claims.role,
        tenantId: claims.tenantId,
      };
    } catch (error) {
      if (isAppError(error) && error.code === 'AUTHENTICATION_ERROR') throw error;
      log.warn('http.auth.rejected', {
        requestId: request.id,
        path: stripQuery(request.url),
        error: error instanceof Error ? error.name : 'unknown',
      });
      throw new AuthenticationError('Invalid or expired session token');
    }
  });
}

/** Resolve the authenticated principal or fail with 401 (defence in depth). */
export function requireAgent(request: FastifyRequest): AuthenticatedAgent {
  if (request.agent === undefined) {
    throw new AuthenticationError('Authenticated agent is required for this route');
  }
  return request.agent;
}

/**
 * Reusable role-based access control preHandler.
 *
 * Runs after the global JWT guard (which attaches `request.agent`), so route
 * modules can compose it per route:
 *
 * ```ts
 * app.get('/diagnostics', { preHandler: requireRole('ADMIN') }, controller.system);
 * ```
 *
 * Fails closed: an empty role list authorizes nobody.
 */
export function requireRole(...roles: readonly AgentRole[]): preHandlerHookHandler {
  return async (request) => {
    const agent = requireAgent(request);
    if (!roles.some((role) => role === agent.role)) {
      throw new AuthorizationError(`This route requires role: ${roles.join(' | ')}`);
    }
  };
}
