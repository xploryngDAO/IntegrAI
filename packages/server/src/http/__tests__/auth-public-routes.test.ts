import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IAuthService } from '@sac/shared';

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

function fakeRequest(body: unknown): FastifyRequest {
  return { body } as unknown as FastifyRequest;
}

function buildControllers(auth: IAuthService) {
  const ctx = {
    services: { auth, clock: { now: () => new Date('2026-01-01T00:00:00.000Z') } },
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
  ])('does not require a JWT for %s', (path) => {
    expect(isPublicRoute('POST', path)).toBe(true);
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
});
