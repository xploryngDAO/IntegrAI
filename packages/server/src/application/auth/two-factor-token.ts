import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';
import type { JwtPayload } from 'jsonwebtoken';
import { AppError } from '@sac/shared';

import { JWT_ISSUER } from './access-token';

/**
 * ============================================================================
 * 2FA challenge token
 * ============================================================================
 *
 * Login answers `401 TWO_FACTOR_REQUIRED` with a short-lived JWT instead of a
 * session. The token is signed with the same secret as the access token but is
 * NOT accepted by the JWT guard: `scope: '2fa'` marks it, and the guard never
 * sees it because `/auth/2fa/challenge` is public and the token travels in the
 * body. `jti` lets the service burn it after a successful redemption.
 */

export const TWO_FACTOR_CHALLENGE_SCOPE = '2fa';
export const TWO_FACTOR_CHALLENGE_TTL = '5m';
export const TWO_FACTOR_CHALLENGE_TTL_SECONDS = 5 * 60;
/**
 * Dedicated audience: the JWT guard only accepts `sac-web`, so a challenge
 * token can never be replayed as a Bearer session even though it shares the
 * signing secret. `AgentService.verifyToken` also rejects any `scope` claim.
 */
export const TWO_FACTOR_CHALLENGE_AUDIENCE = 'sac-2fa';

export interface TwoFactorChallengeClaims {
  userId: string;
  tenantId: string | null;
  jti: string;
  /** Unix seconds (absent only on malformed legacy tokens). */
  expiresAt: number;
}

export interface SignTwoFactorChallengeInput {
  userId: string;
  tenantId: string | null;
  secret: string;
}

export function signTwoFactorChallengeToken(input: SignTwoFactorChallengeInput): string {
  return jwt.sign(
    {
      scope: TWO_FACTOR_CHALLENGE_SCOPE,
      tenantId: input.tenantId,
      jti: randomUUID(),
    },
    input.secret,
    {
      algorithm: 'HS256',
      expiresIn: TWO_FACTOR_CHALLENGE_TTL,
      issuer: JWT_ISSUER,
      audience: TWO_FACTOR_CHALLENGE_AUDIENCE,
      subject: input.userId,
    },
  );
}

function invalidChallengeError(): AppError {
  return new AppError(
    'INVALID_CHALLENGE_TOKEN',
    'Two-factor challenge is invalid or has expired',
    401,
  );
}

export function verifyTwoFactorChallengeToken(
  token: string,
  secret: string,
): TwoFactorChallengeClaims {
  const raw = (token ?? '').trim();
  if (raw.length === 0) throw invalidChallengeError();

  let decoded: JwtPayload | string;
  try {
    decoded = jwt.verify(raw, secret, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: TWO_FACTOR_CHALLENGE_AUDIENCE,
    });
  } catch {
    throw invalidChallengeError();
  }

  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    decoded.scope !== TWO_FACTOR_CHALLENGE_SCOPE ||
    typeof decoded.sub !== 'string' ||
    decoded.sub.length === 0 ||
    typeof decoded.jti !== 'string' ||
    decoded.jti.length === 0
  ) {
    throw invalidChallengeError();
  }

  return {
    userId: decoded.sub,
    tenantId: typeof decoded.tenantId === 'string' ? decoded.tenantId : null,
    jti: decoded.jti,
    expiresAt: typeof decoded.exp === 'number' ? decoded.exp : 0,
  };
}
