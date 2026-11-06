import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppError, AuthenticationError, NotFoundError } from '@sac/shared';
import type { AdminUserView, AuditLogPage } from '@sac/shared';

import { buildTestApp } from './http-test-harness';

/**
 * HTTP contract of `/api/v1/admin/*`.
 *
 * The real Fastify graph (global JWT guard + `requireRole('ADMIN')` + routes +
 * error handler) is exercised; only the service ports are mocks. Covers 401,
 * 403, 404, 409, 422 and the envelope/query translation of every route.
 */

const ADMIN_TOKEN = 'token-admin';
const AGENT_TOKEN = 'token-agent';
const SUPERVISOR_TOKEN = 'token-supervisor';
const TENANTLESS_ADMIN_TOKEN = 'token-tenantless-admin';

const PRINCIPALS: Record<string, Record<string, unknown>> = {
  [ADMIN_TOKEN]: {
    agentId: 'admin-1',
    email: 'admin@acme.test',
    name: 'Ana',
    role: 'ADMIN',
    tenantId: 'tenant-1',
    isPlatformAdmin: false,
  },
  [AGENT_TOKEN]: {
    agentId: 'agent-2',
    email: 'agent@acme.test',
    name: 'Bob',
    role: 'AGENT',
    tenantId: 'tenant-1',
    isPlatformAdmin: false,
  },
  [SUPERVISOR_TOKEN]: {
    agentId: 'sup-1',
    email: 'sup@acme.test',
    name: 'Sara',
    role: 'SUPERVISOR',
    tenantId: 'tenant-1',
    isPlatformAdmin: false,
  },
  [TENANTLESS_ADMIN_TOKEN]: {
    agentId: 'platform-1',
    email: 'platform@acme.test',
    name: 'Platform',
    role: 'ADMIN',
    tenantId: null,
    isPlatformAdmin: true,
  },
};

const USER_ID = '22222222-2222-4222-8222-222222222222';

const USER: AdminUserView = {
  id: USER_ID,
  name: 'Bob',
  email: 'bob@acme.test',
  role: 'AGENT',
  isActive: true,
  lastLoginAt: '2026-11-05T10:00:00.000Z',
  createdAt: '2026-11-01T10:00:00.000Z',
  sessionsCount: 2,
};

const AUDIT_PAGE: AuditLogPage = {
  items: [
    {
      id: 'audit-1',
      tenantId: 'tenant-1',
      actorId: 'admin-1',
      actorEmail: 'admin@acme.test',
      action: 'auth.login.success',
      resourceType: null,
      resourceId: null,
      ip: '203.0.113.7',
      userAgent: 'Chrome',
      metadata: {},
      createdAt: '2026-11-06T12:00:00.000Z',
    },
  ],
  page: 1,
  perPage: 25,
  total: 1,
};

describe('admin HTTP routes', () => {
  let app: FastifyInstance;

  const verifyToken = vi.fn(async (token: string) => {
    const principal = PRINCIPALS[token];
    if (principal === undefined) throw new AuthenticationError('Invalid token');
    return principal as never;
  });
  const listUsers = vi.fn(async () => ({ items: [USER], total: 1 }));
  const updateUser = vi.fn(async () => USER);
  const revokeSessions = vi.fn(async () => ({ revoked: 3 }));
  const listAuditLogs = vi.fn(async () => AUDIT_PAGE);

  beforeAll(async () => {
    app = await buildTestApp({
      services: {
        agents: { verifyToken },
        adminUsers: { list: listUsers, update: updateUser, revokeSessions },
        audit: { list: listAuditLogs, record: (): void => undefined, flush: async (): Promise<void> => undefined },
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    verifyToken.mockClear();
    listUsers.mockClear();
    updateUser.mockClear();
    revokeSessions.mockClear();
    listAuditLogs.mockClear();
    updateUser.mockImplementation(async () => USER);
    revokeSessions.mockImplementation(async () => ({ revoked: 3 }));
    listAuditLogs.mockImplementation(async () => AUDIT_PAGE);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  it('answers 401 without a bearer token on every admin route', async () => {
    const requests = [
      { method: 'GET' as const, url: '/api/v1/admin/users' },
      { method: 'PATCH' as const, url: '/api/v1/admin/users/22222222-2222-4222-8222-222222222222' },
      { method: 'POST' as const, url: '/api/v1/admin/users/22222222-2222-4222-8222-222222222222/revoke-sessions' },
      { method: 'GET' as const, url: '/api/v1/admin/audit-logs' },
    ];

    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'AUTHENTICATION_ERROR' } });
    }
  });

  it('answers 403 for AGENT and SUPERVISOR on every admin route', async () => {
    for (const token of [AGENT_TOKEN, SUPERVISOR_TOKEN]) {
      const responses = await Promise.all([
        app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: auth(token) }),
        app.inject({
          method: 'PATCH',
          url: '/api/v1/admin/users/22222222-2222-4222-8222-222222222222',
          headers: { ...auth(token), 'content-type': 'application/json' },
          payload: { role: 'AGENT' },
        }),
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/users/22222222-2222-4222-8222-222222222222/revoke-sessions',
          headers: auth(token),
        }),
        app.inject({ method: 'GET', url: '/api/v1/admin/audit-logs', headers: auth(token) }),
      ]);

      for (const response of responses) {
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_ERROR' } });
      }
    }
  });

  it('answers 403 for an ADMIN without a workspace', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: auth(TENANTLESS_ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_ERROR' } });
  });

  it('GET /admin/users returns the tenant team inside the data envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { items: [USER], total: 1 } });
    expect(listUsers).toHaveBeenCalledWith('tenant-1');
  });

  it('PATCH /admin/users/:id forwards the JWT tenant + actor and returns the user', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/users/22222222-2222-4222-8222-222222222222',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      payload: { role: 'SUPERVISOR', isActive: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: USER });
    expect(updateUser).toHaveBeenCalledTimes(1);
    const [tenantId, actor, userId, command] = updateUser.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      string,
      Record<string, unknown>,
    ];
    expect(tenantId).toBe('tenant-1');
    expect(actor).toMatchObject({
      id: 'admin-1',
      email: 'admin@acme.test',
      tenantId: 'tenant-1',
    });
    expect(userId).toBe(USER_ID);
    expect(command).toEqual({ role: 'SUPERVISOR', isActive: false });
  });

  it('PATCH /admin/users/:id answers 422 for an empty/invalid body or a bad id', async () => {
    const empty = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/users/22222222-2222-4222-8222-222222222222',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      payload: {},
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const invalidRole = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/users/22222222-2222-4222-8222-222222222222',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      payload: { role: 'OWNER' },
    });
    expect(invalidRole.statusCode).toBe(422);

    const invalidId = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/users/not-a-uuid',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      payload: { role: 'AGENT' },
    });
    expect(invalidId.statusCode).toBe(422);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('PATCH /admin/users/:id propagates 404 (cross-tenant) and 409 (self/last admin)', async () => {
    updateUser.mockRejectedValueOnce(new NotFoundError('User', USER_ID));
    const notFound = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/users/22222222-2222-4222-8222-222222222222',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      payload: { role: 'AGENT' },
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    updateUser.mockRejectedValueOnce(
      new AppError('CANNOT_MODIFY_SELF', 'self', 409),
    );
    const conflict = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/users/22222222-2222-4222-8222-222222222222',
      headers: { ...auth(ADMIN_TOKEN), 'content-type': 'application/json' },
      payload: { isActive: false },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'CANNOT_MODIFY_SELF' } });
  });

  it('POST /admin/users/:id/revoke-sessions returns { revoked } and propagates 409', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/22222222-2222-4222-8222-222222222222/revoke-sessions',
      headers: auth(ADMIN_TOKEN),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { revoked: 3 } });
    expect(revokeSessions).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ id: 'admin-1' }),
      USER_ID,
    );

    revokeSessions.mockRejectedValueOnce(
      new AppError('CANNOT_REVOKE_OWN_SESSIONS', 'self', 409),
    );
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users/22222222-2222-4222-8222-222222222222/revoke-sessions',
      headers: auth(ADMIN_TOKEN),
    });
    expect(conflict.statusCode).toBe(409);
  });

  it('GET /admin/audit-logs parses filters/dates/pagination and scopes by JWT tenant', async () => {
    const response = await app.inject({
      method: 'GET',
      url:
        '/api/v1/admin/audit-logs?action=auth.login.success&actorId=11111111-1111-4111-8111-111111111111' +
        '&from=2026-11-01T00:00:00.000Z&to=2026-11-30T23:59:59.999Z&page=2&perPage=10',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: AUDIT_PAGE });

    const [tenantId, query] = listAuditLogs.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(tenantId).toBe('tenant-1');
    expect(query).toMatchObject({
      action: 'auth.login.success',
      actorId: '11111111-1111-4111-8111-111111111111',
      page: 2,
      perPage: 10,
    });
    expect(query.from).toBeInstanceOf(Date);
    expect((query.from as Date).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect((query.to as Date).toISOString()).toBe('2026-11-30T23:59:59.999Z');
  });

  it('GET /admin/audit-logs answers 422 for perPage > 100 or a non-ISO date', async () => {
    const tooLarge = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs?perPage=101',
      headers: auth(ADMIN_TOKEN),
    });
    expect(tooLarge.statusCode).toBe(422);

    const badDate = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs?from=yesterday',
      headers: auth(ADMIN_TOKEN),
    });
    expect(badDate.statusCode).toBe(422);

    const badActor = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs?actorId=not-a-uuid',
      headers: auth(ADMIN_TOKEN),
    });
    expect(badActor.statusCode).toBe(422);
    expect(listAuditLogs).not.toHaveBeenCalled();
  });
});
