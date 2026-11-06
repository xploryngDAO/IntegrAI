import { createHash, randomBytes, randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';

/**
 * ============================================================================
 * Auth token primitives (login + rotating refresh tokens)
 * ============================================================================
 *
 * Single source of truth for the access-token claims/issuer/audience and for
 * the opaque-token helpers. `AgentService` (login), `AuthSessionService`
 * (refresh), `InvitationService` and the SSO/2FA exchanges all sign through
 * here, so every access token carries the same claim shape.
 *
 * P0 - access-token revocation by `jti`:
 * every token gets a fresh UUID `jti`. It is what `POST /auth/logout` writes to
 * the Redis denylist (`CACHE_KEYS.authAccessTokenDeny`) so the stateless JWT can
 * be invalidated before its natural `exp`. See `access-token-revocation.ts`.
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
  /**
   * Refresh-session row that backs this token. Embedded as the `sid` claim so
   * `GET /auth/sessions` can mark which device is the current one. Optional:
   * legacy tokens (and flows without the session store) simply omit it.
   */
  sessionId?: string;
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
      // Unique per access token: the revocation handle used by logout.
      jti: randomUUID(),
      email: input.subject.email,
      name: input.subject.name,
      role: input.subject.role,
      tenantId: input.subject.tenantId,
      isPlatformAdmin: input.subject.isPlatformAdmin === true,
      ...(input.sessionId !== undefined ? { sid: input.sessionId } : {}),
    },
    input.secret,
    options,
  );
}
