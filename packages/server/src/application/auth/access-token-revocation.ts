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
 */

/** Only presence matters; the value is fixed so monitoring can assert it. */
const DENY_VALUE = '1';

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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
