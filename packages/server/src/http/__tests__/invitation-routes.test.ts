import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  IAuthService,
  IAuthSessionService,
  IInvitationService,
  ILogger,
} from '@sac/shared';
import { AppError } from '@sac/shared';

import type { HttpRouteContext } from '../types';
import { createAuthControllers } from '../controllers/auth.controller';
import { createInvitationControllers } from '../controllers/invitation.controller';
import { isPublicRoute, requireRole, requireTenantId } from '../middleware/auth';
import { registerErrorHandler } from '../middleware/error-handler';
import { invitationRoutes } from '../routes/invitations.routes';

type Principal = {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string | null;
};

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
  agent?: Principal,
  params?: Record<string, unknown>,
): FastifyRequest {
  return {
    body,
    params: params ?? {},
    headers: {},
    ip: '203.0.113.7',
    ...(agent !== undefined ? { agent } : {}),
  } as unknown as FastifyRequest;
}

const ADMIN: Principal = {
  id: 'agent-1',
  email: 'admin@acme.test',
  name: 'Ana',
  role: 'ADMIN',
  tenantId: 'tenant-1',
};

function buildInvitationControllers(invitations: Partial<IInvitationService>) {
  const ctx = {
    services: { invitations },
    hub: { publisher: { agentPresence: vi.fn() } },
  } as unknown as HttpRouteContext;
  return createInvitationControllers(ctx);
}

function buildAuthControllers(invitations: Partial<IInvitationService>) {
  const ctx = {
    services: {
      auth: {} as IAuthService,
      sessions: {} as IAuthSessionService,
      invitations,
      clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
    },
    hub: { publisher: { agentPresence: vi.fn() } },
  } as unknown as HttpRouteContext;
  return createAuthControllers(ctx);
}

/* ==========================================================================
 * Public allowlist + RBAC
 * ========================================================================== */

describe('invitation routes auth surface', () => {
  it('makes only POST /auth/accept-invitation public', () => {
    expect(isPublicRoute('POST', '/api/v1/auth/accept-invitation')).toBe(true);
    expect(isPublicRoute('POST', '/api/v1/auth/accept-invitation?token=x')).toBe(true);

    expect(isPublicRoute('POST', '/api/v1/invitations')).toBe(false);
    expect(isPublicRoute('GET', '/api/v1/invitations')).toBe(false);
    expect(isPublicRoute('DELETE', '/api/v1/invitations/1')).toBe(false);
  });

  it('requireRole("ADMIN") allows ADMIN and denies AGENT/SUPERVISOR with 403', async () => {
    const guard = requireRole('ADMIN') as unknown as (
      request: FastifyRequest,
    ) => Promise<void>;

    await expect(guard(fakeRequest(null, ADMIN))).resolves.toBeUndefined();

    for (const role of ['AGENT', 'SUPERVISOR']) {
      await expect(
        guard(fakeRequest(null, { ...ADMIN, role })),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_ERROR', httpStatus: 403 });
    }

    await expect(guard(fakeRequest(null))).rejects.toMatchObject({
      code: 'AUTHENTICATION_ERROR',
      httpStatus: 401,
    });
  });

  it('requireTenantId resolves the caller tenant and rejects a tenantless operator', () => {
    expect(requireTenantId(fakeRequest(null, ADMIN))).toBe('tenant-1');

    try {
      requireTenantId(fakeRequest(null, { ...ADMIN, tenantId: null }));
      throw new Error('expected requireTenantId to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: 'AUTHORIZATION_ERROR', httpStatus: 403 });
    }
  });
});

/* ==========================================================================
 * POST /invitations
 * ========================================================================== */

describe('POST /invitations', () => {
  it('answers 201 with the invitation envelope and forwards the ADMIN actor', async () => {
    const create = vi.fn(async (command: Parameters<IInvitationService['create']>[0]) => ({
      invitationId: 'invitation-1',
      email: command.email,
      role: command.role,
      expiresAt: new Date('2026-04-08T09:00:00.000Z'),
    }));
    const controllers = buildInvitationControllers({ create });
    const reply = fakeReply();

    const result = await controllers.create(
      fakeRequest({ email: 'OP@Acme.Test', role: 'SUPERVISOR' }, ADMIN),
      reply,
    );

    expect(reply.statusCode).toBe(201);
    expect(result).toEqual({
      data: {
        invitationId: 'invitation-1',
        email: 'op@acme.test',
        role: 'SUPERVISOR',
        expiresAt: '2026-04-08T09:00:00.000Z',
      },
    });
    expect(create).toHaveBeenCalledWith({
      email: 'op@acme.test',
      role: 'SUPERVISOR',
      actor: { id: 'agent-1', name: 'Ana', tenantId: 'tenant-1' },
    });
  });

  it('rejects an unsupported role or e-mail with 422 before calling the service', async () => {
    const create = vi.fn();
    const controllers = buildInvitationControllers({ create });

    await expect(
      controllers.create(fakeRequest({ email: 'op@acme.test', role: 'OWNER' }, ADMIN), fakeReply()),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
    await expect(
      controllers.create(fakeRequest({ email: 'nope', role: 'AGENT' }, ADMIN), fakeReply()),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a tenantless ADMIN with 403', async () => {
    const create = vi.fn();
    const controllers = buildInvitationControllers({ create });

    await expect(
      controllers.create(
        fakeRequest({ email: 'op@acme.test', role: 'AGENT' }, { ...ADMIN, tenantId: null }),
        fakeReply(),
      ),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_ERROR', httpStatus: 403 });
    expect(create).not.toHaveBeenCalled();
  });

  it('propagates the 409 duplicate e-mail from the service', async () => {
    const create = vi.fn(async () => {
      throw new AppError('CONFLICT', 'An operator with this e-mail already exists', 409);
    });
    const controllers = buildInvitationControllers({ create });

    await expect(
      controllers.create(fakeRequest({ email: 'op@acme.test', role: 'AGENT' }, ADMIN), fakeReply()),
    ).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 });
  });
});

/* ==========================================================================
 * GET /invitations
 * ========================================================================== */

describe('GET /invitations', () => {
  it('lists the caller tenant invitations with status and ISO dates', async () => {
    const list = vi.fn(async (tenantId: string) => {
      expect(tenantId).toBe('tenant-1');
      return [
        {
          id: 'invitation-1',
          email: 'pending@acme.test',
          role: 'AGENT' as const,
          status: 'pending' as const,
          createdAt: new Date('2026-04-01T09:00:00.000Z'),
          expiresAt: new Date('2026-04-08T09:00:00.000Z'),
          acceptedAt: null,
        },
        {
          id: 'invitation-2',
          email: 'accepted@acme.test',
          role: 'SUPERVISOR' as const,
          status: 'accepted' as const,
          createdAt: new Date('2026-03-01T09:00:00.000Z'),
          expiresAt: new Date('2026-03-08T09:00:00.000Z'),
          acceptedAt: new Date('2026-03-02T10:00:00.000Z'),
        },
      ];
    });
    const controllers = buildInvitationControllers({ list });

    const result = await controllers.list(fakeRequest(null, ADMIN), fakeReply());

    expect(result).toEqual({
      data: [
        {
          id: 'invitation-1',
          email: 'pending@acme.test',
          role: 'AGENT',
          status: 'pending',
          createdAt: '2026-04-01T09:00:00.000Z',
          expiresAt: '2026-04-08T09:00:00.000Z',
        },
        {
          id: 'invitation-2',
          email: 'accepted@acme.test',
          role: 'SUPERVISOR',
          status: 'accepted',
          createdAt: '2026-03-01T09:00:00.000Z',
          expiresAt: '2026-03-08T09:00:00.000Z',
        },
      ],
    });
  });
});

/* ==========================================================================
 * DELETE /invitations/:id
 * ========================================================================== */

describe('DELETE /invitations/:id', () => {
  const INVITATION_ID = '0b6d1f7e-2c4a-4c3d-9f3e-2b8a1d5c7e90';

  it('answers 204 and forwards the tenant-scoped id', async () => {
    const revoke = vi.fn(async () => undefined);
    const controllers = buildInvitationControllers({ revoke });
    const reply = fakeReply();

    const result = await controllers.revoke(
      fakeRequest(null, ADMIN, { id: INVITATION_ID }),
      reply,
    );

    expect(reply.statusCode).toBe(204);
    expect(result).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith(INVITATION_ID, 'tenant-1');
  });

  it('rejects a malformed id with 422', async () => {
    const revoke = vi.fn();
    const controllers = buildInvitationControllers({ revoke });

    await expect(
      controllers.revoke(fakeRequest(null, ADMIN, { id: 'not-a-uuid' }), fakeReply()),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('propagates the 404 for an invitation outside the tenant', async () => {
    const revoke = vi.fn(async () => {
      throw new AppError('NOT_FOUND', 'Invitation not found', 404);
    });
    const controllers = buildInvitationControllers({ revoke });

    await expect(
      controllers.revoke(fakeRequest(null, ADMIN, { id: INVITATION_ID }), fakeReply()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });
});

/* ==========================================================================
 * POST /auth/accept-invitation
 * ========================================================================== */

describe('POST /auth/accept-invitation', () => {
  const TOKEN = 'a'.repeat(64);

  it('answers 200 with the access + refresh pair (same shape as login)', async () => {
    const accept = vi.fn(async () => ({
      token: 'header.payload.signature',
      refreshToken: 'd'.repeat(96),
      agent: {
        id: 'agent-2',
        name: 'Novo',
        email: 'op@acme.test',
        role: 'AGENT' as const,
        presence: 'OFFLINE' as const,
        tenantId: 'tenant-1',
      },
    }));
    const controllers = buildAuthControllers({ accept });

    const result = await controllers.acceptInvitation(
      fakeRequest({ token: TOKEN, name: 'Novo', password: 'correct-horse-battery' }),
      fakeReply(),
    );

    expect(accept).toHaveBeenCalledWith(
      { token: TOKEN, name: 'Novo', password: 'correct-horse-battery' },
      { userAgent: null, ip: '203.0.113.7' },
    );
    expect(result).toEqual({
      data: {
        token: 'header.payload.signature',
        refreshToken: 'd'.repeat(96),
        agent: {
          id: 'agent-2',
          name: 'Novo',
          email: 'op@acme.test',
          role: 'AGENT',
          presence: 'OFFLINE',
          tenantId: 'tenant-1',
        },
      },
    });
  });

  it('rejects a password below 12 characters with 422 before calling the service', async () => {
    const accept = vi.fn();
    const controllers = buildAuthControllers({ accept });

    await expect(
      controllers.acceptInvitation(
        fakeRequest({ token: TOKEN, name: 'Novo', password: 'short' }),
        fakeReply(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
    expect(accept).not.toHaveBeenCalled();
  });

  it('propagates the 400 INVALID_INVITATION_TOKEN from the service', async () => {
    const accept = vi.fn(async () => {
      throw new AppError('INVALID_INVITATION_TOKEN', 'Invitation link is invalid', 400);
    });
    const controllers = buildAuthControllers({ accept });

    await expect(
      controllers.acceptInvitation(
        fakeRequest({ token: TOKEN, name: 'Novo', password: 'correct-horse-battery' }),
        fakeReply(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION_TOKEN', httpStatus: 400 });
  });
});

/* ==========================================================================
 * Route wiring: the real plugin + requireRole('ADMIN') preHandler
 * ========================================================================== */

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

describe('invitation route wiring (RBAC enforced by the plugin)', () => {
  const INVITATION_ID = '0b6d1f7e-2c4a-4c3d-9f3e-2b8a1d5c7e90';

  let app: FastifyInstance;
  let create: ReturnType<typeof vi.fn>;
  let list: ReturnType<typeof vi.fn>;
  let revoke: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    create = vi.fn(async () => ({
      invitationId: 'invitation-1',
      email: 'op@acme.test',
      role: 'AGENT' as const,
      expiresAt: new Date('2026-04-08T09:00:00.000Z'),
    }));
    list = vi.fn(async () => []);
    revoke = vi.fn(async () => undefined);

    const ctx = {
      services: { invitations: { create, list, revoke } },
      hub: {},
      options: {},
    } as unknown as HttpRouteContext;

    app = Fastify();
    registerErrorHandler(app, { logger: noopLogger, exposeDetails: true });
    // Stand-in for the global JWT guard: the `x-test-role` header chooses the
    // principal, so the tests exercise the per-route requireRole preHandler.
    app.addHook('preHandler', async (request) => {
      const role = request.headers['x-test-role'];
      if (typeof role === 'string' && role.length > 0) {
        request.agent = {
          id: 'agent-1',
          email: 'admin@acme.test',
          name: 'Ana',
          role,
          tenantId: 'tenant-1',
        };
      }
    });
    await app.register(invitationRoutes, { prefix: '/invitations', ...ctx });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    create.mockClear();
    list.mockClear();
    revoke.mockClear();
  });

  it('requires a JWT for every /invitations route', async () => {
    expect((await app.inject({ method: 'GET', url: '/invitations' })).statusCode).toBe(401);
    expect(
      (await app.inject({
        method: 'POST',
        url: '/invitations',
        payload: { email: 'op@acme.test', role: 'AGENT' },
      })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'DELETE', url: `/invitations/${INVITATION_ID}` })).statusCode,
    ).toBe(401);
  });

  it('lets ADMIN create (201), list (200) and revoke (204)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/invitations',
      headers: { 'x-test-role': 'ADMIN' },
      payload: { email: 'op@acme.test', role: 'AGENT' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      data: {
        invitationId: 'invitation-1',
        email: 'op@acme.test',
        role: 'AGENT',
        expiresAt: '2026-04-08T09:00:00.000Z',
      },
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/invitations',
      headers: { 'x-test-role': 'ADMIN' },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ data: [] });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/invitations/${INVITATION_ID}`,
      headers: { 'x-test-role': 'ADMIN' },
    });
    expect(deleted.statusCode).toBe(204);
    expect(revoke).toHaveBeenCalledWith(INVITATION_ID, 'tenant-1');
  });

  it('answers 403 for AGENT and SUPERVISOR on every /invitations route', async () => {
    for (const role of ['AGENT', 'SUPERVISOR']) {
      const created = await app.inject({
        method: 'POST',
        url: '/invitations',
        headers: { 'x-test-role': role },
        payload: { email: 'op@acme.test', role: 'AGENT' },
      });
      expect(created.statusCode).toBe(403);
      expect(created.json()).toMatchObject({
        error: { code: 'AUTHORIZATION_ERROR' },
      });

      const listed = await app.inject({
        method: 'GET',
        url: '/invitations',
        headers: { 'x-test-role': role },
      });
      expect(listed.statusCode).toBe(403);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/invitations/${INVITATION_ID}`,
        headers: { 'x-test-role': role },
      });
      expect(deleted.statusCode).toBe(403);
    }

    // None of the denied requests reached the service.
    expect(create).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });
});
