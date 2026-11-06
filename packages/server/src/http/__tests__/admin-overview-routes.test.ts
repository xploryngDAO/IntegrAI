import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AuthenticationError } from '@sac/shared';

import { AdminUserService } from '../../application/AdminUserService';
import { InMemoryCache } from '../../application/__tests__/accountFakes';
import {
  InMemoryAdminUserRepository,
  RecordingAuditService,
} from '../../application/__tests__/adminFakes';
import { InMemorySessionRepository } from '../../application/__tests__/authFakes';
import { buildTestApp, noopLogger } from './http-test-harness';

/**
 * HTTP contract of `GET /api/v1/admin/overview`.
 *
 * These tests build the REAL admin service on top of the in-memory admin
 * repository and drive it through the real Fastify graph (`app.inject`), so the
 * whole chain is exercised: global JWT guard -> `requireRole('ADMIN')` ->
 * controller -> `AdminUserService.overview` -> tenant-scoped aggregation.
 *
 * Covered:
 *  - 401 without a bearer token and 403 for AGENT/SUPERVISOR/tenantless ADMIN;
 *  - exact counters for two populated workspaces (cross-tenant isolation);
 *  - zero-filled shape (including the three marketplaces) for an empty one;
 *  - account/ticket enum semantics (connected = ACTIVE only; unread = UNREAD;
 *    unassigned excludes the terminal statuses).
 */

const NOW = new Date('2026-11-06T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;

const TENANT_1 = '11111111-1111-4111-8111-111111111111';
const TENANT_2 = '22222222-2222-4222-8222-222222222222';
const TENANT_3 = '33333333-3333-4333-8333-333333333333';

const ADMIN_TOKEN = 'token-admin-1';
const ADMIN_TWO_TOKEN = 'token-admin-2';
const ADMIN_EMPTY_TOKEN = 'token-admin-empty';
const AGENT_TOKEN = 'token-agent';
const SUPERVISOR_TOKEN = 'token-supervisor';
const TENANTLESS_ADMIN_TOKEN = 'token-tenantless-admin';

const PRINCIPALS: Record<string, Record<string, unknown>> = {
  [ADMIN_TOKEN]: {
    agentId: 'admin-1',
    email: 'admin1@acme.test',
    name: 'Ana',
    role: 'ADMIN',
    tenantId: TENANT_1,
    isPlatformAdmin: false,
  },
  [ADMIN_TWO_TOKEN]: {
    agentId: 'admin-2',
    email: 'admin2@beta.test',
    name: 'Bia',
    role: 'ADMIN',
    tenantId: TENANT_2,
    isPlatformAdmin: false,
  },
  [ADMIN_EMPTY_TOKEN]: {
    agentId: 'admin-3',
    email: 'admin3@empty.test',
    name: 'Eva',
    role: 'ADMIN',
    tenantId: TENANT_3,
    isPlatformAdmin: false,
  },
  [AGENT_TOKEN]: {
    agentId: 'agent-2',
    email: 'agent@acme.test',
    name: 'Bob',
    role: 'AGENT',
    tenantId: TENANT_1,
    isPlatformAdmin: false,
  },
  [SUPERVISOR_TOKEN]: {
    agentId: 'sup-1',
    email: 'sup@acme.test',
    name: 'Sara',
    role: 'SUPERVISOR',
    tenantId: TENANT_1,
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

const verifyToken = vi.fn(async (token: string) => {
  const principal = PRINCIPALS[token];
  if (principal === undefined) throw new AuthenticationError('Invalid token');
  return principal as never;
});

function createApp(
  seed?: (repository: InMemoryAdminUserRepository) => void,
): Promise<FastifyInstance> {
  const clock = { now: (): Date => new Date(NOW.getTime()) };
  const repository = new InMemoryAdminUserRepository(clock);
  seed?.(repository);

  const service = new AdminUserService({
    logger: noopLogger,
    clock,
    cache: new InMemoryCache(),
    audit: new RecordingAuditService(),
    repos: {
      adminUsers: repository,
      sessions: new InMemorySessionRepository(clock),
    },
  });

  return buildTestApp({
    services: {
      agents: { verifyToken },
      adminUsers: service,
    },
  });
}

/** Two populated workspaces: every counter of tenant-1 differs from tenant-2. */
function seedPopulatedWorkspace(repository: InMemoryAdminUserRepository): void {
  repository.seed({ id: 'admin-1', tenantId: TENANT_1, role: 'ADMIN', isActive: true });
  repository.seed({ id: 'agent-2', tenantId: TENANT_1, role: 'AGENT', isActive: true });
  repository.seed({ id: 'agent-3', tenantId: TENANT_1, role: 'AGENT', isActive: false });

  repository.seed({ id: 'admin-2', tenantId: TENANT_2, role: 'ADMIN', isActive: true });
  repository.seed({ id: 'agent-4', tenantId: TENANT_2, role: 'AGENT', isActive: true });

  // tenant-1: 2 live, 1 revoked, 1 expired -> active = 2.
  repository.seedSession('agent-2', {
    id: 'session-1',
    expiresAt: new Date(NOW.getTime() + DAY_MS),
  });
  repository.seedSession('admin-1', {
    id: 'session-2',
    expiresAt: new Date(NOW.getTime() + 2 * 60 * 60 * 1_000),
  });
  repository.seedSession('agent-2', {
    id: 'session-3',
    revokedAt: new Date(NOW.getTime() - 60 * 60 * 1_000),
    expiresAt: new Date(NOW.getTime() + DAY_MS),
  });
  repository.seedSession('agent-3', {
    id: 'session-4',
    expiresAt: new Date(NOW.getTime() - 60 * 60 * 1_000),
  });
  // tenant-2: 1 live -> excluded from tenant-1.
  repository.seedSession('admin-2', {
    id: 'session-5',
    expiresAt: new Date(NOW.getTime() + DAY_MS),
  });

  // tenant-1: 2 pending, 1 accepted, 1 expired -> pending = 2.
  repository.seedInvitation({
    tenantId: TENANT_1,
    acceptedAt: null,
    expiresAt: new Date(NOW.getTime() + DAY_MS),
  });
  repository.seedInvitation({
    tenantId: TENANT_1,
    acceptedAt: null,
    expiresAt: new Date(NOW.getTime() + 2 * DAY_MS),
  });
  repository.seedInvitation({
    tenantId: TENANT_1,
    acceptedAt: new Date(NOW.getTime() - 60 * 60 * 1_000),
    expiresAt: new Date(NOW.getTime() + DAY_MS),
  });
  repository.seedInvitation({
    tenantId: TENANT_1,
    acceptedAt: null,
    expiresAt: new Date(NOW.getTime() - 60 * 60 * 1_000),
  });
  repository.seedInvitation({
    tenantId: TENANT_2,
    acceptedAt: null,
    expiresAt: new Date(NOW.getTime() + DAY_MS),
  });

  // tenant-1: 4 accounts (2 ACTIVE) spread over all three marketplaces.
  repository.seedAccount({ tenantId: TENANT_1, marketplace: 'AMAZON', status: 'ACTIVE' });
  repository.seedAccount({ tenantId: TENANT_1, marketplace: 'AMAZON', status: 'ACTIVE' });
  repository.seedAccount({
    tenantId: TENANT_1,
    marketplace: 'MERCADO_LIVRE',
    status: 'TOKEN_EXPIRED',
  });
  repository.seedAccount({ tenantId: TENANT_1, marketplace: 'SHOPEE', status: 'DISCONNECTED' });
  // tenant-2: 2 accounts (both ACTIVE), different marketplace mix.
  repository.seedAccount({ tenantId: TENANT_2, marketplace: 'AMAZON', status: 'ACTIVE' });
  repository.seedAccount({ tenantId: TENANT_2, marketplace: 'SHOPEE', status: 'ACTIVE' });

  // tenant-1: 7 tickets -> 2 UNREAD, 3 unassigned non-terminal.
  const tickets = [
    { status: 'UNREAD', assignedAgentId: null },
    { status: 'UNREAD', assignedAgentId: 'agent-2' },
    { status: 'RESOLVED', assignedAgentId: null },
    { status: 'NO_RESPONSE_NEEDED', assignedAgentId: null },
    { status: 'OPEN_WAITING_AGENT', assignedAgentId: null },
    { status: 'WAITING_BUYER', assignedAgentId: 'agent-2' },
    { status: 'MEDIATION', assignedAgentId: null },
  ] as const;
  for (const ticket of tickets) {
    repository.seedTicket({ tenantId: TENANT_1, ...ticket });
  }
  repository.seedTicket({
    tenantId: TENANT_2,
    status: 'UNREAD',
    assignedAgentId: null,
  });
  repository.seedTicket({
    tenantId: TENANT_2,
    status: 'RESOLVED',
    assignedAgentId: null,
  });

  // tenant-1: 2 rows inside the rolling window (one exactly at the boundary).
  repository.seedAuditEvent({
    tenantId: TENANT_1,
    createdAt: new Date(NOW.getTime() - 60 * 60 * 1_000),
  });
  repository.seedAuditEvent({
    tenantId: TENANT_1,
    createdAt: new Date(NOW.getTime() - DAY_MS),
  });
  repository.seedAuditEvent({
    tenantId: TENANT_1,
    createdAt: new Date(NOW.getTime() - DAY_MS - 60 * 60 * 1_000),
  });
  repository.seedAuditEvent({
    tenantId: TENANT_2,
    createdAt: new Date(NOW.getTime() - 60 * 60 * 1_000),
  });
}

const EMPTY_OVERVIEW = {
  users: { total: 0, active: 0, admins: 0 },
  sessions: { active: 0 },
  invitations: { pending: 0 },
  accounts: {
    total: 0,
    connected: 0,
    byMarketplace: { AMAZON: 0, MERCADO_LIVRE: 0, SHOPEE: 0 },
  },
  tickets: { total: 0, unread: 0, unassigned: 0 },
  audit: { last24h: 0 },
};

describe('GET /api/v1/admin/overview', () => {
  const apps: FastifyInstance[] = [];

  async function appFor(seed?: (repository: InMemoryAdminUserRepository) => void) {
    const app = await createApp(seed);
    apps.push(app);
    return app;
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  it('answers 401 without a bearer token', async () => {
    const app = await appFor();

    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/overview' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'AUTHENTICATION_ERROR' } });
  });

  it('answers 403 for AGENT and SUPERVISOR', async () => {
    const app = await appFor();

    for (const token of [AGENT_TOKEN, SUPERVISOR_TOKEN]) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/overview',
        headers: auth(token),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_ERROR' } });
    }
  });

  it('answers 403 for a platform ADMIN without a workspace', async () => {
    const app = await appFor();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: auth(TENANTLESS_ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_ERROR' } });
  });

  it('returns the exact tenant-1 counters and ignores a client-supplied tenant', async () => {
    const app = await appFor(seedPopulatedWorkspace);

    // The extra query string is not a contract field: the tenant comes ONLY
    // from the JWT, so it must not change the answer.
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/overview?tenantId=${TENANT_2}`,
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        users: { total: 3, active: 2, admins: 1 },
        sessions: { active: 2 },
        invitations: { pending: 2 },
        accounts: {
          total: 4,
          connected: 2,
          byMarketplace: { AMAZON: 2, MERCADO_LIVRE: 1, SHOPEE: 1 },
        },
        tickets: { total: 7, unread: 2, unassigned: 3 },
        audit: { last24h: 2 },
      },
    });
  });

  it('returns ONLY tenant-2 numbers when the caller belongs to tenant-2', async () => {
    const app = await appFor(seedPopulatedWorkspace);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: auth(ADMIN_TWO_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        users: { total: 2, active: 2, admins: 1 },
        sessions: { active: 1 },
        invitations: { pending: 1 },
        accounts: {
          total: 2,
          connected: 2,
          byMarketplace: { AMAZON: 1, MERCADO_LIVRE: 0, SHOPEE: 1 },
        },
        tickets: { total: 2, unread: 1, unassigned: 1 },
        audit: { last24h: 1 },
      },
    });
  });

  it('returns the zero-filled shape for an empty workspace', async () => {
    const app = await appFor();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: auth(ADMIN_EMPTY_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: EMPTY_OVERVIEW });
  });

  it('counts every account in total/byMarketplace but only ACTIVE as connected', async () => {
    const app = await appFor((repository) => {
      repository.seed({ id: 'admin-1', tenantId: TENANT_1, role: 'ADMIN' });
      repository.seedAccount({ tenantId: TENANT_1, marketplace: 'AMAZON', status: 'ACTIVE' });
      repository.seedAccount({
        tenantId: TENANT_1,
        marketplace: 'AMAZON',
        status: 'TOKEN_EXPIRED',
      });
      repository.seedAccount({
        tenantId: TENANT_1,
        marketplace: 'MERCADO_LIVRE',
        status: 'ACTIVE',
      });
      repository.seedAccount({
        tenantId: TENANT_1,
        marketplace: 'SHOPEE',
        status: 'DISCONNECTED',
      });
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        accounts: {
          total: 4,
          connected: 2,
          byMarketplace: { AMAZON: 2, MERCADO_LIVRE: 1, SHOPEE: 1 },
        },
      },
    });
  });

  it('counts UNREAD tickets and excludes terminal statuses from unassigned', async () => {
    const app = await appFor((repository) => {
      repository.seed({ id: 'admin-1', tenantId: TENANT_1, role: 'ADMIN' });
      repository.seedTicket({ tenantId: TENANT_1, status: 'UNREAD', assignedAgentId: null });
      repository.seedTicket({
        tenantId: TENANT_1,
        status: 'UNREAD',
        assignedAgentId: 'agent-2',
      });
      // Terminal statuses: never part of the unassigned backlog.
      repository.seedTicket({ tenantId: TENANT_1, status: 'RESOLVED', assignedAgentId: null });
      repository.seedTicket({
        tenantId: TENANT_1,
        status: 'NO_RESPONSE_NEEDED',
        assignedAgentId: null,
      });
      // Non-terminal and unassigned: counted.
      repository.seedTicket({
        tenantId: TENANT_1,
        status: 'OPEN_WAITING_AGENT',
        assignedAgentId: null,
      });
      repository.seedTicket({ tenantId: TENANT_1, status: 'MEDIATION', assignedAgentId: null });
      // Non-terminal but assigned: not counted.
      repository.seedTicket({
        tenantId: TENANT_1,
        status: 'WAITING_BUYER',
        assignedAgentId: 'agent-2',
      });
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: auth(ADMIN_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        tickets: { total: 7, unread: 2, unassigned: 3 },
      },
    });
  });
});
