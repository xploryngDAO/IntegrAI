import bcrypt from 'bcryptjs';

import { CACHE_KEYS } from '@sac/shared';
import type {
  AgentRecord,
  IAgentRepository,
  IAgentService,
  ICache,
  IClock,
  ILogger,
  ISecretCipher,
  ITwoFactorRepository,
  ITwoFactorService,
  LoginSuccess,
  SessionDeviceInfo,
  TwoFactorRecoveryCodeCountResult,
  TwoFactorRecoveryCodesResult,
  TwoFactorSetupResult,
  TwoFactorStatusResult,
  TwoFactorVerifyResult,
} from '@sac/shared';
import { AppError, AuthenticationError } from '@sac/shared';

import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from './auth/recovery-codes';
import {
  AUTH_RATE_LIMITS,
  AuthRateLimiter,
  type AuthRateLimitDecision,
  type AuthRateLimitTarget,
} from './auth/rate-limit';
import {
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_WINDOW,
  generateTotpSecret,
  matchedTotpStep,
  verifyTotp,
} from './auth/totp';
import {
  TWO_FACTOR_CHALLENGE_TTL_SECONDS,
  verifyTwoFactorChallengeToken,
} from './auth/two-factor-token';

/**
 * ============================================================================
 * TwoFactorService - TOTP enrollment, management and login challenge
 * ============================================================================
 *
 *  - `setup`    generates a 160-bit base32 secret, encrypts it with the shared
 *               `ISecretCipher` and leaves 2FA PENDING (enabled = false).
 *  - `verify`   validates a TOTP code against the pending secret, flips the
 *               flag and returns 8 recovery codes exactly once (SHA-256 at rest).
 *  - `disable`  requires the account password AND a valid TOTP/recovery code,
 *               then wipes the secret and every recovery code.
 *  - `regenerateRecoveryCodes` requires the same re-authentication as `disable`
 *               and replaces the 8 recovery codes atomically, returning the new
 *               plaintext set exactly once.
 *  - `countRecoveryCodes` reports how many codes are still unused so the SPA can
 *               warn the operator to regenerate before running out.
 *  - `challenge` redeems the short-lived JWT issued by login with a TOTP code or
 *               a one-time recovery code, then issues the normal session through
 *               `AgentService.issueSession` (same AuthResponse as login).
 *
 * Replay protection:
 *  - the last accepted TOTP time-step is cached per operator for 3 periods, so
 *    the same code cannot open a second session inside its validation window;
 *  - recovery codes are single-use through a conditional `used_at IS NULL`;
 *  - the challenge JWT carries a `jti` burned after a successful redemption.
 *
 * Brute force:
 *  - `POST /auth/2fa/challenge` allows 5 attempts per challenge `jti` and per
 *    source IP (15 min window, Redis + in-process fallback); the 6th answers
 *    `429 RATE_LIMITED` and, once the window is exhausted, the challenge is
 *    burned so it can never be redeemed (even with the correct code).
 */

export const TWO_FACTOR_ISSUER = 'SAC Hub';

const TOTP_STEP_TTL_SECONDS = TOTP_PERIOD_SECONDS * 3;
const BCRYPT_ALWAYS = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

export function buildOtpAuthUrl(input: {
  issuer: string;
  accountName: string;
  secret: string;
  digits?: number;
  periodSeconds?: number;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.accountName)}`;
  const digits = input.digits ?? TOTP_DIGITS;
  const period = input.periodSeconds ?? TOTP_PERIOD_SECONDS;
  const query = [
    `secret=${encodeURIComponent(input.secret)}`,
    `issuer=${encodeURIComponent(input.issuer)}`,
    'algorithm=SHA1',
    `digits=${digits}`,
    `period=${period}`,
  ].join('&');
  return `otpauth://totp/${label}?${query}`;
}

export interface TwoFactorServiceDependencies {
  logger: ILogger;
  clock: IClock;
  cache: ICache;
  cipher: ISecretCipher;
  jwtSecret: string;
  /** Used to issue the real session once the challenge is redeemed. */
  agentsService: IAgentService;
  /**
   * Challenge throttle. Optional only so legacy harnesses keep compiling: when
   * omitted the service builds one from the injected `cache`/`clock`.
   */
  rateLimiter?: AuthRateLimiter;
  repos: {
    agents: IAgentRepository;
    twoFactor: ITwoFactorRepository;
  };
}

export class TwoFactorService implements ITwoFactorService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly cache: ICache;
  private readonly cipher: ISecretCipher;
  private readonly jwtSecret: string;
  private readonly agentsService: IAgentService;
  private readonly agents: IAgentRepository;
  private readonly twoFactor: ITwoFactorRepository;
  private readonly rateLimiter: AuthRateLimiter;

  constructor(deps: TwoFactorServiceDependencies) {
    this.logger = deps.logger.child({ component: 'TwoFactorService' });
    this.clock = deps.clock;
    this.cache = deps.cache;
    this.cipher = deps.cipher;
    this.jwtSecret = deps.jwtSecret;
    this.agentsService = deps.agentsService;
    this.agents = deps.repos.agents;
    this.twoFactor = deps.repos.twoFactor;
    this.rateLimiter =
      deps.rateLimiter ??
      new AuthRateLimiter({ cache: this.cache, clock: this.clock, logger: this.logger });

    if (!this.jwtSecret || this.jwtSecret.length < 16) {
      throw new Error('TwoFactorService requires a configured JWT_SECRET (min 16 chars)');
    }
  }

  /* ==================================================================== */
  /* Enrollment                                                           */
  /* ==================================================================== */

  async setup(userId: string): Promise<TwoFactorSetupResult> {
    const agent = await this.loadActiveAgent(userId);
    if (agent.twoFactorEnabled) {
      throw new AppError(
        'TWO_FACTOR_ALREADY_ENABLED',
        'Two-factor authentication is already enabled',
        409,
      );
    }

    const secret = generateTotpSecret();
    const secretEnc = this.cipher.encrypt(secret);
    await this.twoFactor.setPendingSecret(agent.id, secretEnc);

    this.logger.info('auth.2fa.setup_started', { userId: agent.id });
    return {
      secret,
      otpauthUrl: buildOtpAuthUrl({
        issuer: TWO_FACTOR_ISSUER,
        accountName: agent.email,
        secret,
      }),
    };
  }

  async verify(userId: string, code: string): Promise<TwoFactorVerifyResult> {
    const agent = await this.loadActiveAgent(userId);
    if (agent.twoFactorEnabled) {
      throw new AppError(
        'TWO_FACTOR_ALREADY_ENABLED',
        'Two-factor authentication is already enabled',
        409,
      );
    }
    if (agent.twoFactorSecretEnc === null) {
      throw this.setupRequiredError();
    }

    const secret = this.decryptSecret(agent);
    const matched = matchedTotpStep(secret, code, this.clock.now(), {
      window: TOTP_WINDOW,
    });
    if (matched === null) {
      this.logger.warn('auth.2fa.verify_failed', { userId: agent.id });
      throw new AppError('INVALID_TOTP', 'Invalid two-factor code', 400);
    }

    const recoveryCodes = generateRecoveryCodes();
    await this.twoFactor.enable(
      agent.id,
      recoveryCodes.map((recoveryCode) => hashRecoveryCode(recoveryCode)),
    );

    this.logger.info('auth.2fa.enabled', { userId: agent.id });
    return { enabled: true, recoveryCodes };
  }

  /* ==================================================================== */
  /* Management                                                           */
  /* ==================================================================== */

  async disable(userId: string, password: string, code?: string): Promise<void> {
    const agent = await this.loadActiveAgent(userId);
    if (!agent.twoFactorEnabled) {
      throw new AppError(
        'TWO_FACTOR_NOT_ENABLED',
        'Two-factor authentication is not enabled',
        409,
      );
    }

    await this.requirePassword(agent, password, 'disable');
    await this.requireValidSecondFactor(agent, code, 'disable');

    await this.twoFactor.disable(agent.id);
    this.logger.info('auth.2fa.disabled', { userId: agent.id });
  }

  /**
   * Replaces every recovery code after re-authentication.
   *
   * The old set is deleted and the new one inserted in a single transaction, so
   * the break-glass path is never empty or half-written. The plaintext codes are
   * returned only here (at rest only their SHA-256 hashes exist).
   */
  async regenerateRecoveryCodes(
    userId: string,
    password: string,
    code?: string,
  ): Promise<TwoFactorRecoveryCodesResult> {
    // Brute-force gate runs before the password/code check (and before the DB
    // read), mirroring the challenge limiter: the window is about attempts.
    await this.rateLimiter.assertAllowed(
      AUTH_RATE_LIMITS.twoFactorRecoveryRegenerate,
      CACHE_KEYS.authTwoFactorRegenerateAttempts(userId),
    );

    const agent = await this.loadActiveAgent(userId);
    if (!agent.twoFactorEnabled) {
      throw new AppError(
        'TWO_FACTOR_NOT_ENABLED',
        'Two-factor authentication is not enabled',
        409,
      );
    }

    await this.requirePassword(agent, password, 'regenerate');
    // Same anti-replay rule as `disable`: a valid TOTP is accepted inside the
    // ±1 window, and a recovery code is consumed (single-use) before the set is
    // replaced.
    await this.requireValidSecondFactor(agent, code, 'regenerate');

    const recoveryCodes = generateRecoveryCodes();
    await this.twoFactor.replaceRecoveryCodes(
      agent.id,
      recoveryCodes.map((recoveryCode) => hashRecoveryCode(recoveryCode)),
    );

    this.logger.info('auth.2fa.recovery_codes_regenerated', {
      userId: agent.id,
      count: recoveryCodes.length,
    });
    return { recoveryCodes };
  }

  async countRecoveryCodes(userId: string): Promise<TwoFactorRecoveryCodeCountResult> {
    const agent = await this.loadActiveAgent(userId);
    const remaining = await this.twoFactor.countUnusedRecoveryCodes(agent.id);
    return { remaining };
  }

  async status(userId: string): Promise<TwoFactorStatusResult> {
    const agent = await this.loadActiveAgent(userId);
    return { enabled: agent.twoFactorEnabled };
  }

  /* ==================================================================== */
  /* Login challenge                                                      */
  /* ==================================================================== */

  async challenge(
    challengeToken: string,
    code: string,
    device?: SessionDeviceInfo,
  ): Promise<LoginSuccess> {
    const claims = verifyTwoFactorChallengeToken(challengeToken, this.jwtSecret);

    // Brute-force gate runs BEFORE the operator lookup / code check: the jti and
    // the source IP each have an independent 5-attempt window, and the attempt is
    // charged even when the challenge is already burned (no free probing).
    const attempts = await this.registerChallengeAttempt(claims.jti, device?.ip);

    const agent = await this.agents.findById(claims.userId);
    if (
      agent === null ||
      !agent.isActive ||
      !agent.twoFactorEnabled ||
      agent.twoFactorSecretEnc === null
    ) {
      throw this.invalidChallengeError();
    }

    if (await this.challengeAlreadyUsed(claims.jti)) {
      throw this.invalidChallengeError();
    }

    const secret = this.decryptSecret(agent);
    const now = this.clock.now();
    const candidate = (code ?? '').trim();

    let authenticated = false;
    const step = matchedTotpStep(secret, candidate, now, { window: TOTP_WINDOW });
    if (step !== null) {
      authenticated = await this.acceptTotpStep(agent.id, step);
    } else if (normalizeRecoveryCode(candidate).length > 0) {
      authenticated = await this.twoFactor.consumeRecoveryCode(
        agent.id,
        hashRecoveryCode(candidate),
        now,
      );
    }

    if (!authenticated) {
      // The window is spent: burn the challenge so even a later correct code
      // cannot redeem it; the next request is answered 429 by the limiter.
      if (attempts.some((decision) => decision.remaining <= 0)) {
        await this.burnChallenge(claims.jti, claims.expiresAt);
      }
      this.logger.warn('auth.2fa.challenge_failed', {
        userId: agent.id,
        attemptsUsed: Math.max(...attempts.map((decision) => decision.used)),
        attemptsLimit: Math.min(...attempts.map((decision) => decision.policy.limit)),
      });
      throw new AppError('INVALID_TOTP', 'Invalid two-factor code', 401);
    }

    const burned = await this.burnChallenge(claims.jti, claims.expiresAt);
    if (!burned) throw this.invalidChallengeError();

    const session = await this.agentsService.issueSession(agent.id, device);
    this.logger.info('auth.2fa.challenge_succeeded', { userId: agent.id });
    return session;
  }

  /* ==================================================================== */
  /* Internals                                                            */
  /* ==================================================================== */

  /**
   * Charges one attempt on both challenge buckets and throws
   * `429 RATE_LIMITED` when either is exhausted.
   *
   * The IP bucket is only used when the request carries an address: a caller
   * without one (internal replay, unit harness) gets the jti window only.
   */
  private async registerChallengeAttempt(
    jti: string,
    ip?: string | null,
  ): Promise<AuthRateLimitDecision[]> {
    const targets: AuthRateLimitTarget[] = [
      {
        policy: AUTH_RATE_LIMITS.twoFactorChallenge,
        key: CACHE_KEYS.authTwoFactorChallengeAttempts(jti),
      },
    ];

    const normalizedIp = (ip ?? '').trim();
    if (normalizedIp.length > 0) {
      targets.push({
        policy: AUTH_RATE_LIMITS.twoFactorChallengeIp,
        key: CACHE_KEYS.authTwoFactorIpAttempts(normalizedIp),
      });
    }

    return this.rateLimiter.consumeAll(targets);
  }

  private async loadActiveAgent(userId: string): Promise<AgentRecord> {
    const agent = await this.agents.findById(userId);
    if (agent === null || !agent.isActive) {
      throw new AuthenticationError('Account is not available');
    }
    return agent;
  }

  private async safePasswordCompare(password: string, passwordHash: string): Promise<boolean> {
    try {
      // Always run bcrypt (even for an empty password) so the timing does not
      // reveal whether the caller sent one.
      return await bcrypt.compare(password, passwordHash || BCRYPT_ALWAYS);
    } catch {
      return false;
    }
  }

  /** Re-authentication prerequisite shared by `disable` and `regenerate`. */
  private async requirePassword(
    agent: AgentRecord,
    password: string,
    action: 'disable' | 'regenerate',
  ): Promise<void> {
    const passwordMatches = await this.safePasswordCompare(password ?? '', agent.passwordHash);
    if (!passwordMatches) {
      this.logger.warn(`auth.2fa.${action}_wrong_password`, { userId: agent.id });
      throw new AppError('INVALID_PASSWORD', 'Password is incorrect', 401);
    }
  }

  /**
   * Second-factor prerequisite shared by `disable` and `regenerate`:
   * a valid TOTP inside the ±1 window OR a current recovery code, which is
   * consumed on use (single-use, matching the `disable` anti-replay rule).
   */
  private async requireValidSecondFactor(
    agent: AgentRecord,
    code: string | undefined,
    action: 'disable' | 'regenerate',
  ): Promise<void> {
    const secret = this.decryptSecret(agent);
    const now = this.clock.now();
    const candidate = (code ?? '').trim();

    let valid = candidate.length > 0 && verifyTotp(secret, candidate, now, { window: TOTP_WINDOW });
    if (!valid && normalizeRecoveryCode(candidate).length > 0) {
      valid = await this.twoFactor.consumeRecoveryCode(
        agent.id,
        hashRecoveryCode(candidate),
        now,
      );
    }
    if (!valid) {
      this.logger.warn(`auth.2fa.${action}_invalid_code`, { userId: agent.id });
      throw new AppError('INVALID_TOTP', 'Invalid two-factor code', 400);
    }
  }

  private decryptSecret(agent: AgentRecord): string {
    if (agent.twoFactorSecretEnc === null) throw this.setupRequiredError();
    try {
      return this.cipher.decrypt(agent.twoFactorSecretEnc);
    } catch (error) {
      this.logger.error('auth.2fa.secret_unreadable', {
        userId: agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(
        'TWO_FACTOR_SECRET_UNREADABLE',
        'Stored two-factor secret could not be read; run setup again',
        409,
      );
    }
  }

  /**
   * Rejects a TOTP code whose time-step was already accepted. The ±1 window
   * alone would otherwise allow the same 6 digits for ~90 seconds.
   */
  private async acceptTotpStep(userId: string, step: number): Promise<boolean> {
    const key = CACHE_KEYS.twoFactorTotpStep(userId);
    try {
      const fresh = await this.cache.setNx(key, String(step), TOTP_STEP_TTL_SECONDS);
      if (fresh) return true;

      const currentRaw = await this.cache.get<string>(key);
      const current = Number(currentRaw ?? '');
      if (Number.isFinite(current) && current >= step) return false;

      await this.cache.set(key, String(step), TOTP_STEP_TTL_SECONDS);
      return true;
    } catch (error) {
      // A Redis outage must not lock every 2FA operator out: recovery codes stay
      // single-use in Postgres and the TOTP window is still narrow.
      this.logger.warn('auth.2fa.totp_guard_unavailable', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  private async challengeAlreadyUsed(jti: string): Promise<boolean> {
    try {
      return await this.cache.exists(CACHE_KEYS.twoFactorChallenge(jti));
    } catch (error) {
      this.logger.warn('auth.2fa.challenge_guard_unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Single-use marker for the challenge JWT (best effort: never blocks login). */
  private async burnChallenge(jti: string, expiresAt: number): Promise<boolean> {
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    const ttl = expiresAt > 0 ? expiresAt - nowSeconds : TWO_FACTOR_CHALLENGE_TTL_SECONDS;
    try {
      return await this.cache.setNx(
        CACHE_KEYS.twoFactorChallenge(jti),
        '1',
        Math.max(1, ttl),
      );
    } catch (error) {
      this.logger.warn('auth.2fa.challenge_burn_unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  private setupRequiredError(): AppError {
    return new AppError(
      'TWO_FACTOR_SETUP_REQUIRED',
      'Start two-factor setup before verifying a code',
      409,
    );
  }

  private invalidChallengeError(): AppError {
    return new AppError(
      'INVALID_CHALLENGE_TOKEN',
      'Two-factor challenge is invalid or has expired',
      401,
    );
  }
}
