import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createInvitationControllers } from '../controllers/invitation.controller';
import { requireRole } from '../middleware/auth';

/**
 * `/api/v1/invitations` - operator invites (Fase 1).
 *
 * Every route is ADMIN-only: the global JWT guard attaches `request.agent` and
 * `requireRole('ADMIN')` runs right after it, so AGENT/SUPERVISOR get a 403.
 */
export const invitationRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createInvitationControllers(ctx);
  const adminOnly = requireRole('ADMIN');

  app.post('/', { preHandler: adminOnly }, controllers.create);
  app.get('/', { preHandler: adminOnly }, controllers.list);
  app.delete('/:id', { preHandler: adminOnly }, controllers.revoke);
};
