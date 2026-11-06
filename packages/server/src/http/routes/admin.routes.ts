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
  app.patch('/users/:id', { preHandler: adminOnly }, controllers.updateUser);
  app.post(
    '/users/:id/revoke-sessions',
    { preHandler: adminOnly },
    controllers.revokeUserSessions,
  );
  app.get('/audit-logs', { preHandler: adminOnly }, controllers.listAuditLogs);
};
