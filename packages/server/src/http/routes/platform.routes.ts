import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createPlatformControllers } from '../controllers/platform.controller';
import { requirePlatformAdmin } from '../middleware/auth';

/**
 * `/api/v1/platform` - internal console (Fase 4).
 *
 * Every route requires a valid JWT (global guard) AND `agents.is_platform_admin`
 * (re-checked in the database by `requirePlatformAdmin`): a regular tenant
 * ADMIN gets 403. There is no route that mutates a workspace on behalf of a
 * tenant user here.
 */
export const platformRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createPlatformControllers(ctx);
  const platformOnly = requirePlatformAdmin(ctx.services.platform);

  app.get('/tenants', { preHandler: platformOnly }, controllers.listTenants);
  app.patch('/tenants/:id', { preHandler: platformOnly }, controllers.updateTenant);
  app.get('/metrics', { preHandler: platformOnly }, controllers.metrics);
};
