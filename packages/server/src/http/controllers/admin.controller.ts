import type { AuditActorContext } from '@sac/shared';
import { ADMIN_USERS_EXPORT_MAX_ROWS, AUDIT_EXPORT_MAX_ROWS } from '@sac/shared';
import type { FastifyRequest } from 'fastify';
import type { HttpRouteContext, RouteHandler } from '../types';
import {
  adminSessionListQuerySchema,
  adminUserExportQuerySchema,
  adminUserListQuerySchema,
  adminUserParamsSchema,
  auditExportQuerySchema,
  auditLogQuerySchema,
  invitationParamsSchema,
  sessionParamsSchema,
  updateAdminUserBodySchema,
} from '../schemas';
import { parseInput } from '../schemas/common';
import { ok } from '../responses';
import { requireAgent, requireTenantId } from '../middleware/auth';
import {
  adminUsersCsvFileName,
  auditCsvFileName,
  buildAdminUsersCsv,
  buildAuditCsv,
} from '../utils/csv';

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
  exportUsersCsv: RouteHandler;
  updateUser: RouteHandler;
  revokeUserSessions: RouteHandler;
  listSessions: RouteHandler;
  revokeSession: RouteHandler;
  listInvitations: RouteHandler;
  revokeInvitation: RouteHandler;
  resendInvitation: RouteHandler;
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
    /**
     * `GET /admin/users` - tenant-scoped team list, ordered by `createdAt`.
     *
     * Optional `search` (name/e-mail, case-insensitive), `role`, `status` and
     * 1-based `page`/`perPage` (default 25, max 100). The response carries the
     * FILTERED `total` plus the resolved pagination so the UI can compute the
     * number of pages.
     */
    async listUsers(request) {
      const tenantId = requireTenantId(request);
      const query = parseInput(adminUserListQuerySchema, request.query, 'query');
      return ok(await services.adminUsers.list(tenantId, query));
    },

    /**
     * `GET /admin/users/export.csv` - bounded CSV snapshot of the team.
     *
     * Same filters/tenant scope as `/users`, ordered by `createdAt` ascending,
     * capped at `ADMIN_USERS_EXPORT_MAX_ROWS` (10k). The raw string (not the
     * JSON envelope) is sent as an attachment.
     */
    async exportUsersCsv(request, reply) {
      const tenantId = requireTenantId(request);
      const query = parseInput(adminUserExportQuerySchema, request.query, 'query');

      const rows = await services.adminUsers.exportRows(
        tenantId,
        query,
        ADMIN_USERS_EXPORT_MAX_ROWS,
      );

      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header(
        'content-disposition',
        `attachment; filename=${adminUsersCsvFileName(services.clock.now())}`,
      );
      return reply.send(buildAdminUsersCsv(rows));
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

    /**
     * `GET /admin/sessions` - LIVE sessions of the workspace.
     *
     * Tenant always comes from the JWT; `page`/`perPage` are optional (default
     * 50, max 100). `current` is derived from the access-token `sid` claim, so
     * the console can mark the caller's own device.
     */
    async listSessions(request) {
      const tenantId = requireTenantId(request);
      const agent = requireAgent(request);
      const query = parseInput(adminSessionListQuerySchema, request.query, 'query');

      return ok(await services.adminUsers.listSessions(tenantId, query, agent.sessionId));
    },

    /**
     * `DELETE /admin/sessions/:id` - revokes ONE device of the workspace.
     *
     * 204 on success, 404 for an unknown/foreign/already-revoked id, 409 when
     * the id is the caller's own current session (`CANNOT_REVOKE_CURRENT_SESSION`)
     * and 422 for a malformed id.
     */
    async revokeSession(request, reply) {
      const tenantId = requireTenantId(request);
      const agent = requireAgent(request);
      const params = parseInput(sessionParamsSchema, request.params, 'params');

      await services.adminUsers.revokeSession(
        tenantId,
        auditActorContext(request),
        params.id,
        agent.sessionId,
      );

      reply.code(204);
      return undefined;
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

    /**
     * `POST /admin/invitations/:id/resend` - re-issues a PENDING/EXPIRED invite.
     *
     * 200 with the refreshed row envelope (status always `PENDING`), 404 when
     * the id is unknown or belongs to another tenant, 409
     * `INVITATION_ALREADY_ACCEPTED` once consumed, 502 `EMAIL_SEND_FAILED` when
     * the relay rejects the message (nothing was written).
     */
    async resendInvitation(request) {
      const tenantId = requireTenantId(request);
      const params = parseInput(invitationParamsSchema, request.params, 'params');
      // The audited provenance plus the display name used by the e-mail
      // template, exactly like `POST /invitations` obtains it from the JWT.
      const actor = { ...auditActorContext(request), name: requireAgent(request).name };

      const result = await services.invitations.resendForAdmin(
        tenantId,
        actor,
        params.id,
      );

      return ok({
        id: result.id,
        email: result.email,
        role: result.role,
        expiresAt: result.expiresAt.toISOString(),
        status: result.status,
      });
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
