import type {
  AgentRecord,
  IAgentRepository,
  IAuthSessionService,
  IClock,
  ILogger,
  ISessionRepository,
  IssuedSession,
  RefreshSessionResult,
  SessionDeviceInfo,
} from '@sac/shared';
import { AppError } from '@sac/shared';

import { hashToken, randomToken, signAccessToken } from './auth/access-token';

/**
 * ============================================================================
 * AuthSessionService - rotating refresh tokens (Fase 1)
 * ============================================================================
 *
 * A session is an opaque 48-byte token whose SHA-256 lives in `sessions`; the
 * raw value never touches the database or the logs.
 *
 *  - `issue`  : called by `AgentService.login` after the password + e-mail gate.
 *  - `rotate` : every refresh revokes the presented row before minting a new
 *               pair (single use). A replayed/revoked/expired token is a 401.
 *  - `revoke` : logout of the current device (only when the row belongs to the
 *               authenticated operator).
 *  - `revokeAllForUser` : logout-everywhere / password reset.
 *
 * The access token is signed through `signAccessToken` so refresh and login
 * produce byte-identical claim shapes for the JWT guard.
 */

const REFRESH_TOKEN_BYTES = 48;
/** 30 days, per the Fase 1 design (`docs/PHASE1_AUTH.md`). */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 256;
const MAX_USER_AGENT_LENGTH = 255;
const MAX_IP_LENGTH = 64;

export interface AuthSessionServiceDependencies {
  logger: ILogger;
  clock: IClock;
  jwtSecret: string;
  jwtExpiresIn: string;
  repos: {
    agents: IAgentRepository;
    sessions: ISessionRepository;
  };
}

export class AuthSessionService implements IAuthSessionService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly jwtSecret: string;
  private readonly jwtExpiresIn: string;
  private readonly agents: IAgentRepository;
  private readonly sessions: ISessionRepository;

  constructor(deps: AuthSessionServiceDependencies) {
    this.logger = deps.logger.child({ component: 'AuthSessionService' });
    this.clock = deps.clock;
    this.jwtSecret = deps.jwtSecret;
    this.jwtExpiresIn = deps.jwtExpiresIn;
    this.agents = deps.repos.agents;
    this.sessions = deps.repos.sessions;

    if (!this.jwtSecret || this.jwtSecret.length < 16) {
      throw new Error('AuthSessionService requires a configured JWT_SECRET (min 16 chars)');
    }
  }

  /* ==================================================================== */
  /* Issue                                                                */
  /* ==================================================================== */

  async issue(userId: string, device?: SessionDeviceInfo): Promise<IssuedSession> {
    const agent = await this.agents.findById(userId);
    if (agent === null || !agent.isActive) {
      throw new AppError(
        'SESSION_SUBJECT_UNAVAILABLE',
        'Account is not available for a session',
        401,
      );
    }
    return this.createSession(agent, device);
  }

  /* ==================================================================== */
  /* Rotate                                                               */
  /* ==================================================================== */

  async rotate(refreshToken: string, device?: SessionDeviceInfo): Promise<RefreshSessionResult> {
    const raw = (refreshToken ?? '').trim();
    if (raw.length < MIN_TOKEN_LENGTH || raw.length > MAX_TOKEN_LENGTH) {
      throw this.invalidRefreshTokenError();
    }

    const session = await this.sessions.findByRefreshTokenHash(hashToken(raw));
    const now = this.clock.now();
    if (
      session === null ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      throw this.invalidRefreshTokenError();
    }

    const agent = await this.agents.findById(session.userId);
    if (agent === null || !agent.isActive) {
      throw this.invalidRefreshTokenError();
    }

    // Burn the presented session BEFORE minting the new pair: a concurrent
    // replay must not be able to rotate the same token twice.
    const revoked = await this.sessions.revoke(session.id, now);
    if (!revoked) throw this.invalidRefreshTokenError();

    const issued = await this.createSession(
      agent,
      device ?? { userAgent: session.userAgent, ip: session.ip },
      session.tenantId,
    );

    const token = signAccessToken({
      subject: agent,
      secret: this.jwtSecret,
      expiresIn: this.jwtExpiresIn,
    });

    this.logger.info('auth.session.rotated', {
      userId: agent.id,
      sessionId: session.id,
    });

    return {
      token,
      refreshToken: issued.refreshToken,
      expiresAt: issued.expiresAt,
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        role: agent.role,
        presence: agent.presence,
        tenantId: agent.tenantId ?? session.tenantId,
      },
    };
  }

  /* ==================================================================== */
  /* Revocation                                                           */
  /* ==================================================================== */

  async revoke(refreshToken: string, userId: string): Promise<boolean> {
    const raw = (refreshToken ?? '').trim();
    if (raw.length < MIN_TOKEN_LENGTH || raw.length > MAX_TOKEN_LENGTH) return false;

    const session = await this.sessions.findByRefreshTokenHash(hashToken(raw));
    // Never reveal whether the token exists: a mismatch is simply a no-op.
    if (session === null || session.userId !== userId || session.revokedAt !== null) {
      return false;
    }

    const revoked = await this.sessions.revoke(session.id, this.clock.now());
    if (revoked) this.logger.info('auth.session.revoked', { userId, sessionId: session.id });
    return revoked;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const count = await this.sessions.revokeAllForUser(userId, this.clock.now());
    if (count > 0) {
      this.logger.info('auth.session.revoked_all', { userId, sessions: count });
    }
    return count;
  }

  /* ==================================================================== */
  /* Internals                                                            */
  /* ==================================================================== */

  private async createSession(
    agent: AgentRecord,
    device?: SessionDeviceInfo,
    tenantIdFallback?: string,
  ): Promise<IssuedSession> {
    // `sessions.tenant_id` is NOT NULL: legacy operators without a tenant keep
    // working with the access token only (the caller degrades gracefully).
    const tenantId = agent.tenantId ?? tenantIdFallback ?? null;
    if (tenantId === null) {
      throw new AppError(
        'SESSION_TENANT_MISSING',
        'Account is not attached to a tenant, cannot open a session',
        409,
      );
    }

    const refreshToken = randomToken(REFRESH_TOKEN_BYTES);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

    await this.sessions.create({
      userId: agent.id,
      tenantId,
      refreshTokenHash: hashToken(refreshToken),
      userAgent: truncate(device?.userAgent, MAX_USER_AGENT_LENGTH),
      ip: truncate(device?.ip, MAX_IP_LENGTH),
      expiresAt,
    });

    return { refreshToken, expiresAt };
  }

  private invalidRefreshTokenError(): AppError {
    return new AppError(
      'INVALID_REFRESH_TOKEN',
      'Refresh token is invalid, expired or already used',
      401,
    );
  }
}

function truncate(value: string | null | undefined, maxLength: number): string | null {
  const normalized = (value ?? '').trim();
  if (normalized.length === 0) return null;
  return normalized.slice(0, maxLength);
}
