import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import type {
  CreateMessageInput,
  CreateMessageResult,
  DeliveryStatus,
  IMessageRepository,
  MessageDirection,
  TicketMessageRecord,
} from '@sac/shared';
import { isUniqueConstraintViolation } from './errors';
import { mapMessage, toInputJson } from './mappers';

const DEFAULT_MESSAGE_LIMIT = 500;
const MAX_MESSAGE_LIMIT = 2_000;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_MESSAGE_LIMIT;
  return Math.min(MAX_MESSAGE_LIMIT, Math.max(1, Math.trunc(limit)));
}

/** Prisma implementation of `IMessageRepository`. */
export class PrismaMessageRepository implements IMessageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Idempotent insert: `external_message_id` is unique, so a webhook replay
   * collides with P2002 and we return the row that already exists with
   * `created = false` (the service turns that into a DUPLICATE ack).
   */
  async createIdempotent(input: CreateMessageInput): Promise<CreateMessageResult> {
    try {
      const record = await this.prisma.ticketMessage.create({ data: buildCreateData(input) });
      return { record: mapMessage(record), created: true };
    } catch (error) {
      if (isUniqueConstraintViolation(error) && input.externalMessageId) {
        const existing = await this.findByExternalMessageId(input.externalMessageId);
        if (existing) return { record: existing, created: false };
      }
      throw error;
    }
  }

  async findById(id: string): Promise<TicketMessageRecord | null> {
    const record = await this.prisma.ticketMessage.findUnique({ where: { id } });
    return record ? mapMessage(record) : null;
  }

  async findByExternalMessageId(externalMessageId: string): Promise<TicketMessageRecord | null> {
    const record = await this.prisma.ticketMessage.findFirst({
      where: { externalMessageId },
      orderBy: { createdAt: 'asc' },
    });
    return record ? mapMessage(record) : null;
  }

  async listByTicket(
    ticketId: string,
    options?: { includeInternal?: boolean; limit?: number },
  ): Promise<TicketMessageRecord[]> {
    const includeInternal = options?.includeInternal ?? true;
    const where: Prisma.TicketMessageWhereInput = { ticketId };
    if (!includeInternal) where.isInternalNote = false;

    const records = await this.prisma.ticketMessage.findMany({
      where,
      // The marketplace clock is the only valid thread ordering key.
      orderBy: [{ marketplaceCreatedAt: 'asc' }, { createdAt: 'asc' }],
      take: clampLimit(options?.limit),
    });
    return records.map(mapMessage);
  }

  async updateDeliveryStatus(
    id: string,
    status: DeliveryStatus,
    detail?: {
      errorDetail?: string | null;
      sentAt?: Date | null;
      deliveredAt?: Date | null;
      readAt?: Date | null;
    },
  ): Promise<TicketMessageRecord> {
    const data: Prisma.TicketMessageUncheckedUpdateInput = { deliveryStatus: status };
    if (detail?.errorDetail !== undefined) data.errorDetail = detail.errorDetail;
    if (detail?.sentAt !== undefined) data.sentAt = detail.sentAt;
    if (detail?.deliveredAt !== undefined) data.deliveredAt = detail.deliveredAt;
    if (detail?.readAt !== undefined) data.readAt = detail.readAt;

    const record = await this.prisma.ticketMessage.update({ where: { id }, data });
    return mapMessage(record);
  }

  async lastByDirection(
    ticketId: string,
    direction: MessageDirection,
  ): Promise<TicketMessageRecord | null> {
    const record = await this.prisma.ticketMessage.findFirst({
      where: { ticketId, direction },
      orderBy: [{ marketplaceCreatedAt: 'desc' }, { createdAt: 'desc' }],
    });
    return record ? mapMessage(record) : null;
  }

  async latestMarketplaceCreatedAt(ticketId: string): Promise<Date | null> {
    const aggregate = await this.prisma.ticketMessage.aggregate({
      where: { ticketId },
      _max: { marketplaceCreatedAt: true },
    });
    return aggregate._max.marketplaceCreatedAt ?? null;
  }
}

function buildCreateData(input: CreateMessageInput): Prisma.TicketMessageUncheckedCreateInput {
  return {
    ticketId: input.ticketId,
    externalMessageId: input.externalMessageId ?? null,
    inReplyToId: input.inReplyToId ?? null,
    referencesIds: input.referencesIds ?? [],
    direction: input.direction,
    channelRouteUsed: input.channelRouteUsed,
    messageType: input.messageType ?? 'text',
    bodyCleanText: input.bodyCleanText,
    bodyHtml: input.bodyHtml ?? null,
    contentPayload: toInputJson(input.contentPayload ?? {}),
    bodyRawS3Uri: input.bodyRawS3Uri ?? null,
    deliveryStatus: input.deliveryStatus ?? 'QUEUED',
    errorDetail: input.errorDetail ?? null,
    isInternalNote: input.isInternalNote ?? false,
    authorAgentId: input.authorAgentId ?? null,
    marketplaceCreatedAt: input.marketplaceCreatedAt,
    sentAt: input.sentAt ?? null,
    deliveredAt: input.deliveredAt ?? null,
    readAt: input.readAt ?? null,
  };
}

export function createMessageRepository(prisma: PrismaClient): PrismaMessageRepository {
  return new PrismaMessageRepository(prisma);
}
