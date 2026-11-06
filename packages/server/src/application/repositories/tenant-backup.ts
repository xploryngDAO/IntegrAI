import type { PrismaClient } from '@prisma/client';
import type {
  ITenantBackupRepository,
  RecordTenantBackupInput,
  TenantBackupRecord,
  TenantBackupSnapshot,
  WebhookEventRecord,
} from '@sac/shared';

import {
  mapAccount,
  mapAgent,
  mapAttachment,
  mapMessage,
  mapOrder,
  mapOutboundAttempt,
  mapSlaPolicy,
  mapTenantBackupRecord,
  mapTicket,
  mapTicketEvent,
} from './mappers';

/**
 * ============================================================================
 * PrismaTenantBackupRepository - backup read side + S3 index (Fase 4)
 * ============================================================================
 *
 * `snapshot` is strictly tenant-scoped and reads EVERY row of the workspace
 * (a backup is complete, unlike the bounded LGPD export). Tables without
 * `tenant_id` are scoped through their parent relation:
 *
 *   agents / accounts / tickets          -> tenant_id
 *   messages / events / outboundAttempts -> ticket.tenant_id
 *   attachments                          -> message.ticket.tenant_id
 *   orders / slaPolicies                 -> account.tenant_id
 *   webhookEvents                        -> tenant_id OR account_id
 *
 * `webhook_events` is the only table with a narrow `select`: the raw payload
 * JSON and its S3 pointer are never loaded, because they are not part of the
 * backup (they may contain buyer PII).
 *
 * The index row is written AFTER the object is stored by the service; the
 * artifact in the bucket is the source of truth and the table only points to it.
 */
export class PrismaTenantBackupRepository implements ITenantBackupRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async snapshot(tenantId: string): Promise<TenantBackupSnapshot> {
    const [agentRows, accountRows, ticketRows] = await Promise.all([
      this.prisma.agent.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.marketplaceAccount.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.supportTicket.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const accountIds = accountRows.map((account) => account.id);
    const webhookScope =
      accountIds.length === 0
        ? { tenantId }
        : { OR: [{ tenantId }, { accountId: { in: accountIds } }] };

    const [messageRows, attachmentRows, eventRows, attemptRows, orderRows, slaRows, webhookRows] =
      await Promise.all([
        this.prisma.ticketMessage.findMany({
          where: { ticket: { tenantId } },
          orderBy: { marketplaceCreatedAt: 'asc' },
        }),
        this.prisma.messageAttachment.findMany({
          where: { message: { ticket: { tenantId } } },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.ticketEvent.findMany({
          where: { ticket: { tenantId } },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.outboundAttempt.findMany({
          where: { ticket: { tenantId } },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.orderCache.findMany({
          where: { account: { tenantId } },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.slaPolicy.findMany({
          where: { account: { tenantId } },
          orderBy: { createdAt: 'asc' },
        }),
        // Raw payloads are intentionally NOT selected (see class comment).
        this.prisma.webhookEvent.findMany({
          where: webhookScope,
          orderBy: { receivedAt: 'asc' },
          select: {
            id: true,
            marketplace: true,
            accountId: true,
            eventId: true,
            topic: true,
            status: true,
            signatureValid: true,
            attempts: true,
            receivedAt: true,
            processedAt: true,
          },
        }),
      ]);

    return {
      agents: agentRows.map(mapAgent),
      accounts: accountRows.map(mapAccount),
      tickets: ticketRows.map(mapTicket),
      messages: messageRows.map(mapMessage),
      attachments: attachmentRows.map(mapAttachment),
      events: eventRows.map(mapTicketEvent),
      outboundAttempts: attemptRows.map(mapOutboundAttempt),
      orders: orderRows.map(mapOrder),
      slaPolicies: slaRows.map(mapSlaPolicy),
      webhookEvents: webhookRows.map(toWebhookRecord),
    };
  }

  async record(input: RecordTenantBackupInput): Promise<TenantBackupRecord> {
    const record = await this.prisma.tenantBackup.create({
      data: {
        tenantId: input.tenantId,
        s3Key: input.s3Key,
        sizeBytes: input.sizeBytes,
        counts: input.counts as unknown as object,
        createdBy: input.createdBy,
        createdAt: input.createdAt,
      },
    });
    return mapTenantBackupRecord(record);
  }

  async listByTenant(tenantId: string): Promise<TenantBackupRecord[]> {
    const records = await this.prisma.tenantBackup.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return records.map(mapTenantBackupRecord);
  }
}

/**
 * Builds a `WebhookEventRecord` from the narrow projection: the payload,
 * `resource` and S3 pointer are not part of the backup and stay empty.
 */
function toWebhookRecord(row: {
  id: string;
  /** Prisma enum also carries the billing pseudo-marketplace; the backup only
   *  ever holds real channel rows (tenant scoped), so the cast is safe here. */
  marketplace: string;
  accountId: string | null;
  eventId: string | null;
  topic: string | null;
  status: WebhookEventRecord['status'];
  signatureValid: boolean;
  attempts: number;
  receivedAt: Date;
  processedAt: Date | null;
}): WebhookEventRecord {
  return {
    id: row.id,
    marketplace: row.marketplace as WebhookEventRecord['marketplace'],
    accountId: row.accountId,
    eventId: row.eventId,
    topic: row.topic,
    resource: null,
    status: row.status,
    signatureValid: row.signatureValid,
    payload: {},
    payloadS3Uri: null,
    attempts: row.attempts,
    error: null,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
  };
}

export function createTenantBackupRepository(prisma: PrismaClient): PrismaTenantBackupRepository {
  return new PrismaTenantBackupRepository(prisma);
}
