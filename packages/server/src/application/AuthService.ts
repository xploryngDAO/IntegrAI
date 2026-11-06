import bcrypt from 'bcryptjs';

import { CACHE_KEYS } from '@sac/shared';
import type {
  AgentRecord,
  IAgentRepository,
  IAuthService,
  ICache,
  IClock,
  IEmailService,
  IEmailVerificationRepository,
  IAuditService,
  IPasswordResetRepository,
  ISessionRepository,
  ITenantRepository,
  ILogger,
  SignupCommand,
  SignupResult,
  TenantRecord,
} from '@sac/shared';
import { AppError, AUDIT_ACTIONS, ConflictError, ValidationError } from '@sac/shared';

import { hashToken, randomToken } from './auth/access-token';
import { setUserRevocationWatermark } from './auth/access-token-revocation';
import { AUTH_RATE_LIMITS, AuthRateLimiter } from './auth/rate-limit';
import { isUniqueConstraintViolation } from './repositories/errors';

/**
 * ============================================================================
 * AuthService - self-service signup, e-mail verification and password reset
 * ============================================================================
 *
 * Scope of this slice (invitations, 2FA and session rotation live elsewhere):
 *
 *  - `signup`: creates a tenant (unique slug derived from the company name) and
 *    its first ADMIN operator with `email_verified_at = null`; the plain token
 *    only ever exists in memory / in the e-mail link, the DB receives SHA-256.
 *  - `verifyEmail`: consumes a single-use token after checking hash + TTL + use.
 *  - `resendVerification`: no account enumeration (the caller always gets 202),
 *    throttled to one message per minute AND to 3 requests / 15 min per e-mail;
 *    the 15 min window answers `429 RATE_LIMITED` and is charged before the
 *    account lookup, so known and unknown addresses behave identically.
 *  - `forgotPassword`: always resolves for a valid address (202 at the edge),
 *    invalidates previous reset tokens, stores SHA-256 with a 30 min TTL and
 *    mails the link; also limited to 3 requests / 15 min per e-mail (429).
 *  - `resetPassword`: validates hash + TTL + single use, re-hashes the password
 *    with bcrypt cost 12, revokes every live refresh session of the operator AND
 *    stamps the per-user revocation watermark, so access tokens already issued
 *    on any device die immediately instead of surviving until `exp`.
 *
 * Hashing/verification never leaks the password and every failure path returns
 * a stable `AppError.code` for the UI.
 */

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
/** Fase 1: password reset links live 30 minutes (`docs/PHASE1_AUTH.md`). */
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const RESET_TOKEN_BYTES = 32;
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 256;
const RESEND_WINDOW_SECONDS = 60;
const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;
const MAX_SLUG_ATTEMPTS = 50;
const MAX_SLUG_LENGTH = 80;
/** Base length capped so the `-<attempt>` suffix still fits `slug VARCHAR(80)`. */
const SLUG_BASE_MAX_LENGTH = 60;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return email.length > 0 && email.length <= 254 && EMAIL_PATTERN.test(email);
}

/** `Loja do João & Cia` -> `loja-do-joao-cia`. Deterministic and URL-safe. */
export function slugifyCompanyName(companyName: string): string {
  const ascii = companyName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const slug = ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_BASE_MAX_LENGTH)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'tenant';
}

export interface AuthServiceConfig {
  /** Preferred base for verification links (the SPA that serves `/verify-email`). */
  webOrigin: string;
  /** Fallback base when `WEB_ORIGIN` is not configured. */
  appBaseUrl: string;
}

export interface AuthServiceDependencies {
  logger: ILogger;
  clock: IClock;
  cache: ICache;
  email: IEmailService;
  config: AuthServiceConfig;
  /**
   * Reset/resend throttle. Optional only so legacy harnesses keep compiling:
   * when omitted the service builds one from the injected `cache`/`clock`.
   */
  rateLimiter?: AuthRateLimiter;
  /** Administrative audit trail (best effort). */
  audit?: IAuditService;
  repos: {
    agents: IAgentRepository;
    tenants: ITenantRepository;
    emailVerifications: IEmailVerificationRepository;
    passwordResets: IPasswordResetRepository;
    sessions: ISessionRepository;
  };
}

export class AuthService implements IAuthService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly cache: ICache;
  private readonly email: IEmailService;
  private readonly config: AuthServiceConfig;
  private readonly agents: IAgentRepository;
  private readonly tenants: ITenantRepository;
  private readonly emailVerifications: IEmailVerificationRepository;
  private readonly passwordResets: IPasswordResetRepository;
  private readonly sessions: ISessionRepository;
  private readonly rateLimiter: AuthRateLimiter;
  private readonly audit: IAuditService | undefined;
  /** Last-resort throttle window when Redis is unreachable (single instance). */
  private readonly localResendWindows = new Map<string, number>();

  constructor(deps: AuthServiceDependencies) {
    this.logger = deps.logger.child({ component: 'AuthService' });
    this.clock = deps.clock;
    this.cache = deps.cache;
    this.email = deps.email;
    this.config = deps.config;
    this.agents = deps.repos.agents;
    this.tenants = deps.repos.tenants;
    this.emailVerifications = deps.repos.emailVerifications;
    this.passwordResets = deps.repos.passwordResets;
    this.sessions = deps.repos.sessions;
    this.audit = deps.audit;
    this.rateLimiter =
      deps.rateLimiter ??
      new AuthRateLimiter({ cache: this.cache, clock: this.clock, logger: this.logger });
  }

  /* ==================================================================== */
  /* Signup                                                               */
  /* ==================================================================== */

  async signup(command: SignupCommand): Promise<SignupResult> {
    const companyName = (command.companyName ?? '').trim();
    const name = (command.name ?? '').trim();
    const email = normalizeEmail(command.email);
    const password = command.password ?? '';

    this.assertSignupInput({ companyName, name, email, password });

    const existing = await this.agents.findByEmail(email);
    if (existing !== null) {
      throw new ConflictError('An account with this e-mail already exists');
    }

    const tenant = await this.createTenant(companyName);

    // The password is hashed before the insert so no plaintext ever reaches the
    // repository, the logs or the e-mail service.
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    let agent: AgentRecord;
    try {
      agent = await this.agents.create({
        email,
        name,
        passwordHash,
        tenantId: tenant.id,
        role: 'ADMIN',
        emailVerifiedAt: null,
      });
    } catch (error) {
      // A concurrent signup can win the global e-mail unique constraint after
      // our pre-check: compensate the orphan tenant and report a 409.
      await this.compensateTenant(tenant);
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictError('An account with this e-mail already exists');
      }
      throw error;
    }

    const token = await this.issueVerificationToken(agent.id);
    await this.sendVerificationEmail(agent, token);

    this.logger.info('auth.signup.created', {
      tenantId: tenant.id,
      userId: agent.id,
    });

    return {
      tenantId: tenant.id,
      userId: agent.id,
      emailVerificationRequired: true,
    };
  }

  /* ==================================================================== */
  /* Verification                                                         */
  /* ==================================================================== */

  async verifyEmail(token: string): Promise<void> {
    const raw = (token ?? '').trim();
    if (raw.length < 32 || raw.length > 256) {
      throw this.invalidTokenError();
    }

    const record = await this.emailVerifications.findByTokenHash(hashToken(raw));
    const now = this.clock.now();
    if (
      record === null ||
      record.usedAt !== null ||
      record.expiresAt.getTime() <= now.getTime()
    ) {
      throw this.invalidTokenError();
    }

    // Mark the operator first: if the token bookkeeping fails afterwards the
    // link stays usable and a retry is idempotent (e-mail already verified).
    await this.agents.markEmailVerified(record.userId, now);
    await this.emailVerifications.markUsed(record.id, now);
    await this.emailVerifications.invalidateUnused(record.userId, now);

    this.logger.info('auth.email.verified', { userId: record.userId });
  }

  /* ==================================================================== */
  /* Resend                                                               */
  /* ==================================================================== */

  async resendVerification(email: string): Promise<void> {
    const normalized = normalizeEmail(email);
    if (!isValidEmail(normalized)) return;

    // 3 / 15 min per address. Charged BEFORE the account lookup, so an unknown
    // address and a real one hit exactly the same window (no enumeration).
    await this.rateLimiter.assertAllowed(
      AUTH_RATE_LIMITS.resendVerification,
      CACHE_KEYS.verificationResendAttempts(normalized),
    );

    // Fixed 1/minute window; a Redis outage must not turn this endpoint into a
    // 500 (fail-open, the e-mail provider is still rate limited by the clock).
    if (!(await this.consumeResendBudget(normalized))) return;

    const agent = await this.agents.findByEmail(normalized);
    if (agent === null || !agent.isActive || agent.emailVerifiedAt !== null) {
      // Same outcome as "sent": callers always get 202 (no enumeration).
      return;
    }

    const token = await this.issueVerificationToken(agent.id);
    await this.sendVerificationEmail(agent, token);

    this.logger.info('auth.email.resend', { userId: agent.id });
  }

  /* ==================================================================== */
  /* Forgot password                                                      */
  /* ==================================================================== */

  /**
   * Always resolves: the HTTP layer answers 202 for every address, so a caller
   * cannot tell an existing account from an unknown one (and the time spent is
   * dominated by the token work only when the account exists). The only
   * non-202 outcome is `429 RATE_LIMITED` after 3 requests / 15 min for the same
   * address - charged before the lookup, so it does not reveal the account.
   */
  async forgotPassword(email: string): Promise<void> {
    const normalized = normalizeEmail(email);
    if (!isValidEmail(normalized)) return;

    await this.rateLimiter.assertAllowed(
      AUTH_RATE_LIMITS.forgotPassword,
      CACHE_KEYS.passwordResetRequest(normalized),
    );

    const agent = await this.agents.findByEmail(normalized);
    if (agent === null || !agent.isActive) {
      // Same outcome as "sent" - nothing is logged that could leak existence.
      return;
    }

    const token = await this.issueResetToken(agent.id);
    await this.sendResetEmail(agent, token);

    this.logger.info('auth.password.reset_requested', { userId: agent.id });
  }

  /* ==================================================================== */
  /* Reset password                                                       */
  /* ==================================================================== */

  async resetPassword(token: string, password: string): Promise<void> {
    const raw = (token ?? '').trim();
    if (raw.length < MIN_TOKEN_LENGTH || raw.length > MAX_TOKEN_LENGTH) {
      throw this.invalidResetTokenError();
    }
    this.assertPassword(password);

    const record = await this.passwordResets.findByTokenHash(hashToken(raw));
    const now = this.clock.now();
    if (
      record === null ||
      record.usedAt !== null ||
      record.expiresAt.getTime() <= now.getTime()
    ) {
      throw this.invalidResetTokenError();
    }

    const agent = await this.agents.findById(record.userId);
    if (agent === null || !agent.isActive) {
      // A token for a removed/disabled operator must not reveal anything.
      throw this.invalidResetTokenError();
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    await this.agents.updatePassword(agent.id, passwordHash);

    // Single use + "only the newest link works" + every device is logged out.
    await this.passwordResets.markUsed(record.id, now);
    await this.passwordResets.invalidateUnused(agent.id, now);
    const revokedSessions = await this.sessions.revokeAllForUser(agent.id, now);

    // Bulk access-token revocation: the refresh sessions above are only half of
    // it - a stateless JWT would otherwise stay usable until `exp` on every
    // device. The watermark is stamped with the instant of the revocation (not
    // the request start: `bcrypt.hash` above can take a while) and is best
    // effort by contract (`setUserRevocationWatermark` never throws).
    const revocationAt = this.clock.now();
    const watermarkSet = await setUserRevocationWatermark({
      userId: agent.id,
      cache: this.cache,
      logger: this.logger,
      at: revocationAt,
    });

    this.logger.info('auth.password.reset_completed', {
      userId: agent.id,
      revokedSessions,
      watermarkSet,
    });

    this.audit?.record({
      action: AUDIT_ACTIONS.passwordResetCompleted,
      tenantId: agent.tenantId ?? null,
      actorId: agent.id,
      actorEmail: agent.email,
      resourceType: 'user',
      resourceId: agent.id,
      metadata: { revokedSessions, watermarkSet },
    });
  }

  /* ==================================================================== */
  /* Internals                                                            */
  /* ==================================================================== */

  private assertPassword(password: string): void {
    if (
      password.length < MIN_PASSWORD_LENGTH ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      throw new ValidationError(
        `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
        { field: 'password', minLength: MIN_PASSWORD_LENGTH },
      );
    }
  }

  private assertSignupInput(input: {
    companyName: string;
    name: string;
    email: string;
    password: string;
  }): void {
    if (input.companyName.length < 2 || input.companyName.length > 160) {
      throw new ValidationError('Company name must be between 2 and 160 characters', {
        field: 'companyName',
      });
    }
    if (input.name.length < 1 || input.name.length > 120) {
      throw new ValidationError('Name must be between 1 and 120 characters', {
        field: 'name',
      });
    }
    if (!isValidEmail(input.email)) {
      throw new ValidationError('A valid e-mail address is required', { field: 'email' });
    }
    this.assertPassword(input.password);
  }

  private async createTenant(companyName: string): Promise<TenantRecord> {
    const base = slugifyCompanyName(companyName).slice(0, SLUG_BASE_MAX_LENGTH);

    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
      const suffix = attempt === 1 ? '' : `-${attempt}`;
      const slug = `${base}${suffix}`.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');

      const existing = await this.tenants.findBySlug(slug);
      if (existing !== null) continue;

      try {
        return await this.tenants.create({
          slug,
          name: companyName,
          status: 'ACTIVE',
        });
      } catch (error) {
        // Two signups racing for the same slug: try the next suffix.
        if (isUniqueConstraintViolation(error)) continue;
        throw error;
      }
    }

    throw new AppError(
      'TENANT_SLUG_UNAVAILABLE',
      'Could not allocate a unique workspace slug, please retry',
      409,
    );
  }

  private async compensateTenant(tenant: TenantRecord): Promise<void> {
    try {
      await this.tenants.delete(tenant.id);
    } catch (error) {
      this.logger.warn('auth.signup.tenant_compensation_failed', {
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Creates a single-use token and stores only its SHA-256 hash. */
  private async issueVerificationToken(userId: string): Promise<string> {
    const token = randomToken(32);
    const tokenHash = hashToken(token);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_MS);

    // A resend invalidates every previous link: only the newest one can be used.
    await this.emailVerifications.invalidateUnused(userId, now);
    await this.emailVerifications.create({ userId, tokenHash, expiresAt });

    return token;
  }

  /**
   * Password reset token: 32 random bytes (64 hex), SHA-256 at rest and a
   * 30 min TTL. Requesting a new link burns every previous one.
   */
  private async issueResetToken(userId: string): Promise<string> {
    const token = randomToken(RESET_TOKEN_BYTES);
    const tokenHash = hashToken(token);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MS);

    await this.passwordResets.invalidateUnused(userId, now);
    await this.passwordResets.create({ userId, tokenHash, expiresAt });

    return token;
  }

  private async sendVerificationEmail(agent: AgentRecord, token: string): Promise<void> {
    const link = `${this.resolveLinkBase()}/verify-email?token=${encodeURIComponent(token)}`;
    try {
      await this.email.sendVerificationEmail(agent.email, link, agent.name);
    } catch (error) {
      // Signup must not fail because the SMTP relay is down: the operator can
      // request a new link later. Never log the token/link here.
      this.logger.warn('auth.email.send_failed', {
        userId: agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sendResetEmail(agent: AgentRecord, token: string): Promise<void> {
    const link = `${this.resolveLinkBase()}/reset-password?token=${encodeURIComponent(token)}`;
    try {
      await this.email.sendPasswordResetEmail(agent.email, link, agent.name);
    } catch (error) {
      // The endpoint still answers 202: the operator can ask for another link.
      this.logger.warn('auth.email.reset_send_failed', {
        userId: agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Verification pages live in the SPA, so `WEB_ORIGIN` (first origin of the
   * comma-separated allowlist) wins; `APP_BASE_URL` is the fallback when the web
   * origin is not configured (e.g. API-only deployments).
   */
  private resolveLinkBase(): string {
    const webOrigins = (this.config.webOrigin ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const base = webOrigins[0] ?? (this.config.appBaseUrl ?? '').trim();
    return base.replace(/\/+$/, '');
  }

  private invalidTokenError(): AppError {
    return new AppError(
      'INVALID_VERIFICATION_TOKEN',
      'Verification link is invalid or has expired',
      400,
    );
  }

  private invalidResetTokenError(): AppError {
    return new AppError(
      'INVALID_RESET_TOKEN',
      'Password reset link is invalid or has expired',
      400,
    );
  }

  private async consumeResendBudget(email: string): Promise<boolean> {
    try {
      return await this.cache.setNx(
        CACHE_KEYS.emailVerificationResend(email),
        '1',
        RESEND_WINDOW_SECONDS,
      );
    } catch (error) {
      this.logger.warn('auth.email.resend_throttle_unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.consumeLocalResendWindow(email);
    }
  }

  /** In-memory fallback: one send per minute per e-mail on this process. */
  private consumeLocalResendWindow(email: string): boolean {
    const now = this.clock.now().getTime();
    for (const [key, expiresAt] of this.localResendWindows) {
      if (expiresAt <= now) this.localResendWindows.delete(key);
    }
    const current = this.localResendWindows.get(email);
    if (current !== undefined && current > now) return false;
    this.localResendWindows.set(email, now + RESEND_WINDOW_SECONDS * 1000);
    return true;
  }
}
