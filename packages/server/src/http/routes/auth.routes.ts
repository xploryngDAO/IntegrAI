import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createAuthControllers } from '../controllers/auth.controller';

/** `/api/v1/auth` - login, identity, presence. */
export const authRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createAuthControllers(ctx);
  app.post('/login', controllers.login);
  app.get('/me', controllers.me);
  app.put('/presence', controllers.setPresence);
};
