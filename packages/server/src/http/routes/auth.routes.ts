import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createAuthControllers } from '../controllers/auth.controller';

/**
 * `/api/v1/auth` - login, identity, presence and the Fase 1 public self-service
 * flows (signup, e-mail verification and verification resend).
 */
export const authRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createAuthControllers(ctx);
  app.post('/login', controllers.login);
  app.post('/signup', controllers.signup);
  app.post('/verify-email', controllers.verifyEmail);
  app.post('/resend-verification', controllers.resendVerification);
  app.get('/me', controllers.me);
  app.put('/presence', controllers.setPresence);
};
