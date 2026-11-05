import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import {
  AuthenticationError,
  AuthorizationError,
  isAppError,
  type AgentRole,
  type IAgentService,
  type ILogger,
  type ITicketQueryService,
  NotFoundError,
} from '@sac/shared';
import type { AuthenticatedAgent } from '../types';
import { stripQuery } from '../utils/query';

/**
 * Routes reachable without a JWT (contract §7 + health probes + OAuth callback +
 * the Fase 1 self-service auth flows reachable before a session exists).
 */
const PUBLIC_EXACT_PATHS: readonly string[] = [
  '/health',
  '/api/v1/health',
  '/api/v1/auth/login',
  '/api/v1/auth/signup',
  '/api/v1/auth/verify-email',
  '/api/v1/auth/resend-verification',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  // Public by design: the invitation token itself proves the e-mail ownership.
  '/api/v1/auth/accept-invitation',
  // Refresh authenticates itself with the rotating opaque token in the body.
  '/api/v1/auth/refresh',
  // The short-lived challenge JWT in the body authenticates the second factor;
  // a full access token does not exist yet at this point.
  '/api/v1/auth/2fa/challenge',
];

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
  tickets: ITicketQueryService;
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

      // Mutations on a ticket must belong to the caller's tenant (404 otherwise).
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const match = /^\/api\/v1\/tickets\/([0-9a-fA-F-]{36})(?:\/|$)/.exec(stripQuery(request.url));
        if (match) {
          try {
            await options.tickets.getDetail(match[1], claims.tenantId);
          } catch {
            throw new NotFoundError('SupportTicket', match[1]);
          }
        }
      }
    } catch (error) {
      if (isAppError(error)) throw error;
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
 * Resolve the caller tenant for tenant-scoped routes (invitations, team, ...).
 *
 * A legacy operator without a tenant can authenticate but must not be able to
 * create rows that require `tenant_id`: fail with 403 instead of letting Prisma
 * reject the insert.
 */
export function requireTenantId(request: FastifyRequest): string {
  const agent = requireAgent(request);
  if (agent.tenantId === null || agent.tenantId === undefined || agent.tenantId.length === 0) {
    throw new AuthorizationError('Authenticated operator is not attached to a workspace');
  }
  return agent.tenantId;
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
