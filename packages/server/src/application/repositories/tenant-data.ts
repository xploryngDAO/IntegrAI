import type { PrismaClient } from '@prisma/client';
import type {
  ITenantDataRepository,
  TenantDataSnapshot,
  TenantDataSnapshotOptions,
} from '@sac/shared';
import { mapAccount, mapAgent, mapMessage, mapTicket, mapTicketEvent } from './mappers';

/** Hard caps for one LGPD export (documented in docs/PHASE4_PLATFORM.md). */
export const EXPORT_TICKET_LIMIT = 1_000;
export const EXPORT_MESSAGE_LIMIT = 5_000;
export const EXPORT_EVENT_LIMIT = 5_000;

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Prisma read/write side of the LGPD tenant privacy slice.
 *
 * The snapshot is strictly tenant-scoped and bounded: an export can never pull
 * the whole database into memory, and `truncated` tells the operator that the
 * artifact is partial (the SPA/console renders it in `meta`).
 *
 * `buyer_pii_vault` is deliberately NOT read: restricted marketplace data is
 * segregated, auto-purged and out of scope of the workspace export.
 */
export class PrismaTenantDataRepository implements ITenantDataRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async snapshot(
    tenantId: string,
    options?: TenantDataSnapshotOptions,
  ): Promise<TenantDataSnapshot> {
    const ticketLimit = clampInt(options?.ticketLimit, 1, EXPORT_TICKET_LIMIT, EXPORT_TICKET_LIMIT);
    const messageLimit = clampInt(
      options?.messageLimit,
      1,
      EXPORT_MESSAGE_LIMIT,
      EXPORT_MESSAGE_LIMIT,
    );
    const eventLimit = clampInt(options?.eventLimit, 1, EXPORT_EVENT_LIMIT, EXPORT_EVENT_LIMIT);

    const [agentRows, accountRows, ticketRows] = await Promise.all([
      this.prisma.agent.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.marketplaceAccount.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.supportTicket.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: ticketLimit + 1,
      }),
    ]);

    const ticketsTruncated = ticketRows.length > ticketLimit;
    const tickets = ticketsTruncated ? ticketRows.slice(0, ticketLimit) : ticketRows;
    const ticketIds = tickets.map((ticket) => ticket.id);

    if (ticketIds.length === 0) {
      return {
        agents: agentRows.map(mapAgent),
        accounts: accountRows.map(mapAccount),
        tickets: [],
        messages: [],
        events: [],
        truncated: { tickets: ticketsTruncated, messages: false },
      };
    }

    const [messageRows, eventRows] = await Promise.all([
      this.prisma.ticketMessage.findMany({
        where: { ticketId: { in: ticketIds } },
        orderBy: { marketplaceCreatedAt: 'asc' },
        take: messageLimit + 1,
      }),
      this.prisma.ticketEvent.findMany({
        where: { ticketId: { in: ticketIds } },
        orderBy: { createdAt: 'asc' },
        take: eventLimit + 1,
      }),
    ]);

    const messagesTruncated = messageRows.length > messageLimit;
    const events = eventRows.slice(0, eventLimit);

    return {
      agents: agentRows.map(mapAgent),
      accounts: accountRows.map(mapAccount),
      tickets: tickets.map(mapTicket),
      messages: (messagesTruncated ? messageRows.slice(0, messageLimit) : messageRows).map(mapMessage),
      events: events.map(mapTicketEvent),
      truncated: { tickets: ticketsTruncated, messages: messagesTruncated },
    };
  }

  async revokeSessions(tenantId: string, at: Date): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { tenantId, revokedAt: null },
      data: { revokedAt: at },
    });
    return result.count;
  }
}

export function createTenantDataRepository(prisma: PrismaClient): PrismaTenantDataRepository {
  return new PrismaTenantDataRepository(prisma);
}
