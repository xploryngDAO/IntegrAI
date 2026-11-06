import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';
import type { JwtPayload } from 'jsonwebtoken';
import { AppError } from '@sac/shared';

import { JWT_ISSUER } from './access-token';

/**
 * ============================================================================
 * Enforced 2FA enrollment token (`setupToken`)
 * ============================================================================
 *
 * A workspace with `require_2fa = true` blocks the password login of an operator
 * WITHOUT an active TOTP factor. No session is issued: the login answers
 * `403 TWO_FACTOR_SETUP_REQUIRED` with `details.setupToken`, a 15 min JWT that
 * only authorizes the enrollment endpoints:
 *
 *   POST /api/v1/auth/2fa/enroll/setup   (Bearer setupToken) -> { secret, otpauthUri }
 *   POST /api/v1/auth/2fa/enroll/verify  (Bearer setupToken) -> AuthResponse + recoveryCodes
 *
 * Isolation from real sessions:
 *  - dedicated audience `sac-2fa-setup` (the JWT guard only accepts `sac-web`);
 *  - `scope: '2fa-setup'` is also rejected by `AgentService.verifyToken`;
 *  - the token is only accepted from the `Authorization: Bearer` header of the
 *    two public enrollment routes, never from a body.
 *
 * Single-use: `jti` is burned in Redis by `TwoFactorService.enrollVerify` before
 * the TOTP flag is enabled, so a captured token cannot replay the enrollment.
 */

export const TWO_FACTOR_SETUP_SCOPE = '2fa-setup';
export const TWO_FACTOR_SETUP_AUDIENCE = 'sac-2fa-setup';
export const TWO_FACTOR_SETUP_TTL = '15m';
export const TWO_FACTOR_SETUP_TTL_SECONDS = 15 * 60;

export interface TwoFactorSetupClaims {
  /** Same value as `sub`; exposed explicitly for handlers/services. */
  agentId: string;
  tenantId: string | null;
  jti: string;
  /** Unix seconds (0 on a malformed legacy token). */
  expiresAt: number;
}

export interface SignTwoFactorSetupInput {
  agentId: string;
  tenantId: string | null;
  secret: string;
}

export function signTwoFactorSetupToken(input: SignTwoFactorSetupInput): string {
  return jwt.sign(
    {
      scope: TWO_FACTOR_SETUP_SCOPE,
      agentId: input.agentId,
      tenantId: input.tenantId,
      jti: randomUUID(),
    },
    input.secret,
    {
      algorithm: 'HS256',
      expiresIn: TWO_FACTOR_SETUP_TTL,
      issuer: JWT_ISSUER,
      audience: TWO_FACTOR_SETUP_AUDIENCE,
      subject: input.agentId,
    },
  );
}

function setupTokenError(code: 'SETUP_TOKEN_INVALID' | 'SETUP_TOKEN_EXPIRED'): AppError {
  return new AppError(
    code,
    code === 'SETUP_TOKEN_EXPIRED'
      ? 'Two-factor setup token has expired'
      : 'Two-factor setup token is invalid',
    401,
  );
}

/**
 * Verifies signature, issuer, audience, expiry and the exact claim shape.
 *
 * Invalid and expired tokens answer DISTINCT stable codes (401
 * `SETUP_TOKEN_INVALID` / `SETUP_TOKEN_EXPIRED`) so the SPA can restart the login
 * flow instead of showing a generic error.
 */
export function verifyTwoFactorSetupToken(
  token: string,
  secret: string,
): TwoFactorSetupClaims {
  const raw = (token ?? '').trim();
  if (raw.length === 0) throw setupTokenError('SETUP_TOKEN_INVALID');

  let decoded: JwtPayload | string;
  try {
    decoded = jwt.verify(raw, secret, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: TWO_FACTOR_SETUP_AUDIENCE,
    });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) throw setupTokenError('SETUP_TOKEN_EXPIRED');
    throw setupTokenError('SETUP_TOKEN_INVALID');
  }

  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    decoded.scope !== TWO_FACTOR_SETUP_SCOPE ||
    typeof decoded.sub !== 'string' ||
    decoded.sub.length === 0 ||
    decoded.agentId !== decoded.sub ||
    typeof decoded.jti !== 'string' ||
    decoded.jti.length === 0
  ) {
    throw setupTokenError('SETUP_TOKEN_INVALID');
  }

  return {
    agentId: decoded.sub,
    tenantId: typeof decoded.tenantId === 'string' ? decoded.tenantId : null,
    jti: decoded.jti,
    expiresAt: typeof decoded.exp === 'number' ? decoded.exp : 0,
  };
}
