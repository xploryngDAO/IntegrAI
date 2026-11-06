import type { PrismaClient } from '@prisma/client';
import { MARKETPLACES, OPEN_TICKET_STATUSES } from '@sac/shared';
import type {
  IPlatformRepository,
  Marketplace,
  PlatformMetricsRecord,
  TenantUsageCounts,
} from '@sac/shared';

/**
 * Prisma implementation of the Fase 4 cross-tenant aggregates.
 *
 * The platform console and the plan-limit gate only need COUNTS, so everything
 * here is a `groupBy`/`count` - no business row is ever loaded into memory.
 */
export class PrismaPlatformRepository implements IPlatformRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async usageFor(tenantIds: string[]): Promise<Record<string, TenantUsageCounts>> {
    const unique = [...new Set(tenantIds.filter((id) => typeof id === 'string' && id.length > 0))];
    const usage: Record<string, TenantUsageCounts> = {};
    for (const id of unique) usage[id] = { accounts: 0, agents: 0, tickets: 0 };
    if (unique.length === 0) return usage;

    const [accounts, agents, tickets] = await Promise.all([
      this.prisma.marketplaceAccount.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: unique } },
        _count: { _all: true },
      }),
      this.prisma.agent.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: unique } },
        _count: { _all: true },
      }),
      this.prisma.supportTicket.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: unique } },
        _count: { _all: true },
      }),
    ]);

    for (const row of accounts) {
      if (row.tenantId !== null) usage[row.tenantId].accounts = row._count._all;
    }
    for (const row of agents) {
      if (row.tenantId !== null) usage[row.tenantId].agents = row._count._all;
    }
    for (const row of tickets) {
      if (row.tenantId !== null) usage[row.tenantId].tickets = row._count._all;
    }

    return usage;
  }

  async metrics(input: {
    messagesSince: Date;
    slaHorizon: Date;
  }): Promise<PlatformMetricsRecord> {
    const openStatuses = [...OPEN_TICKET_STATUSES];

    const [totalTenants, activeTenants, accountsByMarketplace, openTickets, messagesLast24h, slaAtRisk] =
      await Promise.all([
        this.prisma.tenant.count(),
        this.prisma.tenant.count({ where: { status: 'ACTIVE', deletedAt: null } }),
        this.prisma.marketplaceAccount.groupBy({
          by: ['marketplace'],
          _count: { _all: true },
        }),
        this.prisma.supportTicket.count({ where: { status: { in: openStatuses } } }),
        this.prisma.ticketMessage.count({ where: { createdAt: { gte: input.messagesSince } } }),
        // "At risk": still open, not yet marked breached, and the deadline is
        // already inside the warning horizon (overdue rows included so a stale
        // SLA scan does not hide urgent work).
        this.prisma.supportTicket.count({
          where: {
            status: { in: openStatuses },
            slaBreached: false,
            slaDeadlineAt: { lte: input.slaHorizon },
          },
        }),
      ]);

    const byMarketplace = Object.fromEntries(
      MARKETPLACES.map((marketplace) => [marketplace, 0]),
    ) as Record<Marketplace, number>;
    for (const row of accountsByMarketplace) {
      byMarketplace[row.marketplace] = row._count._all;
    }

    return {
      totalTenants,
      activeTenants,
      accountsByMarketplace: byMarketplace,
      openTickets,
      messagesLast24h,
      slaAtRisk,
    };
  }
}

export function createPlatformRepository(prisma: PrismaClient): PrismaPlatformRepository {
  return new PrismaPlatformRepository(prisma);
}
