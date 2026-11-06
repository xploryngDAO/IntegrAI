import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  AuditEventRecord,
  AuditListFilter,
  CreateAuditEventInput,
  IAuditEventRepository,
} from '@sac/shared';

import { mapAuditEvent, toInputJson } from './mappers';

/**
 * Prisma implementation of `IAuditEventRepository`.
 *
 * The table is append-only from the application's point of view: there is no
 * update/delete method, and every write is a single INSERT that `AuditService`
 * fires in the background. Reads are always tenant-scoped by the service.
 */
export class PrismaAuditEventRepository implements IAuditEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateAuditEventInput): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        action: input.action,
        tenantId: input.tenantId,
        actorId: input.actorId,
        actorEmail: input.actorEmail,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        ip: input.ip,
        userAgent: input.userAgent,
        metadata: toInputJson(input.metadata),
      },
    });
  }

  async list(
    filter: AuditListFilter,
  ): Promise<{ items: AuditEventRecord[]; total: number }> {
    const where: Prisma.AuditEventWhereInput = { tenantId: filter.tenantId };
    if (filter.action !== undefined) where.action = filter.action;
    if (filter.actorId !== undefined) where.actorId = filter.actorId;
    if (filter.from !== undefined || filter.to !== undefined) {
      where.createdAt = {
        ...(filter.from !== undefined ? { gte: filter.from } : {}),
        ...(filter.to !== undefined ? { lte: filter.to } : {}),
      };
    }

    const [records, total] = await this.prisma.$transaction([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: filter.offset,
        take: filter.limit,
      }),
      this.prisma.auditEvent.count({ where }),
    ]);

    return { items: records.map(mapAuditEvent), total };
  }
}

export function createAuditEventRepository(
  prisma: PrismaClient,
): PrismaAuditEventRepository {
  return new PrismaAuditEventRepository(prisma);
}
