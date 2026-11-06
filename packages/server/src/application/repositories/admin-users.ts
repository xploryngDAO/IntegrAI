import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  AdminUserRecord,
  AgentRecord,
  AgentRole,
  IAdminUserRepository,
} from '@sac/shared';

import { mapAgent } from './mappers';

/**
 * Prisma implementation of `IAdminUserRepository`.
 *
 * `listByTenant` derives the two counters the console needs without an N+1:
 * one `groupBy` for the live refresh sessions and another for the last session
 * instant (used as "last login"). A workspace with zero operators short-circuits
 * before querying `sessions` (an empty `IN ()` is wasted work).
 */
export class PrismaAdminUserRepository implements IAdminUserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByTenant(tenantId: string, at: Date): Promise<AdminUserRecord[]> {
    const records = await this.prisma.agent.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
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
}

export function createAdminUserRepository(prisma: PrismaClient): PrismaAdminUserRepository {
  return new PrismaAdminUserRepository(prisma);
}
