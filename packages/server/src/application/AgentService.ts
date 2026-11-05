import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { CACHE_KEYS } from '@sac/shared';
import type {
  AgentPresenceStatus,
  AgentRecord,
  IAgentRepository,
  IAgentService,
  IAgentSummary,
  IAuthSessionService,
  ICache,
  IClock,
  ILogger,
  IRealtimePublisher,
  ITicketRepository,
  LoginResult,
  SessionDeviceInfo,
} from '@sac/shared';
import { AppError, AuthenticationError, NotFoundError, ValidationError } from '@sac/shared';

import { signAccessToken } from './auth/access-token';
import { toAgentSummary, compareAgentsByPresence } from './mappers';

/**
 * ============================================================================
 * AgentService
 * ============================================================================
 *
 * Operator auth + presence.
 *
 *  - passwords are verified with bcrypt (constant-time, never logged);
 *  - JWT (`HS256`) carries only the agent identity, signed with JWT_SECRET and
 *    expiring according to JWT_EXPIRES_IN;
 *  - presence is written to Postgres (durable) AND Redis with a short TTL plus a
 *    presence index set (the queue assignment reads the fast path);
 *  - every presence change is published on the `agent:presence` socket event so
 *    the queue column updates the "Atendentes" widget without polling.
 */

export interface AgentServiceDependencies {
  logger: ILogger;
  clock: IClock;
  cache: ICache;
  realtime: IRealtimePublisher;
  jwtSecret: string;
  jwtExpiresIn: string;
  presenceTtlSeconds: number;
  /** Optional: without it login still works, it just returns no refresh token. */
  sessions?: IAuthSessionService;
  repos: {
    agents: IAgentRepository;
    tickets: ITicketRepository;
  };
}

interface AgentJwtClaims {
  sub: string;
  email: string;
  name: string;
  role: string;
  tenantId?: string | null;
  iat?: number;
  exp?: number;
}

export class AgentService implements IAgentService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly cache: ICache;
  private readonly realtime: IRealtimePublisher;
  private readonly jwtSecret: string;
  private readonly jwtExpiresIn: string;
  private readonly presenceTtlSeconds: number;
  private readonly agents: IAgentRepository;
  private readonly tickets: ITicketRepository;
  private readonly sessions: IAuthSessionService | undefined;

  constructor(deps: AgentServiceDependencies) {
    this.logger = deps.logger.child({ component: 'AgentService' });
    this.clock = deps.clock;
    this.cache = deps.cache;
    this.realtime = deps.realtime;
    this.jwtSecret = deps.jwtSecret;
    this.jwtExpiresIn = deps.jwtExpiresIn;
    this.presenceTtlSeconds = Math.max(30, deps.presenceTtlSeconds || 120);
    this.agents = deps.repos.agents;
    this.tickets = deps.repos.tickets;
    this.sessions = deps.sessions;

    if (!this.jwtSecret || this.jwtSecret.length < 16) {
      throw new Error('AgentService requires a configured JWT_SECRET (min 16 chars)');
    }
  }

  /* ==================================================================== */
  /* Auth                                                                 */
  /* ==================================================================== */

  async login(email: string, password: string, device?: SessionDeviceInfo): Promise<LoginResult> {
    const normalizedEmail = (email ?? '').trim().toLowerCase();
    if (normalizedEmail === '' || !password) {
      throw new ValidationError('Email and password are required');
    }

    const agent = await this.agents.findByEmail(normalizedEmail);
    // Always run a bcrypt comparison so an unknown e-mail and a wrong password
    // take the same amount of time (no account enumeration). This is a real
    // bcrypt hash of a random value, never a password any account can use.
    const passwordHash =
      agent?.passwordHash ?? '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    let passwordMatches = false;
    try {
      passwordMatches = await bcrypt.compare(password, passwordHash);
    } catch {
      passwordMatches = false;
    }

    if (!agent || !passwordMatches || !agent.isActive) {
      this.logger.warn('agent.login.failed', { email: normalizedEmail });
      throw new AuthenticationError('Invalid credentials');
    }

    // Fase 1: self-service accounts must prove e-mail ownership before a session
    // is issued. The check runs only AFTER a valid password so an attacker
    // cannot use it to enumerate accounts (wrong password still answers 401).
    // Legacy operators were backfilled with `email_verified_at = now()`.
    if (agent.emailVerifiedAt === null) {
      this.logger.warn('agent.login.email_not_verified', { agentId: agent.id });
      throw new AppError(
        'EMAIL_NOT_VERIFIED',
        'E-mail address is not verified. Check your inbox for the verification link.',
        403,
      );
    }

    const token = this.signToken(agent);
    await this.writePresence(agent.id, 'ONLINE', agent.name);

    // Fase 1: a refresh token lets the SPA renew the short access token without
    // asking for the password again. Session bookkeeping is best effort: a
    // legacy operator without a tenant (or a transient DB failure) must still be
    // able to log in with the JWT alone.
    const refreshToken = await this.issueRefreshToken(agent, device);

    this.logger.info('agent.login.succeeded', { agentId: agent.id, role: agent.role });
    return {
      token,
      ...(refreshToken !== null ? { refreshToken } : {}),
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        role: agent.role,
        presence: 'ONLINE',
        tenantId: agent.tenantId ?? null,
      },
    };
  }

  async verifyToken(token: string): Promise<{ agentId: string; email: string; name: string; role: string; tenantId: string | null }> {
    if (!token) throw new AuthenticationError('Missing bearer token');
    try {
      const decoded = jwt.verify(token, this.jwtSecret, {
        algorithms: ['HS256'],
        issuer: 'sac-hub',
        audience: 'sac-web',
      }) as unknown as AgentJwtClaims;
      if (!decoded || typeof decoded.sub !== 'string') {
        throw new AuthenticationError('Malformed token payload');
      }
      return {
        agentId: decoded.sub,
        email: typeof decoded.email === 'string' ? decoded.email : '',
        name: typeof decoded.name === 'string' ? decoded.name : '',
        role: typeof decoded.role === 'string' ? decoded.role : 'AGENT',
        tenantId: typeof decoded.tenantId === 'string' ? decoded.tenantId : null,
      };
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError('Invalid or expired token');
    }
  }

  private signToken(agent: AgentRecord): string {
    return signAccessToken({
      subject: agent,
      secret: this.jwtSecret,
      expiresIn: this.jwtExpiresIn,
    });
  }

  /** Returns `null` when the refresh token could not be issued (never fatal). */
  private async issueRefreshToken(
    agent: AgentRecord,
    device?: SessionDeviceInfo,
  ): Promise<string | null> {
    if (this.sessions === undefined) return null;

    try {
      const issued = await this.sessions.issue(agent.id, device);
      return issued.refreshToken;
    } catch (error) {
      this.logger.warn('agent.session.issue_failed', {
        agentId: agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /* ==================================================================== */
  /* Presence                                                             */
  /* ==================================================================== */

  async setPresence(agentId: string, presence: AgentPresenceStatus): Promise<IAgentSummary> {
    if (!['ONLINE', 'PAUSED', 'OFFLINE'].includes(presence)) {
      throw new ValidationError(`Unsupported presence value: ${String(presence)}`);
    }
    const agent = await this.agents.findById(agentId);
    if (!agent) throw new NotFoundError('Agent', agentId);

    const now = this.clock.now();
    const updated = await this.agents.updatePresence(agentId, presence, now);
    await this.writePresence(agentId, presence, agent.name);

    const activeTickets = await this.safeActiveTickets(agentId);
    const summary = toAgentSummary({ ...updated, presence }, activeTickets);
    this.logger.debug('agent.presence.changed', { agentId, presence });
    return summary;
  }

  async heartbeat(agentId: string): Promise<void> {
    const agent = await this.agents.findById(agentId);
    if (!agent) throw new NotFoundError('Agent', agentId);

    // Preserve PAUSED across heartbeats so a paused agent is not silently
    // promoted back into the assignment pool.
    const cached = await this.cache.get<AgentPresenceStatus>(CACHE_KEYS.agentPresence(agentId));
    const presence: AgentPresenceStatus =
      cached === 'PAUSED' ? 'PAUSED' : cached === 'OFFLINE' ? 'ONLINE' : 'ONLINE';

    const now = this.clock.now();
    await this.agents.updatePresence(agentId, presence, now);
    await this.cache.set(CACHE_KEYS.agentPresence(agentId), presence, this.presenceTtlSeconds);
    await this.cache.sadd(CACHE_KEYS.presenceIndex(), [agentId]);
  }

  async list(tenantId?: string | null): Promise<IAgentSummary[]> {
    const agents = await this.agents.list({ activeOnly: true, ...(tenantId ? { tenantId } : {}) });
    const summaries = await Promise.all(
      agents.map(async (agent) => toAgentSummary(agent, await this.safeActiveTickets(agent.id))),
    );
    return summaries.sort(compareAgentsByPresence);
  }

  private async writePresence(
    agentId: string,
    presence: AgentPresenceStatus,
    agentName: string,
  ): Promise<void> {
    try {
      if (presence === 'OFFLINE') {
        await this.cache.del(CACHE_KEYS.agentPresence(agentId));
        await this.cache.srem(CACHE_KEYS.presenceIndex(), [agentId]);
      } else {
        await this.cache.set(CACHE_KEYS.agentPresence(agentId), presence, this.presenceTtlSeconds);
        await this.cache.sadd(CACHE_KEYS.presenceIndex(), [agentId]);
      }
    } catch (error) {
      // Presence is best-effort: a Redis outage must not block login.
      this.logger.warn('agent.presence.cache_failed', {
        agentId,
        presence,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (presence !== 'OFFLINE') {
      try {
        this.realtime.agentPresence({
          agentId,
          agentName,
          presence,
          at: this.clock.now().toISOString(),
        });
      } catch (error) {
        this.logger.warn('agent.presence.realtime_failed', {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async safeActiveTickets(agentId: string): Promise<number> {
    try {
      return await this.tickets.countActiveByAgent(agentId);
    } catch (error) {
      this.logger.warn('agent.active_tickets_failed', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }
}

