import { createHash, randomBytes } from 'node:crypto';

import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';

/**
 * ============================================================================
 * Auth token primitives (login + rotating refresh tokens)
 * ============================================================================
 *
 * Single source of truth for the access-token claims/issuer/audience and for
 * the opaque-token helpers. `AgentService` (login) and `AuthSessionService`
 * (refresh) MUST sign through here, otherwise the guard would reject tokens
 * minted by one of the two paths.
 */

export const JWT_ISSUER = 'sac-hub';
export const JWT_AUDIENCE = 'sac-web';

/** Minimal principal persisted inside the access token. */
export interface AccessTokenSubject {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string | null;
  /**
   * Fase 4: platform console flag. The guard re-reads it from the database on
   * `/platform/*`, so this claim is informational only (UI/menu rendering).
   */
  isPlatformAdmin: boolean;
}

/** SHA-256 (hex) - the only representation of an opaque token we persist. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Cryptographically random opaque token (hex). */
export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function signAccessToken(input: {
  subject: AccessTokenSubject;
  secret: string;
  expiresIn: string;
}): string {
  const options: SignOptions = {
    algorithm: 'HS256',
    expiresIn: input.expiresIn as SignOptions['expiresIn'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    subject: input.subject.id,
  };
  return jwt.sign(
    {
      email: input.subject.email,
      name: input.subject.name,
      role: input.subject.role,
      tenantId: input.subject.tenantId,
      isPlatformAdmin: input.subject.isPlatformAdmin === true,
    },
    input.secret,
    options,
  );
}
