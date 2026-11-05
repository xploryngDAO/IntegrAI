import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  IWebhookEventRepository,
  Marketplace,
  RecordWebhookInput,
  WebhookEventRecord,
} from '@sac/shared';
import { isUniqueConstraintViolation } from './errors';
import { mapWebhookEvent, toInputJson } from './mappers';

type WebhookStatus = 'RECEIVED' | 'DUPLICATE' | 'PROCESSED' | 'FAILED' | 'DEAD_LETTER';

/** Prisma implementation of `IWebhookEventRepository`. */
export class PrismaWebhookEventRepository implements IWebhookEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Persists the inbound audit row. The `(marketplace, event_id)` unique index
   * makes replays collide; the existing row is returned so the ingress can
   * respond 200 without corrupting the original processing state.
   */
  async record(input: RecordWebhookInput): Promise<WebhookEventRecord> {
    try {
      const record = await this.prisma.webhookEvent.create({ data: buildCreateData(input) });
      return mapWebhookEvent(record);
    } catch (error) {
      if (isUniqueConstraintViolation(error) && input.eventId) {
        const existing = await this.findByEventId(input.marketplace, input.eventId);
        if (existing) return existing;
      }
      throw error;
    }
  }

  async markStatus(
    id: string,
    status: WebhookStatus,
    detail?: { error?: string | null; processedAt?: Date },
  ): Promise<void> {
    const data: Prisma.WebhookEventUpdateManyMutationInput = { status };
    if (detail?.error !== undefined) data.error = detail.error;
    if (detail?.processedAt !== undefined) {
      data.processedAt = detail.processedAt;
    } else if (status === 'PROCESSED') {
      data.processedAt = new Date();
    }

    // updateMany => idempotent (a deleted/replayed row does not throw P2025).
    await this.prisma.webhookEvent.updateMany({ where: { id }, data });
  }

  async findByEventId(
    marketplace: Marketplace,
    eventId: string,
  ): Promise<WebhookEventRecord | null> {
    const record = await this.prisma.webhookEvent.findFirst({
      where: { marketplace, eventId },
      orderBy: { receivedAt: 'asc' },
    });
    return record ? mapWebhookEvent(record) : null;
  }

  async incrementAttempts(id: string): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  }
}

function buildCreateData(input: RecordWebhookInput): Prisma.WebhookEventUncheckedCreateInput {
  return {
    marketplace: input.marketplace,
    accountId: input.accountId ?? null,
    eventId: input.eventId ?? null,
    topic: input.topic ?? null,
    resource: input.resource ?? null,
    status: input.status ?? 'RECEIVED',
    signatureValid: input.signatureValid ?? false,
    payload: toInputJson(input.payload ?? {}),
    payloadS3Uri: input.payloadS3Uri ?? null,
    error: input.error ?? null,
  };
}

export function createWebhookEventRepository(prisma: PrismaClient): PrismaWebhookEventRepository {
  return new PrismaWebhookEventRepository(prisma);
}
