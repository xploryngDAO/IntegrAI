import { CACHE_KEYS } from '@sac/shared';
import type { ICache, ILogger } from '@sac/shared';

/**
 * ============================================================================
 * Access-token revocation (denylist by `jti`) - P0
 * ============================================================================
 *
 * Access tokens are stateless: once signed they are valid until `exp`. Logout
 * therefore writes the token `jti` to a short-lived Redis denylist and
 * `AgentService.verifyToken` consults it on every request.
 *
 * Failure policy (explicit, deliberately asymmetric):
 *
 *  - WRITE (logout): best effort. A Redis failure must never turn a successful
 *    logout into a 5xx; the refresh sessions are still revoked and the response
 *    stays 204. The access token then survives until `exp` (logged as
 *    `auth.access_token.revoke_failed`).
 *  - READ (verifyToken): FAIL-OPEN. If Redis is unavailable we log
 *    `auth.access_token.denylist_unavailable` and keep the token acceptable.
 *    Availability wins: a Redis outage must not log every operator out (the
 *    same reasoning as the login rate limiter's degraded mode). The trade-off is
 *    bounded: an outage only widens the window in which an already logged-out
 *    token is still accepted, and the token still expires on its own.
 *
 * A token minted before this feature has no `jti`; it is accepted until `exp`
 * (rejecting it would log every operator out on deploy) but neither denied nor
 * revocable individually.
 *
 * ----------------------------------------------------------------------------
 * Bulk revocation: per-user watermark (logout everywhere / password reset)
 * ----------------------------------------------------------------------------
 *
 * The `jti` denylist covers one token. "Logout everywhere" and a password reset
 * must invalidate every access token of an operator, including tokens on other
 * devices whose `jti` was never presented to the API. For that we keep a single
 * watermark per user (`sac:auth:user:revoked:<userId>`, unix seconds): any
 * access token with `iat <= watermark` is rejected, tokens minted afterwards
 * are accepted.
 *
 * Failure policy mirrors the denylist:
 *
 *  - WRITE: best effort. A Redis failure never fails the reset/logout (the
 *    password was already changed and the refresh sessions were already
 *    revoked); it is logged as `auth.user_revocation.watermark_write_failed`.
 *  - READ: FAIL-OPEN. If the watermark cannot be read we log
 *    `auth.user_revocation.watermark_unavailable` and accept the token until its
 *    own `exp`. A Redis outage therefore widens the window in which a revoked
 *    token is still usable; it never locks the whole API out (same reasoning as
 *    the `jti` denylist and the login rate limiter).
 *
 * `iat` has one-second resolution: two tokens issued within the same second as
 * the revocation are indistinguishable, and `iat <= watermark` deliberately
 * resolves that ambiguity towards revocation (a login that lands in the same
 * second may have to be retried). Accepting them would leave a one-second
 * window in which a token minted just before the reset survives.
 */

/** Only presence matters; the value is fixed so monitoring can assert it. */
const DENY_VALUE = '1';

/**
 * How long the per-user watermark survives. It must outlive every access token
 * it invalidates; 30 days (the refresh-token TTL) comfortably exceeds the
 * access-token lifetime (`JWT_EXPIRES_IN`, default 1 h), so an expiring marker
 * can never resurrect a token that is still alive.
 */
export const USER_REVOCATION_WATERMARK_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * TTL used when the token has no `exp` claim. Tokens minted by
 * `signAccessToken` always carry `exp`, so this is purely defensive and mirrors
 * the `JWT_EXPIRES_IN` default ('1h').
 */
export const ACCESS_TOKEN_DENY_FALLBACK_TTL_SECONDS = 60 * 60;

/** Redis key of the denylist entry for one access token. */
export function accessTokenDenyKey(jti: string): string {
  return CACHE_KEYS.authAccessTokenDeny(jti);
}

/** Redis key of the per-user revocation watermark (unix seconds). */
export function userRevocationWatermarkKey(userId: string): string {
  return CACHE_KEYS.authUserRevocation(userId);
}

/**
 * Remaining lifetime of the token in whole seconds (ceil so the key never
 * expires before the token it blocks). Returns 0 when the token is already
 * expired - there is nothing left to revoke and `jwt.verify` rejects it.
 *
 * `fallbackTtlSeconds` only applies when `expiresAtSeconds` is missing or not
 * a finite number (legacy/malformed token).
 */
export function resolveAccessTokenDenyTtlSeconds(
  expiresAtSeconds: number | undefined,
  now: Date,
  fallbackTtlSeconds: number = ACCESS_TOKEN_DENY_FALLBACK_TTL_SECONDS,
): number {
  if (typeof expiresAtSeconds === 'number' && Number.isFinite(expiresAtSeconds)) {
    const remaining = Math.ceil(expiresAtSeconds - now.getTime() / 1000);
    return remaining > 0 ? remaining : 0;
  }
  return fallbackTtlSeconds > 0 ? Math.ceil(fallbackTtlSeconds) : 0;
}

export interface DenyAccessTokenInput {
  /** `jti` of the token being revoked; a legacy token without one is a no-op. */
  jti: string | undefined;
  /** `exp` claim (Unix seconds) - the denylist entry lives for what is left. */
  expiresAt?: number | undefined;
  /** Current instant; defaults to `new Date()`. */
  now?: Date | undefined;
  cache: ICache | undefined;
  logger?: ILogger | undefined;
  fallbackTtlSeconds?: number;
}

/**
 * Writes the denylist entry. Best effort: never throws.
 *
 * @returns `true` only when the key was actually stored.
 */
export async function denyAccessToken(input: DenyAccessTokenInput): Promise<boolean> {
  const jti = normalizeJti(input.jti);
  if (jti === undefined) return false;

  if (input.cache === undefined) {
    input.logger?.warn('auth.access_token.denylist_unavailable', {
      reason: 'cache_not_configured',
      jti,
    });
    return false;
  }

  const ttlSeconds = resolveAccessTokenDenyTtlSeconds(
    input.expiresAt,
    input.now ?? new Date(),
    input.fallbackTtlSeconds,
  );
  if (ttlSeconds <= 0) return false;

  try {
    await input.cache.set(accessTokenDenyKey(jti), DENY_VALUE, ttlSeconds);
    input.logger?.info('auth.access_token.revoked', { jti, ttlSeconds });
    return true;
  } catch (error) {
    input.logger?.warn('auth.access_token.revoke_failed', {
      jti,
      error: describeError(error),
    });
    return false;
  }
}

export interface IsAccessTokenDeniedInput {
  /** `jti` claim; `undefined` means a legacy token, which is accepted. */
  jti: string | undefined;
  cache: ICache | undefined;
  logger?: ILogger | undefined;
}

/**
 * Checks the denylist. FAIL-OPEN on a cache error (see the module docs): the
 * outage is logged and the token is accepted until its own `exp`.
 */
export async function isAccessTokenDenied(input: IsAccessTokenDeniedInput): Promise<boolean> {
  const jti = normalizeJti(input.jti);
  if (jti === undefined || input.cache === undefined) return false;

  try {
    return await input.cache.exists(accessTokenDenyKey(jti));
  } catch (error) {
    input.logger?.warn('auth.access_token.denylist_unavailable', {
      reason: 'cache_read_failed',
      jti,
      error: describeError(error),
    });
    return false;
  }
}

function normalizeJti(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const jti = value.trim();
  return jti.length > 0 ? jti : undefined;
}

/* ==========================================================================
 * Per-user watermark ("logout everywhere" / password reset)
 * ========================================================================== */

export interface SetUserRevocationWatermarkInput {
  /** Operator whose access tokens are being invalidated. */
  userId: string;
  cache: ICache | undefined;
  logger?: ILogger | undefined;
  /** Revocation instant; defaults to `new Date()`, stored at second precision. */
  at?: Date | undefined;
  /** Override the marker TTL (tests/ops); defaults to 30 days. */
  ttlSeconds?: number | undefined;
}

/**
 * Stores "every access token of this user with `iat <= at` is revoked".
 *
 * Best effort: never throws. The watermark is best-effort monotonic - a write
 * that would move it backwards (clock skew, an older revocation racing a newer
 * one) is a no-op, so a completed reset can never un-revoke an earlier one.
 * Under a true write race the two instants are within milliseconds of each
 * other, so the window is negligible.
 *
 * @returns `true` only when the marker is at or ahead of the requested instant.
 */
export async function setUserRevocationWatermark(
  input: SetUserRevocationWatermarkInput,
): Promise<boolean> {
  const userId = normalizeUserId(input.userId);
  if (userId === undefined) return false;

  const watermark = toUnixSeconds(input.at ?? new Date());
  if (watermark === null) return false;

  if (input.cache === undefined) {
    input.logger?.warn('auth.user_revocation.watermark_unavailable', {
      reason: 'cache_not_configured',
      userId,
    });
    return false;
  }

  const key = userRevocationWatermarkKey(userId);
  const ttlSeconds =
    input.ttlSeconds !== undefined && input.ttlSeconds > 0
      ? Math.ceil(input.ttlSeconds)
      : USER_REVOCATION_WATERMARK_TTL_SECONDS;

  try {
    // Monotonic read-then-write. A read that fails is treated as a failed
    // write (the marker is only useful when Redis is healthy).
    const current = toUnixSeconds(await input.cache.get<number | string>(key));
    if (current !== null && current >= watermark) {
      input.logger?.info('auth.user_revocation.watermark_unchanged', {
        userId,
        watermark: current,
      });
      return true;
    }

    await input.cache.set(key, watermark, ttlSeconds);
    input.logger?.info('auth.user_revocation.watermark_set', {
      userId,
      watermark,
      ttlSeconds,
    });
    return true;
  } catch (error) {
    input.logger?.warn('auth.user_revocation.watermark_write_failed', {
      userId,
      watermark,
      error: describeError(error),
    });
    return false;
  }
}

export interface IsUserTokenRevokedInput {
  /** `sub` (agent id) of the token being verified. */
  userId: string | undefined;
  /** `iat` claim in Unix seconds; absent on legacy/malformed tokens. */
  issuedAt: number | undefined;
  cache: ICache | undefined;
  logger?: ILogger | undefined;
}

/**
 * True when an access token was issued at or before the user's watermark.
 *
 * FAIL-OPEN on a cache error (see the module docs): the outage is logged and
 * the token is accepted until its own `exp`. A token without `iat`, or a user
 * without a watermark, is accepted.
 */
export async function isUserTokenRevoked(input: IsUserTokenRevokedInput): Promise<boolean> {
  const userId = normalizeUserId(input.userId);
  if (userId === undefined) return false;

  const issuedAt = toUnixSeconds(input.issuedAt);
  // A legacy token without `iat` cannot be compared: accept it until `exp`.
  if (issuedAt === null) return false;

  if (input.cache === undefined) {
    input.logger?.warn('auth.user_revocation.watermark_unavailable', {
      reason: 'cache_not_configured',
      userId,
    });
    return false;
  }

  try {
    const watermark = toUnixSeconds(
      await input.cache.get<number | string>(userRevocationWatermarkKey(userId)),
    );
    if (watermark === null) return false;
    return issuedAt <= watermark;
  } catch (error) {
    input.logger?.warn('auth.user_revocation.watermark_unavailable', {
      reason: 'cache_read_failed',
      userId,
      error: describeError(error),
    });
    return false;
  }
}

function normalizeUserId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const userId = value.trim();
  return userId.length > 0 ? userId : undefined;
}

/**
 * Unix seconds from a `Date`/number/numeric string. Values written by older
 * deployments (plain string instead of JSON) are tolerated; anything that is
 * not a finite number is `null`.
 */
function toUnixSeconds(value: Date | number | string | null | undefined): number | null {
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? Math.floor(millis / 1000) : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  }
  return null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
