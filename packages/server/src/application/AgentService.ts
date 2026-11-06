import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { CACHE_KEYS } from '@sac/shared';
import type {
  AgentPresenceStatus,
  AgentRecord,
  IAgentRepository,
  IAgentService,
  IAgentSummary,
  IAuditService,
  IAuthSessionService,
  ICache,
  IClock,
  IEmailService,
  ILogger,
  IRealtimePublisher,
  ISessionRepository,
  ISsoPasswordGuard,
  ITenantRepository,
  ITicketRepository,
  IssuedSession,
  LoginResult,
  LoginSuccess,
  SessionDeviceInfo,
  TenantRecord,
} from '@sac/shared';
import {
  AppError,
  AUDIT_ACTIONS,
  AuthenticationError,
  NotFoundError,
  TenantInactiveError,
  ValidationError,
  isTenantActive,
  redactPiiForLogs,
} from '@sac/shared';

import { signAccessToken } from './auth/access-token';
import {
  isAccessTokenDenied,
  isUserTokenRevoked,
} from './auth/access-token-revocation';
import { AUTH_RATE_LIMITS, AuthRateLimiter } from './auth/rate-limit';
import { signTwoFactorChallengeToken } from './auth/two-factor-token';
import { signTwoFactorSetupToken } from './auth/two-factor-setup-token';
import { toAgentSummary, compareAgentsByPresence } from './mappers';

/**
 * ============================================================================
 * AgentService
 * ============================================================================
 *
 * Operator auth + presence.
 *
 *  - passwords are verified with bcrypt (constant-time, never logged);
 *  - login is rate limited BEFORE any credential work (10 attempts / 15 min per
 *    e-mail + client IP, Redis-backed with an in-process fallback) so brute
 *    force answers a stable `429 RATE_LIMITED`;
 *  - JWT (`HS256`) carries only the agent identity, signed with JWT_SECRET and
 *    expiring according to JWT_EXPIRES_IN;
 *  - presence is written to Postgres (durable) AND Redis with a short TTL plus a
 *    presence index set (the queue assignment reads the fast path);
 *  - every presence change is published on the `agent:presence` socket event so
 *    the queue column updates the "Atendentes" widget without polling.
 */

/** A fingerprint unseen for 90 days counts as a new device. */
const NEW_DEVICE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
/** Same caps `AuthSessionService.createSession` applies before persisting. */
const MAX_SESSION_USER_AGENT_LENGTH = 255;
const MAX_SESSION_IP_LENGTH = 64;

/**
 * Fingerprint that produced a new-device alert, captured BEFORE the new session
 * row exists (see `detectNewDevice`). `at` is the login instant from the clock.
 */
interface NewDeviceFingerprint {
  ip: string;
  userAgent: string;
  at: Date;
}

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
  /**
   * Fase 4: tenant lifecycle gate. Optional only so legacy unit harnesses keep
   * compiling; the container ALWAYS wires it, and without it a deleted tenant
   * would still be able to authenticate.
   */
  tenants?: ITenantRepository;
  /**
   * Login throttle. Optional only so legacy harnesses keep compiling: when
   * omitted the service builds one from the injected `cache`/`clock`.
   */
  rateLimiter?: AuthRateLimiter;
  /**
   * Enterprise SSO enforcement (`enforce_sso`). Optional only so legacy unit
   * harnesses keep compiling; the container ALWAYS wires `TenantSsoService`, and
   * without it a workspace that enforces SSO would still accept passwords.
   */
  sso?: ISsoPasswordGuard;
  /** Administrative audit trail (best effort; never blocks login). */
  audit?: IAuditService;
  /**
   * New-device security alert (`auth.login.new_device`). Optional only so
   * legacy unit harnesses keep compiling; the container ALWAYS wires it.
   */
  email?: IEmailService;
  /**
   * Session store read by the new-device detector. This is the same Prisma
   * repository `AuthSessionService` writes through, injected directly because
   * the detector needs an exact fingerprint lookup the session service does not
   * expose. Optional for legacy harnesses: without it the detector is a no-op.
   */
  sessionRepository?: ISessionRepository;
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
  /** Fase 4: informational claim; `/platform/*` re-checks the database. */
  isPlatformAdmin?: boolean;
  /**
   * Scoped tokens (2FA challenge) are signed with the same secret but MUST NOT
   * be accepted as a session: `verifyToken` rejects any `scope` claim.
   */
  scope?: string;
  /** P0: unique access-token id, the revocation handle (absent on old tokens). */
  jti?: string;
  /** Refresh-session row backing this token (used by `/auth/sessions`). */
  sid?: string;
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
  private readonly tenants: ITenantRepository | undefined;
  private readonly rateLimiter: AuthRateLimiter;
  private readonly sso: ISsoPasswordGuard | undefined;
  private readonly audit: IAuditService | undefined;
  private readonly email: IEmailService | undefined;
  private readonly sessionRepository: ISessionRepository | undefined;

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
    this.tenants = deps.tenants;
    this.sso = deps.sso;
    this.audit = deps.audit;
    this.email = deps.email;
    this.sessionRepository = deps.sessionRepository;
    this.rateLimiter =
      deps.rateLimiter ??
      new AuthRateLimiter({ cache: this.cache, clock: this.clock, logger: this.logger });

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

    // Brute-force gate. Runs BEFORE the account lookup and the bcrypt compare so
    // a saturated window costs no CPU and cannot be used to probe accounts: the
    // 429 depends only on the e-mail + IP pair, never on whether the account
    // exists. The counter is incremented for successful logins too.
    await this.rateLimiter.assertAllowed(
      AUTH_RATE_LIMITS.login,
      CACHE_KEYS.authLoginAttempts(normalizedEmail, normalizeClientIp(device?.ip)),
    );

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
      // Never log the raw address: the login log is retained and the e-mail is
      // PII (docs/SECURITY.md). The masked value still lets support correlate
      // a burst of failures for the same account.
      this.logger.warn('agent.login.failed', { email: redactPiiForLogs(normalizedEmail) });
      // Audit carries the full e-mail on its dedicated column (contract) but
      // never the password nor the submitted token.
      this.audit?.record({
        action: AUDIT_ACTIONS.loginFailure,
        tenantId: agent?.tenantId ?? null,
        actorId: agent?.id ?? null,
        actorEmail: normalizedEmail,
        ip: device?.ip ?? null,
        userAgent: device?.userAgent ?? null,
        metadata: {
          reason: !agent
            ? 'unknown_account'
            : !passwordMatches
              ? 'invalid_password'
              : 'inactive_account',
        },
      });
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

    // Fase 4: a suspended/soft-deleted workspace can never open a session. The
    // check runs AFTER the password so a wrong password still answers 401 and
    // the workspace status is not leaked to an unauthenticated caller.
    const tenant = await this.assertTenantActive(agent.tenantId, agent.id);

    // Enterprise SSO (`enforce_sso`): a member of a workspace that requires SSO
    // cannot authenticate with a password. Runs AFTER the password was validated
    // and AFTER the tenant lifecycle gate, so a wrong password still answers 401
    // (no enumeration) and a suspended workspace keeps its own error. Platform
    // administrators are exempt inside the guard (break-glass).
    await this.assertPasswordLoginAllowed(agent);

    // Fase 1: 2FA-enabled operators get NOTHING but a 5 min challenge JWT.
    // No access token, no refresh session and no presence change until the
    // second factor is redeemed on `/auth/2fa/challenge`.
    if (agent.twoFactorEnabled) {
      this.logger.info('agent.login.two_factor_required', { agentId: agent.id });
      return {
        twoFactorRequired: true,
        challengeToken: signTwoFactorChallengeToken({
          userId: agent.id,
          tenantId: agent.tenantId ?? null,
          secret: this.jwtSecret,
        }),
      };
    }

    // Workspace policy (`require_2fa`): a member WITHOUT an active TOTP factor
    // must enroll before receiving a session. The password was already validated
    // and the workspace lifecycle/SSO gates already ran, so this answers 403 with
    // a stable code and a 15 min `setupToken` (never an access token). SSO is
    // intentionally exempt: its second factor is delegated to the IdP, and the
    // SSO flow calls `issueSession` directly instead of this password path.
    if (tenant?.require2fa === true) {
      this.logger.info('agent.login.two_factor_setup_required', {
        agentId: agent.id,
        tenantId: tenant.id,
      });
      throw new AppError(
        'TWO_FACTOR_SETUP_REQUIRED',
        'Two-factor authentication is required for this workspace. Enroll a TOTP factor before signing in.',
        403,
        {
          setupToken: signTwoFactorSetupToken({
            agentId: agent.id,
            tenantId: agent.tenantId ?? null,
            secret: this.jwtSecret,
          }),
        },
      );
    }

    const session = await this.issueSessionFor(agent, device);
    this.logger.info('agent.login.succeeded', { agentId: agent.id, role: agent.role });
    this.audit?.record({
      action: AUDIT_ACTIONS.loginSuccess,
      tenantId: agent.tenantId ?? null,
      actorId: agent.id,
      actorEmail: agent.email,
      ip: device?.ip ?? null,
      userAgent: device?.userAgent ?? null,
      metadata: { role: agent.role, twoFactor: false },
    });
    return session;
  }

  /**
   * Issues a session for an operator whose identity is already proven (password
   * + e-mail verification, or a redeemed 2FA challenge). Keeps the refresh-token
   * bookkeeping best effort: a legacy operator without a tenant (or a transient
   * DB failure) must still be able to log in with the JWT alone.
   */
  async issueSession(agentId: string, device?: SessionDeviceInfo): Promise<LoginSuccess> {
    const agent = await this.agents.findById(agentId);
    if (agent === null || !agent.isActive) {
      throw new AuthenticationError('Invalid credentials');
    }
    // Fase 4: the 2FA challenge completion path must not mint a session for a
    // workspace that was deleted/suspended after the challenge token was issued.
    await this.assertTenantActive(agent.tenantId, agent.id);
    return this.issueSessionFor(agent, device);
  }

  private async issueSessionFor(
    agent: AgentRecord,
    device?: SessionDeviceInfo,
  ): Promise<LoginSuccess> {
    // Security: fingerprint the device BEFORE the new session row exists, so the
    // probe cannot match the very session it is about to create. The lookup is
    // awaited (one indexed query) and fail-open; the alert e-mail itself is
    // fire-and-forget and never blocks/fails the login.
    const newDevice = await this.detectNewDevice(agent, device);
    // The refresh session is minted FIRST so the access token can carry its
    // `sid` claim (`GET /auth/sessions` marks the current device). A session
    // store failure is not fatal: the operator still gets the JWT alone.
    const issued = await this.issueRefreshSession(agent, device);
    const token = this.signToken(agent, issued?.sessionId);
    await this.writePresence(agent.id, 'ONLINE', agent.name);

    if (newDevice !== null) this.emitNewDeviceAlert(agent, newDevice);

    return {
      token,
      ...(issued !== null ? { refreshToken: issued.refreshToken } : {}),
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

  async verifyToken(token: string): Promise<{
    agentId: string;
    email: string;
    name: string;
    role: string;
    tenantId: string | null;
    isPlatformAdmin: boolean;
    /** Access-token id; absent on tokens minted before P0 revocation existed. */
    jti?: string;
    /** `exp` claim in Unix seconds; used by logout to size the denylist TTL. */
    tokenExpiresAt?: number;
  }> {
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
      // Defence in depth: a challenge JWT is not an access token. Even if a
      // future change aligns the audience, the scope claim keeps the guard safe.
      if (decoded.scope !== undefined) {
        throw new AuthenticationError('Token is not an access token');
      }
      const jti =
        typeof decoded.jti === 'string' && decoded.jti.length > 0 ? decoded.jti : undefined;

      // P0 - access-token revocation. A token whose `jti` is on the logout
      // denylist is rejected even though its signature and `exp` are fine. The
      // check is FAIL-OPEN on a cache outage (warn + accept) so Redis does not
      // log every operator out; see `access-token-revocation.ts`. A legacy token
      // without `jti` cannot be checked and stays valid until `exp`.
      const denied = await isAccessTokenDenied({
        jti,
        cache: this.cache,
        logger: this.logger,
      });
      if (denied) {
        this.logger.warn('agent.session.access_token_revoked', {
          agentId: decoded.sub,
          jti,
        });
        throw new AuthenticationError('Access token has been revoked');
      }

      // Bulk revocation (password reset / "logout everywhere"): one watermark
      // per user invalidates every access token minted at or before it,
      // including tokens from devices whose `jti` was never presented to the
      // API. `iat <= watermark` is intentional: a token minted in the same
      // second as the revocation is treated as revoked. Same FAIL-OPEN policy
      // as the denylist when Redis is unavailable (see
      // `access-token-revocation.ts`); a legacy token without `iat` is accepted
      // until `exp`.
      const userRevoked = await isUserTokenRevoked({
        userId: decoded.sub,
        issuedAt: typeof decoded.iat === 'number' ? decoded.iat : undefined,
        cache: this.cache,
        logger: this.logger,
      });
      if (userRevoked) {
        this.logger.warn('agent.session.access_token_revoked', {
          agentId: decoded.sub,
          reason: 'user_watermark',
          ...(typeof decoded.iat === 'number' ? { issuedAt: decoded.iat } : {}),
        });
        throw new AuthenticationError('Access token has been revoked');
      }

      const tenantId = typeof decoded.tenantId === 'string' ? decoded.tenantId : null;
      const sessionId =
        typeof decoded.sid === 'string' && decoded.sid.length > 0 ? decoded.sid : undefined;

      // Fase 4: every request re-checks the workspace lifecycle. A soft-deleted
      // or suspended tenant answers 403 TENANT_INACTIVE instead of continuing to
      // use the API with a still-valid access token.
      await this.assertTenantActive(tenantId, decoded.sub);

      return {
        agentId: decoded.sub,
        email: typeof decoded.email === 'string' ? decoded.email : '',
        name: typeof decoded.name === 'string' ? decoded.name : '',
        role: typeof decoded.role === 'string' ? decoded.role : 'AGENT',
        tenantId,
        isPlatformAdmin: decoded.isPlatformAdmin === true,
        ...(jti !== undefined ? { jti } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(typeof decoded.exp === 'number' ? { tokenExpiresAt: decoded.exp } : {}),
      };
    } catch (error) {
      // Domain errors (TENANT_INACTIVE, AUTHENTICATION_ERROR) keep their status;
      // jsonwebtoken failures (signature/expiry/malformed) become a 401.
      if (error instanceof AppError) throw error;
      throw new AuthenticationError('Invalid or expired token');
    }
  }

  /**
   * Rejects a tenant that is not ACTIVE (suspended or soft-deleted). A token
   * that references an unknown tenant is treated the same way: the workspace
   * no longer exists, so the session must not be usable.
   *
   * Returns the tenant row (or `null` when the caller has no tenant / the
   * repository is not wired) so login can evaluate other workspace policies
   * (`require_2fa`) without a second lookup.
   */
  private async assertTenantActive(
    tenantId: string | null,
    agentId: string,
  ): Promise<TenantRecord | null> {
    if (tenantId === null || this.tenants === undefined) return null;

    const tenant: TenantRecord | null = await this.tenants.findById(tenantId);
    if (tenant === null) {
      this.logger.warn('agent.session.tenant_missing', { agentId, tenantId });
      throw new TenantInactiveError('DELETED', tenantId);
    }
    if (!isTenantActive(tenant)) {
      this.logger.warn('agent.session.tenant_inactive', {
        agentId,
        tenantId,
        status: tenant.status,
      });
      throw new TenantInactiveError(tenant.status, tenantId);
    }
    return tenant;
  }

  private signToken(agent: AgentRecord, sessionId?: string): string {
    return signAccessToken({
      subject: agent,
      secret: this.jwtSecret,
      expiresIn: this.jwtExpiresIn,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  }

  /**
   * Fase 5: `enforce_sso` gate. Optional dependency: a deployment/test harness
   * without the SSO services keeps the legacy behaviour, the container always
   * wires it.
   */
  private async assertPasswordLoginAllowed(agent: AgentRecord): Promise<void> {
    if (this.sso === undefined) return;
    await this.sso.assertPasswordLoginAllowed({
      tenantId: agent.tenantId,
      isPlatformAdmin: agent.isPlatformAdmin,
    });
  }

  /** Returns `null` when the refresh session could not be issued (never fatal). */
  private async issueRefreshSession(
    agent: AgentRecord,
    device?: SessionDeviceInfo,
  ): Promise<IssuedSession | null> {
    if (this.sessions === undefined) return null;

    try {
      return await this.sessions.issue(agent.id, device);
    } catch (error) {
      this.logger.warn('agent.session.issue_failed', {
        agentId: agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /* ==================================================================== */
  /* New-device security alert                                            */
  /* ==================================================================== */

  /**
   * Returns the fingerprint when this operator has NO session with the same IP
   * AND the same user-agent in the last 90 days, or `null` when the device is
   * already known / the fingerprint is unusable / the probe failed.
   *
   * Contract:
   *  - a request without IP or without user-agent is ignored (no alert);
   *  - values are trimmed and truncated exactly like `AuthSessionService`
   *    persists them, so the equality check matches the stored row;
   *  - the lookup is fail-open: a read failure is only logged. We cannot tell
   *    whether the device is new, and blocking the login would be worse than
   *    missing one alert.
   */
  private async detectNewDevice(
    agent: AgentRecord,
    device?: SessionDeviceInfo,
  ): Promise<NewDeviceFingerprint | null> {
    if (this.sessionRepository === undefined) return null;

    const ip = normalizeSessionFingerprint(device?.ip, MAX_SESSION_IP_LENGTH);
    const userAgent = normalizeSessionFingerprint(
      device?.userAgent,
      MAX_SESSION_USER_AGENT_LENGTH,
    );
    // A partial fingerprint cannot identify a device: never send a false alarm.
    if (ip === null || userAgent === null) return null;

    const at = this.clock.now();
    const since = new Date(at.getTime() - NEW_DEVICE_WINDOW_MS);

    try {
      const known = await this.sessionRepository.hasSessionWithFingerprint(agent.id, {
        ip,
        userAgent,
        since,
      });
      return known ? null : { ip, userAgent, at };
    } catch (error) {
      this.logger.warn('agent.login.new_device_check_failed', {
        agentId: agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Emits the audit row synchronously (best effort, the audit service already
   * never throws) and kicks the e-mail off without awaiting it. The actor
   * e-mail is redacted: the alert goes to the inbox, the audit trail keeps only
   * the masked address, and the metadata never carries the full address.
   */
  private emitNewDeviceAlert(agent: AgentRecord, fingerprint: NewDeviceFingerprint): void {
    this.audit?.record({
      action: AUDIT_ACTIONS.loginNewDevice,
      tenantId: agent.tenantId ?? null,
      actorId: agent.id,
      actorEmail: redactPiiForLogs(agent.email),
      resourceType: 'user',
      resourceId: agent.id,
      ip: fingerprint.ip,
      userAgent: fingerprint.userAgent,
      metadata: {
        ip: fingerprint.ip,
        userAgent: fingerprint.userAgent,
        at: fingerprint.at.toISOString(),
      },
    });

    this.logger.info('agent.login.new_device', { agentId: agent.id });

    if (this.email === undefined) return;
    // Fire-and-forget by contract: `sendNewDeviceEmail` swallows every failure,
    // so this promise never rejects and the caller never awaits it.
    void this.sendNewDeviceEmail(agent, fingerprint);
  }

  private async sendNewDeviceEmail(
    agent: AgentRecord,
    fingerprint: NewDeviceFingerprint,
  ): Promise<void> {
    try {
      const tenantName = await this.resolveTenantName(agent.tenantId);
      await this.email?.sendNewSessionAlert({
        to: agent.email,
        name: agent.name,
        ip: fingerprint.ip,
        userAgent: fingerprint.userAgent,
        at: fingerprint.at,
        tenantName,
      });
    } catch (error) {
      // Best effort: a broken relay must not turn a successful login into a
      // failure (nor surface as an unhandled rejection).
      this.logger.warn('agent.login.new_device_email_failed', {
        agentId: agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Workspace display name for the alert body; never fatal. */
  private async resolveTenantName(tenantId: string | null): Promise<string | null> {
    if (tenantId === null || this.tenants === undefined) return null;
    try {
      const tenant = await this.tenants.findById(tenantId);
      return tenant?.name ?? null;
    } catch (error) {
      this.logger.warn('agent.login.new_device_tenant_lookup_failed', {
        tenantId,
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

  /**
   * Self-service profile edit (`PATCH /auth/me`).
   *
   * Only the display name is writable: role, tenant, e-mail and presence have
   * dedicated, audited flows. The response is the same `IAgentSummary` the
   * identity probe returns, so the SPA can update its header in place.
   */
  async updateProfile(
    agentId: string,
    input: { name: string },
    device?: SessionDeviceInfo,
  ): Promise<IAgentSummary> {
    const agent = await this.agents.findById(agentId);
    if (agent === null || !agent.isActive) throw new NotFoundError('Agent', agentId);

    const name = (input.name ?? '').trim();
    if (name.length < 1 || name.length > 120) {
      throw new ValidationError('Name must be between 1 and 120 characters', { field: 'name' });
    }

    const updated = await this.agents.updateName(agent.id, name);
    const summary = toAgentSummary(updated, await this.safeActiveTickets(updated.id));

    this.audit?.record({
      action: AUDIT_ACTIONS.profileUpdated,
      tenantId: updated.tenantId ?? null,
      actorId: updated.id,
      actorEmail: updated.email,
      resourceType: 'user',
      resourceId: updated.id,
      ip: device?.ip ?? null,
      userAgent: device?.userAgent ?? null,
      metadata: { nameChanged: updated.name !== agent.name },
    });

    this.logger.info('agent.profile.updated', { agentId: updated.id });
    return summary;
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

/**
 * Client IP used in the login throttle key. A request without a resolvable
 * address (internal worker, unit harness) is grouped under `unknown` so it still
 * has a window instead of silently bypassing the limiter.
 */
function normalizeClientIp(value?: string | null): string {
  const ip = (value ?? '').trim();
  return ip.length > 0 ? ip : 'unknown';
}

/**
 * Same normalization `AuthSessionService.createSession` applies before writing
 * `sessions.ip` / `sessions.user_agent`: trim, empty means "absent", longer
 * values are sliced to the column cap. Keeping both sides identical is what
 * makes the fingerprint equality check reliable.
 */
function normalizeSessionFingerprint(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  const normalized = (value ?? '').trim();
  if (normalized.length === 0) return null;
  return normalized.slice(0, maxLength);
}
