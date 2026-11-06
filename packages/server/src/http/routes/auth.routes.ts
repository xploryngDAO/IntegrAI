import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createAuthControllers } from '../controllers/auth.controller';
import { createSsoControllers } from '../controllers/sso.controller';

/**
 * `/api/v1/auth` - login, identity, presence and the Fase 1 self-service flows:
 * signup, e-mail verification (+resend), password reset (forgot/reset), operator
 * invitation acceptance and the rotating refresh-token session endpoints.
 *
 * Fase 5 adds the public enterprise SSO flow (`/sso/*`): discovery, start,
 * callback and the one-time-code exchange. None of them can present a JWT.
 */
export const authRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createAuthControllers(ctx);
  const sso = createSsoControllers(ctx);

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
  app.patch('/me', controllers.updateMe);
  app.put('/presence', controllers.setPresence);

  // Self-service session management (JWT): list devices, revoke one (current
  // deletion = logout) and "revoke other devices". A session of another
  // operator is a 404, never a 403.
  app.get('/sessions', controllers.listSessions);
  app.post('/sessions/revoke-others', controllers.revokeOtherSessions);
  app.delete('/sessions/:id', controllers.revokeSession);

  // Fase 5 - enterprise SSO (public browser flow; see docs/ENTERPRISE_SSO.md).
  app.get('/sso/discover', sso.discover);
  app.get('/sso/start', sso.start);
  app.get('/sso/callback', sso.callback);
  app.post('/sso/exchange', sso.exchange);

  // Fase 1 - 2FA TOTP. `/challenge` is public (the short-lived challenge JWT in
  // the body authenticates the second step); the management routes need a JWT.
  app.post('/2fa/setup', controllers.twoFactorSetup);
  app.post('/2fa/verify', controllers.twoFactorVerify);
  app.post('/2fa/disable', controllers.twoFactorDisable);
  app.get('/2fa/status', controllers.twoFactorStatus);
  app.post('/2fa/challenge', controllers.twoFactorChallenge);
  // Enforced enrollment (workspace `require_2fa`): public routes authenticated by
  // the short-lived `setupToken` in `Authorization: Bearer` (no access token yet).
  app.post('/2fa/enroll/setup', controllers.twoFactorEnrollSetup);
  app.post('/2fa/enroll/verify', controllers.twoFactorEnrollVerify);
  // Recovery codes: regenerate returns the new plaintext set exactly once;
  // count feeds the "running low" warning in the security settings.
  app.post('/2fa/recovery-codes/regenerate', controllers.twoFactorRegenerateRecoveryCodes);
  app.get('/2fa/recovery-codes/count', controllers.twoFactorRecoveryCodeCount);
};
