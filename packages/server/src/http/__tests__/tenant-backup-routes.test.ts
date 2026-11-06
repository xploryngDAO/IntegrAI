import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type {
  IAppServices,
  ILogger,
  IPlatformService,
  ITenantBackupService,
  RestoreTenantResult,
  TenantBackupResult,
  TenantBackupView,
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
const BACKUP_KEY = 'backups/acme/2026-11-05T12-00-00-000Z.json';

const COUNTS = {
  agents: 1,
  accounts: 1,
  tickets: 2,
  messages: 3,
  attachments: 0,
  events: 1,
  outboundAttempts: 0,
  orders: 1,
  slaPolicies: 0,
  webhookEvents: 1,
};

const BACKUP_RESULT: TenantBackupResult = {
  backupKey: BACKUP_KEY,
  sizeBytes: 4096,
  counts: COUNTS,
  createdAt: '2026-11-05T12:00:00.000Z',
};

const BACKUP_VIEW: TenantBackupView = {
  id: '22222222-2222-4222-8222-222222222222',
  tenantId: TENANT_ID,
  backupKey: BACKUP_KEY,
  sizeBytes: 4096,
  counts: COUNTS,
  createdBy: 'platform-admin',
  createdAt: '2026-11-05T12:00:00.000Z',
};

const RESTORE_RESULT: RestoreTenantResult = {
  tenantId: '33333333-3333-4333-8333-333333333333',
  slug: 'acme-restored',
  counts: COUNTS,
};

describe('tenant backup/restore routes', () => {
  let app: FastifyInstance;
  let requirePlatformAdmin: ReturnType<typeof vi.fn>;
  let createBackup: ReturnType<typeof vi.fn>;
  let listBackups: ReturnType<typeof vi.fn>;
  let restore: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    requirePlatformAdmin = vi.fn(async (actorId: string) => {
      if (actorId === 'platform-admin') return;
      throw new AuthorizationError('Platform administrator privileges are required');
    });
    createBackup = vi.fn(async () => BACKUP_RESULT);
    listBackups = vi.fn(async () => [BACKUP_VIEW]);
    restore = vi.fn(async () => RESTORE_RESULT);

    const services = {
      platform: { requirePlatformAdmin } as unknown as IPlatformService,
      tenantBackup: { createBackup, listBackups, restore } as unknown as ITenantBackupService,
      logger: noopLogger,
    } as unknown as IAppServices;

    const ctx = {
      services,
      hub: {},
      options: {},
    } as unknown as HttpRouteContext;

    app = Fastify();
    registerErrorHandler(app, { logger: noopLogger, exposeDetails: true });
    // Stand-in for the global JWT guard: the header chooses the principal.
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
    createBackup.mockClear();
    listBackups.mockClear();
    restore.mockClear();
  });

  it('is never a public route', () => {
    for (const [method, path] of [
      ['POST', `/api/v1/platform/tenants/${TENANT_ID}/backup`],
      ['GET', `/api/v1/platform/tenants/${TENANT_ID}/backups`],
      ['POST', '/api/v1/platform/tenants/restore'],
    ] as const) {
      expect(isPublicRoute(method, path)).toBe(false);
    }
  });

  it('answers 401 without a principal', async () => {
    for (const request of [
      { method: 'POST' as const, url: `/platform/tenants/${TENANT_ID}/backup` },
      { method: 'GET' as const, url: `/platform/tenants/${TENANT_ID}/backups` },
      {
        method: 'POST' as const,
        url: '/platform/tenants/restore',
        payload: { backupKey: BACKUP_KEY, newSlug: 'clone', newName: 'Clone' },
      },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'AUTHENTICATION_ERROR' } });
    }
    expect(createBackup).not.toHaveBeenCalled();
    expect(listBackups).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it('answers 403 for a regular tenant ADMIN (RBAC)', async () => {
    for (const request of [
      { method: 'POST' as const, url: `/platform/tenants/${TENANT_ID}/backup` },
      { method: 'GET' as const, url: `/platform/tenants/${TENANT_ID}/backups` },
      {
        method: 'POST' as const,
        url: '/platform/tenants/restore',
        payload: { backupKey: BACKUP_KEY, newSlug: 'clone', newName: 'Clone' },
      },
    ]) {
      const response = await app.inject({ ...request, headers: { 'x-test-agent': 'tenant-admin' } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_ERROR' } });
    }
    expect(createBackup).not.toHaveBeenCalled();
    expect(listBackups).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it('POST /platform/tenants/:id/backup creates and returns the artifact pointer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/platform/tenants/${TENANT_ID}/backup`,
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: BACKUP_RESULT });
    expect(createBackup).toHaveBeenCalledWith(TENANT_ID, 'platform-admin');
    expect(requirePlatformAdmin).toHaveBeenCalledWith('platform-admin');
  });

  it('POST /platform/tenants/:id/backup rejects a non-UUID id with 422', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/platform/tenants/not-a-uuid/backup',
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(422);
    expect(createBackup).not.toHaveBeenCalled();
  });

  it('GET /platform/tenants/:id/backups returns the index rows', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/platform/tenants/${TENANT_ID}/backups`,
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [BACKUP_VIEW] });
    expect(listBackups).toHaveBeenCalledWith(TENANT_ID);
  });

  it('GET /platform/tenants/:id/backups propagates an unknown workspace as 404', async () => {
    listBackups.mockRejectedValueOnce(new NotFoundError('Tenant', TENANT_ID));

    const response = await app.inject({
      method: 'GET',
      url: `/platform/tenants/${TENANT_ID}/backups`,
      headers: { 'x-test-agent': 'platform-admin' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('POST /platform/tenants/restore forwards the normalized body and returns the new tenant', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/platform/tenants/restore',
      headers: { 'x-test-agent': 'platform-admin' },
      payload: { backupKey: BACKUP_KEY, newSlug: 'Acme-Restored', newName: '  Acme Restored  ' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: RESTORE_RESULT });
    expect(restore).toHaveBeenCalledWith(
      { backupKey: BACKUP_KEY, newSlug: 'acme-restored', newName: 'Acme Restored' },
      'platform-admin',
    );
  });

  it('POST /platform/tenants/restore rejects an invalid body with 422', async () => {
    const cases = [
      {},
      { backupKey: 'other/acme/x.json', newSlug: 'clone', newName: 'Clone' },
      { backupKey: BACKUP_KEY, newSlug: 'Invalid Slug', newName: 'Clone' },
      { backupKey: BACKUP_KEY, newSlug: 'clone', newName: '' },
      { backupKey: BACKUP_KEY, newSlug: 'clone', newName: 'Clone', extra: true },
    ];

    for (const payload of cases) {
      const response = await app.inject({
        method: 'POST',
        url: '/platform/tenants/restore',
        headers: { 'x-test-agent': 'platform-admin' },
        payload,
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    expect(restore).not.toHaveBeenCalled();
  });

  it('POST /platform/tenants/restore maps slug conflict to 409 and missing backup to 404', async () => {
    restore.mockRejectedValueOnce(
      new ConflictError('Workspace slug is already in use', {
        code: 'TENANT_SLUG_CONFLICT',
      }),
    );
    let response = await app.inject({
      method: 'POST',
      url: '/platform/tenants/restore',
      headers: { 'x-test-agent': 'platform-admin' },
      payload: { backupKey: BACKUP_KEY, newSlug: 'acme', newName: 'Clone' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'CONFLICT', details: { code: 'TENANT_SLUG_CONFLICT' } },
    });

    restore.mockRejectedValueOnce(new NotFoundError('TenantBackup', BACKUP_KEY));
    response = await app.inject({
      method: 'POST',
      url: '/platform/tenants/restore',
      headers: { 'x-test-agent': 'platform-admin' },
      payload: { backupKey: BACKUP_KEY, newSlug: 'clone', newName: 'Clone' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
