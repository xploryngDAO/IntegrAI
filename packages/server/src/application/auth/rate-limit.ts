import type { ICache, IClock, ILogger } from '@sac/shared';
import { RateLimitError, redactPiiForLogs } from '@sac/shared';

/**
 * ============================================================================
 * Sensitive-auth rate limiting (fixed window, Redis + in-process fallback)
 * ============================================================================
 *
 * One reusable gate for every unauthenticated flow that can be brute forced:
 *
 *  - `login`                    10 attempts / 15 min per e-mail + client IP
 *  - `2fa/challenge`             5 attempts / 15 min per challenge `jti` and per IP
 *  - `auth/forgot-password`      3 requests / 15 min per e-mail
 *  - `auth/resend-verification`  3 requests / 15 min per e-mail
 *  - `auth/2fa/recovery-codes/regenerate`
 *                                5 attempts / 15 min per operator
 *
 * Mechanics: every attempt is a `INCR` on a namespaced key with the window TTL
 * applied on the first hit (`RedisCache.incr` runs both atomically in Lua), so N
 * API instances share one counter. The counter is incremented BEFORE the
 * credential check, which makes the limit independent of whether the attempt
 * would have succeeded and keeps unknown/known accounts indistinguishable
 * (429 is decided by the address alone, never by the account state).
 *
 * Availability: an `ICache` failure (Redis down) must never lock operators out
 * or turn a public endpoint into a 500. The limiter then falls back to an
 * in-process fixed window (per e-mail/IP key) and logs `degraded: true`; the
 * window still blocks brute force, just without the distributed guarantee.
 *
 * Keys never appear in logs: they embed the e-mail/IP, so only the bucket name,
 * the limit and the counter value are logged.
 */

export interface AuthRateLimitPolicy {
  /** Stable bucket name used in `details.bucket` and in the logs. */
  bucket: string;
  /** Requests allowed inside one window (the limit itself is allowed). */
  limit: number;
  /** Fixed window length in seconds. */
  windowSeconds: number;
}

/** The policies of `docs/PHASE1_AUTH.md` (security / LGPD section). */
export const AUTH_RATE_LIMITS = {
  login: { bucket: 'auth.login', limit: 10, windowSeconds: 15 * 60 },
  twoFactorChallenge: { bucket: 'auth.2fa.challenge', limit: 5, windowSeconds: 15 * 60 },
  twoFactorChallengeIp: { bucket: 'auth.2fa.challenge.ip', limit: 5, windowSeconds: 15 * 60 },
  forgotPassword: { bucket: 'auth.forgot-password', limit: 3, windowSeconds: 15 * 60 },
  resendVerification: { bucket: 'auth.resend-verification', limit: 3, windowSeconds: 15 * 60 },
  twoFactorRecoveryRegenerate: {
    bucket: 'auth.2fa.recovery-codes.regenerate',
    limit: 5,
    windowSeconds: 15 * 60,
  },
  /*
   * Enforced 2FA enrollment (`require_2fa` policy). `/auth/2fa/enroll/*` is
   * public (the Bearer setupToken authenticates it), so both steps are throttled
   * per client IP; verify additionally has a per-`jti` window so a single leaked
   * token cannot be brute-forced from many addresses.
   */
  twoFactorEnrollSetup: {
    bucket: 'auth.2fa.enroll.setup',
    limit: 10,
    windowSeconds: 15 * 60,
  },
  twoFactorEnrollVerify: {
    bucket: 'auth.2fa.enroll.verify',
    limit: 5,
    windowSeconds: 15 * 60,
  },
  twoFactorEnrollVerifyIp: {
    bucket: 'auth.2fa.enroll.verify.ip',
    limit: 5,
    windowSeconds: 15 * 60,
  },
  /*
   * Enterprise SSO public endpoints. They are unauthenticated (the browser has
   * no token yet), so each one is throttled per client IP:
   *  - discover is an e-mail-domain oracle (30/15min);
   *  - start/callback/exchange drive an outbound IdP call or a token mint (20/15min).
   */
  ssoDiscover: { bucket: 'auth.sso.discover', limit: 30, windowSeconds: 15 * 60 },
  ssoStart: { bucket: 'auth.sso.start', limit: 20, windowSeconds: 15 * 60 },
  ssoCallback: { bucket: 'auth.sso.callback', limit: 20, windowSeconds: 15 * 60 },
  ssoExchange: { bucket: 'auth.sso.exchange', limit: 20, windowSeconds: 15 * 60 },
} as const satisfies Record<string, AuthRateLimitPolicy>;

export interface AuthRateLimitDecision {
  policy: AuthRateLimitPolicy;
  /** Requests consumed in the current window (including this one). */
  used: number;
  /** Requests still allowed in the current window (never negative). */
  remaining: number;
  allowed: boolean;
  /** 0 while allowed; time until the window resets when blocked. */
  retryAfterMs: number;
  /** True when Redis failed and the in-process window answered instead. */
  degraded: boolean;
}

export interface AuthRateLimitTarget {
  policy: AuthRateLimitPolicy;
  /** Namespaced counter key (see `CACHE_KEYS.auth*`). */
  key: string;
}

export interface AuthRateLimiterDependencies {
  cache: ICache;
  clock: IClock;
  logger: ILogger;
}

/** Hard cap on the in-process fallback map (bounded memory under an outage). */
const MAX_LOCAL_KEYS = 10_000;

interface LocalWindow {
  used: number;
  resetAt: number;
}

export class AuthRateLimiter {
  private readonly cache: ICache;
  private readonly clock: IClock;
  private readonly logger: ILogger;
  /** Last-resort windows used only while `ICache` is failing. */
  private readonly localWindows = new Map<string, LocalWindow>();

  constructor(deps: AuthRateLimiterDependencies) {
    this.cache = deps.cache;
    this.clock = deps.clock;
    this.logger = deps.logger.child({ component: 'AuthRateLimiter' });
  }

  /**
   * Registers one attempt and decides whether it may proceed.
   *
   * The attempt is ALWAYS counted (also when it will be blocked), which keeps
   * the window monotonic under concurrent requests.
   */
  async consume(policy: AuthRateLimitPolicy, key: string): Promise<AuthRateLimitDecision> {
    assertPolicy(policy);

    let used: number;
    let degraded = false;
    try {
      used = await this.cache.incr(key, policy.windowSeconds);
      if (!Number.isFinite(used) || used <= 0) {
        throw new Error(`Unexpected rate-limit counter value: ${String(used)}`);
      }
    } catch (error) {
      degraded = true;
      used = this.consumeLocalWindow(key, policy.windowSeconds);
      this.logger.warn('auth.rate_limit.degraded', {
        bucket: policy.bucket,
        limit: policy.limit,
        used,
        error: redactPiiForLogs(error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }

    const allowed = used <= policy.limit;
    const remaining = Math.max(0, policy.limit - used);
    const retryAfterMs = allowed ? 0 : await this.retryAfterMs(key, policy);

    return { policy, used, remaining, allowed, retryAfterMs, degraded };
  }

  /** `consume` + throw the stable `429 RATE_LIMITED` when the window is full. */
  async assertAllowed(
    policy: AuthRateLimitPolicy,
    key: string,
  ): Promise<AuthRateLimitDecision> {
    const decision = await this.consume(policy, key);
    if (!decision.allowed) throw this.blocked(decision);
    return decision;
  }

  /**
   * Consumes several buckets as one attempt (e.g. 2FA: challenge `jti` + IP).
   *
   * Every bucket is incremented BEFORE deciding, so a blocked challenge still
   * charges the IP window (and vice versa) and an attacker cannot dodge one
   * bucket by exhausting the other first. Throws the most constrained blocked
   * bucket.
   */
  async consumeAll(targets: readonly AuthRateLimitTarget[]): Promise<AuthRateLimitDecision[]> {
    const decisions: AuthRateLimitDecision[] = [];
    for (const target of targets) {
      decisions.push(await this.consume(target.policy, target.key));
    }

    const blocked = decisions
      .filter((decision) => !decision.allowed)
      .sort((a, b) => a.remaining - b.remaining)[0];
    if (blocked !== undefined) throw this.blocked(blocked);
    return decisions;
  }

  /** Clears one bucket (tests / manual unblock). */
  async reset(key: string): Promise<void> {
    this.localWindows.delete(key);
    try {
      await this.cache.del(key);
    } catch (error) {
      this.logger.warn('auth.rate_limit.reset_failed', {
        error: redactPiiForLogs(error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
  }

  /* ==================================================================== */
  /* Internals                                                            */
  /* ==================================================================== */

  private blocked(decision: AuthRateLimitDecision): RateLimitError {
    this.logger.warn('auth.rate_limit.blocked', {
      bucket: decision.policy.bucket,
      limit: decision.policy.limit,
      used: decision.used,
      windowSeconds: decision.policy.windowSeconds,
      retryAfterMs: decision.retryAfterMs,
      degraded: decision.degraded,
    });
    return new RateLimitError(decision.policy.bucket, decision.retryAfterMs);
  }

  /**
   * Best-effort remaining window for the `Retry-After` hint. A missing/negative
   * TTL (redis semantics: -1 no TTL, -2 no key) falls back to the full window.
   */
  private async retryAfterMs(key: string, policy: AuthRateLimitPolicy): Promise<number> {
    const fullWindowMs = policy.windowSeconds * 1_000;
    try {
      const ttlSeconds = await this.cache.ttl(key);
      if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
        return Math.min(fullWindowMs, Math.ceil(ttlSeconds * 1_000));
      }
    } catch {
      // Redis is already degraded: the full window is the safe upper bound.
    }
    return fullWindowMs;
  }

  /** In-process fixed window used only when Redis fails. */
  private consumeLocalWindow(key: string, windowSeconds: number): number {
    const now = this.clock.now().getTime();
    this.pruneLocalWindows(now);

    const current = this.localWindows.get(key);
    if (current === undefined || current.resetAt <= now) {
      this.localWindows.set(key, { used: 1, resetAt: now + windowSeconds * 1_000 });
      return 1;
    }

    current.used += 1;
    return current.used;
  }

  /** Drops expired windows and keeps the fallback map bounded. */
  private pruneLocalWindows(now: number): void {
    for (const [key, window] of this.localWindows) {
      if (window.resetAt <= now) this.localWindows.delete(key);
    }
    // Map iteration follows insertion order: the first keys are the oldest.
    while (this.localWindows.size > MAX_LOCAL_KEYS) {
      const oldest = this.localWindows.keys().next();
      if (oldest.done === true) break;
      this.localWindows.delete(oldest.value);
    }
  }
}

function assertPolicy(policy: AuthRateLimitPolicy): void {
  if (
    policy.bucket.length === 0 ||
    !Number.isInteger(policy.limit) ||
    policy.limit < 1 ||
    !Number.isFinite(policy.windowSeconds) ||
    policy.windowSeconds < 1
  ) {
    throw new Error(`Invalid auth rate-limit policy: ${JSON.stringify(policy)}`);
  }
}
