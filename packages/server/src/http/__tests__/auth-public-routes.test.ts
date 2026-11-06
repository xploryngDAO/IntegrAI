import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IAuthService, IAuthSessionService, ICache, ILogger } from '@sac/shared';
import { AppError } from '@sac/shared';

import type { HttpRouteContext } from '../types';
import { USER_REVOCATION_WATERMARK_TTL_SECONDS } from '../../application/auth/access-token-revocation';
import { createAuthControllers } from '../controllers/auth.controller';
import { isPublicRoute } from '../middleware/auth';

/** Fixed instant used by the controller clock below. */
const NOW = new Date('2026-01-01T00:00:00.000Z');

const silentLogger: ILogger = {
  child(): ILogger {
    return this;
  },
  trace(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

/** Records the denylist writes (key, value and TTL) made by logout. */
class RecordingCache implements ICache {
  readonly entries = new Map<string, unknown>();
  readonly ttls = new Map<string, number>();
  failSet = false;

  async get<T>(key: string): Promise<T | null> {
    return (this.entries.get(key) as T | undefined) ?? null;
  }
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (this.failSet) throw new Error('redis unavailable');
    this.entries.set(key, value);
    this.ttls.set(key, ttlSeconds);
  }
  async setNx(key: string, value: string): Promise<boolean> {
    if (this.entries.has(key)) return false;
    this.entries.set(key, value);
    return true;
  }
  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }
  async exists(key: string): Promise<boolean> {
    return this.entries.has(key);
  }
  async ttl(key: string): Promise<number> {
    return this.ttls.get(key) ?? -2;
  }
  async incr(): Promise<number> {
    return 1;
  }
  async hset(): Promise<void> {}
  async hgetall<T extends Record<string, string>>(): Promise<T | null> {
    return null;
  }
  async sadd(): Promise<void> {}
  async srem(): Promise<void> {}
  async smembers(): Promise<string[]> {
    return [];
  }
}

function fakeReply(): FastifyReply {
  const reply = {
    statusCode: 200,
    code(this: { statusCode: number }, status: number) {
      this.statusCode = status;
      return reply;
    },
  };
  return reply as unknown as FastifyReply;
}

function fakeRequest(
  body: unknown,
  agent?: {
    id: string;
    email: string;
    name: string;
    role: string;
    tenantId: string | null;
    jti?: string;
    tokenExpiresAt?: number;
  },
): FastifyRequest {
  return {
    body,
    headers: {},
    ip: '203.0.113.7',
    ...(agent !== undefined ? { agent } : {}),
  } as unknown as FastifyRequest;
}

function buildControllers(
  auth: IAuthService,
  sessions?: IAuthSessionService,
  cache: ICache = new RecordingCache(),
) {
  const ctx = {
    services: {
      auth,
      cache,
      logger: silentLogger,
      // Audit is best-effort and optional to the controller logic; the real
      // container always wires it (see `AuditService`).
      audit: { record: (): void => undefined, list: async () => ({ items: [], page: 1, perPage: 25, total: 0 }), flush: async (): Promise<void> => undefined },
      ...(sessions !== undefined ? { sessions } : {}),
      clock: { now: () => NOW },
    },
    hub: { publisher: { agentPresence: vi.fn() } },
  } as unknown as HttpRouteContext;
  return createAuthControllers(ctx);
}

describe('public auth routes', () => {
  it.each([
    '/api/v1/auth/login',
    '/api/v1/auth/signup',
    '/api/v1/auth/verify-email',
    '/api/v1/auth/resend-verification',
    '/api/v1/auth/forgot-password',
    '/api/v1/auth/reset-password',
    '/api/v1/auth/refresh',
  ])('does not require a JWT for %s', (path) => {
    expect(isPublicRoute('POST', path)).toBe(true);
  });

  it('requires a JWT for /auth/logout', () => {
    expect(isPublicRoute('POST', '/api/v1/auth/logout')).toBe(false);
  });

  it('still protects /auth/me', () => {
    expect(isPublicRoute('GET', '/api/v1/auth/me')).toBe(false);
  });

  it('answers signup with 201 and the tenant/user envelope', async () => {
    const signup = vi.fn(async () => ({
      tenantId: 'tenant-1',
      userId: 'user-1',
      emailVerificationRequired: true as const,
    }));
    const controllers = buildControllers({ signup } as unknown as IAuthService);
    const reply = fakeReply();

    const result = await controllers.signup(
      fakeRequest({
        companyName: 'Acme',
        name: 'Ana',
        email: 'ana@acme.test',
        password: 'correct-horse-battery',
      }),
      reply,
    );

    expect(reply.statusCode).toBe(201);
    expect(result).toEqual({
      data: { tenantId: 'tenant-1', userId: 'user-1', emailVerificationRequired: true },
    });
    expect(signup).toHaveBeenCalledWith({
      companyName: 'Acme',
      name: 'Ana',
      email: 'ana@acme.test',
      password: 'correct-horse-battery',
    });
  });

  it('answers resend-verification with 202 for any address', async () => {
    const resendVerification = vi.fn(async () => undefined);
    const controllers = buildControllers({ resendVerification } as unknown as IAuthService);
    const reply = fakeReply();

    const result = await controllers.resendVerification(
      fakeRequest({ email: 'nobody@example.com' }),
      reply,
    );

    expect(reply.statusCode).toBe(202);
    expect(result).toEqual({ data: { status: 'accepted' } });
  });

  it('answers verify-email with 200 once the token is consumed', async () => {
    const verifyEmail = vi.fn(async () => undefined);
    const controllers = buildControllers({ verifyEmail } as unknown as IAuthService);

    const result = await controllers.verifyEmail(
      fakeRequest({ token: 'a'.repeat(64) }),
      fakeReply(),
    );

    expect(verifyEmail).toHaveBeenCalledWith('a'.repeat(64));
    expect(result).toEqual({ data: { verified: true } });
  });

  it('rejects a signup password below 12 characters with 422', async () => {
    const controllers = buildControllers({} as IAuthService);
    await expect(
      controllers.signup(
        fakeRequest({
          companyName: 'Acme',
          name: 'Ana',
          email: 'ana@acme.test',
          password: 'short',
        }),
        fakeReply(),
      ),
    ).rejects.toMatchObject({ httpStatus: 422, code: 'VALIDATION_ERROR' });
  });

  it('answers forgot-password with 202 for any address', async () => {
    const forgotPassword = vi.fn(async () => undefined);
    const controllers = buildControllers({ forgotPassword } as unknown as IAuthService);
    const reply = fakeReply();

    const result = await controllers.forgotPassword(
      fakeRequest({ email: 'ghost@example.com' }),
      reply,
    );

    expect(reply.statusCode).toBe(202);
    expect(result).toEqual({ data: { status: 'accepted' } });
    expect(forgotPassword).toHaveBeenCalledWith('ghost@example.com');
  });

  it('answers reset-password with 200 and forwards token + password', async () => {
    const resetPassword = vi.fn(async () => undefined);
    const controllers = buildControllers({ resetPassword } as unknown as IAuthService);

    const result = await controllers.resetPassword(
      fakeRequest({ token: 'a'.repeat(64), password: 'correct-horse-battery' }),
      fakeReply(),
    );

    expect(result).toEqual({ data: { reset: true } });
    expect(resetPassword).toHaveBeenCalledWith('a'.repeat(64), 'correct-horse-battery');
  });

  it('propagates a 400 INVALID_RESET_TOKEN from the service', async () => {
    const resetPassword = vi.fn(async () => {
      throw new AppError('INVALID_RESET_TOKEN', 'Password reset link is invalid', 400);
    });
    const controllers = buildControllers({ resetPassword } as unknown as IAuthService);

    await expect(
      controllers.resetPassword(
        fakeRequest({ token: 'b'.repeat(64), password: 'correct-horse-battery' }),
        fakeReply(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN', httpStatus: 400 });
  });

  it('rejects a reset password below 12 characters with 422', async () => {
    const controllers = buildControllers({} as IAuthService);

    await expect(
      controllers.resetPassword(
        fakeRequest({ token: 'c'.repeat(64), password: 'short' }),
        fakeReply(),
      ),
    ).rejects.toMatchObject({ httpStatus: 422, code: 'VALIDATION_ERROR' });
  });

  it('rotates the refresh token and answers 200 with the new pair', async () => {
    const rotate = vi.fn(async () => ({
      token: 'header.payload.signature',
      refreshToken: 'd'.repeat(96),
      expiresAt: new Date('2026-01-31T00:00:00.000Z'),
      agent: {
        id: 'agent-1',
        name: 'Ana',
        email: 'ana@acme.test',
        role: 'ADMIN',
        presence: 'ONLINE' as const,
        tenantId: 'tenant-1',
      },
    }));
    const controllers = buildControllers({} as IAuthService, {
      rotate,
    } as unknown as IAuthSessionService);

    const result = await controllers.refresh(
      fakeRequest({ refreshToken: 'e'.repeat(96) }),
      fakeReply(),
    );

    expect(rotate).toHaveBeenCalledWith('e'.repeat(96), {
      userAgent: null,
      ip: '203.0.113.7',
    });
    expect(result).toEqual({
      data: {
        token: 'header.payload.signature',
        refreshToken: 'd'.repeat(96),
        agent: {
          id: 'agent-1',
          name: 'Ana',
          email: 'ana@acme.test',
          role: 'ADMIN',
          presence: 'ONLINE',
          tenantId: 'tenant-1',
        },
      },
    });
  });

  it('propagates a 401 INVALID_REFRESH_TOKEN', async () => {
    const rotate = vi.fn(async () => {
      throw new AppError('INVALID_REFRESH_TOKEN', 'Refresh token is invalid', 401);
    });
    const controllers = buildControllers({} as IAuthService, {
      rotate,
    } as unknown as IAuthSessionService);

    await expect(
      controllers.refresh(fakeRequest({ refreshToken: 'f'.repeat(96) }), fakeReply()),
    ).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN', httpStatus: 401 });
  });

  it('answers logout with 204 and revokes only the given session', async () => {
    const revoke = vi.fn(async () => true);
    const revokeAllForUser = vi.fn(async () => 0);
    const controllers = buildControllers({} as IAuthService, {
      revoke,
      revokeAllForUser,
    } as unknown as IAuthSessionService);
    const reply = fakeReply();

    const result = await controllers.logout(
      fakeRequest(
        { refreshToken: '9'.repeat(96) },
        { id: 'agent-1', email: 'ana@acme.test', name: 'Ana', role: 'ADMIN', tenantId: 'tenant-1' },
      ),
      reply,
    );

    expect(reply.statusCode).toBe(204);
    expect(result).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith('9'.repeat(96), 'agent-1');
    expect(revokeAllForUser).not.toHaveBeenCalled();
  });

  it('answers logout without a body by revoking every session', async () => {
    const revoke = vi.fn(async () => true);
    const revokeAllForUser = vi.fn(async () => 2);
    const controllers = buildControllers({} as IAuthService, {
      revoke,
      revokeAllForUser,
    } as unknown as IAuthSessionService);
    const reply = fakeReply();

    await controllers.logout(
      fakeRequest(null, {
        id: 'agent-1',
        email: 'ana@acme.test',
        name: 'Ana',
        role: 'ADMIN',
        tenantId: 'tenant-1',
      }),
      reply,
    );

    expect(reply.statusCode).toBe(204);
    expect(revoke).not.toHaveBeenCalled();
    expect(revokeAllForUser).toHaveBeenCalledWith('agent-1');
  });

  /* ====================================================================== */
  /* P0: logout revokes the current ACCESS token by jti                     */
  /* ====================================================================== */

  it('denylists the current access token with its remaining TTL', async () => {
    const cache = new RecordingCache();
    const revoke = vi.fn(async () => true);
    const controllers = buildControllers(
      {} as IAuthService,
      { revoke, revokeAllForUser: vi.fn(async () => 0) } as unknown as IAuthSessionService,
      cache,
    );
    const reply = fakeReply();
    const nowSeconds = Math.floor(NOW.getTime() / 1000);

    const result = await controllers.logout(
      fakeRequest(
        { refreshToken: '9'.repeat(96) },
        {
          id: 'agent-1',
          email: 'ana@acme.test',
          name: 'Ana',
          role: 'ADMIN',
          tenantId: 'tenant-1',
          jti: '7d9a4d5e-2f3b-4f0a-9c1e-0a1b2c3d4e5f',
          // 15 minutes left on the token.
          tokenExpiresAt: nowSeconds + 900,
        },
      ),
      reply,
    );

    expect(reply.statusCode).toBe(204);
    expect(result).toBeUndefined();
    expect(cache.entries.get('sac:auth:deny:7d9a4d5e-2f3b-4f0a-9c1e-0a1b2c3d4e5f')).toBe('1');
    expect(cache.ttls.get('sac:auth:deny:7d9a4d5e-2f3b-4f0a-9c1e-0a1b2c3d4e5f')).toBe(900);
    // The refresh-session revocation is unchanged by the access-token denylist.
    expect(revoke).toHaveBeenCalledWith('9'.repeat(96), 'agent-1');
  });

  it('does not write the jti denylist for a legacy token without jti', async () => {
    const cache = new RecordingCache();
    const controllers = buildControllers(
      {} as IAuthService,
      {
        revoke: vi.fn(async () => true),
        revokeAllForUser: vi.fn(async () => 0),
      } as unknown as IAuthSessionService,
      cache,
    );
    const reply = fakeReply();

    await controllers.logout(
      fakeRequest(
        null,
        { id: 'agent-1', email: 'ana@acme.test', name: 'Ana', role: 'ADMIN', tenantId: 'tenant-1' },
      ),
      reply,
    );

    expect(reply.statusCode).toBe(204);
    // No `jti` to deny - but logout everywhere still stamps the user watermark.
    expect([...cache.entries.keys()].some((key) => key.startsWith('sac:auth:deny:'))).toBe(false);
    expect(cache.entries.get('sac:auth:user:revoked:agent-1')).toBe(
      Math.floor(NOW.getTime() / 1000),
    );
  });

  /* ====================================================================== */
  /* Bulk revocation: logout without refreshToken is "logout everywhere"    */
  /* ====================================================================== */

  it('stamps the per-user watermark on logout everywhere (no refreshToken)', async () => {
    const cache = new RecordingCache();
    const revokeAllForUser = vi.fn(async () => 2);
    const controllers = buildControllers(
      {} as IAuthService,
      { revoke: vi.fn(async () => true), revokeAllForUser } as unknown as IAuthSessionService,
      cache,
    );
    const reply = fakeReply();

    await controllers.logout(
      fakeRequest(null, {
        id: 'agent-1',
        email: 'ana@acme.test',
        name: 'Ana',
        role: 'ADMIN',
        tenantId: 'tenant-1',
      }),
      reply,
    );

    expect(reply.statusCode).toBe(204);
    expect(revokeAllForUser).toHaveBeenCalledWith('agent-1');

    const watermarkKey = 'sac:auth:user:revoked:agent-1';
    expect(cache.entries.get(watermarkKey)).toBe(Math.floor(NOW.getTime() / 1000));
    expect(cache.ttls.get(watermarkKey)).toBe(USER_REVOCATION_WATERMARK_TTL_SECONDS);
  });

  it('does NOT stamp the watermark when a refreshToken is present (single device)', async () => {
    const cache = new RecordingCache();
    const revoke = vi.fn(async () => true);
    const controllers = buildControllers(
      {} as IAuthService,
      { revoke, revokeAllForUser: vi.fn(async () => 0) } as unknown as IAuthSessionService,
      cache,
    );
    const reply = fakeReply();

    await controllers.logout(
      fakeRequest(
        { refreshToken: '9'.repeat(96) },
        {
          id: 'agent-1',
          email: 'ana@acme.test',
          name: 'Ana',
          role: 'ADMIN',
          tenantId: 'tenant-1',
          jti: 'jti-1',
          tokenExpiresAt: Math.floor(NOW.getTime() / 1000) + 900,
        },
      ),
      reply,
    );

    expect(reply.statusCode).toBe(204);
    expect(revoke).toHaveBeenCalledWith('9'.repeat(96), 'agent-1');
    // Only this token's jti is denied: other devices keep their access tokens.
    expect(cache.entries.has('sac:auth:deny:jti-1')).toBe(true);
    expect(cache.entries.has('sac:auth:user:revoked:agent-1')).toBe(false);
  });

  it('keeps logout 204 when the denylist write fails (best effort)', async () => {
    const cache = new RecordingCache();
    cache.failSet = true;
    const revokeAllForUser = vi.fn(async () => 2);
    const controllers = buildControllers(
      {} as IAuthService,
      { revoke: vi.fn(async () => true), revokeAllForUser } as unknown as IAuthSessionService,
      cache,
    );
    const reply = fakeReply();

    await expect(
      controllers.logout(
        fakeRequest(null, {
          id: 'agent-1',
          email: 'ana@acme.test',
          name: 'Ana',
          role: 'ADMIN',
          tenantId: 'tenant-1',
          jti: 'jti-1',
          tokenExpiresAt: Math.floor(NOW.getTime() / 1000) + 900,
        }),
        reply,
      ),
    ).resolves.toBeUndefined();

    expect(reply.statusCode).toBe(204);
    expect(revokeAllForUser).toHaveBeenCalledWith('agent-1');
  });
});
