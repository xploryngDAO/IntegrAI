import { AUDIT_ACTIONS, AppError, NotFoundError } from '@sac/shared';
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
  sessionParamsSchema,
  signupBodySchema,
  twoFactorChallengeBodySchema,
  twoFactorDisableBodySchema,
  twoFactorEnrollVerifyBodySchema,
  twoFactorRecoveryRegenerateBodySchema,
  twoFactorVerifyBodySchema,
  updateProfileBodySchema,
  verifyEmailBodySchema,
} from '../schemas';
import { parseInput } from '../schemas/common';
import { ok } from '../responses';
import { extractBearerToken, requireAgent } from '../middleware/auth';
import { toAgentRole } from '../mappers';
import {
  denyAccessToken,
  setUserRevocationWatermark,
} from '../../application/auth/access-token-revocation';

export interface AuthControllers {
  login: RouteHandler;
  me: RouteHandler;
  updateMe: RouteHandler;
  setPresence: RouteHandler;
  listSessions: RouteHandler;
  revokeSession: RouteHandler;
  revokeOtherSessions: RouteHandler;
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
  twoFactorEnrollSetup: RouteHandler;
  twoFactorEnrollVerify: RouteHandler;
  twoFactorRegenerateRecoveryCodes: RouteHandler;
  twoFactorRecoveryCodeCount: RouteHandler;
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

/** Raw `User-Agent` for the audit trail (never the `deviceName` label). */
function userAgentOf(request: FastifyRequest): string | null {
  const header = request.headers['user-agent'];
  return typeof header === 'string' ? header : null;
}

/**
 * The enforced enrollment routes are public, so the global guard does not parse
 * the header for them. The Bearer value is the setup token (never an access
 * token); a missing header answers the same stable 401 as an invalid one.
 */
function setupTokenOf(request: FastifyRequest): string {
  const token = extractBearerToken(request.headers.authorization);
  if (token === null) {
    throw new AppError('SETUP_TOKEN_INVALID', 'Two-factor setup token is missing', 401);
  }
  return token;
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
        // Fase 4: drives the platform console entry in the SPA. The `/platform/*`
        // routes re-check the flag in the database on every request.
        isPlatformAdmin: agent.isPlatformAdmin === true,
      });
    },

    /**
     * `PATCH /auth/me` - self-service profile (display name only).
     *
     * Returns the same `IAgentSummary` projection as `GET /auth/me`, so the SPA
     * can update its header without a second request. The action is audited by
     * `AgentService.updateProfile` (`auth.profile.updated`).
     */
    async updateMe(request) {
      const agent = requireAgent(request);
      const body = parseInput(updateProfileBodySchema, request.body, 'body');
      return ok(
        await services.agents.updateProfile(agent.id, body, {
          ip: request.ip,
          userAgent: userAgentOf(request),
        }),
      );
    },

    /**
     * `GET /auth/sessions` - live refresh sessions of the authenticated operator.
     *
     * `current` comes from the access-token `sid` claim, so a token minted before
     * the claim existed simply marks no row as current.
     */
    async listSessions(request) {
      const agent = requireAgent(request);
      const items = await services.sessions.listForUser(agent.id, agent.sessionId);
      return ok({ items });
    },

    /**
     * `DELETE /auth/sessions/:id` - revokes one device.
     *
     * Only the caller's own sessions: a foreign/unknown id is a 404. Revoking
     * the session that issued the current access token is allowed and behaves
     * like a logout — the JWT `jti` is denylisted so the token dies immediately.
     * 204 is idempotent (a already-revoked session is still a success).
     */
    async revokeSession(request, reply) {
      const agent = requireAgent(request);
      const params = parseInput(sessionParamsSchema, request.params, 'params');
      const result = await services.sessions.revokeById(
        params.id,
        agent.id,
        agent.sessionId,
      );

      if (result.current) {
        // Best effort by contract: `denyAccessToken` never throws.
        await denyAccessToken({
          jti: agent.jti,
          expiresAt: agent.tokenExpiresAt,
          now: services.clock.now(),
          cache: services.cache,
          logger: services.logger,
        });
      }

      services.audit?.record({
        action: AUDIT_ACTIONS.logout,
        tenantId: agent.tenantId,
        actorId: agent.id,
        actorEmail: agent.email,
        ip: request.ip,
        userAgent: userAgentOf(request),
        resourceType: 'session',
        resourceId: params.id,
        metadata: { scope: 'session', current: result.current, revoked: result.revoked },
      });

      reply.code(204);
      return undefined;
    },

    /** `POST /auth/sessions/revoke-others` - every device except the current one. */
    async revokeOtherSessions(request) {
      const agent = requireAgent(request);
      const revoked = await services.sessions.revokeOthers(agent.id, agent.sessionId);
      return ok({ revoked });
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
     * With `refreshToken` in the body: revokes only that session (current
     * device) plus the access token of this request, whose `jti` is added to
     * the Redis denylist for the remaining lifetime of the token.
     *
     * WITHOUT `refreshToken`: "logout everywhere". Revokes every refresh session
     * of the operator and stamps the per-user revocation watermark (every access
     * token minted before now is rejected on its next request, on every device),
     * in addition to the `jti` denylist of the presented token.
     *
     * Always 204: an unknown session token is not an error, and a Redis failure
     * on either write is best effort (the refresh sessions are still revoked and
     * the access tokens then survive only until their own `exp`).
     */
    async logout(request, reply) {
      const agent = requireAgent(request);
      const body = parseInput(logoutBodySchema, request.body ?? {}, 'body');

      if (body.refreshToken !== undefined) {
        await services.sessions.revoke(body.refreshToken, agent.id);
      } else {
        await services.sessions.revokeAllForUser(agent.id);

        // Best effort by contract: `setUserRevocationWatermark` never throws.
        await setUserRevocationWatermark({
          userId: agent.id,
          cache: services.cache,
          logger: services.logger,
          at: services.clock.now(),
        });
      }

      // Best effort by contract: `denyAccessToken` never throws.
      await denyAccessToken({
        jti: agent.jti,
        expiresAt: agent.tokenExpiresAt,
        now: services.clock.now(),
        cache: services.cache,
        logger: services.logger,
      });

      services.audit?.record({
        action: AUDIT_ACTIONS.logout,
        tenantId: agent.tenantId,
        actorId: agent.id,
        actorEmail: agent.email,
        ip: request.ip,
        userAgent: userAgentOf(request),
        metadata: {
          scope: body.refreshToken !== undefined ? 'session' : 'all',
          revokedAll: body.refreshToken === undefined,
        },
      });

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
     * `POST /auth/2fa/recovery-codes/regenerate` - JWT.
     *
     * Re-authenticates with password + TOTP/recovery code, replaces the whole
     * recovery-code set in one transaction and returns the 8 plaintext codes
     * exactly once. The throttled/blocked path answers `429 RATE_LIMITED`.
     */
    async twoFactorRegenerateRecoveryCodes(request) {
      const agent = requireAgent(request);
      const body = parseInput(twoFactorRecoveryRegenerateBodySchema, request.body, 'body');
      const result = await services.twoFactor.regenerateRecoveryCodes(
        agent.id,
        body.password,
        body.code,
      );
      return ok(result);
    },

    /**
     * `GET /auth/2fa/recovery-codes/count` - JWT.
     *
     * `{ remaining }`: unused recovery codes, used by the SPA to warn before the
     * operator runs out of break-glass codes.
     */
    async twoFactorRecoveryCodeCount(request) {
      const agent = requireAgent(request);
      const result = await services.twoFactor.countRecoveryCodes(agent.id);
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

    /**
     * `POST /auth/2fa/enroll/setup` - public, `Authorization: Bearer setupToken`.
     *
     * First step of the enforced enrollment: validates the 15 min setup token
     * issued by a login blocked by the workspace `require_2fa` policy and returns
     * `{ secret, otpauthUri }` (no session, no presence change).
     */
    async twoFactorEnrollSetup(request) {
      const result = await services.twoFactor.enrollSetup(setupTokenOf(request), {
        userAgent: userAgentOf(request),
        ip: request.ip ?? null,
      });
      return ok(result);
    },

    /**
     * `POST /auth/2fa/enroll/verify` - public, `Authorization: Bearer setupToken`.
     *
     * Second step: burns the setup token, enables TOTP, returns the normal
     * `AuthResponse` PLUS `recoveryCodes`, and publishes the operator presence
     * exactly like login/2FA challenge.
     */
    async twoFactorEnrollVerify(request) {
      const body = parseInput(twoFactorEnrollVerifyBodySchema, request.body, 'body');
      const result = await services.twoFactor.enrollVerify(
        setupTokenOf(request),
        body.code,
        deviceInfo(request, body.deviceName),
      );

      publishPresence({
        id: result.session.agent.id,
        name: result.session.agent.name,
        presence: result.session.agent.presence,
      });

      return ok({
        ...toAuthResponse(result.session),
        recoveryCodes: result.recoveryCodes,
      });
    },
  };
}
