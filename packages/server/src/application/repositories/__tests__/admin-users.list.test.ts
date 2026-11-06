import { describe, expect, it } from 'vitest';
import type { Agent, PrismaClient } from '@prisma/client';

import { PrismaAdminUserRepository } from '../admin-users';

/**
 * `PrismaAdminUserRepository.listFiltered` is where the `/admin/users` filters
 * become SQL. The tests pin:
 *
 *  - `tenantId` is ALWAYS present and first (never client-controlled);
 *  - `search` compiles to `name` OR `email` with a case-insensitive `contains`;
 *  - `role`/`status` become `role`/`isActive` and are combined with the search;
 *  - `findMany` and `count` receive the SAME `where` (`total` is filtered);
 *  - `orderBy` is `createdAt` asc + `id` asc and `skip`/`take` come from the
 *    service (already clamped);
 *  - the two counters are derived with one `groupBy` per concern (no N+1) and
 *    skipped entirely for an empty page.
 *
 * The Prisma client is a recording stub: no database is required.
 */

interface AgentQueryArgs {
  where?: Record<string, unknown>;
  orderBy?: unknown;
  skip?: number;
  take?: number;
}

interface SessionGroupArgs {
  by?: unknown;
  where?: Record<string, unknown>;
  _count?: unknown;
  _max?: unknown;
}

const TENANT = '11111111-1111-4111-8111-111111111111';

function makeAgentRow(overrides: Partial<Agent> = {}): Agent {
  const at = new Date('2026-11-01T12:00:00.000Z');
  return {
    id: overrides.id ?? '22222222-2222-4222-8222-222222222222',
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

function createHarness(options: { rows?: Agent[]; total?: number } = {}) {
  const rows = options.rows ?? [makeAgentRow()];
  const total = options.total ?? rows.length;
  const findManyCalls: AgentQueryArgs[] = [];
  const countCalls: AgentQueryArgs[] = [];
  const groupByCalls: SessionGroupArgs[] = [];
  const sessionCounts = new Map<string, number>();
  const lastLoginAt = new Map<string, Date>();

  const prisma = {
    agent: {
      findMany: async (args: AgentQueryArgs): Promise<Agent[]> => {
        findManyCalls.push(args);
        const skip = args.skip ?? 0;
        const take = args.take ?? rows.length;
        return rows.slice(skip, skip + take);
      },
      count: async (args: AgentQueryArgs): Promise<number> => {
        countCalls.push(args);
        return total;
      },
    },
    session: {
      groupBy: async (args: SessionGroupArgs) => {
        groupByCalls.push(args);
        const ids = ((args.where?.userId as { in?: string[] } | undefined)?.in ?? []) as string[];
        if (args._count !== undefined) {
          return ids
            .filter((id) => sessionCounts.has(id))
            .map((id) => ({ userId: id, _count: { _all: sessionCounts.get(id) } }));
        }
        return ids
          .filter((id) => lastLoginAt.has(id))
          .map((id) => ({ userId: id, _max: { createdAt: lastLoginAt.get(id) } }));
      },
    },
  } as unknown as PrismaClient;

  return {
    repository: new PrismaAdminUserRepository(prisma),
    findManyCalls,
    countCalls,
    groupByCalls,
    sessionCounts,
    lastLoginAt,
    rows,
  };
}

const AT = new Date('2026-11-06T12:00:00.000Z');

describe('PrismaAdminUserRepository.listFiltered', () => {
  it('scopes by tenant, orders deterministically and applies skip/take', async () => {
    const h = createHarness({ total: 7 });

    const result = await h.repository.listFiltered(
      { tenantId: TENANT, offset: 50, limit: 25 },
      AT,
    );

    expect(h.findManyCalls[0]).toMatchObject({
      where: { tenantId: TENANT },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: 50,
      take: 25,
    });
    expect(h.countCalls[0]?.where).toEqual({ tenantId: TENANT });
    expect(result.total).toBe(7);
  });

  it('combines search (name OR email, insensitive), role and INACTIVE status on findMany AND count', async () => {
    const h = createHarness({ total: 3 });

    await h.repository.listFiltered(
      {
        tenantId: TENANT,
        search: '  ACME ',
        role: 'AGENT',
        status: 'INACTIVE',
        offset: 0,
        limit: 100,
      },
      AT,
    );

    const expectedWhere = {
      tenantId: TENANT,
      OR: [
        { name: { contains: 'ACME', mode: 'insensitive' } },
        { email: { contains: 'ACME', mode: 'insensitive' } },
      ],
      role: 'AGENT',
      isActive: false,
    };
    expect(h.findManyCalls[0]?.where).toEqual(expectedWhere);
    expect(h.countCalls[0]?.where).toEqual(expectedWhere);
  });

  it('maps ACTIVE to isActive: true and treats a blank search as absent', async () => {
    const h = createHarness();

    await h.repository.listFiltered(
      { tenantId: TENANT, status: 'ACTIVE', offset: 0, limit: 25 },
      AT,
    );
    await h.repository.listFiltered(
      { tenantId: TENANT, search: '   ', offset: 0, limit: 25 },
      AT,
    );

    expect(h.findManyCalls[0]?.where).toEqual({
      tenantId: TENANT,
      isActive: true,
    });
    expect(h.findManyCalls[1]?.where).toEqual({ tenantId: TENANT });
  });

  it('derives sessionsCount/lastLoginAt with two grouped queries scoped to the page ids', async () => {
    const rows = [
      makeAgentRow({ id: 'agent-1' }),
      makeAgentRow({ id: 'agent-2' }),
    ];
    const h = createHarness({ rows });
    h.sessionCounts.set('agent-1', 4);
    h.lastLoginAt.set('agent-1', new Date('2026-11-05T10:00:00.000Z'));

    const result = await h.repository.listFiltered(
      { tenantId: TENANT, offset: 0, limit: 25 },
      AT,
    );

    expect(result.items).toEqual([
      {
        agent: expect.objectContaining({ id: 'agent-1' }),
        sessionsCount: 4,
        lastLoginAt: new Date('2026-11-05T10:00:00.000Z'),
      },
      {
        agent: expect.objectContaining({ id: 'agent-2' }),
        sessionsCount: 0,
        lastLoginAt: null,
      },
    ]);
    expect(h.groupByCalls).toHaveLength(2);
    for (const call of h.groupByCalls) {
      expect((call.where?.userId as { in: string[] }).in).toEqual(['agent-1', 'agent-2']);
    }
  });

  it('skips the session queries for an empty page', async () => {
    const h = createHarness({ rows: [], total: 0 });

    const result = await h.repository.listFiltered(
      { tenantId: TENANT, search: 'ghost', offset: 0, limit: 25 },
      AT,
    );

    expect(result).toEqual({ items: [], total: 0 });
    expect(h.groupByCalls).toHaveLength(0);
  });
});
