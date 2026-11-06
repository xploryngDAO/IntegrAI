import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createTenantControllers } from '../controllers/tenant.controller';
import { createSsoControllers } from '../controllers/sso.controller';
import { requireRole } from '../middleware/auth';

/**
 * `/api/v1/tenants` - workspace self-service (Fase 2), enterprise SSO (Fase 5)
 * and LGPD privacy (Fase 4).
 *
 * `GET /me` is available to every authenticated role; `PATCH /me`, the export,
 * the delete and the whole `/me/sso` configuration are ADMIN-only, matching the
 * invitation/team surfaces. The global JWT guard has already attached
 * `request.agent` before these preHandlers run.
 */
export const tenantRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createTenantControllers(ctx);
  const sso = createSsoControllers(ctx);
  const adminOnly = requireRole('ADMIN');

  app.get('/me', controllers.get);
  app.patch('/me', { preHandler: adminOnly }, controllers.update);
  app.get('/me/export', { preHandler: adminOnly }, controllers.exportData);
  app.delete('/me', { preHandler: adminOnly }, controllers.remove);

  // Fase 5 - the workspace OpenID Connect connection. The client secret is
  // write-only and never returned by the read model.
  app.get('/me/sso', { preHandler: adminOnly }, sso.getConfig);
  app.put('/me/sso', { preHandler: adminOnly }, sso.updateConfig);
  app.post('/me/sso/test', { preHandler: adminOnly }, sso.testConnection);
  app.delete('/me/sso', { preHandler: adminOnly }, sso.deleteConfig);
};
