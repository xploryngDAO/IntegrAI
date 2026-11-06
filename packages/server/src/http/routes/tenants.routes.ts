import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createTenantControllers } from '../controllers/tenant.controller';
import { requireRole } from '../middleware/auth';

/**
 * `/api/v1/tenants` - workspace self-service (Fase 2) and LGPD privacy (Fase 4).
 *
 * `GET /me` is available to every authenticated role; `PATCH /me`, the export
 * and the delete are ADMIN-only, matching the invitation/team surfaces. The
 * global JWT guard has already attached `request.agent` before these
 * preHandlers run.
 */
export const tenantRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createTenantControllers(ctx);
  const adminOnly = requireRole('ADMIN');

  app.get('/me', controllers.get);
  app.patch('/me', { preHandler: adminOnly }, controllers.update);
  app.get('/me/export', { preHandler: adminOnly }, controllers.exportData);
  app.delete('/me', { preHandler: adminOnly }, controllers.remove);
};
