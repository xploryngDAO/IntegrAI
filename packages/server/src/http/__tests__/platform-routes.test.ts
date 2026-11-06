import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type {
  ILogger,
  IPlatformService,
  ITenantPurgeService,
  PlatformAlertsResult,
  PlatformBillingSummary,
  PlatformMetrics,
  PlatformTenantListResult,
  PlatformTenantView,
  TenantBillingView,
  TenantMetrics,
  TenantPurgeResult,
} from '@sac/shared';
import { AuthorizationError, ConflictError, NotFoundError } from '@sac/shared';

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

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

const TENANT_VIEW: PlatformTenantView = {
  id: TENANT_ID,
  slug: 'acme',
  name: 'Acme',
  plan: 'PRO',
  status: 'ACTIVE',
  limits: { maxAccounts: 10, maxAgents: 25 },
  counts: { accounts: 3, agents: 5, tickets: 40 },
  onboardingCompletedAt: null,
  deletedAt: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  billingStatus: 'ACTIVE',
  trialEndsAt: '2026-12-01T00:00:00.000Z',
  billingEmail: 'finance@acme.test',
};

const LIST: PlatformTenantListResult = {
  items: [TENANT_VIEW],
  total: 1,
  page: 1,
  pageSize: 25,
  totalPages: 1,
};

const PURGE_RESULT: TenantPurgeResult = {
  tenantId: TENANT_ID,
  slug: 'acme',
  deletedAt: '2026-10-01T10:00:00.000Z',
  purgedAt: '2026-11-05T12:00:00.000Z',
  counts: {
    sessions: 2,
    invitations: 1,
    passwordResets: 0,
    emailVerifications: 1,
    twoFactorRecoveryCodes: 8,
    buyerPiiVault: 3,
    messageAttachments: 2,
    messages: 10,
    ticketEvents: 4,
    outboundAttempts: 5,
    tickets: 3,
    orders: 2,
    webhookEvents: 6,
    slaPolicies: 1,
    accounts: 1,
    agents: 2,
    tenant: 1,
  },
  s3ObjectsDeleted: 3,
  s3Failed: 0,
  manual: true,
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

const TENANT_METRICS: TenantMetrics = {
  accounts: 3,
  agents: 5,
  ticketsByStatus: {
    UNREAD: 2,
    OPEN_WAITING_AGENT: 1,
    WAITING_BUYER: 4,
    NO_RESPONSE_NEEDED: 1,
    MEDIATION: 3,
    RESOLVED: 9,
  },
  openTickets: 10,
  slaAtRisk: 6,
  slaBreached: 2,
  avgFirstResponseMinutes: 42.3,
  messagesLast7d: 120,
  ticketsLast14d: [{ date: '2026-11-05', count: 2 }],
  plan: 'PRO',
  limits: { maxAccounts: 10, maxAgents: 25 },
  usagePct: { accounts: 30, agents: 20 },
};

const ALERTS: PlatformAlertsResult = {
  generatedAt: '2026-11-05T12:00:00.000Z',
  total: 1,
  alerts: [
    {
      severity: 'warning',
      tenantId: TENANT_ID,
      tenantSlug: 'acme',
      type: 'SLA_AT_RISK',
      message: '11 open tickets are at SLA risk',
      value: 11,
    },
  ],
};

const BILLING_SUMMARY: PlatformBillingSummary = {
  mrr: 2_097,
  byPlan: [
    { plan: 'FREE', tenants: 2, mrr: 0 },
    { plan: 'PRO', tenants: 2, mrr: 598 },
    { plan: 'ENTERPRISE', tenants: 1, mrr: 1_499 },
  ],
  trialing: 3,
  pastDue: 1,
};

const BILLING_VIEW: TenantBillingView = {
  tenantId: TENANT_ID,
  slug: 'acme',
  plan: 'PRO',
  billingStatus: 'ACTIVE',
  trialEndsAt: '2026-12-01T00:00:00.000Z',
  billingEmail: 'finance@acme.test',
  monthlyPriceBrl: 299,
  updatedAt: '2026-11-05T12:00:00.000Z',
};

describe('platform console routes', () => {
  let app: FastifyInstance;
  let requirePlatformAdmin: ReturnType<typeof vi.fn>;
  let listTenants: ReturnType<typeof vi.fn>;
  let updateTenant: ReturnType<typeof vi.fn>;
  let purgeTenant: ReturnType<typeof vi.fn>;
  let metrics: ReturnType<typeof vi.fn>;
  let tenantMetrics: ReturnType<typeof vi.fn>;
  let alerts: ReturnType<typeof vi.fn>;
  let billingSummary: ReturnType<typeof vi.fn>;
  let updateBilling: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    requirePlatformAdmin = vi.fn(async (actorId: string) => {
      if (actorId === 'platform-admin') return;
      throw new AuthorizationError('Platform administrator privileges are required');
    });
    listTenants = vi.fn(async () => LIST);
    updateTenant = vi.fn(async () => TENANT_VIEW);
    purgeTenant = vi.fn(async () => PURGE_RESULT);
    metrics = vi.fn(async () => METRICS);
    tenantMetrics = vi.fn(async () => TENANT_METRICS);
    alerts = vi.fn(async () => ALERTS);
    billingSummary = vi.fn(async () => BILLING_SUMMARY);
    updateBilling = vi.fn(async () => BILLING_VIEW);

    const ctx = {
      services: {
        platform: {
          requirePlatformAdmin,
          listTenants,
          updateTenant,
          metrics,
          tenantMetrics,
          alerts,
          billingSummary,
          updateBilling,
        } as unknown as IPlatformService,
        tenantPurge: { purgeTenant } as unknown as ITenantPurgeService,
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
    purgeTenant.mockClear();
    metrics.mockClear();
    tenantMetrics.mockClear();
    alerts.mockClear();
    billingSummary.mockClear();
    updateBilling.mockClear();
  });

  it('is not reachable without a JWT', () => {
    for (const [method, path] of [
      ['GET', '/api/v1/platform/tenants'],
      ['PATCH', '/api/v1/platform/tenants/11111111-1111-4111-8111-111111111111'],
      ['POST', '/api/v1/platform/tenants/11111111-1111-4111-8111-111111111111/purge'],
      ['GET', '/api/v1/platform/metrics'],
      ['GET', '/api/v1/platform/tenants/11111111-1111-4111-8111-111111111111/metrics'],
      ['GET', '/api/v1/platform/alerts'],
      ['GET', '/api/v1/platform/billing/summary'],
      ['PATCH', '/api/v1/platform/tenants/11111111-1111-4111-8111-111111111111/billing'],
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
      {
        method: 'POST' as const,
        url: '/platform/tenants/11111111-1111-4111-8111-111111111111/purge',
      },
      {
        method: 'GET' as const,
        url: '/platform/tenants/11111111-1111-4111-8111-111111111111/metrics',
      },
      { method: 'GET' as const, url: '/platform/alerts' },
      { method: 'GET' as const, url: '/platform/billing/summary' },
      {
        method: 'PATCH' as const,
        url: '/platform/tenants/11111111-1111-4111-8111-111111111111/billing',
        payload: { billingStatus: 'ACTIVE' },
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
    expect(purgeTenant).not.toHaveBeenCalled();
    expect(metrics).not.toHaveBeenCalled();
    expect(tenantMetrics).not.toHaveBeenCalled();
    expect(alerts).not.toHaveBeenCalled();
    expect(billingSummary).not.toHaveBeenCalled();
    expect(updateBilling).not.toHaveBeenCalled();
  });

  it('GET /platform/tenants forwards pagination and returns tenants + counts', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/tenants?page=2&pageSize=5',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: LIST });
    // Billing prefill travels with the list (same shape as PATCH .../billing).
    expect(response.json().data.items[0]).toMatchObject({
      billingStatus: 'ACTIVE',
      trialEndsAt: '2026-12-01T00:00:00.000Z',
      billingEmail: 'finance@acme.test',
    });
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

  it('GET /platform/tenants forwards the trimmed search term', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/tenants?page=1&pageSize=10&search=%20Acme%20',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(listTenants).toHaveBeenCalledWith({ page: 1, pageSize: 10, search: 'Acme' });
  });

  it('GET /platform/tenants treats a blank search as absent', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/tenants?search=',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(listTenants).toHaveBeenCalledWith({ page: 1, pageSize: 25 });
  });

  it('GET /platform/tenants rejects a search longer than 120 chars with 422', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/platform/tenants?search=${'a'.repeat(121)}`,
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(listTenants).not.toHaveBeenCalled();
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

  it('GET /platform/tenants/:id/metrics returns the workspace snapshot', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/platform/tenants/${TENANT_ID}/metrics`,
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: TENANT_METRICS });
    expect(tenantMetrics).toHaveBeenCalledWith(TENANT_ID);
    expect(requirePlatformAdmin).toHaveBeenCalledWith('platform-admin');
  });

  it('GET /platform/tenants/:id/metrics rejects a non-UUID tenant id with 422', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/tenants/not-a-uuid/metrics',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(tenantMetrics).not.toHaveBeenCalled();
  });

  it('GET /platform/tenants/:id/metrics propagates an unknown workspace as 404', async () => {
    tenantMetrics.mockRejectedValueOnce(new NotFoundError('Tenant', TENANT_ID));

    const response = await app.inject({
      method: 'GET',
      url: `/platform/tenants/${TENANT_ID}/metrics`,
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('GET /platform/alerts returns the derived alert list with metadata', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/alerts',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: ALERTS.alerts,
      meta: { generatedAt: ALERTS.generatedAt, total: ALERTS.total },
    });
    expect(alerts).toHaveBeenCalledTimes(1);
  });

  it('GET /platform/billing/summary returns the MRR base', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/billing/summary',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: BILLING_SUMMARY });
    expect(billingSummary).toHaveBeenCalledTimes(1);
  });

  describe('PATCH /platform/tenants/:id/billing', () => {
    it('forwards the subscription fields and returns the billing view', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/platform/tenants/${TENANT_ID}/billing`,
        headers: { 'x-test-agent': 'platform-admin' },
        payload: {
          billingStatus: 'ACTIVE',
          trialEndsAt: '2026-12-01T00:00:00.000Z',
          billingEmail: 'finance@acme.test',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: BILLING_VIEW });
      expect(updateBilling).toHaveBeenCalledWith(TENANT_ID, {
        billingStatus: 'ACTIVE',
        trialEndsAt: new Date('2026-12-01T00:00:00.000Z'),
        billingEmail: 'finance@acme.test',
      });
    });

    it('forwards null to clear the trial end and the billing e-mail', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/platform/tenants/${TENANT_ID}/billing`,
        headers: { 'x-test-agent': 'platform-admin' },
        payload: { trialEndsAt: null, billingEmail: null },
      });

      expect(response.statusCode).toBe(200);
      expect(updateBilling).toHaveBeenCalledWith(TENANT_ID, {
        trialEndsAt: null,
        billingEmail: null,
      });
    });

    it('rejects an empty body, unknown fields and invalid values with 422', async () => {
      const cases = [
        {},
        { billingStatus: 'ACTIVE', tenantId: 'tenant-2' },
        { billingStatus: 'PAST' },
        { billingEmail: 'not-an-email' },
        { billingEmail: '' },
        { trialEndsAt: 'not-a-date' },
      ];

      for (const payload of cases) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/platform/tenants/${TENANT_ID}/billing`,
          headers: { 'x-test-agent': 'platform-admin' },
          payload,
        });

        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      }
      expect(updateBilling).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID tenant id with 422', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/platform/tenants/not-a-uuid/billing',
        headers: { 'x-test-agent': 'platform-admin' },
        payload: { billingStatus: 'ACTIVE' },
      });

      expect(response.statusCode).toBe(422);
      expect(updateBilling).not.toHaveBeenCalled();
    });

    it('maps a soft-deleted workspace refusal to 409', async () => {
      updateBilling.mockRejectedValueOnce(
        new ConflictError('Deleted workspaces cannot change billing', {
          code: 'TENANT_DELETED',
        }),
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/platform/tenants/${TENANT_ID}/billing`,
        headers: { 'x-test-agent': 'platform-admin' },
        payload: { billingStatus: 'ACTIVE' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'CONFLICT', details: { code: 'TENANT_DELETED' } },
      });
    });
  });

  describe('POST /platform/tenants/:id/purge (manual LGPD purge)', () => {
    const purgedCounts = PURGE_RESULT.counts;

    it('runs the purge for a platform admin and returns the per-table counts', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/platform/tenants/${TENANT_ID}/purge`,
        headers: { 'x-test-agent': 'platform-admin' },
      });

      expect(response.statusCode).toBe(200);
      expect(purgeTenant).toHaveBeenCalledWith(TENANT_ID, 'platform-admin');
      expect(response.json()).toEqual({ data: PURGE_RESULT });
      expect(purgedCounts.tenant).toBe(1);
    });

    it('rejects a non-UUID tenant id with 422', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/platform/tenants/not-a-uuid/purge',
        headers: { 'x-test-agent': 'platform-admin' },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      expect(purgeTenant).not.toHaveBeenCalled();
    });

    it('maps the "workspace is not deleted" refusal to 409', async () => {
      purgeTenant.mockRejectedValueOnce(
        new ConflictError('Only soft-deleted workspaces can be purged', {
          code: 'TENANT_NOT_DELETED',
        }),
      );

      const response = await app.inject({
        method: 'POST',
        url: `/platform/tenants/${TENANT_ID}/purge`,
        headers: { 'x-test-agent': 'platform-admin' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'CONFLICT', details: { code: 'TENANT_NOT_DELETED' } },
      });
    });

    it('propagates an unknown workspace as 404', async () => {
      purgeTenant.mockRejectedValueOnce(new NotFoundError('Tenant', TENANT_ID));

      const response = await app.inject({
        method: 'POST',
        url: `/platform/tenants/${TENANT_ID}/purge`,
        headers: { 'x-test-agent': 'platform-admin' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    });
  });
});
