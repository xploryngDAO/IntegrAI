import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createAuthControllers } from '../controllers/auth.controller';

/**
 * `/api/v1/auth` - login, identity, presence and the Fase 1 self-service flows:
 * signup, e-mail verification (+resend), password reset (forgot/reset), operator
 * invitation acceptance and the rotating refresh-token session endpoints.
 */
export const authRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createAuthControllers(ctx);
  app.post('/login', controllers.login);
  app.post('/signup', controllers.signup);
  app.post('/verify-email', controllers.verifyEmail);
  app.post('/resend-verification', controllers.resendVerification);
  app.post('/forgot-password', controllers.forgotPassword);
  app.post('/reset-password', controllers.resetPassword);
  app.post('/accept-invitation', controllers.acceptInvitation);
  app.post('/refresh', controllers.refresh);
  app.post('/logout', controllers.logout);
  app.get('/me', controllers.me);
  app.put('/presence', controllers.setPresence);

  // Fase 1 - 2FA TOTP. `/challenge` is public (the short-lived challenge JWT in
  // the body authenticates the second step); the management routes need a JWT.
  app.post('/2fa/setup', controllers.twoFactorSetup);
  app.post('/2fa/verify', controllers.twoFactorVerify);
  app.post('/2fa/disable', controllers.twoFactorDisable);
  app.get('/2fa/status', controllers.twoFactorStatus);
  app.post('/2fa/challenge', controllers.twoFactorChallenge);
};
