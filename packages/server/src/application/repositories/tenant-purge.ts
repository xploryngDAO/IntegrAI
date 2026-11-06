import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import type {
  ITenantPurgeRepository,
  TenantObjectKeys,
  TenantPurgeCounts,
  TenantRecord,
} from '@sac/shared';

import { mapTenant } from './mappers';

/**
 * ============================================================================
 * PrismaTenantPurgeRepository - LGPD physical delete (Fase 4)
 * ============================================================================
 *
 * Everything for ONE workspace happens inside a single `$transaction`, so a
 * crash can never leave a half-purged tenant (no orphan tickets, no credential
 * rows for a deleted operator).
 *
 * Delete order is FK-safe (children before parents):
 *
 *   sessions -> invitations -> password_resets / email_verifications /
 *   two_factor_recovery_codes (by the tenant's operator ids) -> buyer_pii_vault
 *   -> message_attachments -> ticket_messages -> ticket_events ->
 *   outbound_attempts -> support_tickets -> orders_cache -> sla_policies ->
 *   marketplace_accounts -> agents -> tenants
 *
 * Tables without `tenant_id` are scoped through their parent relation
 * (`{ ticket: { tenantId } }`, `{ account: { tenantId } }`), which keeps the
 * delete set exact without loading business rows into memory.
 *
 * S3 artifacts are NOT deleted inside the transaction. `collectObjectKeys`
 * reads them first (read-only) and `TenantPurgeService` erases the objects
 * through `IObjectStorage` before calling `purge`, so the DB transaction stays
 * short and a storage outage can never leave a half-deleted workspace.
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 500;
/** Physical purge of a large workspace can exceed Prisma's 5 s default. */
const PURGE_TRANSACTION_TIMEOUT_MS = 120_000;
const PURGE_TRANSACTION_MAX_WAIT_MS = 10_000;

export class PrismaTenantPurgeRepository implements ITenantPurgeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findPurgeable(cutoff: Date, limit: number): Promise<TenantRecord[]> {
    const take = normalizeLimit(limit);
    const records = await this.prisma.tenant.findMany({
      where: {
        status: 'DELETED',
        deletedAt: { not: null, lte: cutoff },
      },
      orderBy: { deletedAt: 'asc' },
      take,
    });
    return records.map(mapTenant);
  }

  /**
   * Reads every S3 artifact the transactional purge will orphan.
   *
   * Scope mirrors `purge` exactly:
   *  - `ticket_messages` / `message_attachments` through the ticket relation;
   *  - `webhook_events` by `tenant_id` OR by one of the workspace accounts
   *    (`account_id` is `ON DELETE SET NULL`, so legacy rows may have a NULL
   *    tenant and would otherwise survive the delete as orphans).
   *
   * Only the columns that carry a key/URI are selected; `content_payload` is
   * read solely for its `attachment_keys` metadata (never for body text) and
   * the webhook payload JSON is not loaded.
   */
  async collectObjectKeys(tenantId: string): Promise<TenantObjectKeys> {
    const accounts = await this.prisma.marketplaceAccount.findMany({
      where: { tenantId },
      select: { id: true },
    });
    const accountIds = accounts.map((account) => account.id);

    const [webhooks, attachments, messages] = await Promise.all([
      this.prisma.webhookEvent.findMany({
        where: {
          payloadS3Uri: { not: null },
          ...(accountIds.length === 0
            ? { tenantId }
            : { OR: [{ tenantId }, { accountId: { in: accountIds } }] }),
        },
        select: { payloadS3Uri: true },
      }),
      this.prisma.messageAttachment.findMany({
        where: { message: { ticket: { tenantId } } },
        select: { s3Uri: true },
      }),
      this.prisma.ticketMessage.findMany({
        where: { ticket: { tenantId } },
        select: { bodyRawS3Uri: true, contentPayload: true },
      }),
    ]);

    return {
      webhookPayloads: collect(webhooks.map((row) => row.payloadS3Uri)),
      messageBodies: collect(messages.map((row) => row.bodyRawS3Uri)),
      attachments: collect(attachments.map((row) => row.s3Uri)),
      metadataAttachments: collect(messages.flatMap((row) => attachmentKeys(row.contentPayload))),
    };
  }

  async purge(tenantId: string): Promise<TenantPurgeCounts> {
    return this.prisma.$transaction(
      async (tx) => {
        const counts: TenantPurgeCounts = {
          sessions: 0,
          invitations: 0,
          passwordResets: 0,
          emailVerifications: 0,
          twoFactorRecoveryCodes: 0,
          buyerPiiVault: 0,
          messageAttachments: 0,
          messages: 0,
          ticketEvents: 0,
          outboundAttempts: 0,
          tickets: 0,
          orders: 0,
          webhookEvents: 0,
          slaPolicies: 0,
          accounts: 0,
          agents: 0,
          tenant: 0,
        };

        // 1. Session/credential bookkeeping that carries `tenant_id` directly.
        counts.sessions = (await tx.session.deleteMany({ where: { tenantId } })).count;
        counts.invitations = (await tx.invitation.deleteMany({ where: { tenantId } })).count;

        // 2. Token tables are keyed by `user_id`, so resolve the operator ids
        //    first (only the id column is loaded).
        const agents = await tx.agent.findMany({
          where: { tenantId },
          select: { id: true },
        });
        const agentIds = agents.map((agent) => agent.id);

        if (agentIds.length > 0) {
          counts.passwordResets = (
            await tx.passwordReset.deleteMany({ where: { userId: { in: agentIds } } })
          ).count;
          counts.emailVerifications = (
            await tx.emailVerification.deleteMany({ where: { userId: { in: agentIds } } })
          ).count;
          counts.twoFactorRecoveryCodes = (
            await tx.twoFactorRecoveryCode.deleteMany({ where: { userId: { in: agentIds } } })
          ).count;
        }

        // 3. Conversation tree, scoped through the ticket parent relation.
        counts.buyerPiiVault = (
          await tx.buyerPiiVault.deleteMany({ where: { ticket: { tenantId } } })
        ).count;
        counts.messageAttachments = (
          await tx.messageAttachment.deleteMany({
            where: { message: { ticket: { tenantId } } },
          })
        ).count;
        counts.messages = (
          await tx.ticketMessage.deleteMany({ where: { ticket: { tenantId } } })
        ).count;
        counts.ticketEvents = (
          await tx.ticketEvent.deleteMany({ where: { ticket: { tenantId } } })
        ).count;
        counts.outboundAttempts = (
          await tx.outboundAttempt.deleteMany({ where: { ticket: { tenantId } } })
        ).count;
        counts.tickets = (await tx.supportTicket.deleteMany({ where: { tenantId } })).count;

        // 4. Store data (orders and SLA policies hang off the account).
        counts.orders = (
          await tx.orderCache.deleteMany({ where: { account: { tenantId } } })
        ).count;
        counts.slaPolicies = (
          await tx.slaPolicy.deleteMany({ where: { account: { tenantId } } })
        ).count;

        // `webhook_events.account_id` is `ON DELETE SET NULL`, so a legacy row
        // with a NULL `tenant_id` would survive the account delete as an orphan.
        // Scope by account id as well (only the id column is loaded).
        const accounts = await tx.marketplaceAccount.findMany({
          where: { tenantId },
          select: { id: true },
        });
        const accountIds = accounts.map((account) => account.id);
        counts.webhookEvents = (
          await tx.webhookEvent.deleteMany({
            where:
              accountIds.length === 0
                ? { tenantId }
                : { OR: [{ tenantId }, { accountId: { in: accountIds } }] },
          })
        ).count;

        counts.accounts = (
          await tx.marketplaceAccount.deleteMany({ where: { tenantId } })
        ).count;

        // 5. Operators, then the workspace row itself.
        counts.agents = (await tx.agent.deleteMany({ where: { tenantId } })).count;
        counts.tenant = (await tx.tenant.deleteMany({ where: { id: tenantId } })).count;

        return counts;
      },
      { timeout: PURGE_TRANSACTION_TIMEOUT_MS, maxWait: PURGE_TRANSACTION_MAX_WAIT_MS },
    );
  }
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/** Trimmed, non-empty, de-duplicated keys (order preserved). */
function collect(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const key = value.trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Outbox rows keep their attachment keys in
 * `content_payload.attachment_keys` (see `OutboundRouterService`). JSON is
 * untrusted, so anything that is not a non-empty string is ignored.
 */
function attachmentKeys(payload: Prisma.JsonValue | null | undefined): string[] {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const raw = (payload as Record<string, unknown>)['attachment_keys'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

export function createTenantPurgeRepository(prisma: PrismaClient): PrismaTenantPurgeRepository {
  return new PrismaTenantPurgeRepository(prisma);
}
