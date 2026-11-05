import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createDiagnosticsControllers } from '../controllers/diagnostics.controller';
import { requireRole } from '../middleware/auth';

/**
 * `/api/v1` diagnostics (contract §9) - ADMIN only.
 *
 * `GET /diagnostics` exercises infrastructure + every connected account;
 * `POST /accounts/:id/diagnose` runs the real token exchange / seller reads for a
 * single account. Both are mounted here (instead of the accounts router) so the
 * diagnostics surface - including its 30s deadline - is defined in one place.
 */
export const diagnosticsRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createDiagnosticsControllers(ctx);
  const adminOnly = requireRole('ADMIN');

  app.get('/diagnostics', { preHandler: adminOnly }, controllers.system);
  app.post('/accounts/:id/diagnose', { preHandler: adminOnly }, controllers.account);
};
