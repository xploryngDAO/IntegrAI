import { createHash, randomBytes } from 'node:crypto';

import { base32Encode } from './totp';

/**
 * Recovery codes: the break-glass path when the authenticator is unavailable.
 *
 *  - 8 codes, 40 bits each (5 random bytes -> 8 base32 chars), rendered as
 *    `XXXX-XXXX` for readability;
 *  - only the SHA-256 of the normalized value is persisted (UNIQUE column);
 *  - `normalizeRecoveryCode` makes comparison forgiving (case, spaces, hyphens)
 *    while hashing a single canonical form.
 */

export const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_BYTES = 5;
const CODE_HALF_LENGTH = 4;

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    const raw = base32Encode(randomBytes(RECOVERY_CODE_BYTES));
    codes.add(`${raw.slice(0, CODE_HALF_LENGTH)}-${raw.slice(CODE_HALF_LENGTH)}`);
  }
  return [...codes];
}

/** Canonical form used both for hashing and for lookups. */
export function normalizeRecoveryCode(code: string): string {
  return (code ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '');
}

/** SHA-256 (hex) of the canonical recovery code - the only stored form. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code), 'utf8').digest('hex');
}
