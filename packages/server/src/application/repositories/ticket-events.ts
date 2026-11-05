import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  AppendTicketEventInput,
  ITicketEventRepository,
  TicketEventRecord,
} from '@sac/shared';
import { mapTicketEvent, toInputJson } from './mappers';

/** Prisma implementation of `ITicketEventRepository` (audit timeline). */
export class PrismaTicketEventRepository implements ITicketEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async append(input: AppendTicketEventInput): Promise<TicketEventRecord> {
    const record = await this.prisma.ticketEvent.create({
      data: {
        ticketId: input.ticketId,
        eventType: input.eventType,
        actorAgentId: input.actorAgentId ?? null,
        actorLabel: input.actorLabel ?? null,
        payload: toInputJson(input.payload ?? {}),
      },
    });
    return mapTicketEvent(record);
  }

  async listByTicket(ticketId: string): Promise<TicketEventRecord[]> {
    const records = await this.prisma.ticketEvent.findMany({
      where: { ticketId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return records.map(mapTicketEvent);
  }
}


export function createTicketEventRepository(prisma: PrismaClient): PrismaTicketEventRepository {
  return new PrismaTicketEventRepository(prisma);
}
