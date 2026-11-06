import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppError, AuthenticationError, NotFoundError } from '@sac/shared';
import type {
  AdminInvitationListResult,
  AdminOverview,
  AdminSessionListResult,
  AdminUserView,
  AuditEventView,
  AuditLogPage,
  ILogger,
} from '@sac/shared';

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
    // Access-token `sid` claim: `current` on `/admin/sessions` compares to it.
    sessionId: '44444444-4444-4444-8444-444444444444',
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
const INVITATION_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';

const OVERVIEW: AdminOverview = {
  users: { total: 3, active: 2, admins: 1 },
  sessions: { active: 4 },
  invitations: { pending: 2 },
  accounts: {
    total: 5,
    connected: 4,
    byMarketplace: { AMAZON: 2, MERCADO_LIVRE: 2, SHOPEE: 1 },
  },
  tickets: { total: 12, unread: 3, unassigned: 5 },
  audit: { last24h: 8 },
};

const SESSIONS: AdminSessionListResult = {
  items: [
    {
      id: SESSION_ID,
      agentId: 'agent-2',
      name: 'Bob',
      email: 'bob@acme.test',
      role: 'AGENT',
      ip: '203.0.113.9',
      userAgent: 'Firefox',
      createdAt: '2026-11-06T10:00:00.000Z',
      lastUsedAt: null,
      current: false,
    },
  ],
  total: 1,
};

const INVITATION_LIST: AdminInvitationListResult = {
  items: [
    {
      id: INVITATION_ID,
      email: 'invitee@acme.test',
      role: 'AGENT',
      createdAt: '2026-11-06T10:00:00.000Z',
      expiresAt: '2026-11-13T10:00:00.000Z',
      acceptedAt: null,
      status: 'PENDING',
    },
  ],
  total: 1,
};

const CSV_ROWS: AuditEventView[] = [
  {
    id: 'audit-1',
    tenantId: 'tenant-1',
    actorId: 'admin-1',
    actorEmail: 'ana@acme.test',
    action: 'auth.login.success',
    resourceType: 'user',
    resourceId: null,
    ip: '203.0.113.7',
    userAgent: 'Chrome, "Quoted"',
    metadata: { ignored: true },
    createdAt: '2026-11-06T12:00:00.000Z',
  },
];

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
  const listUsers = vi.fn(async () => ({
    items: [USER],
    total: 1,
    page: 1,
    perPage: 25,
  }));
  const overview = vi.fn(async () => OVERVIEW);
  const exportUsers = vi.fn(async () => [USER]);
  const updateUser = vi.fn(async () => USER);
  const revokeSessions = vi.fn(async () => ({ revoked: 3 }));
  const listSessions = vi.fn(async () => SESSIONS);
  const revokeSession = vi.fn(async () => undefined);
  const listInvitations = vi.fn(async () => INVITATION_LIST);
  const revokeInvitation = vi.fn(async () => undefined);
  const resendInvitation = vi.fn(async () => ({
    id: INVITATION_ID,
    email: 'invitee@acme.test',
    role: 'AGENT' as const,
    expiresAt: new Date('2026-11-20T10:00:00.000Z'),
    status: 'PENDING' as const,
  }));
  const listAuditLogs = vi.fn(async () => AUDIT_PAGE);
  const exportAuditRows = vi.fn(async () => CSV_ROWS);
  const recordAudit = vi.fn();
  const warn = vi.fn();
  const testLogger: ILogger = {
    child(): ILogger {
      return testLogger;
    },
    trace: (): void => undefined,
    debug: (): void => undefined,
    info: (): void => undefined,
    warn,
    error: (): void => undefined,
  };

  beforeAll(async () => {
    app = await buildTestApp({
      services: {
        logger: testLogger,
        agents: { verifyToken },
        adminUsers: {
          overview,
          list: listUsers,
          exportRows: exportUsers,
          update: updateUser,
          revokeSessions,
          listSessions,
          revokeSession,
        },
        invitations: {
          listForAdmin: listInvitations,
          revokeForAdmin: revokeInvitation,
          resendForAdmin: resendInvitation,
        },
        audit: {
          list: listAuditLogs,
          exportRows: exportAuditRows,
          record: recordAudit,
          flush: async (): Promise<void> => undefined,
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    verifyToken.mockClear();
    overview.mockClear();
    listUsers.mockClear();
    exportUsers.mockClear();
    updateUser.mockClear();
    revokeSessions.mockClear();
    listSessions.mockClear();
    revokeSession.mockClear();
    listInvitations.mockClear();
    revokeInvitation.mockClear();
    resendInvitation.mockClear();
    listAuditLogs.mockClear();
    exportAuditRows.mockClear();
    recordAudit.mockClear();
    warn.mockClear();
    recordAudit.mockImplementation(() => undefined);
    updateUser.mockImplementation(async () => USER);
    overview.mockImplementation(async () => OVERVIEW);
    listUsers.mockImplementation(async () => ({
      items: [USER],
      total: 1,
      page: 1,
      perPage: 25,
    }));
    exportUsers.mockImplementation(async () => [USER]);
    revokeSessions.mockImplementation(async () => ({ revoked: 3 }));
    listSessions.mockImplementation(async () => SESSIONS);
    revokeSession.mockImplementation(async () => undefined);
    listInvitations.mockImplementation(async () => INVITATION_LIST);
    revokeInvitation.mockImplementation(async () => undefined);
    resendInvitation.mockImplementation(async () => ({
      id: INVITATION_ID,
      email: 'invitee@acme.test',
      role: 'AGENT' as const,
      expiresAt: new Date('2026-11-20T10:00:00.000Z'),
      status: 'PENDING' as const,
    }));
    listAuditLogs.mockImplementation(async () => AUDIT_PAGE);
    exportAuditRows.mockImplementation(async () => CSV_ROWS);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  it('answers 401 without a bearer token on every admin route', async () => {
    const requests = [
      { method: 'GET' as const, url: '/api/v1/admin/overview' },
      { method: 'GET' as const, url: '/api/v1/admin/users' },
      { method: 'GET' as const, url: '/api/v1/admin/users/export.csv' },
      { method: 'PATCH' as const, url: '/api/v1/admin/users/22222222-2222-4222-8222-222222222222' },
      { method: 'POST' as const, url: '/api/v1/admin/users/22222222-2222-4222-8222-222222222222/revoke-sessions' },
      { method: 'GET' as const, url: '/api/v1/admin/invitations' },
      {
        method: 'POST' as const,
        url: `/api/v1/admin/invitations/${INVITATION_ID}/resend`,
      },
      { method: 'DELETE' as const, url: `/api/v1/admin/invitations/${INVITATION_ID}` },
      { method: 'GET' as const, url: '/api/v1/admin/sessions' },
      { method: 'DELETE' as const, url: `/api/v1/admin/sessions/${SESSION_ID}` },
      { method: 'GET' as const, url: '/api/v1/admin/audit-logs' },
      { method: 'GET' as const, url: '/api/v1/admin/audit-logs/export.csv' },
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
        app.inject({
          method: 'GET',
          url: '/api/v1/admin/overview',
          headers: auth(token),
        }),
        app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: auth(token) }),
        app.inject({
          method: 'GET',
          url: '/api/v1/admin/users/export.csv',
          headers: auth(token),
        }),
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
        app.inject({ method: 'GET', url: '/api/v1/admin/invitations', headers: auth(token) }),
        app.inject({
          method: 'POST',
          url: `/api/v1/admin/invitations/${INVITATION_ID}/resend`,
          headers: auth(token),
        }),
        app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/invitations/${INVITATION_ID}`,
          headers: auth(token),
        }),
        app.inject({ method: 'GET', url: '/api/v1/admin/sessions', headers: auth(token) }),
        app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/sessions/${SESSION_ID}`,
          headers: auth(token),
        }),
        app.inject({ method: 'GET', url: '/api/v1/admin/audit-logs', headers: auth(token) }),
        app.inject({
          method: 'GET',
          url: '/api/v1/admin/audit-logs/export.csv',
          headers: auth(token),
        }),
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

    const exportResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users/export.csv',
      headers: auth(TENANTLESS_ADMIN_TOKEN),
    });
    expect(exportResponse.statusCode).toBe(403);
    expect(exportResponse.json()).toMatchObject({
      error: { code: 'AUTHORIZATION_ERROR' },
    });
    expect(exportUsers).not.toHaveBeenCalled();

    const sessionsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sessions',
      headers: auth(TENANTLESS_ADMIN_TOKEN),
    });
    expect(sessionsResponse.statusCode).toBe(403);
    expect(sessionsResponse.json()).toMatchObject({
      error: { code: 'AUTHORIZATION_ERROR' },
    });
    expect(listSessions).not.toHaveBeenCalled();

    const overviewResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: auth(TENANTLESS_ADMIN_TOKEN),
    });
    expect(overviewResponse.statusCode).toBe(403);
    expect(overviewResponse.json()).toMatchObject({
      error: { code: 'AUTHORIZATION_ERROR' },
    });
    expect(overview).not.toHaveBeenCalled();
  });

  it('GET /admin/overview returns the tenant snapshot inside the data envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: OVERVIEW });
    // Tenant comes from the JWT, never from the request.
    expect(overview).toHaveBeenCalledWith('tenant-1');
  });

  it('GET /admin/users returns the tenant team inside the data envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { items: [USER], total: 1, page: 1, perPage: 25 },
    });
    expect(listUsers).toHaveBeenCalledWith('tenant-1', { page: 1, perPage: 25 });
  });

  it('GET /admin/users parses search/role/status/pagination and scopes by JWT tenant', async () => {
    listUsers.mockResolvedValueOnce({
      items: [USER],
      total: 42,
      page: 2,
      perPage: 10,
    });

    const response = await app.inject({
      method: 'GET',
      url:
        '/api/v1/admin/users?search=%20%20Ana%20%20&role=AGENT&status=ACTIVE' +
        '&page=2&perPage=10',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { items: [USER], total: 42, page: 2, perPage: 10 },
    });
    expect(listUsers).toHaveBeenCalledWith('tenant-1', {
      search: 'Ana',
      role: 'AGENT',
      status: 'ACTIVE',
      page: 2,
      perPage: 10,
    });
  });

  it('GET /admin/users answers 422 for an invalid role/status/page/perPage/search', async () => {
    const invalidUrls = [
      '/api/v1/admin/users?role=OWNER',
      '/api/v1/admin/users?status=DISABLED',
      '/api/v1/admin/users?page=0',
      '/api/v1/admin/users?page=abc',
      '/api/v1/admin/users?perPage=101',
      `/api/v1/admin/users?search=${'a'.repeat(121)}`,
    ];

    for (const url of invalidUrls) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: auth(ADMIN_TOKEN),
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }

    expect(listUsers).not.toHaveBeenCalled();
  });

  it('GET /admin/users/export.csv sends the filtered team as an RFC4180 attachment', async () => {
    exportUsers.mockResolvedValueOnce([
      {
        ...USER,
        name: 'Bob, "The Builder"',
        lastLoginAt: null,
        sessionsCount: 0,
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users/export.csv?search=Bob&role=AGENT&status=INACTIVE',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename=usuarios-2026-11-05.csv',
    );
    expect(response.body).toBe(
      'name,email,role,is_active,last_login_at,created_at,sessions_count\r\n' +
        '"Bob, ""The Builder""",bob@acme.test,AGENT,true,,2026-11-01T10:00:00.000Z,0\r\n',
    );

    const [tenantId, query, limit] = exportUsers.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      number,
    ];
    expect(tenantId).toBe('tenant-1');
    expect(query).toEqual({ search: 'Bob', role: 'AGENT', status: 'INACTIVE' });
    expect(limit).toBe(10_000);
    expect(listUsers).not.toHaveBeenCalled();
  });

  it('GET /admin/users/export.csv returns the header only when there is nothing to export', async () => {
    exportUsers.mockResolvedValueOnce([]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users/export.csv',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      'name,email,role,is_active,last_login_at,created_at,sessions_count\r\n',
    );
  });

  it('GET /admin/users/export.csv answers 422 for invalid filters without querying', async () => {
    for (const url of [
      '/api/v1/admin/users/export.csv?role=OWNER',
      '/api/v1/admin/users/export.csv?status=DISABLED',
      `/api/v1/admin/users/export.csv?search=${'a'.repeat(121)}`,
    ]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: auth(ADMIN_TOKEN),
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }

    expect(exportUsers).not.toHaveBeenCalled();
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

  it('GET /admin/sessions returns the tenant live sessions with the JWT sid as current', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sessions',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: SESSIONS });
    // Tenant comes from the JWT, `current` from the access-token `sid` claim.
    expect(listSessions).toHaveBeenCalledWith(
      'tenant-1',
      { page: 1, perPage: 50 },
      '44444444-4444-4444-8444-444444444444',
    );
  });

  it('GET /admin/sessions parses page/perPage and rejects values above the cap', async () => {
    listSessions.mockResolvedValueOnce({ items: [], total: 0 });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sessions?page=2&perPage=10',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(listSessions).toHaveBeenCalledWith(
      'tenant-1',
      { page: 2, perPage: 10 },
      '44444444-4444-4444-8444-444444444444',
    );

    listSessions.mockClear();
    for (const url of [
      '/api/v1/admin/sessions?page=0',
      '/api/v1/admin/sessions?page=abc',
      '/api/v1/admin/sessions?perPage=101',
    ]) {
      const invalid = await app.inject({
        method: 'GET',
        url,
        headers: auth(ADMIN_TOKEN),
      });
      expect(invalid.statusCode).toBe(422);
      expect(invalid.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('DELETE /admin/sessions/:id answers 204 and forwards tenant + actor + sid', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/sessions/${SESSION_ID}`,
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(revokeSession).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({
        id: 'admin-1',
        email: 'admin@acme.test',
        tenantId: 'tenant-1',
      }),
      SESSION_ID,
      '44444444-4444-4444-8444-444444444444',
    );
  });

  it('DELETE /admin/sessions/:id propagates 404 (foreign/unknown) and 409 (current)', async () => {
    revokeSession.mockRejectedValueOnce(new NotFoundError('Session', SESSION_ID));
    const notFound = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/sessions/${SESSION_ID}`,
      headers: auth(ADMIN_TOKEN),
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    revokeSession.mockRejectedValueOnce(
      new AppError('CANNOT_REVOKE_CURRENT_SESSION', 'current', 409),
    );
    const conflict = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/sessions/${SESSION_ID}`,
      headers: auth(ADMIN_TOKEN),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'CANNOT_REVOKE_CURRENT_SESSION' },
    });
  });

  it('DELETE /admin/sessions/:id answers 422 for a malformed id', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/sessions/not-a-uuid',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(revokeSession).not.toHaveBeenCalled();
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

  it('GET /admin/invitations returns the tenant invites with the derived status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/invitations',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: INVITATION_LIST });
    expect(listInvitations).toHaveBeenCalledWith('tenant-1');
  });

  it('DELETE /admin/invitations/:id answers 204 and forwards tenant + actor', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/invitations/${INVITATION_ID}`,
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(revokeInvitation).toHaveBeenCalledTimes(1);

    const [tenantId, actor, invitationId] = revokeInvitation.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      string,
    ];
    expect(tenantId).toBe('tenant-1');
    expect(actor).toMatchObject({
      id: 'admin-1',
      email: 'admin@acme.test',
      tenantId: 'tenant-1',
    });
    expect(invitationId).toBe(INVITATION_ID);
  });

  it('DELETE /admin/invitations/:id propagates 404 (cross-tenant) and 409 (accepted)', async () => {
    revokeInvitation.mockRejectedValueOnce(
      new NotFoundError('Invitation', INVITATION_ID),
    );
    const notFound = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/invitations/${INVITATION_ID}`,
      headers: auth(ADMIN_TOKEN),
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    revokeInvitation.mockRejectedValueOnce(
      new AppError('INVITATION_ALREADY_ACCEPTED', 'accepted', 409),
    );
    const conflict = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/invitations/${INVITATION_ID}`,
      headers: auth(ADMIN_TOKEN),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'INVITATION_ALREADY_ACCEPTED' },
    });
  });

  it('DELETE /admin/invitations/:id answers 422 for a malformed id', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/invitations/not-a-uuid',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(revokeInvitation).not.toHaveBeenCalled();
  });

  it('POST /admin/invitations/:id/resend returns the refreshed PENDING row', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/invitations/${INVITATION_ID}/resend`,
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        id: INVITATION_ID,
        email: 'invitee@acme.test',
        role: 'AGENT',
        expiresAt: '2026-11-20T10:00:00.000Z',
        status: 'PENDING',
      },
    });

    const [tenantId, actor, invitationId] = resendInvitation.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      string,
    ];
    expect(tenantId).toBe('tenant-1');
    expect(actor).toMatchObject({
      id: 'admin-1',
      email: 'admin@acme.test',
      tenantId: 'tenant-1',
      name: 'Ana',
    });
    expect(invitationId).toBe(INVITATION_ID);
  });

  it('POST /admin/invitations/:id/resend propagates 404 and 409', async () => {
    resendInvitation.mockRejectedValueOnce(
      new NotFoundError('Invitation', INVITATION_ID),
    );
    const notFound = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/invitations/${INVITATION_ID}/resend`,
      headers: auth(ADMIN_TOKEN),
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    resendInvitation.mockRejectedValueOnce(
      new AppError('INVITATION_ALREADY_ACCEPTED', 'accepted', 409),
    );
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/invitations/${INVITATION_ID}/resend`,
      headers: auth(ADMIN_TOKEN),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'INVITATION_ALREADY_ACCEPTED' },
    });
  });

  it('POST /admin/invitations/:id/resend propagates 502 EMAIL_SEND_FAILED', async () => {
    resendInvitation.mockRejectedValueOnce(
      new AppError('EMAIL_SEND_FAILED', 'relay unavailable', 502),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/invitations/${INVITATION_ID}/resend`,
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { code: 'EMAIL_SEND_FAILED' },
    });
  });

  it('POST /admin/invitations/:id/resend answers 422 for a malformed id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/invitations/not-a-uuid/resend',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(resendInvitation).not.toHaveBeenCalled();
  });

  it('GET /admin/audit-logs/export.csv sends an RFC4180 attachment scoped by JWT tenant and filters', async () => {
    const response = await app.inject({
      method: 'GET',
      url:
        '/api/v1/admin/audit-logs/export.csv?action=auth.login.success' +
        '&actorId=11111111-1111-4111-8111-111111111111' +
        '&from=2026-11-01T00:00:00.000Z&to=2026-11-30T23:59:59.999Z',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename=audit-logs-2026-11-05.csv',
    );
    expect(response.body).toBe(
      'created_at,action,actor_email,resource_type,resource_id,ip,user_agent\r\n' +
        '2026-11-06T12:00:00.000Z,auth.login.success,ana@acme.test,user,,203.0.113.7,"Chrome, ""Quoted"""\r\n',
    );

    const [tenantId, query, limit] = exportAuditRows.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      number,
    ];
    expect(tenantId).toBe('tenant-1');
    expect(query).toMatchObject({
      action: 'auth.login.success',
      actorId: '11111111-1111-4111-8111-111111111111',
    });
    expect((query.from as Date).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect((query.to as Date).toISOString()).toBe('2026-11-30T23:59:59.999Z');
    expect(limit).toBe(10_000);
  });

  it('GET /admin/audit-logs/export.csv returns the header only when there is nothing to export', async () => {
    exportAuditRows.mockResolvedValueOnce([]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs/export.csv',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      'created_at,action,actor_email,resource_type,resource_id,ip,user_agent\r\n',
    );
  });

  it('GET /admin/audit-logs/export.csv answers 422 for invalid filters without querying', async () => {
    const badDate = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs/export.csv?from=yesterday',
      headers: auth(ADMIN_TOKEN),
    });
    expect(badDate.statusCode).toBe(422);

    const badActor = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs/export.csv?actorId=not-a-uuid',
      headers: auth(ADMIN_TOKEN),
    });
    expect(badActor.statusCode).toBe(422);
    expect(exportAuditRows).not.toHaveBeenCalled();
  });

  /* ======================================================================
   * CSV export audit (`admin.users.exported` / `admin.audit.exported`)
   * ==================================================================== */

  it('GET /admin/users/export.csv audits admin.users.exported with the applied filters and real row count', async () => {
    exportUsers.mockResolvedValueOnce([
      USER,
      { ...USER, id: '66666666-6666-4666-8666-666666666666', email: 'ana@acme.test' },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users/export.csv?search=Bob&role=AGENT&status=ACTIVE',
      headers: { ...auth(ADMIN_TOKEN), 'user-agent': 'Vitest/9.9' },
    });

    expect(response.statusCode).toBe(200);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith({
      action: 'admin.users.exported',
      tenantId: 'tenant-1',
      actorId: 'admin-1',
      // The actor e-mail has its own column and is allowed in full.
      actorEmail: 'admin@acme.test',
      ip: '127.0.0.1',
      userAgent: 'Vitest/9.9',
      resourceType: 'export',
      resourceId: null,
      metadata: {
        filters: { search: 'Bob', role: 'AGENT', status: 'ACTIVE' },
        rowCount: 2,
        format: 'csv',
      },
    });
  });

  it('GET /admin/users/export.csv keeps the audit metadata lean when unfiltered', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users/export.csv',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    const event = recordAudit.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    // No `filters` key at all: an unfiltered export must not invent `{}`.
    expect(event.metadata).toEqual({ rowCount: 1, format: 'csv' });
  });

  it('GET /admin/users/export.csv audits rowCount 0 for a header-only CSV', async () => {
    exportUsers.mockResolvedValueOnce([]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users/export.csv',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    const event = recordAudit.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    expect(event.metadata).toEqual({ rowCount: 0, format: 'csv' });
  });

  it('GET /admin/users/export.csv counts a quoted multi-line record as ONE data row', async () => {
    exportUsers.mockResolvedValueOnce([{ ...USER, name: 'Bob\r\nJr' }]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users/export.csv',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    const event = recordAudit.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    expect(event.metadata.rowCount).toBe(1);
  });

  it('GET /admin/users/export.csv redacts an e-mail search in the audit metadata', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users/export.csv?search=bob%40acme.test',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    const event = recordAudit.mock.calls[0]?.[0] as {
      metadata: { filters?: Record<string, string> };
    };
    expect(event.metadata.filters).toEqual({ search: 'bo***@acme.test' });
    expect(JSON.stringify(event.metadata)).not.toContain('bob@acme.test');
  });

  it('GET /admin/audit-logs/export.csv audits admin.audit.exported with ISO filters and row count', async () => {
    const response = await app.inject({
      method: 'GET',
      url:
        '/api/v1/admin/audit-logs/export.csv?action=auth.login.success' +
        '&actorId=11111111-1111-4111-8111-111111111111' +
        '&from=2026-11-01T00:00:00.000Z&to=2026-11-30T23:59:59.999Z',
      headers: { ...auth(ADMIN_TOKEN), 'user-agent': 'Vitest/9.9' },
    });

    expect(response.statusCode).toBe(200);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith({
      action: 'admin.audit.exported',
      tenantId: 'tenant-1',
      actorId: 'admin-1',
      actorEmail: 'admin@acme.test',
      ip: '127.0.0.1',
      userAgent: 'Vitest/9.9',
      resourceType: 'export',
      resourceId: null,
      metadata: {
        filters: {
          action: 'auth.login.success',
          actorId: '11111111-1111-4111-8111-111111111111',
          from: '2026-11-01T00:00:00.000Z',
          to: '2026-11-30T23:59:59.999Z',
        },
        rowCount: 1,
        format: 'csv',
      },
    });
  });

  it('GET /admin/audit-logs/export.csv keeps the audit metadata lean when unfiltered', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs/export.csv',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    const event = recordAudit.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    expect(event.metadata).toEqual({ rowCount: 1, format: 'csv' });
  });

  it('does not audit an export before authentication/authorization', async () => {
    for (const headers of [{}, auth(AGENT_TOKEN), auth(SUPERVISOR_TOKEN), auth(TENANTLESS_ADMIN_TOKEN)]) {
      const responses = await Promise.all([
        app.inject({
          method: 'GET',
          url: '/api/v1/admin/users/export.csv',
          headers,
        }),
        app.inject({
          method: 'GET',
          url: '/api/v1/admin/audit-logs/export.csv',
          headers,
        }),
      ]);

      for (const response of responses) {
        expect([401, 403]).toContain(response.statusCode);
      }
    }

    expect(recordAudit).not.toHaveBeenCalled();
    expect(exportUsers).not.toHaveBeenCalled();
    expect(exportAuditRows).not.toHaveBeenCalled();
  });

  it('still streams the CSV (200) when the audit sink fails', async () => {
    recordAudit.mockImplementationOnce(() => {
      throw new Error('audit sink down');
    });

    const usersResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users/export.csv',
      headers: auth(ADMIN_TOKEN),
    });

    expect(usersResponse.statusCode).toBe(200);
    expect(usersResponse.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(usersResponse.body).toBe(
      'name,email,role,is_active,last_login_at,created_at,sessions_count\r\n' +
        'Bob,bob@acme.test,AGENT,true,2026-11-05T10:00:00.000Z,2026-11-01T10:00:00.000Z,2\r\n',
    );
    // Best effort: the failure is logged (without PII) and the download goes on.
    expect(warn).toHaveBeenCalledWith(
      'admin.export.audit_failed',
      expect.objectContaining({ action: 'admin.users.exported', tenantId: 'tenant-1' }),
    );

    recordAudit.mockImplementationOnce(() => {
      throw new Error('audit sink down');
    });

    const auditResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs/export.csv',
      headers: auth(ADMIN_TOKEN),
    });

    expect(auditResponse.statusCode).toBe(200);
    expect(auditResponse.body).toContain(
      '2026-11-06T12:00:00.000Z,auth.login.success,ana@acme.test,user,',
    );
  });
});
