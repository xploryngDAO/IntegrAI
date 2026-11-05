import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  matchedTotpStep,
  totp,
  verifyTotp,
} from '../auth/totp';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from '../auth/recovery-codes';

/**
 * RFC 6238 Appendix B (SHA-1) vectors. The reference secret is the ASCII string
 * "12345678901234567890"; the table uses 8 digits, while the product default is
 * 6 digits (the last 6 digits of the same truncated value).
 */
const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const RFC_VECTORS: ReadonlyArray<readonly [unixSeconds: number, code8: string]> = [
  [59, '94287082'],
  [1_111_111_109, '07081804'],
  [1_111_111_111, '14050471'],
  [1_234_567_890, '89005924'],
  [2_000_000_000, '69279037'],
  [20_000_000_000, '65353130'],
];

describe('base32 (RFC 4648)', () => {
  it('encodes the RFC 6238 reference secret exactly', () => {
    expect(base32Encode(Buffer.from(RFC_SECRET_ASCII, 'utf8'))).toBe(RFC_SECRET_BASE32);
  });

  it('round-trips arbitrary secrets', () => {
    const source = Buffer.from('a-160-bit-secret-for-tests!!', 'utf8');
    expect(base32Decode(base32Encode(source)).equals(source)).toBe(true);
  });

  it('tolerates lowercase, spaces, hyphens and padding when decoding', () => {
    const decoded = base32Decode('gezd gnbv-gy3t qojq gezdgnbvgy3tqojq==');
    expect(decoded.toString('utf8')).toBe(RFC_SECRET_ASCII);
  });

  it('rejects characters outside the base32 alphabet', () => {
    expect(() => base32Decode('GEZD!')).toThrow(/Invalid base32/);
  });

  it('generates a 160-bit secret (32 unpadded base32 chars)', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(secret);
  });
});

describe('TOTP (RFC 6238)', () => {
  it.each(RFC_VECTORS)('matches the RFC vector at T=%i', (unixSeconds, code8) => {
    const at = new Date(unixSeconds * 1000);
    expect(totp(RFC_SECRET_BASE32, at, { digits: 8 })).toBe(code8);

    // The default 6-digit code is the same dynamic-truncation value mod 10^6.
    expect(totp(RFC_SECRET_BASE32, at)).toBe(code8.slice(-6));
  });

  it('uses HMAC-SHA1 counters (HOTP RFC 4226 vector: counter 0 -> 755224)', () => {
    // RFC 4226 uses the same ASCII secret and a 6 digit code.
    expect(hotp(RFC_SECRET_BASE32, 0)).toBe('755224');
  });

  it('accepts the previous and next 30 s step (±1 window)', () => {
    const at = new Date(1_700_000_000 * 1000);
    const code = totp(RFC_SECRET_BASE32, at);

    expect(verifyTotp(RFC_SECRET_BASE32, code, at)).toBe(true);
    expect(verifyTotp(RFC_SECRET_BASE32, code, new Date(at.getTime() + 30_000))).toBe(true);
    expect(verifyTotp(RFC_SECRET_BASE32, code, new Date(at.getTime() - 30_000))).toBe(true);
  });

  it('rejects codes two steps away and codes from another secret', () => {
    const at = new Date(1_700_000_000 * 1000);
    const code = totp(RFC_SECRET_BASE32, at);

    expect(verifyTotp(RFC_SECRET_BASE32, code, new Date(at.getTime() + 60_000))).toBe(false);
    expect(verifyTotp(RFC_SECRET_BASE32, code, new Date(at.getTime() - 60_000))).toBe(false);
    expect(verifyTotp(generateTotpSecret(), code, at)).toBe(false);
  });

  it('rejects malformed codes without throwing', () => {
    const at = new Date(1_700_000_000 * 1000);
    expect(matchedTotpStep(RFC_SECRET_BASE32, '', at)).toBeNull();
    expect(matchedTotpStep(RFC_SECRET_BASE32, '12345', at)).toBeNull();
    expect(matchedTotpStep(RFC_SECRET_BASE32, 'abcdef', at)).toBeNull();
    expect(matchedTotpStep(RFC_SECRET_BASE32, '1234567', at)).toBeNull();
  });

  it('returns the accepted time-step so callers can reject replays', () => {
    const at = new Date(1_700_000_000 * 1000);
    const code = totp(RFC_SECRET_BASE32, at);
    const step = Math.floor(at.getTime() / 1000 / 30);

    expect(matchedTotpStep(RFC_SECRET_BASE32, code, at)).toBe(step);
    // One step later the code is still inside the ±1 window; the returned step
    // is always the code's own step, not the current clock step.
    expect(matchedTotpStep(RFC_SECRET_BASE32, code, new Date(at.getTime() + 30_000))).toBe(step);
  });
});

describe('recovery codes', () => {
  it('generates 8 unique, readable codes', () => {
    const codes = generateRecoveryCodes();

    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    }
  });

  it('hashes the canonical form only (SHA-256 hex)', () => {
    const code = 'abcd-2345';
    const hash = hashRecoveryCode(code);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashRecoveryCode(' ABCD 2345 '));
    expect(hash).not.toContain(normalizeRecoveryCode(code));
    expect(normalizeRecoveryCode(code)).toBe('ABCD2345');
  });

  it('drops characters outside the base32 alphabet when normalizing', () => {
    expect(normalizeRecoveryCode('a-b-c-d-2-3-4-5!')).toBe('ABCD2345');
  });
});
