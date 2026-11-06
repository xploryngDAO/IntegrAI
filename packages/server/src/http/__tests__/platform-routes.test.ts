import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type {
  ILogger,
  IPlatformService,
  PlatformMetrics,
  PlatformTenantListResult,
  PlatformTenantView,
} from '@sac/shared';
import { AuthorizationError } from '@sac/shared';

import type { HttpRouteContext } from '../types';
import { platformRoutes } from '../routes/platform.routes';
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

const TENANT_VIEW: PlatformTenantView = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
  plan: 'PRO',
  status: 'ACTIVE',
  limits: { maxAccounts: 10, maxAgents: 25 },
  counts: { accounts: 3, agents: 5, tickets: 40 },
  onboardingCompletedAt: null,
  deletedAt: null,
  createdAt: '2026-11-01T10:00:00.000Z',
};

const LIST: PlatformTenantListResult = {
  items: [TENANT_VIEW],
  total: 1,
  page: 1,
  pageSize: 25,
  totalPages: 1,
};

const METRICS: PlatformMetrics = {
  generatedAt: '2026-11-05T12:00:00.000Z',
  totalTenants: 3,
  activeTenants: 2,
  accountsByMarketplace: { AMAZON: 1, MERCADO_LIVRE: 2, SHOPEE: 0 },
  totalAccounts: 3,
  openTickets: 7,
  messagesLast24h: 42,
  slaAtRisk: 1,
  slaRiskHorizonMinutes: 120,
};

describe('platform console routes', () => {
  let app: FastifyInstance;
  let requirePlatformAdmin: ReturnType<typeof vi.fn>;
  let listTenants: ReturnType<typeof vi.fn>;
  let updateTenant: ReturnType<typeof vi.fn>;
  let metrics: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    requirePlatformAdmin = vi.fn(async (actorId: string) => {
      if (actorId === 'platform-admin') return;
      throw new AuthorizationError('Platform administrator privileges are required');
    });
    listTenants = vi.fn(async () => LIST);
    updateTenant = vi.fn(async () => TENANT_VIEW);
    metrics = vi.fn(async () => METRICS);

    const ctx = {
      services: {
        platform: { requirePlatformAdmin, listTenants, updateTenant, metrics } as unknown as IPlatformService,
        logger: noopLogger,
      },
      hub: {},
      options: {},
    } as unknown as HttpRouteContext;

    app = Fastify();
    registerErrorHandler(app, { logger: noopLogger, exposeDetails: true });
    // Stand-in for the global JWT guard: the headers choose the principal.
    app.addHook('preHandler', async (request) => {
      const actorId = request.headers['x-test-agent'];
      if (typeof actorId === 'string' && actorId.length > 0) {
        request.agent = {
          id: actorId,
          email: `${actorId}@acme.test`,
          name: 'Ana',
          role: 'ADMIN',
          tenantId: 'tenant-1',
          isPlatformAdmin: actorId === 'platform-admin',
        };
      }
    });
    await app.register(platformRoutes, { prefix: '/platform', ...ctx });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    requirePlatformAdmin.mockClear();
    listTenants.mockClear();
    updateTenant.mockClear();
    metrics.mockClear();
  });

  it('is not reachable without a JWT', () => {
    for (const [method, path] of [
      ['GET', '/api/v1/platform/tenants'],
      ['PATCH', '/api/v1/platform/tenants/11111111-1111-4111-8111-111111111111'],
      ['GET', '/api/v1/platform/metrics'],
    ] as const) {
      expect(isPublicRoute(method, path)).toBe(false);
    }
  });

  it('answers 401 without a principal', async () => {
    const response = await app.inject({ method: 'GET', url: '/platform/metrics' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'AUTHENTICATION_ERROR' } });
    expect(metrics).not.toHaveBeenCalled();
  });

  it('answers 403 for a regular tenant ADMIN (not a platform admin)', async () => {
    for (const request of [
      { method: 'GET' as const, url: '/platform/tenants' },
      { method: 'GET' as const, url: '/platform/metrics' },
      {
        method: 'PATCH' as const,
        url: '/platform/tenants/11111111-1111-4111-8111-111111111111',
        payload: { plan: 'PRO' },
      },
    ]) {
      const response = await app.inject({
        ...request,
        headers: { 'x-test-agent': 'tenant-admin' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_ERROR' } });
    }
    expect(listTenants).not.toHaveBeenCalled();
    expect(updateTenant).not.toHaveBeenCalled();
    expect(metrics).not.toHaveBeenCalled();
  });

  it('GET /platform/tenants forwards pagination and returns tenants + counts', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/tenants?page=2&pageSize=5',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: LIST });
    expect(listTenants).toHaveBeenCalledWith({ page: 2, pageSize: 5 });
    expect(requirePlatformAdmin).toHaveBeenCalledWith('platform-admin');
  });

  it('GET /platform/tenants applies the default pagination', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/tenants',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(listTenants).toHaveBeenCalledWith({ page: 1, pageSize: 25 });
  });

  it('GET /platform/tenants rejects invalid pagination with 422', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/tenants?page=0&pageSize=1000',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(listTenants).not.toHaveBeenCalled();
  });

  it('PATCH /platform/tenants/:id updates plan/limits/status', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/platform/tenants/11111111-1111-4111-8111-111111111111',
      headers: { 'x-test-agent': 'platform-admin' },
      payload: { plan: 'ENTERPRISE', maxAgents: 100, status: 'SUSPENDED' },
    });

    expect(response.statusCode).toBe(200);
    expect(updateTenant).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', {
      plan: 'ENTERPRISE',
      maxAgents: 100,
      status: 'SUSPENDED',
    });
    expect(response.json()).toEqual({ data: TENANT_VIEW });
  });

  it('PATCH rejects an empty body, an unknown field and an invalid plan with 422', async () => {
    const cases = [{}, { tenantId: 'tenant-2', plan: 'PRO' }, { plan: 'PLATINUM' }];

    for (const payload of cases) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/platform/tenants/11111111-1111-4111-8111-111111111111',
        headers: { 'x-test-agent': 'platform-admin' },
        payload,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    expect(updateTenant).not.toHaveBeenCalled();
  });

  it('PATCH rejects a non-UUID tenant id with 422', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/platform/tenants/not-a-uuid',
      headers: { 'x-test-agent': 'platform-admin' },
      payload: { plan: 'PRO' },
    });

    expect(response.statusCode).toBe(422);
    expect(updateTenant).not.toHaveBeenCalled();
  });

  it('GET /platform/metrics returns the global totals', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/metrics',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: METRICS });
    expect(metrics).toHaveBeenCalledTimes(1);
  });
});
