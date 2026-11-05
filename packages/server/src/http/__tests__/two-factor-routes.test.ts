import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  IAgentService,
  ITwoFactorService,
  LoginResult,
} from '@sac/shared';

import type { HttpRouteContext } from '../types';
import { createAuthControllers } from '../controllers/auth.controller';
import { isPublicRoute } from '../middleware/auth';

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
  agent?: { id: string; email: string; name: string; role: string; tenantId: string | null },
): FastifyRequest {
  return {
    body,
    headers: { 'user-agent': 'Mozilla/5.0 (test)' },
    ip: '203.0.113.7',
    ...(agent !== undefined ? { agent } : {}),
  } as unknown as FastifyRequest;
}

interface Harness {
  ctx: HttpRouteContext;
  publishPresence: ReturnType<typeof vi.fn>;
  controllers: ReturnType<typeof createAuthControllers>;
}

function buildHarness(options: {
  agents?: Partial<IAgentService>;
  twoFactor?: Partial<ITwoFactorService>;
}): Harness {
  const publishPresence = vi.fn();
  const ctx = {
    services: {
      agents: options.agents ?? {},
      twoFactor: options.twoFactor ?? {},
      clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
    },
    hub: { publisher: { agentPresence: publishPresence } },
  } as unknown as HttpRouteContext;

  return { ctx, publishPresence, controllers: createAuthControllers(ctx) };
}

const AGENT = {
  id: 'agent-1',
  email: 'ana@acme.test',
  name: 'Ana',
  role: 'ADMIN',
  tenantId: 'tenant-1',
};

const SESSION = {
  token: 'header.payload.signature',
  refreshToken: 'f'.repeat(96),
  agent: {
    id: AGENT.id,
    name: AGENT.name,
    email: AGENT.email,
    role: 'ADMIN',
    presence: 'ONLINE' as const,
    tenantId: AGENT.tenantId,
  },
};

describe('2FA route exposure (401 contract)', () => {
  it('keeps /auth/2fa/challenge public (the challenge JWT authenticates it)', () => {
    expect(isPublicRoute('POST', '/api/v1/auth/2fa/challenge')).toBe(true);
  });

  it.each([
    ['POST', '/api/v1/auth/2fa/setup'],
    ['POST', '/api/v1/auth/2fa/verify'],
    ['POST', '/api/v1/auth/2fa/disable'],
    ['GET', '/api/v1/auth/2fa/status'],
  ])('requires a JWT for %s %s', (method, path) => {
    expect(isPublicRoute(method, path)).toBe(false);
  });

  it('throws 401 AUTHENTICATION_ERROR when the management route has no principal', async () => {
    const h = buildHarness({ twoFactor: {} });

    await expect(h.controllers.twoFactorStatus(fakeRequest({}), fakeReply())).rejects.toMatchObject({
      code: 'AUTHENTICATION_ERROR',
      httpStatus: 401,
    });
  });

  it('allows any authenticated role to manage its own 2FA (no role gate)', async () => {
    const setup = vi.fn(async () => ({
      secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      otpauthUrl: 'otpauth://totp/SAC%20Hub:ana%40acme.test?secret=GEZD',
    }));
    const h = buildHarness({ twoFactor: { setup } });

    const result = await h.controllers.twoFactorSetup(
      fakeRequest({}, { ...AGENT, role: 'AGENT' }),
      fakeReply(),
    );

    expect(setup).toHaveBeenCalledWith(AGENT.id);
    expect(result).toEqual({
      data: {
        secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        otpauthUrl: 'otpauth://totp/SAC%20Hub:ana%40acme.test?secret=GEZD',
      },
    });
  });
});

describe('POST /auth/login with 2FA', () => {
  it('answers 401 with the top-level TWO_FACTOR_REQUIRED body and no tokens', async () => {
    const login = vi.fn(async (): Promise<LoginResult> => ({
      twoFactorRequired: true,
      challengeToken: 'challenge.jwt.token',
    }));
    const h = buildHarness({ agents: { login } });
    const reply = fakeReply();

    const result = await h.controllers.login(
      fakeRequest({ email: 'ana@acme.test', password: 'correct-horse-battery' }),
      reply,
    );

    expect(reply.statusCode).toBe(401);
    expect(result).toEqual({ code: 'TWO_FACTOR_REQUIRED', challengeToken: 'challenge.jwt.token' });
    expect(h.publishPresence).not.toHaveBeenCalled();
  });

  it('keeps the normal 200 AuthResponse envelope when 2FA is off', async () => {
    const login = vi.fn(async (): Promise<LoginResult> => SESSION);
    const h = buildHarness({ agents: { login } });
    const reply = fakeReply();

    const result = await h.controllers.login(
      fakeRequest({ email: 'ana@acme.test', password: 'correct-horse-battery' }),
      reply,
    );

    expect(reply.statusCode).toBe(200);
    expect(result).toEqual({ data: SESSION });
    expect(h.publishPresence).toHaveBeenCalledWith({
      agentId: AGENT.id,
      agentName: AGENT.name,
      presence: 'ONLINE',
      at: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('2FA management controllers', () => {
  it('setup returns the secret + otpauth URL once', async () => {
    const setup = vi.fn(async () => ({
      secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      otpauthUrl: 'otpauth://totp/SAC%20Hub:ana%40acme.test?secret=GEZD',
    }));
    const h = buildHarness({ twoFactor: { setup } });

    const result = await h.controllers.twoFactorSetup(fakeRequest({}, AGENT), fakeReply());

    expect(setup).toHaveBeenCalledWith(AGENT.id);
    expect(result).toMatchObject({ data: { secret: expect.any(String) as string } });
  });

  it('verify forwards the code and returns the recovery codes', async () => {
    const verify = vi.fn(async () => ({
      enabled: true as const,
      recoveryCodes: ['ABCD-2345'],
    }));
    const h = buildHarness({ twoFactor: { verify } });

    const result = await h.controllers.twoFactorVerify(
      fakeRequest({ code: '123456' }, AGENT),
      fakeReply(),
    );

    expect(verify).toHaveBeenCalledWith(AGENT.id, '123456');
    expect(result).toEqual({ data: { enabled: true, recoveryCodes: ['ABCD-2345'] } });
  });

  it('disable requires password + code and answers { enabled: false }', async () => {
    const disable = vi.fn(async () => undefined);
    const h = buildHarness({ twoFactor: { disable } });

    const result = await h.controllers.twoFactorDisable(
      fakeRequest({ password: 'correct-horse-battery', code: '123456' }, AGENT),
      fakeReply(),
    );

    expect(disable).toHaveBeenCalledWith(AGENT.id, 'correct-horse-battery', '123456');
    expect(result).toEqual({ data: { enabled: false } });
  });

  it('status returns { enabled }', async () => {
    const status = vi.fn(async () => ({ enabled: true }));
    const h = buildHarness({ twoFactor: { status } });

    const result = await h.controllers.twoFactorStatus(fakeRequest({}, AGENT), fakeReply());

    expect(status).toHaveBeenCalledWith(AGENT.id);
    expect(result).toEqual({ data: { enabled: true } });
  });
});

describe('POST /auth/2fa/challenge', () => {
  it('returns the AuthResponse envelope and publishes presence', async () => {
    const challenge = vi.fn(async () => SESSION);
    const h = buildHarness({ twoFactor: { challenge } });
    const reply = fakeReply();

    const result = await h.controllers.twoFactorChallenge(
      fakeRequest(
        {
          challengeToken: 'challenge.jwt.token.value',
          code: '123456',
          deviceName: 'Phone',
        },
        AGENT,
      ),
      reply,
    );

    expect(challenge).toHaveBeenCalledWith('challenge.jwt.token.value', '123456', {
      userAgent: 'Phone',
      ip: '203.0.113.7',
    });
    expect(reply.statusCode).toBe(200);
    expect(result).toEqual({ data: SESSION });
    expect(h.publishPresence).toHaveBeenCalledWith({
      agentId: AGENT.id,
      agentName: AGENT.name,
      presence: 'ONLINE',
      at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('rejects a malformed body with 422 VALIDATION_ERROR', async () => {
    const h = buildHarness({ twoFactor: { challenge: vi.fn() } });

    await expect(
      h.controllers.twoFactorChallenge(fakeRequest({ challengeToken: 'x' }), fakeReply()),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
  });
});
