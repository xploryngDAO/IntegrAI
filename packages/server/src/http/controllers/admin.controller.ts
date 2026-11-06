import type { AuditActorContext } from '@sac/shared';
import type { FastifyRequest } from 'fastify';
import type { HttpRouteContext, RouteHandler } from '../types';
import {
  adminUserParamsSchema,
  auditLogQuerySchema,
  updateAdminUserBodySchema,
} from '../schemas';
import { parseInput } from '../schemas/common';
import { ok } from '../responses';
import { requireAgent, requireTenantId } from '../middleware/auth';

/**
 * `/admin/*` - workspace administration (ADMIN only).
 *
 * The role gate is applied by the route module (`requireRole('ADMIN')`); every
 * handler re-resolves the tenant from the JWT (`requireTenantId`) so a tenant id
 * can never come from the path/body. Cross-tenant user ids are answered 404 by
 * the service, never 403.
 */
export interface AdminControllers {
  listUsers: RouteHandler;
  updateUser: RouteHandler;
  revokeUserSessions: RouteHandler;
  listAuditLogs: RouteHandler;
}

/** Request provenance attached to every audited administrative mutation. */
export function auditActorContext(request: FastifyRequest): AuditActorContext {
  const agent = requireAgent(request);
  const header = request.headers['user-agent'];
  return {
    id: agent.id,
    email: agent.email,
    tenantId: agent.tenantId,
    ip: request.ip,
    userAgent: typeof header === 'string' ? header : null,
  };
}

export function createAdminControllers(ctx: HttpRouteContext): AdminControllers {
  const { services } = ctx;

  return {
    /** `GET /admin/users` - tenant-scoped team list, ordered by `createdAt`. */
    async listUsers(request) {
      const tenantId = requireTenantId(request);
      return ok(await services.adminUsers.list(tenantId));
    },

    /**
     * `PATCH /admin/users/:id` - role and/or active flag.
     *
     * 409 for self-change and for the last active ADMIN; 404 for a foreign
     * tenant; 422 for an empty/unknown body.
     */
    async updateUser(request) {
      const tenantId = requireTenantId(request);
      const params = parseInput(adminUserParamsSchema, request.params, 'params');
      const body = parseInput(updateAdminUserBodySchema, request.body, 'body');

      const user = await services.adminUsers.update(
        tenantId,
        auditActorContext(request),
        params.id,
        body,
      );
      return ok(user);
    },

    /** `POST /admin/users/:id/revoke-sessions` - 409 when the target is self. */
    async revokeUserSessions(request) {
      const tenantId = requireTenantId(request);
      const params = parseInput(adminUserParamsSchema, request.params, 'params');

      return ok(
        await services.adminUsers.revokeSessions(
          tenantId,
          auditActorContext(request),
          params.id,
        ),
      );
    },

    /** `GET /admin/audit-logs` - filtered, paginated, tenant-scoped. */
    async listAuditLogs(request) {
      const tenantId = requireTenantId(request);
      const query = parseInput(auditLogQuerySchema, request.query, 'query');
      return ok(await services.audit.list(tenantId, query));
    },
  };
}
