import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import { OPEN_TICKET_STATUSES } from '@sac/shared';
import type {
  AgentRecord,
  CreateTicketInput,
  ITicketRepository,
  Marketplace,
  PageRequest,
  Paginated,
  SupportTicketRecord,
  ThreadingLookup,
  TicketListFilter,
  TicketStatus,
  TicketStats,
  TicketUpdatePatch,
} from '@sac/shared';
import { mapAgent, mapTicket, toInputJson, toJsonObject } from './mappers';

const DEFAULT_ORDER_WINDOW_DAYS = 30;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_LIST_LIMIT = 500;

interface AverageRow {
  avg_first_response_minutes: number | null;
  avg_resolution_minutes: number | null;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function roundMinutes(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function daysAgo(days: number, from: Date = new Date()): Date {
  return new Date(from.getTime() - Math.max(1, Math.trunc(days)) * 24 * 60 * 60 * 1_000);
}

function openStatusList(): TicketStatus[] {
  return [...OPEN_TICKET_STATUSES];
}

/**
 * Prisma implementation of `ITicketRepository`.
 *
 * The list/stats filters share one `buildWhere` so the queue column and the
 * telemetry counters can never diverge.
 */
export class PrismaTicketRepository implements ITicketRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateTicketInput): Promise<SupportTicketRecord> {
    const data: Prisma.SupportTicketUncheckedCreateInput = {
      tenantId: input.tenantId ?? null,
      accountId: input.accountId,
      marketplace: input.marketplace,
      ticketType: input.ticketType,
      externalReferenceId: input.externalReferenceId,
      externalOrderId: input.externalOrderId ?? null,
      orderCacheId: input.orderCacheId ?? null,
      packId: input.packId ?? null,
      claimId: input.claimId ?? null,
      conversationId: input.conversationId ?? null,
      returnSn: input.returnSn ?? null,
      subject: input.subject ?? null,
      buyerExternalId: input.buyerExternalId ?? null,
      buyerDisplayName: input.buyerDisplayName ?? null,
      buyerAnonymizedEmail: input.buyerAnonymizedEmail ?? null,
      buyerContactHash: input.buyerContactHash ?? null,
      hasActiveClaim: input.hasActiveClaim ?? false,
      status: input.status ?? 'UNREAD',
      priority: input.priority ?? 'MEDIUM',
      slaDeadlineAt: input.slaDeadlineAt,
      slaTargetAt: input.slaTargetAt ?? null,
      slaLegMinutes: input.slaLegMinutes ?? null,
      assignedQueue: input.assignedQueue ?? null,
      channelMetadata: toInputJson(input.channelMetadata ?? {}),
      tags: input.tags ?? [],
    };

    const record = await this.prisma.supportTicket.create({ data });
    return mapTicket(record);
  }

  async findById(id: string): Promise<SupportTicketRecord | null> {
    const record = await this.prisma.supportTicket.findUnique({ where: { id } });
    return record ? mapTicket(record) : null;
  }

  async findByExternalReference(
    marketplace: Marketplace,
    externalReferenceId: string,
  ): Promise<SupportTicketRecord | null> {
    const record = await this.prisma.supportTicket.findFirst({
      where: { marketplace, externalReferenceId },
      orderBy: { updatedAt: 'desc' },
    });
    return record ? mapTicket(record) : null;
  }

  async findActiveByExternalOrderId(
    marketplace: Marketplace,
    externalOrderId: string,
    withinDays: number = DEFAULT_ORDER_WINDOW_DAYS,
  ): Promise<SupportTicketRecord | null> {
    const record = await this.prisma.supportTicket.findFirst({
      where: {
        marketplace,
        externalOrderId,
        status: { in: openStatusList() },
        updatedAt: { gte: daysAgo(withinDays) },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return record ? mapTicket(record) : null;
  }

  async findOpenPreSaleByBuyerEmail(
    marketplace: Marketplace,
    buyerAnonymizedEmail: string,
  ): Promise<SupportTicketRecord | null> {
    const record = await this.prisma.supportTicket.findFirst({
      where: {
        marketplace,
        buyerAnonymizedEmail,
        ticketType: 'PRE_SALE',
        status: { in: openStatusList() },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return record ? mapTicket(record) : null;
  }

  /**
   * Amazon inbound threading order (documented in docs/ARCHITECTURE.md):
   *   1. In-Reply-To / References matched against ticket_messages;
   *   2. order id within `activeWithinDays` (default 30);
   *   3. open PRE_SALE thread for the same anonymized buyer email.
   */
  async findThreadingMatch(lookup: ThreadingLookup): Promise<SupportTicketRecord | null> {
    const replyIds = (lookup.inReplyToIds ?? []).filter((id) => id.trim().length > 0);
    if (replyIds.length > 0) {
      const message = await this.prisma.ticketMessage.findFirst({
        where: {
          ticket: { marketplace: lookup.marketplace, accountId: lookup.accountId },
          OR: [
            { inReplyToId: { in: replyIds } },
            { externalMessageId: { in: replyIds } },
            { referencesIds: { hasSome: replyIds } },
          ],
        },
        orderBy: { marketplaceCreatedAt: 'desc' },
        select: { ticketId: true },
      });
      if (message) {
        const ticket = await this.findById(message.ticketId);
        if (ticket) return ticket;
      }
    }

    if (lookup.externalOrderId && lookup.externalOrderId.trim().length > 0) {
      const byOrder = await this.findActiveByExternalOrderId(
        lookup.marketplace,
        lookup.externalOrderId,
        lookup.activeWithinDays ?? DEFAULT_ORDER_WINDOW_DAYS,
      );
      if (byOrder) return byOrder;
    }

    if (lookup.buyerAnonymizedEmail && lookup.buyerAnonymizedEmail.trim().length > 0) {
      return this.findOpenPreSaleByBuyerEmail(lookup.marketplace, lookup.buyerAnonymizedEmail);
    }

    return null;
  }

  async update(
    id: string,
    patch: TicketUpdatePatch,
    options?: { mergeChannelMetadata?: boolean },
  ): Promise<SupportTicketRecord> {
    const data: Prisma.SupportTicketUncheckedUpdateInput = {};

    if (patch.status !== undefined) data.status = patch.status;
    if (patch.priority !== undefined) data.priority = patch.priority;
    if (patch.slaDeadlineAt !== undefined) data.slaDeadlineAt = patch.slaDeadlineAt;
    if (patch.slaTargetAt !== undefined) data.slaTargetAt = patch.slaTargetAt;
    if (patch.slaLegMinutes !== undefined) data.slaLegMinutes = patch.slaLegMinutes;
    if (patch.slaBreached !== undefined) data.slaBreached = patch.slaBreached;
    if (patch.slaState !== undefined) data.slaState = patch.slaState;
    if (patch.firstResponseAt !== undefined) data.firstResponseAt = patch.firstResponseAt;
    if (patch.resolvedAt !== undefined) data.resolvedAt = patch.resolvedAt;
    if (patch.lastInboundAt !== undefined) data.lastInboundAt = patch.lastInboundAt;
    if (patch.lastOutboundAt !== undefined) data.lastOutboundAt = patch.lastOutboundAt;
    if (patch.lastMessageAt !== undefined) data.lastMessageAt = patch.lastMessageAt;
    if (patch.unreadCount !== undefined) data.unreadCount = patch.unreadCount;
    if (patch.assignedAgentId !== undefined) data.assignedAgentId = patch.assignedAgentId;
    if (patch.assignedQueue !== undefined) data.assignedQueue = patch.assignedQueue;
    if (patch.hasActiveClaim !== undefined) data.hasActiveClaim = patch.hasActiveClaim;
    if (patch.subject !== undefined) data.subject = patch.subject;
    if (patch.buyerDisplayName !== undefined) data.buyerDisplayName = patch.buyerDisplayName;
    if (patch.buyerAnonymizedEmail !== undefined) {
      data.buyerAnonymizedEmail = patch.buyerAnonymizedEmail;
    }
    if (patch.externalOrderId !== undefined) data.externalOrderId = patch.externalOrderId;
    if (patch.orderCacheId !== undefined) data.orderCacheId = patch.orderCacheId;
    if (patch.packId !== undefined) data.packId = patch.packId;
    if (patch.claimId !== undefined) data.claimId = patch.claimId;
    if (patch.conversationId !== undefined) data.conversationId = patch.conversationId;
    if (patch.returnSn !== undefined) data.returnSn = patch.returnSn;
    if (patch.tags !== undefined) data.tags = patch.tags;

    if (patch.channelMetadata !== undefined) {
      if (options?.mergeChannelMetadata) {
        const current = await this.prisma.supportTicket.findUnique({
          where: { id },
          select: { channelMetadata: true },
        });
        data.channelMetadata = toInputJson({
          ...toJsonObject(current?.channelMetadata),
          ...patch.channelMetadata,
        });
      } else {
        data.channelMetadata = toInputJson(patch.channelMetadata);
      }
    }

    const record = await this.prisma.supportTicket.update({ where: { id }, data });
    return mapTicket(record);
  }

  async list(filter: TicketListFilter, page: PageRequest): Promise<Paginated<SupportTicketRecord>> {
    const pageNumber = clampInt(page.page, 1, 1_000_000, 1);
    const pageSize = clampInt(page.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
    const where = this.buildWhere(filter);

    const [total, records] = await this.prisma.$transaction([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({
        where,
        orderBy: [
          { slaBreached: 'desc' },
          { priority: 'desc' },
          { slaDeadlineAt: 'asc' },
          { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        ],
        skip: (pageNumber - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: records.map(mapTicket),
      total,
      page: pageNumber,
      pageSize,
      totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
    };
  }

  async findSlaDue(now: Date, limit: number): Promise<SupportTicketRecord[]> {
    const records = await this.prisma.supportTicket.findMany({
      where: {
        status: { in: openStatusList() },
        slaBreached: false,
        slaDeadlineAt: { lt: now },
      },
      orderBy: { slaDeadlineAt: 'asc' },
      take: clampInt(limit, 1, MAX_LIST_LIMIT, 100),
    });
    return records.map(mapTicket);
  }

  async findAtRisk(now: Date, warningWindowMs: number, limit: number): Promise<SupportTicketRecord[]> {
    const windowMs = Math.max(0, warningWindowMs);
    const records = await this.prisma.supportTicket.findMany({
      where: {
        status: { in: openStatusList() },
        slaBreached: false,
        slaDeadlineAt: {
          gte: now,
          lte: new Date(now.getTime() + windowMs),
        },
      },
      orderBy: { slaDeadlineAt: 'asc' },
      take: clampInt(limit, 1, MAX_LIST_LIMIT, 100),
    });
    return records.map(mapTicket);
  }

  async markBreached(ids: string[], at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.prisma.supportTicket.updateMany({
      where: {
        id: { in: ids },
        slaBreached: false,
        // Only ticket deadlines that had actually passed at `at` are flagged.
        slaDeadlineAt: { lt: at },
      },
      data: { slaBreached: true, slaState: 'BREACHED' },
    });
    return result.count;
  }

  async incrementUnread(id: string, delta: number): Promise<number> {
    // GREATEST(0, ...) keeps the counter sane under duplicate mark-as-read races.
    const rows = await this.prisma.$queryRaw<Array<{ unread_count: number }>>`
      UPDATE support_tickets
      SET unread_count = GREATEST(0, unread_count + ${Math.trunc(delta)}),
          updated_at = NOW()
      WHERE id = ${id}::uuid
      RETURNING unread_count
    `;
    return rows.length > 0 ? Number(rows[0]?.unread_count ?? 0) : 0;
  }

  async stats(filter?: TicketListFilter): Promise<TicketStats> {
    const where = this.buildWhere(filter ?? {});

    const [total, unread, openWaitingAgent, atRisk, breached, avgRows] =
      await this.prisma.$transaction([
        this.prisma.supportTicket.count({ where }),
        this.prisma.supportTicket.count({ where: { ...where, unreadCount: { gt: 0 } } }),
        this.prisma.supportTicket.count({
          where: { ...where, status: 'OPEN_WAITING_AGENT' },
        }),
        this.prisma.supportTicket.count({ where: { ...where, slaState: 'AT_RISK' } }),
        this.prisma.supportTicket.count({ where: { ...where, slaBreached: true } }),
        this.prisma.$queryRaw<AverageRow[]>`
          SELECT
            AVG(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60)::float8
              AS avg_first_response_minutes,
            AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60)::float8
              AS avg_resolution_minutes
          FROM support_tickets
          WHERE first_response_at IS NOT NULL OR resolved_at IS NOT NULL
        `,
      ]);

    // groupBy is issued outside the transaction: Prisma's `$transaction` tuple
    // inference loses the `_count` shape for aggregation queries.
    const marketplaceGroups = await this.prisma.supportTicket.groupBy({
      by: ['marketplace'],
      where,
      orderBy: { marketplace: 'asc' },
      _count: { _all: true },
    });

    const byMarketplace: Record<Marketplace, number> = {
      AMAZON: 0,
      MERCADO_LIVRE: 0,
      SHOPEE: 0,
    };
    for (const group of marketplaceGroups) {
      // Tickets are marketplace-channel rows only; `BILLING` exists solely in
      // `webhook_events`, so skip it defensively instead of widening the map.
      if (group.marketplace === 'BILLING') continue;
      byMarketplace[group.marketplace] = group._count._all;
    }

    const averages = avgRows[0] ?? { avg_first_response_minutes: null, avg_resolution_minutes: null };

    return {
      total,
      unread,
      openWaitingAgent,
      atRisk,
      breached,
      avgFirstResponseMinutes: roundMinutes(averages.avg_first_response_minutes),
      avgResolutionMinutes: roundMinutes(averages.avg_resolution_minutes),
      byMarketplace,
    };
  }

  async countActiveByAgent(agentId: string): Promise<number> {
    return this.prisma.supportTicket.count({
      where: {
        assignedAgentId: agentId,
        status: { in: openStatusList() },
      },
    });
  }

  /**
   * FIFO assignment: among ONLINE active agents with a free slot for `queue`,
   * pick the one with the fewest open tickets in that queue (ties broken by
   * tenure, so load is spread deterministically).
   */
  async findLeastLoadedAgent(queue: string): Promise<AgentRecord | null> {
    const agents = await this.prisma.agent.findMany({
      where: { isActive: true, presence: 'ONLINE' },
      include: {
        _count: {
          select: {
            tickets: {
              where: {
                status: { in: openStatusList() },
                assignedQueue: queue,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const candidates = agents
      .filter((agent) => agent._count.tickets < agent.maxConcurrent)
      .sort((a, b) => {
        if (a._count.tickets !== b._count.tickets) return a._count.tickets - b._count.tickets;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

    const chosen = candidates[0];
    return chosen ? mapAgent(chosen) : null;
  }

  private buildWhere(filter: TicketListFilter): Prisma.SupportTicketWhereInput {
    const where: Prisma.SupportTicketWhereInput = {};
    const and: Prisma.SupportTicketWhereInput[] = [];

    if (filter.tenantId) where.tenantId = filter.tenantId;

    if (filter.marketplace && filter.marketplace.length > 0) {
      where.marketplace = { in: filter.marketplace };
    }
    if (filter.accountId) where.accountId = filter.accountId;
    if (filter.status && filter.status.length > 0) where.status = { in: filter.status };
    if (filter.ticketType && filter.ticketType.length > 0) where.ticketType = { in: filter.ticketType };
    if (filter.priority && filter.priority.length > 0) where.priority = { in: filter.priority };
    if (filter.hasActiveClaim !== undefined) where.hasActiveClaim = filter.hasActiveClaim;

    if (filter.assignedAgentId === null) {
      where.assignedAgentId = null;
    } else if (typeof filter.assignedAgentId === 'string') {
      where.assignedAgentId = filter.assignedAgentId;
    }
    if (filter.onlyUnassigned) where.assignedAgentId = null;

    switch (filter.queueKey) {
      case 'SLA_CRITICAL':
        and.push({
          status: { in: openStatusList() },
          OR: [{ slaBreached: true }, { slaState: 'AT_RISK' }],
        });
        break;
      case 'CLAIMS':
        and.push({ hasActiveClaim: true });
        break;
      case 'PRE_SALE':
        and.push({ ticketType: 'PRE_SALE' });
        break;
      case 'WAITING_ME':
        and.push({ status: { in: ['UNREAD', 'OPEN_WAITING_AGENT'] } });
        break;
      case 'UNASSIGNED':
        and.push({ assignedAgentId: null });
        break;
      default:
        break;
    }

    if (filter.onlySlaCritical) {
      and.push({
        status: { in: openStatusList() },
        OR: [{ slaBreached: true }, { slaState: 'AT_RISK' }],
      });
    }

    const search = filter.search?.trim();
    if (search && search.length > 0) {
      and.push({
        OR: [
          { subject: { contains: search, mode: 'insensitive' } },
          { buyerDisplayName: { contains: search, mode: 'insensitive' } },
          { buyerAnonymizedEmail: { contains: search, mode: 'insensitive' } },
          { externalReferenceId: { contains: search, mode: 'insensitive' } },
          { externalOrderId: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    if (and.length > 0) where.AND = and;
    return where;
  }
}

export function createTicketRepository(prisma: PrismaClient): PrismaTicketRepository {
  return new PrismaTicketRepository(prisma);
}
