import { AUDIT_ACTIONS, SSO_REDIRECTABLE_ERROR_CODES, isAppError } from '@sac/shared';
import type { AuthResponse, LoginSuccess } from '@sac/shared';
import type { FastifyRequest } from 'fastify';
import type { HttpRouteContext, RouteHandler } from '../types';
import {
  parseInput,
  ssoCallbackQuerySchema,
  ssoDiscoverQuerySchema,
  ssoExchangeBodySchema,
  ssoStartQuerySchema,
  updateSsoConnectionBodySchema,
} from '../schemas';
import { ok } from '../responses';
import { requireAgent, requireTenantId } from '../middleware/auth';
import { toAgentRole } from '../mappers';

/**
 * `/tenants/me/sso` (ADMIN) and the public `/auth/sso/*` flow.
 *
 * The configuration routes resolve the tenant EXCLUSIVELY from the JWT
 * (`requireTenantId`) and the role gate is applied by the route module, so a
 * caller can never read or rewrite another workspace's IdP.
 *
 * The public routes are intentionally redirect-based (browser flow):
 *  - `start` answers 302 to the IdP authorization endpoint;
 *  - `callback` answers 302 to the SPA callback with a ONE-TIME code, or with a
 *    stable `?error=<code>` for failures that happened after the state was
 *    validated (never a raw JSON page in the middle of a login).
 */
export interface SsoControllers {
  getConfig: RouteHandler;
  updateConfig: RouteHandler;
  deleteConfig: RouteHandler;
  discover: RouteHandler;
  start: RouteHandler;
  callback: RouteHandler;
  exchange: RouteHandler;
}

/** Same `AuthResponse` contract used by login/refresh/2FA. */
function toAuthResponse(result: LoginSuccess): AuthResponse {
  return {
    token: result.token,
    ...(result.refreshToken !== undefined ? { refreshToken: result.refreshToken } : {}),
    agent: {
      id: result.agent.id,
      name: result.agent.name,
      email: result.agent.email,
      role: toAgentRole(result.agent.role),
      presence: result.agent.presence,
      tenantId: result.agent.tenantId,
    },
  };
}

function userAgentOf(request: FastifyRequest): string | null {
  const header = request.headers['user-agent'];
  return typeof header === 'string' ? header : null;
}

export function createSsoControllers(ctx: HttpRouteContext): SsoControllers {
  const { services } = ctx;

  return {
    /** `GET /tenants/me/sso` (ADMIN) - config without the secret. */
    async getConfig(request) {
      const tenantId = requireTenantId(request);
      return ok(await services.tenantSso.get(tenantId));
    },

    /** `PUT /tenants/me/sso` (ADMIN) - upsert; the secret is write-only. */
    async updateConfig(request) {
      const agent = requireAgent(request);
      const tenantId = requireTenantId(request);
      const body = parseInput(updateSsoConnectionBodySchema, request.body, 'body');
      const view = await services.tenantSso.update(tenantId, body);

      services.audit?.record({
        action: AUDIT_ACTIONS.tenantSsoUpdated,
        tenantId,
        actorId: agent.id,
        actorEmail: agent.email,
        ip: request.ip,
        userAgent: userAgentOf(request),
        resourceType: 'tenant_sso',
        resourceId: tenantId,
        // Never the client secret: only whether it rotated and the non-secret
        // switches the operator changed.
        metadata: {
          provider: view?.provider ?? null,
          enabled: view?.enabled ?? null,
          enforceSso: view?.enforceSso ?? null,
          autoProvision: view?.autoProvision ?? null,
          defaultRole: view?.defaultRole ?? null,
          secretRotated: body.clientSecret !== undefined,
        },
      });

      return ok(view);
    },

    /** `DELETE /tenants/me/sso` (ADMIN) - 204, or 404 when nothing existed. */
    async deleteConfig(request, reply) {
      const agent = requireAgent(request);
      const tenantId = requireTenantId(request);
      await services.tenantSso.remove(tenantId);

      services.audit?.record({
        action: AUDIT_ACTIONS.tenantSsoDeleted,
        tenantId,
        actorId: agent.id,
        actorEmail: agent.email,
        ip: request.ip,
        userAgent: userAgentOf(request),
        resourceType: 'tenant_sso',
        resourceId: tenantId,
      });

      reply.code(204);
      return undefined;
    },

    /** `GET /auth/sso/discover` (public) - routing only, no secret. */
    async discover(request) {
      const query = parseInput(ssoDiscoverQuerySchema, request.query, 'query');
      return ok(
        await services.tenantSso.discover({
          ...(query.email !== undefined ? { email: query.email } : {}),
          ...(query.domain !== undefined ? { domain: query.domain } : {}),
          ip: request.ip,
        }),
      );
    },

    /** `GET /auth/sso/start` (public) - 302 to the IdP with state/nonce/PKCE. */
    async start(request, reply) {
      const query = parseInput(ssoStartQuerySchema, request.query, 'query');
      const result = await services.sso.start({
        email: query.email,
        ...(query.provider !== undefined ? { provider: query.provider } : {}),
        ip: request.ip,
      });
      return reply.redirect(result.authorizationUrl, 302);
    },

    /**
     * `GET /auth/sso/callback` (public).
     *
     * Success: 302 `<WEB_ORIGIN>/auth/sso/callback?code=<one-time>`.
     * Post-state failure: 302 `<WEB_ORIGIN>/auth/sso/callback?error=<code>`.
     * Invalid/forged/replayed state: 400 `SSO_STATE_INVALID` (no redirect, the
     * target would be attacker-influenced).
     */
    async callback(request, reply) {
      const query = parseInput(ssoCallbackQuerySchema, request.query, 'query');

      try {
        const result = await services.sso.callback({
          ...(query.code !== undefined ? { code: query.code } : {}),
          state: query.state,
          ...(query.error !== undefined ? { error: query.error } : {}),
          ip: request.ip,
          userAgent: userAgentOf(request),
        });
        return reply.redirect(result.redirectUrl, 302);
      } catch (error) {
        if (isAppError(error) && SSO_REDIRECTABLE_ERROR_CODES.includes(error.code)) {
          return reply.redirect(services.sso.failureRedirect(error.code), 302);
        }
        throw error;
      }
    },

    /** `POST /auth/sso/exchange` (public) - one-time code -> AuthResponse. */
    async exchange(request) {
      const body = parseInput(ssoExchangeBodySchema, request.body, 'body');
      const result = await services.sso.exchange({
        code: body.code,
        ip: request.ip,
        userAgent: userAgentOf(request),
      });
      return ok(toAuthResponse(result));
    },
  };
}
