import type { AuditActorContext } from '@sac/shared';
import { AUDIT_EXPORT_MAX_ROWS } from '@sac/shared';
import type { FastifyRequest } from 'fastify';
import type { HttpRouteContext, RouteHandler } from '../types';
import {
  adminUserParamsSchema,
  auditExportQuerySchema,
  auditLogQuerySchema,
  invitationParamsSchema,
  updateAdminUserBodySchema,
} from '../schemas';
import { parseInput } from '../schemas/common';
import { ok } from '../responses';
import { requireAgent, requireTenantId } from '../middleware/auth';
import { auditCsvFileName, buildAuditCsv } from '../utils/csv';

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
  listInvitations: RouteHandler;
  revokeInvitation: RouteHandler;
  listAuditLogs: RouteHandler;
  exportAuditLogsCsv: RouteHandler;
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

    /** `GET /admin/invitations` - tenant invites, newest first, derived status. */
    async listInvitations(request) {
      const tenantId = requireTenantId(request);
      return ok(await services.invitations.listForAdmin(tenantId));
    },

    /**
     * `DELETE /admin/invitations/:id` - hard-deletes a pending invitation.
     *
     * 204 on success, 404 when the id is unknown or belongs to another tenant,
     * 409 `INVITATION_ALREADY_ACCEPTED` once consumed.
     */
    async revokeInvitation(request, reply) {
      const tenantId = requireTenantId(request);
      const params = parseInput(invitationParamsSchema, request.params, 'params');

      await services.invitations.revokeForAdmin(
        tenantId,
        auditActorContext(request),
        params.id,
      );

      reply.code(204);
      return undefined;
    },

    /** `GET /admin/audit-logs` - filtered, paginated, tenant-scoped. */
    async listAuditLogs(request) {
      const tenantId = requireTenantId(request);
      const query = parseInput(auditLogQuerySchema, request.query, 'query');
      return ok(await services.audit.list(tenantId, query));
    },

    /**
     * `GET /admin/audit-logs/export.csv` - bounded CSV snapshot.
     *
     * Same filters/tenant scope as `/audit-logs`, newest first, capped at
     * `AUDIT_EXPORT_MAX_ROWS` (10k). The raw string (not the JSON envelope) is
     * sent as an attachment; `metadata` is omitted by design.
     */
    async exportAuditLogsCsv(request, reply) {
      const tenantId = requireTenantId(request);
      const query = parseInput(auditExportQuerySchema, request.query, 'query');

      const rows = await services.audit.exportRows(
        tenantId,
        query,
        AUDIT_EXPORT_MAX_ROWS,
      );

      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header(
        'content-disposition',
        `attachment; filename=${auditCsvFileName(services.clock.now())}`,
      );
      return reply.send(buildAuditCsv(rows));
    },
  };
}
