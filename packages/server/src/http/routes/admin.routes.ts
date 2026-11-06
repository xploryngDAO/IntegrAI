import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createAdminControllers } from '../controllers/admin.controller';
import { requireRole } from '../middleware/auth';

/**
 * `/api/v1/admin` - workspace administration.
 *
 * Every route is ADMIN-only: the global JWT guard attaches `request.agent` and
 * `requireRole('ADMIN')` runs right after it, so AGENT/SUPERVISOR get a 403 and
 * an unauthenticated caller gets a 401. A platform admin without a tenant ADMIN
 * role is also rejected (this surface is tenant-scoped).
 */
export const adminRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createAdminControllers(ctx);
  const adminOnly = requireRole('ADMIN');

  app.get('/users', { preHandler: adminOnly }, controllers.listUsers);
  // Declared right after `/users`: the static child never shadows the parent.
  app.get(
    '/users/export.csv',
    { preHandler: adminOnly },
    controllers.exportUsersCsv,
  );
  app.patch('/users/:id', { preHandler: adminOnly }, controllers.updateUser);
  app.post(
    '/users/:id/revoke-sessions',
    { preHandler: adminOnly },
    controllers.revokeUserSessions,
  );
  app.get('/invitations', { preHandler: adminOnly }, controllers.listInvitations);
  app.post(
    '/invitations/:id/resend',
    { preHandler: adminOnly },
    controllers.resendInvitation,
  );
  app.delete(
    '/invitations/:id',
    { preHandler: adminOnly },
    controllers.revokeInvitation,
  );
  // Live session inventory of the workspace (one row per signed-in device).
  app.get('/sessions', { preHandler: adminOnly }, controllers.listSessions);
  app.delete('/sessions/:id', { preHandler: adminOnly }, controllers.revokeSession);
  app.get('/audit-logs', { preHandler: adminOnly }, controllers.listAuditLogs);
  // Declared after `/audit-logs`: the static children never shadow the parent.
  app.get(
    '/audit-logs/export.csv',
    { preHandler: adminOnly },
    controllers.exportAuditLogsCsv,
  );
};
