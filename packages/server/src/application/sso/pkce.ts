import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * ============================================================================
 * Enterprise SSO - PKCE and HMAC-signed `state`
 * ============================================================================
 *
 * `state` has two independent protections:
 *
 *  1. a server-side single-use record in Redis (payload + TTL 10 min);
 *  2. an HMAC-SHA256 signature appended to the value itself, so a forged or
 *     truncated `state` is rejected before any datastore lookup (and cannot be
 *     used to probe Redis keys).
 *
 * The signature key is derived from `JWT_SECRET` with domain separation, so a
 * leaked access token secret rotation invalidates pending states as well.
 */

const STATE_CONTEXT = 'sac:sso:state:v1';
const STATE_RANDOM_BYTES = 24;
const PKCE_VERIFIER_BYTES = 32;
const NONCE_BYTES = 32;

/** base64url without padding (RFC 7636 alphabet). */
export function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/** Verifier: 43 chars (32 random bytes) - inside the RFC 7636 43..128 range. */
export function createPkceVerifier(): string {
  return base64Url(randomBytes(PKCE_VERIFIER_BYTES));
}

/** S256 challenge: `base64url(sha256(verifier))`. */
export function createPkceChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** Opaque `nonce` echoed by the IdP inside the ID token. */
export function createNonce(): string {
  return base64Url(randomBytes(NONCE_BYTES));
}

/** Opaque one-time hand-off code (twice the size of a session refresh token). */
export function createOneTimeCode(): string {
  return base64Url(randomBytes(32));
}

function signState(secret: string, value: string): string {
  return createHmac('sha256', secret).update(`${STATE_CONTEXT}:${value}`, 'utf8').digest('base64url');
}

/** `state` = `<random>.<HMAC>`; the random part is stored server-side. */
export function createSignedState(secret: string): string {
  const random = base64Url(randomBytes(STATE_RANDOM_BYTES));
  return `${random}.${signState(secret, random)}`;
}

/**
 * Verifies the HMAC of a `state` value in constant time.
 *
 * Returns the opaque random part (the Redis key suffix) or `null` when the value
 * is malformed/tampered with.
 */
export function verifySignedState(secret: string, state: string): string | null {
  const value = (state ?? '').trim();
  const separator = value.lastIndexOf('.');
  if (separator <= 0 || separator === value.length - 1) return null;

  const random = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (random.length < 16 || random.length > 128 || signature.length > 128) return null;

  const expected = signState(secret, random);
  return constantTimeEquals(signature, expected) ? random : null;
}

/** Length-safe constant-time string comparison (hex/base64url values). */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  if (left.length === 0) return false;
  return timingSafeEqual(left, right);
}
