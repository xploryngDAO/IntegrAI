import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  BillingEventAuditRecord,
  BillingWebhookType,
  IBillingEventRepository,
  RecordBillingEventInput,
  RecordBillingEventResult,
} from '@sac/shared';
import { isBillingWebhookType } from '@sac/shared';
import { isUniqueConstraintViolation } from './errors';
import { toInputJson, toJsonObject } from './mappers';

/**
 * ============================================================================
 * PrismaBillingEventRepository - billing audit in `webhook_events`
 * ============================================================================
 *
 * Billing deliberately reuses `webhook_events` (instead of a new table): the
 * `(marketplace, event_id)` unique index already provides cross-process
 * idempotency and the LGPD purge already removes rows by `tenant_id`.
 *
 * Billing rows are stored with `marketplace = 'BILLING'` (enum value added by
 * the Fase 4 gateway migration), `event_id = billing:<externalId>` (null when
 * the gateway did not send an external id), `topic` = the normalized event type
 * and `payload` = the normalized payload. `account_id` stays null: a billing
 * event belongs to a workspace, not to a marketplace account.
 */

const BILLING_MARKETPLACE = 'BILLING' as const;

const EVENT_SELECT = {
  id: true,
  eventId: true,
  topic: true,
  tenantId: true,
  status: true,
  payload: true,
  error: true,
  receivedAt: true,
  processedAt: true,
} as const;

type BillingWebhookRow = {
  id: string;
  eventId: string | null;
  topic: string | null;
  tenantId: string | null;
  status: 'RECEIVED' | 'DUPLICATE' | 'PROCESSED' | 'FAILED' | 'DEAD_LETTER';
  payload: Prisma.JsonValue;
  error: string | null;
  receivedAt: Date;
  processedAt: Date | null;
};

export class PrismaBillingEventRepository implements IBillingEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByEventId(eventId: string): Promise<BillingEventAuditRecord | null> {
    const row = await this.prisma.webhookEvent.findFirst({
      where: { marketplace: BILLING_MARKETPLACE, eventId },
      orderBy: { receivedAt: 'asc' },
      select: EVENT_SELECT,
    });
    if (row === null) return null;
    return this.toRecord(row);
  }

  /**
   * Inserts the audit row. A `(marketplace, event_id)` collision (concurrent
   * delivery of the same externalId) returns the existing row with
   * `created: false` instead of throwing, so the caller can answer 200.
   */
  async record(input: RecordBillingEventInput): Promise<RecordBillingEventResult> {
    try {
      const row = await this.prisma.webhookEvent.create({
        data: {
          marketplace: BILLING_MARKETPLACE,
          eventId: input.eventId,
          tenantId: input.tenantId,
          topic: input.type,
          status: 'RECEIVED',
          signatureValid: true,
          payload: toInputJson(input.payload),
          error: input.error ?? null,
        },
        select: EVENT_SELECT,
      });
      return { record: this.toRecord(row), created: true };
    } catch (error) {
      if (isUniqueConstraintViolation(error) && input.eventId !== null) {
        const existing = await this.findByEventId(input.eventId);
        if (existing !== null) return { record: existing, created: false };
      }
      throw error;
    }
  }

  async markStatus(
    id: string,
    status: 'RECEIVED' | 'DUPLICATE' | 'PROCESSED' | 'FAILED' | 'DEAD_LETTER',
    detail?: { error?: string | null; processedAt?: Date },
  ): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: { id, marketplace: BILLING_MARKETPLACE },
      data: {
        status,
        ...(detail?.error !== undefined ? { error: detail.error } : {}),
        processedAt: detail?.processedAt ?? (status === 'PROCESSED' ? new Date() : null),
      },
    });
  }

  /** Newest-first billing events, with the workspace slug for the console. */
  async listRecent(limit: number): Promise<BillingEventAuditRecord[]> {
    const rows = await this.prisma.webhookEvent.findMany({
      where: { marketplace: BILLING_MARKETPLACE },
      orderBy: { receivedAt: 'desc' },
      take: limit,
      select: EVENT_SELECT,
    });

    const tenantIds = [
      ...new Set(
        rows
          .map((row) => row.tenantId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];
    const tenants =
      tenantIds.length === 0
        ? []
        : await this.prisma.tenant.findMany({
            where: { id: { in: tenantIds } },
            select: { id: true, slug: true },
          });
    const slugById = new Map(tenants.map((tenant) => [tenant.id, tenant.slug]));

    return rows.map((row) =>
      this.toRecord(row, row.tenantId !== null ? (slugById.get(row.tenantId) ?? null) : null),
    );
  }

  private toRecord(row: BillingWebhookRow, tenantSlug: string | null = null): BillingEventAuditRecord {
    const type: BillingWebhookType | null = isBillingWebhookType(row.topic) ? row.topic : null;
    return {
      id: row.id,
      eventId: row.eventId,
      type,
      tenantId: row.tenantId,
      tenantSlug,
      status: row.status,
      payload: toJsonObject(row.payload),
      error: row.error,
      receivedAt: row.receivedAt,
      processedAt: row.processedAt,
    };
  }
}

export function createBillingEventRepository(
  prisma: PrismaClient,
): PrismaBillingEventRepository {
  return new PrismaBillingEventRepository(prisma);
}
