import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { ILogger, ITenantService } from '@sac/shared';

import type { HttpRouteContext } from '../types';
import { tenantRoutes } from '../routes/tenants.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { isPublicRoute } from '../middleware/auth';

const noopLogger: ILogger = {
  child(): ILogger {
    return this;
  },
  trace(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

const PROFILE = {
  id: 'tenant-1',
  slug: 'acme',
  name: 'Acme',
  onboardingCompletedAt: new Date('2026-11-05T12:00:00.000Z'),
};

describe('tenant self-service routes', () => {
  let app: FastifyInstance;
  let get: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    get = vi.fn(async () => PROFILE);
    update = vi.fn(async (_tenantId: string, command: { name?: string; onboardingCompleted?: boolean }) => ({
      ...PROFILE,
      name: command.name ?? PROFILE.name,
      onboardingCompletedAt:
        command.onboardingCompleted === false ? null : PROFILE.onboardingCompletedAt,
    }));

    const ctx = {
      services: { tenants: { get, update } as unknown as ITenantService },
      hub: {},
      options: {},
    } as unknown as HttpRouteContext;

    app = Fastify();
    registerErrorHandler(app, { logger: noopLogger, exposeDetails: true });
    // Stand-in for the global JWT guard: the headers choose the principal.
    app.addHook('preHandler', async (request) => {
      const tenantId = request.headers['x-test-tenant'];
      if (typeof tenantId === 'string' && tenantId.length > 0) {
        request.agent = {
          id: 'agent-1',
          email: 'admin@acme.test',
          name: 'Ana',
          role: String(request.headers['x-test-role'] ?? 'ADMIN'),
          tenantId,
        };
      }
    });
    await app.register(tenantRoutes, { prefix: '/tenants', ...ctx });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    get.mockClear();
    update.mockClear();
  });

  it('requires a JWT for both routes', () => {
    expect(isPublicRoute('GET', '/api/v1/tenants/me')).toBe(false);
    expect(isPublicRoute('PATCH', '/api/v1/tenants/me')).toBe(false);
  });

  it('GET /tenants/me returns the JWT workspace profile', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/tenants/me',
      headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'AGENT' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        id: 'tenant-1',
        slug: 'acme',
        name: 'Acme',
        onboardingCompletedAt: '2026-11-05T12:00:00.000Z',
      },
    });
    expect(get).toHaveBeenCalledWith('tenant-1');
  });

  it('GET /tenants/me answers 401 without a principal', async () => {
    const response = await app.inject({ method: 'GET', url: '/tenants/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'AUTHENTICATION_ERROR' } });
    expect(get).not.toHaveBeenCalled();
  });

  it('PATCH /tenants/me completes onboarding for an ADMIN using the JWT tenant', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/tenants/me',
      headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
      payload: { onboardingCompleted: true, name: 'Acme Omnichannel' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { onboardingCompletedAt: '2026-11-05T12:00:00.000Z', name: 'Acme Omnichannel' },
    });
    expect(update).toHaveBeenCalledWith('tenant-1', {
      onboardingCompleted: true,
      name: 'Acme Omnichannel',
    });
  });

  it('PATCH /tenants/me ignores a tenantId smuggled into the body (ADMIN)', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/tenants/me',
      headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
      payload: { tenantId: 'tenant-2', onboardingCompleted: true },
    });

    // `.strict()` rejects unknown keys instead of silently ignoring them.
    expect(response.statusCode).toBe(422);
    expect(update).not.toHaveBeenCalled();
  });

  it('PATCH /tenants/me answers 403 for AGENT and SUPERVISOR', async () => {
    for (const role of ['AGENT', 'SUPERVISOR']) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/tenants/me',
        headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': role },
        payload: { onboardingCompleted: true },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_ERROR' } });
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('PATCH /tenants/me rejects an empty body with 422', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/tenants/me',
      headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
      payload: {},
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(update).not.toHaveBeenCalled();
  });
});
