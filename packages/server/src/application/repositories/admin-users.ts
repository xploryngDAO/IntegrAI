import type { Agent, Prisma, PrismaClient } from '@prisma/client';
import type {
  AdminUserListFilter,
  AdminUserRecord,
  AgentRecord,
  AgentRole,
  IAdminUserRepository,
} from '@sac/shared';

import { mapAgent } from './mappers';

const ADMIN_USER_ORDER: Prisma.AgentOrderByWithRelationInput[] = [
  { createdAt: 'asc' },
  { id: 'asc' },
];

/**
 * Search filter of `GET /admin/users`: `name` OR `email` contains the term.
 *
 * `mode: 'insensitive'` is Prisma/Postgres `ILIKE`, so the comparison is
 * case-insensitive at the database (no rows are filtered in memory). The SAME
 * `where` is used by `count`, keeping `total` aligned with the filtered page.
 */
function adminUserSearchWhere(search: string | undefined): Prisma.AgentWhereInput {
  const term = (search ?? '').trim();
  if (term.length === 0) return {};
  return {
    OR: [
      { name: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
    ],
  };
}

/**
 * Prisma implementation of `IAdminUserRepository`.
 *
 * `listByTenant`/`listFiltered` derive the two counters the console needs
 * without an N+1: one `groupBy` for the live refresh sessions and another for
 * the last session instant (used as "last login"). A page with zero operators
 * short-circuits before querying `sessions` (an empty `IN ()` is wasted work).
 */
export class PrismaAdminUserRepository implements IAdminUserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByTenant(tenantId: string, at: Date): Promise<AdminUserRecord[]> {
    const records = await this.prisma.agent.findMany({
      where: { tenantId },
      orderBy: ADMIN_USER_ORDER,
    });
    return this.hydrate(records, at);
  }

  async listFiltered(
    filter: AdminUserListFilter,
    at: Date,
  ): Promise<{ items: AdminUserRecord[]; total: number }> {
    // Tenant comes first and is never client-controlled; the filters are only
    // added when present so an unfiltered page keeps a minimal `where`.
    const where: Prisma.AgentWhereInput = {
      tenantId: filter.tenantId,
      ...adminUserSearchWhere(filter.search),
      ...(filter.role !== undefined ? { role: filter.role } : {}),
      ...(filter.status !== undefined ? { isActive: filter.status === 'ACTIVE' } : {}),
    };

    const [records, total] = await Promise.all([
      this.prisma.agent.findMany({
        where,
        orderBy: ADMIN_USER_ORDER,
        skip: filter.offset,
        take: filter.limit,
      }),
      // Same `where` as `findMany`: `total` describes the FILTERED set.
      this.prisma.agent.count({ where }),
    ]);

    return { items: await this.hydrate(records, at), total };
  }

  async findById(id: string): Promise<AgentRecord | null> {
    const record = await this.prisma.agent.findUnique({ where: { id } });
    return record !== null ? mapAgent(record) : null;
  }

  async update(
    id: string,
    patch: { role?: AgentRole; isActive?: boolean },
  ): Promise<AgentRecord> {
    const data: Prisma.AgentUpdateInput = {};
    if (patch.role !== undefined) data.role = patch.role;
    if (patch.isActive !== undefined) data.isActive = patch.isActive;

    const record = await this.prisma.agent.update({ where: { id }, data });
    return mapAgent(record);
  }

  async countActiveAdmins(tenantId: string): Promise<number> {
    return this.prisma.agent.count({
      where: { tenantId, role: 'ADMIN', isActive: true },
    });
  }

  /** Agent rows + the two derived counters (two grouped queries, no N+1). */
  private async hydrate(records: Agent[], at: Date): Promise<AdminUserRecord[]> {
    if (records.length === 0) return [];

    const ids = records.map((record) => record.id);
    const [sessionCounts, lastSessions] = await Promise.all([
      this.prisma.session.groupBy({
        by: ['userId'],
        where: { userId: { in: ids }, revokedAt: null, expiresAt: { gt: at } },
        _count: { _all: true },
      }),
      this.prisma.session.groupBy({
        by: ['userId'],
        where: { userId: { in: ids } },
        _max: { createdAt: true },
      }),
    ]);

    const countsByUser = new Map<string, number>(
      sessionCounts.map((row) => [row.userId, row._count._all]),
    );
    const lastLoginByUser = new Map<string, Date>(
      lastSessions
        .filter((row) => row._max.createdAt !== null)
        .map((row) => [row.userId, row._max.createdAt as Date]),
    );

    return records.map((record) => ({
      agent: mapAgent(record),
      sessionsCount: countsByUser.get(record.id) ?? 0,
      lastLoginAt: lastLoginByUser.get(record.id) ?? null,
    }));
  }
}

export function createAdminUserRepository(prisma: PrismaClient): PrismaAdminUserRepository {
  return new PrismaAdminUserRepository(prisma);
}
