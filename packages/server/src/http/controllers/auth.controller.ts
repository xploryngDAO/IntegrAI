import { NotFoundError } from '@sac/shared';
import type {
  AuthResponse,
  IAgentSummary,
  LoginSuccess,
  SessionDeviceInfo,
} from '@sac/shared';
import type { FastifyRequest } from 'fastify';
import type { HttpRouteContext, RouteHandler } from '../types';
import {
  acceptInvitationBodySchema,
  forgotPasswordBodySchema,
  loginBodySchema,
  logoutBodySchema,
  presenceBodySchema,
  refreshBodySchema,
  resendVerificationBodySchema,
  resetPasswordBodySchema,
  signupBodySchema,
  twoFactorChallengeBodySchema,
  twoFactorDisableBodySchema,
  twoFactorVerifyBodySchema,
  verifyEmailBodySchema,
} from '../schemas';
import { parseInput } from '../schemas/common';
import { ok } from '../responses';
import { requireAgent } from '../middleware/auth';
import { toAgentRole } from '../mappers';

export interface AuthControllers {
  login: RouteHandler;
  me: RouteHandler;
  setPresence: RouteHandler;
  signup: RouteHandler;
  verifyEmail: RouteHandler;
  resendVerification: RouteHandler;
  forgotPassword: RouteHandler;
  resetPassword: RouteHandler;
  acceptInvitation: RouteHandler;
  refresh: RouteHandler;
  logout: RouteHandler;
  twoFactorSetup: RouteHandler;
  twoFactorVerify: RouteHandler;
  twoFactorDisable: RouteHandler;
  twoFactorStatus: RouteHandler;
  twoFactorChallenge: RouteHandler;
}

/** The exact `AuthResponse` shape shared by login, refresh, invite and 2FA. */
function toAuthResponse(result: LoginSuccess): AuthResponse {
  return {
    token: result.token,
    ...(result.refreshToken !== undefined ? { refreshToken: result.refreshToken } : {}),
    agent: {
      id: result.agent.id,
      name: result.agent.name,
      email: result.agent.email,
      role: toAgentRole(result.agent.role),
      presence: result.agent.presence,
      tenantId: result.agent.tenantId,
    },
  };
}

/**
 * Device fingerprint attached to a session: the explicit `deviceName` from the
 * SPA wins, otherwise the `User-Agent` header. The IP is the socket/forwarded
 * address Fastify already resolves (`trustProxy` is configured at the edge).
 */
function deviceInfo(request: FastifyRequest, deviceName?: string): SessionDeviceInfo {
  const header = request.headers['user-agent'];
  const userAgent = deviceName?.trim() || (typeof header === 'string' ? header : null);
  return { userAgent: userAgent ?? null, ip: request.ip ?? null };
}

export function createAuthControllers(ctx: HttpRouteContext): AuthControllers {
  const { services, hub } = ctx;

  const publishPresence = (summary: Pick<IAgentSummary, 'id' | 'name' | 'presence'>): void => {
    hub.publisher.agentPresence({
      agentId: summary.id,
      agentName: summary.name,
      presence: summary.presence,
      at: services.clock.now().toISOString(),
    });
  };

  return {
    /**
     * `POST /auth/login` - public.
     *
     * 200 with the `AuthResponse` for a normal login. When the operator has 2FA
     * enabled, NO token is issued: 401 with `{ code: 'TWO_FACTOR_REQUIRED',
     * challengeToken }` (top-level shape required by the 2FA contract; the token
     * is redeemed on `/auth/2fa/challenge`).
     */
    async login(request, reply) {
      const body = parseInput(loginBodySchema, request.body, 'body');
      const result = await services.agents.login(
        body.email,
        body.password,
        deviceInfo(request, body.deviceName),
      );

      if ('twoFactorRequired' in result) {
        reply.code(401);
        return { code: 'TWO_FACTOR_REQUIRED', challengeToken: result.challengeToken };
      }

      const response = toAuthResponse(result);

      publishPresence({
        id: result.agent.id,
        name: result.agent.name,
        presence: result.agent.presence,
      });

      return ok(response);
    },

    /** `GET /auth/me` - identity + live workload for the operator header. */
    async me(request) {
      const agent = requireAgent(request);
      const agents = await services.agents.list();
      const summary = agents.find((entry) => entry.id === agent.id);
      if (summary === undefined) throw new NotFoundError('Agent', agent.id);

      return ok({
        id: summary.id,
        name: summary.name,
        email: summary.email,
        role: toAgentRole(summary.role),
        presence: summary.presence,
        activeTickets: summary.activeTickets,
        tenantId: agent.tenantId,
      });
    },

    /** `PUT /auth/presence` - operator availability toggle. */
    async setPresence(request) {
      const agent = requireAgent(request);
      const body = parseInput(presenceBodySchema, request.body, 'body');
      const summary = await services.agents.setPresence(agent.id, body.presence);
      publishPresence(summary);
      return ok(summary);
    },

    /** `POST /auth/signup` - public: creates tenant + ADMIN, sends verification. */
    async signup(request, reply) {
      const body = parseInput(signupBodySchema, request.body, 'body');
      const result = await services.auth.signup(body);
      reply.code(201);
      return ok(result);
    },

    /** `POST /auth/verify-email` - public: consumes the single-use token. */
    async verifyEmail(request) {
      const body = parseInput(verifyEmailBodySchema, request.body, 'body');
      await services.auth.verifyEmail(body.token);
      return ok({ verified: true });
    },

    /**
     * `POST /auth/resend-verification` - public.
     *
     * Always 202 with the same body, whether the account exists, is already
     * verified or was throttled (no account enumeration).
     */
    async resendVerification(request, reply) {
      const body = parseInput(resendVerificationBodySchema, request.body, 'body');
      await services.auth.resendVerification(body.email);
      reply.code(202);
      return ok({ status: 'accepted' });
    },

    /**
     * `POST /auth/forgot-password` - public.
     *
     * Always 202 with the same body: unknown e-mails, inactive accounts and SMTP
     * failures are indistinguishable from a delivered reset link.
     */
    async forgotPassword(request, reply) {
      const body = parseInput(forgotPasswordBodySchema, request.body, 'body');
      await services.auth.forgotPassword(body.email);
      reply.code(202);
      return ok({ status: 'accepted' });
    },

    /**
     * `POST /auth/reset-password` - public.
     *
     * 200 on success; an unknown, expired or replayed token answers 400
     * `INVALID_RESET_TOKEN` (never revealing which of the three it was).
     */
    async resetPassword(request) {
      const body = parseInput(resetPasswordBodySchema, request.body, 'body');
      await services.auth.resetPassword(body.token, body.password);
      return ok({ reset: true });
    },

    /**
     * `POST /auth/accept-invitation` - public.
     *
     * The invitation token proves the e-mail ownership, so the operator is
     * created already verified and receives an access token + refresh token
     * (same `AuthResponse` shape as login/refresh) to enter right away.
     */
    async acceptInvitation(request) {
      const body = parseInput(acceptInvitationBodySchema, request.body, 'body');
      const result = await services.invitations.accept(
        { token: body.token, name: body.name, password: body.password },
        deviceInfo(request, body.deviceName),
      );

      const response: AuthResponse = {
        token: result.token,
        ...(result.refreshToken !== undefined ? { refreshToken: result.refreshToken } : {}),
        agent: {
          id: result.agent.id,
          name: result.agent.name,
          email: result.agent.email,
          role: toAgentRole(result.agent.role),
          presence: result.agent.presence,
          tenantId: result.agent.tenantId,
        },
      };

      return ok(response);
    },

    /**
     * `POST /auth/refresh` - public.
     *
     * Rotates the refresh token (the presented one is revoked) and returns a new
     * access token + refresh token pair. Any invalid/revoked/expired token is a
     * 401 `INVALID_REFRESH_TOKEN`.
     */
    async refresh(request) {
      const body = parseInput(refreshBodySchema, request.body, 'body');
      const result = await services.sessions.rotate(
        body.refreshToken,
        deviceInfo(request, body.deviceName),
      );

      const response: AuthResponse = {
        token: result.token,
        refreshToken: result.refreshToken,
        agent: {
          id: result.agent.id,
          name: result.agent.name,
          email: result.agent.email,
          role: toAgentRole(result.agent.role),
          presence: result.agent.presence,
          tenantId: result.agent.tenantId,
        },
      };

      return ok(response);
    },

    /**
     * `POST /auth/logout` - JWT required.
     *
     * Revokes the session carried in the body, or every session of the operator
     * when the body omits `refreshToken` ("logout everywhere"). Always 204: an
     * unknown token is not an error and does not leak whether it existed.
     */
    async logout(request, reply) {
      const agent = requireAgent(request);
      const body = parseInput(logoutBodySchema, request.body ?? {}, 'body');

      if (body.refreshToken !== undefined) {
        await services.sessions.revoke(body.refreshToken, agent.id);
      } else {
        await services.sessions.revokeAllForUser(agent.id);
      }

      reply.code(204);
      return undefined;
    },

    /**
     * `POST /auth/2fa/setup` - JWT.
     *
     * Generates a 160-bit base32 secret, stores it encrypted as PENDING
     * (`enabled = false`) and returns the secret + `otpauth://` URL exactly once.
     */
    async twoFactorSetup(request) {
      const agent = requireAgent(request);
      const result = await services.twoFactor.setup(agent.id);
      return ok(result);
    },

    /**
     * `POST /auth/2fa/verify` - JWT.
     *
     * Confirms the pending secret and enables 2FA; the 8 recovery codes are
     * returned in this response only (only their SHA-256 is persisted).
     */
    async twoFactorVerify(request) {
      const agent = requireAgent(request);
      const body = parseInput(twoFactorVerifyBodySchema, request.body, 'body');
      const result = await services.twoFactor.verify(agent.id, body.code);
      return ok(result);
    },

    /** `POST /auth/2fa/disable` - JWT: password + TOTP/recovery code. */
    async twoFactorDisable(request) {
      const agent = requireAgent(request);
      const body = parseInput(twoFactorDisableBodySchema, request.body, 'body');
      await services.twoFactor.disable(agent.id, body.password, body.code);
      return ok({ enabled: false });
    },

    /** `GET /auth/2fa/status` - JWT: `{ enabled }` for the security settings. */
    async twoFactorStatus(request) {
      const agent = requireAgent(request);
      const result = await services.twoFactor.status(agent.id);
      return ok(result);
    },

    /**
     * `POST /auth/2fa/challenge` - public.
     *
     * Redeems the short-lived challenge JWT issued by login with a TOTP code or
     * a one-time recovery code, then returns the same `AuthResponse` as login.
     */
    async twoFactorChallenge(request) {
      const body = parseInput(twoFactorChallengeBodySchema, request.body, 'body');
      const result = await services.twoFactor.challenge(
        body.challengeToken,
        body.code,
        deviceInfo(request, body.deviceName),
      );

      publishPresence({
        id: result.agent.id,
        name: result.agent.name,
        presence: result.agent.presence,
      });

      return ok(toAuthResponse(result));
    },
  };
}
