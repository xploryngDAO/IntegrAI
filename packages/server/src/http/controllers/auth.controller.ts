import { NotFoundError } from '@sac/shared';
import type {
  AuthResponse,
  IAgentSummary,
  SessionDeviceInfo,
} from '@sac/shared';
import type { FastifyRequest } from 'fastify';
import type { HttpRouteContext, RouteHandler } from '../types';
import {
  forgotPasswordBodySchema,
  loginBodySchema,
  logoutBodySchema,
  presenceBodySchema,
  refreshBodySchema,
  resendVerificationBodySchema,
  resetPasswordBodySchema,
  signupBodySchema,
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
  refresh: RouteHandler;
  logout: RouteHandler;
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
    /** `POST /auth/login` - public. */
    async login(request) {
      const body = parseInput(loginBodySchema, request.body, 'body');
      const result = await services.agents.login(
        body.email,
        body.password,
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
  };
}
