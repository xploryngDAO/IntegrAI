import { createHmac } from 'node:crypto';
import type {  BillingEventAuditRecord,
  BillingEventStatus,
  IBillingEventRepository,
  RecordBillingEventInput,
  RecordBillingEventResult,
} from '@sac/shared';

/**
 * In-memory `IBillingEventRepository` for the Fase 4 billing tests.
 *
 * It mirrors the production semantics that matter:
 *  - `(marketplace, event_id)` uniqueness is enforced per `eventId` (the
 *    `record` call returns `created: false` instead of throwing);
 *  - `markStatus` closes the row (`PROCESSED`/`FAILED`);
 *  - `listRecent` is newest-first and resolves the tenant slug.
 */
export class InMemoryBillingEventRepository implements IBillingEventRepository {
  readonly rows: BillingEventAuditRecord[] = [];
  /** Resolves the workspace slug for `listRecent` (console projection). */
  slugFor: (tenantId: string) => string | null = () => null;
  private sequence = 0;

  constructor(
    private readonly now: () => Date = () => new Date('2026-11-05T12:00:00.000Z'),
  ) {}

  seed(overrides: Partial<BillingEventAuditRecord> = {}): BillingEventAuditRecord {
    const row: BillingEventAuditRecord = {
      id: overrides.id ?? `billing-event-${(this.sequence += 1)}`,
      eventId: overrides.eventId ?? null,
      type: overrides.type ?? 'subscription.activated',
      tenantId: overrides.tenantId ?? null,
      tenantSlug: overrides.tenantSlug ?? null,
      status: overrides.status ?? 'RECEIVED',
      payload: overrides.payload ?? {},
      error: overrides.error ?? null,
      receivedAt: overrides.receivedAt ?? this.now(),
      processedAt: overrides.processedAt ?? null,
    };
    this.rows.push(row);
    return row;
  }

  async findByEventId(eventId: string): Promise<BillingEventAuditRecord | null> {
    return this.rows.find((row) => row.eventId === eventId) ?? null;
  }

  async record(input: RecordBillingEventInput): Promise<RecordBillingEventResult> {
    if (input.eventId !== null) {
      const existing = await this.findByEventId(input.eventId);
      if (existing !== null) return { record: existing, created: false };
    }

    const record = this.seed({
      eventId: input.eventId,
      tenantId: input.tenantId,
      type: input.type,
      payload: input.payload,
      status: 'RECEIVED',
      error: input.error ?? null,
      receivedAt: this.now(),
    });
    return { record, created: true };
  }

  async markStatus(
    id: string,
    status: BillingEventStatus,
    detail?: { error?: string | null; processedAt?: Date },
  ): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) return;
    row.status = status;
    if (detail?.error !== undefined) row.error = detail.error;
    if (detail?.processedAt !== undefined) row.processedAt = detail.processedAt;
  }

  async listRecent(limit: number): Promise<BillingEventAuditRecord[]> {
    return [...this.rows]
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, limit)
      .map((row) => ({
        ...row,
        tenantSlug: row.tenantId !== null ? this.slugFor(row.tenantId) : null,
      }));
  }
}

/** Signed delivery: exact JSON bytes + the matching HMAC SHA-256 hex digest. */
export function signedBillingDelivery(
  body: unknown,
  secret: string,
): { rawBody: Buffer; signature: string; body: unknown } {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature, body };
}
