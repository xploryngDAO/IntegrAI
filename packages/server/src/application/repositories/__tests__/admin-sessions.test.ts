import { describe, expect, it } from 'vitest';
import type { Agent, PrismaClient, Session } from '../../../generated/prisma/client';

import { PrismaAdminUserRepository } from '../admin-users';

/**
 * `PrismaAdminUserRepository` is where `/admin/sessions` becomes SQL.
 *
 * The schema has no Prisma relation between `sessions` and `agents`, so the
 * "join" is explicit and these tests pin it:
 *
 *  - the tenant's agent ids are read first (tenant is never client-controlled);
 *  - the session `where` carries `revokedAt: null`, `expiresAt > now`, the
 *    tenant id AND only the tenant's operator ids;
 *  - `orderBy` is `lastUsedAt DESC NULLS LAST`, `createdAt DESC`, `id DESC`;
 *  - `findMany` and `count` share the exact same `where`;
 *  - `revokeById` is a conditional `updateMany` (`revokedAt IS NULL`) scoped to
 *    the tenant and returns the revoked row joined with its owner, or `null`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const AT = new Date('2026-11-06T12:00:00.000Z');

function makeAgentRow(overrides: Partial<Agent> = {}): Agent {
  const at = new Date('2026-11-01T12:00:00.000Z');
  return {
    id: overrides.id ?? 'agent-1',
    tenantId: overrides.tenantId !== undefined ? overrides.tenantId : TENANT,
    email: overrides.email ?? 'ana@acme.test',
    name: overrides.name ?? 'Ana Admin',
    passwordHash: overrides.passwordHash ?? 'not-a-real-hash',
    role: overrides.role ?? 'AGENT',
    presence: overrides.presence ?? 'OFFLINE',
    avatarColor: overrides.avatarColor ?? '#2563eb',
    maxConcurrent: overrides.maxConcurrent ?? 20,
    isActive: overrides.isActive ?? true,
    lastSeenAt: overrides.lastSeenAt ?? null,
    emailVerifiedAt: overrides.emailVerifiedAt ?? null,
    twoFactorSecretEnc: overrides.twoFactorSecretEnc ?? null,
    twoFactorEnabled: overrides.twoFactorEnabled ?? false,
    isPlatformAdmin: overrides.isPlatformAdmin ?? false,
    mustResetPassword: overrides.mustResetPassword ?? false,
    createdAt: overrides.createdAt ?? at,
    updatedAt: overrides.updatedAt ?? at,
  };
}

function makeSessionRow(overrides: Partial<Session> = {}): Session {
  const at = new Date('2026-11-05T12:00:00.000Z');
  return {
    id: overrides.id ?? 'session-1',
    userId: overrides.userId ?? 'agent-1',
    tenantId: overrides.tenantId ?? TENANT,
    refreshTokenHash: overrides.refreshTokenHash ?? 'hash-1',
    userAgent: overrides.userAgent ?? null,
    ip: overrides.ip ?? null,
    expiresAt: overrides.expiresAt ?? new Date('2026-12-05T12:00:00.000Z'),
    revokedAt: overrides.revokedAt ?? null,
    lastUsedAt: overrides.lastUsedAt ?? null,
    createdAt: overrides.createdAt ?? at,
  };
}

interface QueryArgs {
  where?: Record<string, unknown>;
  orderBy?: unknown;
  skip?: number;
  take?: number;
  data?: Record<string, unknown>;
}

function createHarness(
  options: {
    agents?: Agent[];
    sessions?: Session[];
    total?: number;
    revokeCount?: number;
  } = {},
) {
  const agents = options.agents ?? [makeAgentRow()];
  const sessions = options.sessions ?? [makeSessionRow()];
  const total = options.total ?? sessions.length;
  const agentFindManyCalls: QueryArgs[] = [];
  const agentFindFirstCalls: QueryArgs[] = [];
  const sessionFindManyCalls: QueryArgs[] = [];
  const sessionFindFirstCalls: QueryArgs[] = [];
  const sessionCountCalls: QueryArgs[] = [];
  const sessionUpdateManyCalls: QueryArgs[] = [];

  const prisma = {
    agent: {
      findMany: async (args: QueryArgs): Promise<Agent[]> => {
        agentFindManyCalls.push(args);
        return agents;
      },
      findFirst: async (args: QueryArgs): Promise<Agent | null> => {
        agentFindFirstCalls.push(args);
        return (
          agents.find(
            (row) =>
              row.id === args.where?.id &&
              row.tenantId === (args.where as { tenantId?: string }).tenantId,
          ) ?? null
        );
      },
    },
    session: {
      findMany: async (args: QueryArgs): Promise<Session[]> => {
        sessionFindManyCalls.push(args);
        return sessions;
      },
      count: async (args: QueryArgs): Promise<number> => {
        sessionCountCalls.push(args);
        return total;
      },
      findFirst: async (args: QueryArgs): Promise<Session | null> => {
        sessionFindFirstCalls.push(args);
        return (
          sessions.find(
            (row) =>
              row.id === args.where?.id &&
              row.tenantId === (args.where as { tenantId?: string }).tenantId,
          ) ?? null
        );
      },
      updateMany: async (args: QueryArgs): Promise<{ count: number }> => {
        sessionUpdateManyCalls.push(args);
        return { count: options.revokeCount ?? 1 };
      },
    },
  } as unknown as PrismaClient;

  return {
    repository: new PrismaAdminUserRepository(prisma),
    agentFindManyCalls,
    agentFindFirstCalls,
    sessionFindManyCalls,
    sessionFindFirstCalls,
    sessionCountCalls,
    sessionUpdateManyCalls,
    agents,
    sessions,
  };
}

describe('PrismaAdminUserRepository.listAtivasByTenant', () => {
  it('joins the tenant agents with the live sessions and paginates deterministically', async () => {
    const agents = [
      makeAgentRow({ id: 'agent-1', email: 'ana@acme.test', name: 'Ana' }),
      makeAgentRow({ id: 'agent-2', email: 'bob@acme.test', name: 'Bob', role: 'SUPERVISOR' }),
    ];
    const h = createHarness({
      agents,
      sessions: [makeSessionRow({ id: 'session-1', userId: 'agent-1' })],
      total: 7,
    });

    const result = await h.repository.listAtivasByTenant(
      { tenantId: TENANT, offset: 50, limit: 25 },
      AT,
    );

    expect(h.agentFindManyCalls[0]).toEqual({ where: { tenantId: TENANT } });

    const where = {
      userId: { in: ['agent-1', 'agent-2'] },
      tenantId: TENANT,
      revokedAt: null,
      expiresAt: { gt: AT },
    };
    expect(h.sessionFindManyCalls[0]).toMatchObject({
      where,
      orderBy: [
        { lastUsedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      skip: 50,
      take: 25,
    });
    expect(h.sessionCountCalls[0]?.where).toEqual(where);
    expect(result.total).toBe(7);
    expect(result.items).toEqual([
      {
        session: expect.objectContaining({ id: 'session-1', userId: 'agent-1' }),
        agent: expect.objectContaining({
          id: 'agent-1',
          email: 'ana@acme.test',
          name: 'Ana',
        }),
      },
    ]);
  });

  it('short-circuits without touching the session table when the tenant has no agents', async () => {
    const h = createHarness({ agents: [], sessions: [], total: 0 });

    const result = await h.repository.listAtivasByTenant(
      { tenantId: OTHER_TENANT, offset: 0, limit: 50 },
      AT,
    );

    expect(result).toEqual({ items: [], total: 0 });
    expect(h.sessionFindManyCalls).toHaveLength(0);
    expect(h.sessionCountCalls).toHaveLength(0);
  });
});

describe('PrismaAdminUserRepository.revokeById', () => {
  it('conditionally revokes one live tenant session and returns it with its owner', async () => {
    const h = createHarness({
      agents: [makeAgentRow({ id: 'agent-2', email: 'bob@acme.test' })],
      sessions: [makeSessionRow({ id: 'session-target', userId: 'agent-2' })],
    });

    const result = await h.repository.revokeById(TENANT, 'session-target', AT);

    expect(h.sessionFindFirstCalls[0]).toEqual({
      where: { id: 'session-target', tenantId: TENANT, expiresAt: { gt: AT } },
    });
    expect(h.agentFindFirstCalls[0]).toEqual({
      where: { id: 'agent-2', tenantId: TENANT },
    });
    expect(h.sessionUpdateManyCalls[0]).toEqual({
      where: {
        id: 'session-target',
        tenantId: TENANT,
        revokedAt: null,
        expiresAt: { gt: AT },
      },
      data: { revokedAt: AT },
    });
    expect(result).toMatchObject({
      session: { id: 'session-target', revokedAt: AT },
      agent: { id: 'agent-2', email: 'bob@acme.test' },
    });
  });

  it('answers null for an unknown/cross-tenant id without writing', async () => {
    const h = createHarness({ sessions: [] });

    await expect(h.repository.revokeById(TENANT, 'session-missing', AT)).resolves.toBeNull();
    expect(h.sessionUpdateManyCalls).toHaveLength(0);
  });

  it('answers null when the conditional update loses the race', async () => {
    const h = createHarness({
      agents: [makeAgentRow({ id: 'agent-2' })],
      sessions: [makeSessionRow({ id: 'session-target', userId: 'agent-2' })],
      revokeCount: 0,
    });

    await expect(h.repository.revokeById(TENANT, 'session-target', AT)).resolves.toBeNull();
    expect(h.sessionUpdateManyCalls).toHaveLength(1);
  });
});
