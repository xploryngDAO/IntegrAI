import type { PrismaClient } from '../../generated/prisma/client';
import { MARKETPLACES, OPEN_TICKET_STATUSES, TICKET_STATUSES } from '@sac/shared';
import type {
  IPlatformRepository,
  Marketplace,
  PlatformAlertAccountRecord,
  PlatformAlertQuery,
  PlatformAlertSnapshot,
  PlatformAlertTenantRecord,
  PlatformBillingPlanCount,
  PlatformMetricsRecord,
  TenantMetricsQuery,
  TenantMetricsRecord,
  TenantUsageCounts,
  TicketStatus,
} from '@sac/shared';

/**
 * Prisma implementation of the Fase 4 cross-tenant aggregates.
 *
 * The platform console and the plan-limit gate only need COUNTS, so everything
 * here is a `groupBy`/`count` - no business row is ever loaded into memory. The
 * two exceptions are deliberate: the 14-day ticket series and the average first
 * response are computed by Postgres (`$queryRaw`), still scoped by `tenant_id`.
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
      // `BILLING` only exists in `webhook_events` (billing audit); a marketplace
      // account can never have it. Skip defensively so the channel map stays
      // typed by the three real marketplaces.
      if (row.marketplace === 'BILLING') continue;
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

  /* ==================================================================== */
  /* Per-tenant metrics (Fase 4)                                          */
  /* ==================================================================== */

  async tenantMetrics(
    tenantId: string,
    input: TenantMetricsQuery,
  ): Promise<TenantMetricsRecord> {
    const openStatuses = [...OPEN_TICKET_STATUSES];

    const [accounts, agents, statusGroups, slaAtRisk, slaBreached, messagesLast7d, avgRows, dayRows] =
      await Promise.all([
        this.prisma.marketplaceAccount.count({ where: { tenantId } }),
        this.prisma.agent.count({ where: { tenantId } }),
        this.prisma.supportTicket.groupBy({
          by: ['status'],
          where: { tenantId },
          _count: { _all: true },
        }),
        // Same definition as the global metric, but scoped to this workspace.
        this.prisma.supportTicket.count({
          where: {
            tenantId,
            status: { in: openStatuses },
            slaBreached: false,
            slaDeadlineAt: { lte: input.slaHorizon },
          },
        }),
        this.prisma.supportTicket.count({ where: { tenantId, slaBreached: true } }),
        // TicketMessage has no tenant_id; scope it through the ticket relation.
        this.prisma.ticketMessage.count({
          where: { createdAt: { gte: input.messagesSince }, ticket: { tenantId } },
        }),
        this.prisma.$queryRaw<Array<{ avg_first_response_minutes: number | null }>>`
          SELECT
            AVG(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60)::float8
              AS avg_first_response_minutes
          FROM support_tickets
          WHERE tenant_id = ${tenantId}::uuid
            AND first_response_at IS NOT NULL
        `,
        // Calendar-day buckets (UTC) for the 14-day chart. The service
        // zero-fills the days without tickets and guarantees 14 entries.
        this.prisma.$queryRaw<Array<{ day: string; count: number }>>`
          SELECT
            to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS count
          FROM support_tickets
          WHERE tenant_id = ${tenantId}::uuid
            AND created_at >= ${input.ticketsSince}
          GROUP BY 1
          ORDER BY 1
        `,
      ]);

    const ticketsByStatus = Object.fromEntries(
      TICKET_STATUSES.map((status) => [status, 0]),
    ) as Record<TicketStatus, number>;
    for (const row of statusGroups) {
      ticketsByStatus[row.status] = row._count._all;
    }

    const average = avgRows[0]?.avg_first_response_minutes ?? null;
    const avgFirstResponseMinutes =
      average === null || !Number.isFinite(Number(average)) ? null : Number(average);

    return {
      accounts,
      agents,
      ticketsByStatus,
      slaAtRisk,
      slaBreached,
      avgFirstResponseMinutes,
      messagesLast7d,
      ticketsByDay: dayRows.map((row) => ({ date: row.day, count: Number(row.count) })),
    };
  }

  /* ==================================================================== */
  /* Alerts (Fase 4) - derived from live rows, no alert table             */
  /* ==================================================================== */

  async alertSnapshot(input: PlatformAlertQuery): Promise<PlatformAlertSnapshot> {
    const tenants = await this.prisma.tenant.findMany({
      where: { deletedAt: null, status: { not: 'DELETED' } },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        plan: true,
        maxAccounts: true,
        maxAgents: true,
      },
      orderBy: { slug: 'asc' },
    });

    const tenantRows: PlatformAlertTenantRecord[] = tenants.map((tenant) => ({ ...tenant }));
    const tenantIds = tenantRows.map((tenant) => tenant.id);

    const snapshot: PlatformAlertSnapshot = {
      tenants: tenantRows,
      accounts: [],
      usage: {},
      slaAtRisk: {},
      expiringInvitations: {},
    };
    if (tenantIds.length === 0) return snapshot;

    for (const id of tenantIds) {
      snapshot.usage[id] = { accounts: 0, agents: 0 };
    }

    const [accounts, agentGroups, accountGroups, slaGroups, invitationGroups] = await Promise.all([
      // Only accounts that are already a signal: not ACTIVE, or an error inside
      // the recent window. Healthy accounts never reach the alert list.
      this.prisma.marketplaceAccount.findMany({
        where: {
          tenantId: { in: tenantIds },
          OR: [
            { status: { not: 'ACTIVE' } },
            { lastErrorAt: { gte: input.errorSince } },
          ],
        },
        select: {
          id: true,
          tenantId: true,
          marketplace: true,
          displayName: true,
          status: true,
          lastErrorAt: true,
          lastError: true,
        },
        orderBy: { displayName: 'asc' },
      }),
      this.prisma.agent.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: tenantIds } },
        _count: { _all: true },
      }),
      this.prisma.marketplaceAccount.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: tenantIds } },
        _count: { _all: true },
      }),
      this.prisma.supportTicket.groupBy({
        by: ['tenantId'],
        where: {
          tenantId: { in: tenantIds },
          status: { in: [...OPEN_TICKET_STATUSES] },
          slaBreached: false,
          slaDeadlineAt: { lte: input.slaHorizon },
        },
        _count: { _all: true },
      }),
      this.prisma.invitation.groupBy({
        by: ['tenantId'],
        where: {
          tenantId: { in: tenantIds },
          acceptedAt: null,
          expiresAt: { gt: input.now, lte: input.invitationHorizon },
        },
        _count: { _all: true },
      }),
    ]);

    // Marketplace accounts are always real channels; the cast drops the
    // `BILLING` enum member that only exists for `webhook_events`.
    const accountRows: PlatformAlertAccountRecord[] = accounts.map((account) => ({
      ...account,
      marketplace: account.marketplace as Marketplace,
    }));
    snapshot.accounts = accountRows;

    for (const row of agentGroups) {
      if (row.tenantId !== null) snapshot.usage[row.tenantId].agents = row._count._all;
    }
    for (const row of accountGroups) {
      if (row.tenantId !== null) snapshot.usage[row.tenantId].accounts = row._count._all;
    }
    for (const row of slaGroups) {
      if (row.tenantId !== null) snapshot.slaAtRisk[row.tenantId] = row._count._all;
    }
    for (const row of invitationGroups) {
      if (row.tenantId !== null) snapshot.expiringInvitations[row.tenantId] = row._count._all;
    }

    return snapshot;
  }

  /* ==================================================================== */
  /* Billing (Fase 4) - MRR base                                         */
  /* ==================================================================== */

  async billingByPlanAndStatus(): Promise<PlatformBillingPlanCount[]> {
    const rows = await this.prisma.tenant.groupBy({
      by: ['plan', 'billingStatus'],
      // A soft-deleted workspace is never billed.
      where: { deletedAt: null, status: { not: 'DELETED' } },
      _count: { _all: true },
    });

    return rows.map((row) => ({
      plan: row.plan,
      billingStatus: row.billingStatus,
      tenants: row._count._all,
    }));
  }
}

export function createPlatformRepository(prisma: PrismaClient): PrismaPlatformRepository {
  return new PrismaPlatformRepository(prisma);
}
