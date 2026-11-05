import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * ============================================================================
 * TOTP (RFC 6238) + base32 (RFC 4648) primitives
 * ============================================================================
 *
 * Implemented on top of `node:crypto` on purpose: no third-party dependency.
 *
 *  - HMAC-SHA1, 6 digits, 30 s step, ±1 step verification window (clock skew);
 *  - secrets are 20 random bytes (160 bits) encoded as unpadded base32;
 *  - comparison is constant time (`timingSafeEqual`), never `===`;
 *  - `matchedTotpStep` returns the accepted time-step so the caller can reject
 *    replays of the same code (the window alone would allow it for ~90 s).
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20;
const TOTP_ALGORITHM = 'sha1';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_LOOKUP = new Map<string, number>(
  [...BASE32_ALPHABET].map((char, index) => [char, index]),
);

/** Unpadded base32 (RFC 4648 §6), uppercase - the TOTP secret encoding. */
export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/**
 * Decodes base32, tolerating lowercase, spaces, hyphens and `=` padding (users
 * paste secrets from authenticator apps in every shape).
 */
export function base32Decode(input: string): Buffer {
  const normalized = (input ?? '')
    .trim()
    .replace(/[\s-]/g, '')
    .replace(/=+$/g, '')
    .toUpperCase();

  if (normalized.length === 0) return Buffer.alloc(0);

  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of normalized) {
    const index = BASE32_LOOKUP.get(char);
    if (index === undefined) {
      throw new Error(`Invalid base32 character: ${char}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }

  return Buffer.from(bytes);
}

/** 160-bit random secret, base32 encoded (32 chars, no padding). */
export function generateTotpSecret(bytes: number = TOTP_SECRET_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < 16) {
    throw new Error('TOTP secret must have at least 128 bits (16 bytes)');
  }
  return base32Encode(randomBytes(bytes));
}

export interface HotpOptions {
  digits?: number;
  periodSeconds?: number;
}

/** RFC 4226 HOTP over an explicit counter (BigInt counter, 8-byte big endian). */
export function hotp(
  secret: string | Buffer,
  counter: number | bigint,
  options: Pick<HotpOptions, 'digits'> = {},
): string {
  const key = typeof secret === 'string' ? base32Decode(secret) : secret;
  if (key.length === 0) throw new Error('TOTP secret must not be empty');

  const digits = options.digits ?? TOTP_DIGITS;
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(TOTP_ALGORITHM, key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    (digest[offset] & 0x7f) * 0x1000000 +
    ((digest[offset + 1] & 0xff) << 16) +
    ((digest[offset + 2] & 0xff) << 8) +
    (digest[offset + 3] & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

function toEpochMs(at: Date | number): number {
  return at instanceof Date ? at.getTime() : at;
}

/** Time-step (`floor(unixSeconds / period)`) for an instant. */
export function currentTotpStep(
  at: Date | number = new Date(),
  periodSeconds: number = TOTP_PERIOD_SECONDS,
): number {
  return Math.floor(toEpochMs(at) / 1000 / periodSeconds);
}

/** RFC 6238 TOTP for an instant. */
export function totp(
  secret: string,
  at: Date | number = new Date(),
  options: HotpOptions = {},
): string {
  const period = options.periodSeconds ?? TOTP_PERIOD_SECONDS;
  return hotp(secret, currentTotpStep(at, period), { digits: options.digits ?? TOTP_DIGITS });
}

export interface TotpVerificationOptions extends HotpOptions {
  /** Accepted steps before/after the current one. Defaults to ±1. */
  window?: number;
}

function constantTimeEquals(expected: string, provided: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(provided, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Returns the matching time-step when `code` is valid inside the window, or
 * `null`. Callers persist the step to reject a replay of the same code.
 */
export function matchedTotpStep(
  secret: string,
  code: string,
  at: Date | number = new Date(),
  options: TotpVerificationOptions = {},
): number | null {
  const digits = options.digits ?? TOTP_DIGITS;
  const period = options.periodSeconds ?? TOTP_PERIOD_SECONDS;
  const window = options.window ?? TOTP_WINDOW;

  const provided = (code ?? '').trim();
  if (provided.length !== digits || !/^\d+$/.test(provided)) return null;

  const current = currentTotpStep(at, period);
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    if (step < 0) continue;
    if (constantTimeEquals(hotp(secret, step, { digits }), provided)) return step;
  }
  return null;
}

/** Boolean convenience wrapper over `matchedTotpStep`. */
export function verifyTotp(
  secret: string,
  code: string,
  at: Date | number = new Date(),
  options: TotpVerificationOptions = {},
): boolean {
  return matchedTotpStep(secret, code, at, options) !== null;
}
