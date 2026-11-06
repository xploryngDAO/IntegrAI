import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type {
  DeleteTenantResult,
  ILogger,
  ITenantPrivacyService,
  ITenantService,
  TenantExportPayload,
} from '@sac/shared';
import { AppError } from '@sac/shared';

import type { HttpRouteContext } from '../types';
import { tenantRoutes } from '../routes/tenants.routes';
import { registerErrorHandler } from '../middleware/error-handler';

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

const EXPORT: TenantExportPayload = {
  meta: {
    formatVersion: '1.0',
    exportedAt: '2026-11-05T12:00:00.000Z',
    exportedBy: 'agent-1',
    tenantId: 'tenant-1',
    limits: { maxAccounts: 10, maxAgents: 25 },
    ticketLimit: 1_000,
    messageLimit: 5_000,
    truncated: { tickets: false, messages: false },
    notes: ['exporta sem credenciais'],
  },
  tenant: {
    id: 'tenant-1',
    slug: 'acme',
    name: 'Acme',
    status: 'ACTIVE',
    plan: 'PRO',
    limits: { maxAccounts: 10, maxAgents: 25 },
    onboardingCompletedAt: null,
    deletedAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  },
  agents: [],
  accounts: [],
  tickets: [],
  messages: [],
  events: [],
};

const DELETED: DeleteTenantResult = {
  tenantId: 'tenant-1',
  slug: 'acme',
  status: 'DELETED',
  deletedAt: '2026-11-05T12:00:00.000Z',
  purge: { scheduled: true, note: 'queue.tenant.purge em 30 dias' },
};

describe('tenant LGPD routes', () => {
  let app: FastifyInstance;
  let exportData: ReturnType<typeof vi.fn>;
  let deleteTenant: ReturnType<typeof vi.fn>;
  let getTenant: ReturnType<typeof vi.fn>;
  let updateTenant: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    exportData = vi.fn(async () => EXPORT);
    deleteTenant = vi.fn(
      async (
        _tenantId: string,
        _body: { password: string; confirmSlug: string },
        _actorId: string,
      ) => {
        if (_body.password === 'wrong') {
          throw new AppError('INVALID_PASSWORD', 'Password confirmation failed', 403, {
            field: 'password',
          });
        }
        return DELETED;
      },
    );
    getTenant = vi.fn(async () => ({
      id: 'tenant-1',
      slug: 'acme',
      name: 'Acme',
      onboardingCompletedAt: null,
    }));
    updateTenant = vi.fn(async () => ({
      id: 'tenant-1',
      slug: 'acme',
      name: 'Acme',
      onboardingCompletedAt: null,
    }));

    const ctx = {
      services: {
        tenants: { get: getTenant, update: updateTenant } as unknown as ITenantService,
        tenantPrivacy: { exportData, deleteTenant } as unknown as ITenantPrivacyService,
      },
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
          isPlatformAdmin: false,
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
    exportData.mockClear();
    deleteTenant.mockClear();
  });

  describe('GET /tenants/me/export', () => {
    it('returns the JSON artifact as a download for an ADMIN', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/tenants/me/export',
        headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
      });

      expect(response.statusCode).toBe(200);
      expect(exportData).toHaveBeenCalledWith('tenant-1', 'agent-1');
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="tenant-acme-export-2026-11-05.json"',
      );
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json()).toEqual(EXPORT);
      // The artifact is a raw document, not the usual `{ data }` envelope.
      expect(response.json()).not.toHaveProperty('data');
    });

    it('answers 403 for AGENT and SUPERVISOR', async () => {
      for (const role of ['AGENT', 'SUPERVISOR']) {
        const response = await app.inject({
          method: 'GET',
          url: '/tenants/me/export',
          headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': role },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_ERROR' } });
      }
      expect(exportData).not.toHaveBeenCalled();
    });

    it('answers 401 without a principal', async () => {
      const response = await app.inject({ method: 'GET', url: '/tenants/me/export' });

      expect(response.statusCode).toBe(401);
      expect(exportData).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /tenants/me', () => {
    it('soft deletes with 202 after password + slug confirmation', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/tenants/me',
        headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
        payload: { password: 'CorrectHorse123!', confirmSlug: 'acme' },
      });

      expect(response.statusCode).toBe(202);
      expect(deleteTenant).toHaveBeenCalledWith(
        'tenant-1',
        { password: 'CorrectHorse123!', confirmSlug: 'acme' },
        'agent-1',
      );
      expect(response.json()).toEqual({ data: DELETED });
    });

    it('answers 403 for a non-ADMIN without calling the service', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/tenants/me',
        headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'AGENT' },
        payload: { password: 'CorrectHorse123!', confirmSlug: 'acme' },
      });

      expect(response.statusCode).toBe(403);
      expect(deleteTenant).not.toHaveBeenCalled();
    });

    it('rejects a missing password/slug or a smuggled tenantId with 422', async () => {
      const cases = [
        { confirmSlug: 'acme' },
        { password: 'CorrectHorse123!' },
        { password: 'CorrectHorse123!', confirmSlug: 'acme', tenantId: 'tenant-2' },
      ];

      for (const payload of cases) {
        const response = await app.inject({
          method: 'DELETE',
          url: '/tenants/me',
          headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
          payload,
        });

        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      }
      expect(deleteTenant).not.toHaveBeenCalled();
    });

    it('propagates the invalid password as 403 INVALID_PASSWORD', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/tenants/me',
        headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
        payload: { password: 'wrong', confirmSlug: 'acme' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_PASSWORD' } });
      expect(deleteTenant).toHaveBeenCalledTimes(1);
    });
  });
});
