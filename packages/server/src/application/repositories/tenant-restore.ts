import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import type {
  ITenantRestoreRepository,
  Marketplace,
  RestoreTenantInput,
  RestoreTenantOutcome,
  TenantBackupCounts,
} from '@sac/shared';
import { ConflictError, ValidationError } from '@sac/shared';

import { isUniqueConstraintViolation } from './errors';
import { emptyBackupCounts } from './mappers';

/**
 * ============================================================================
 * PrismaTenantRestoreRepository - transactional restore (Fase 4)
 * ============================================================================
 *
 * Creates a BRAND-NEW workspace from a backup artifact. The source tenant is
 * never touched (it may not even exist anymore), and every business row gets a
 * new uuid:
 *
 *   tenant -> agents -> accounts -> orders -> tickets -> slaPolicies
 *          -> messages -> attachments -> events -> outboundAttempts
 *          -> webhookEvents -> tenant_backups (index of the restored artifact)
 *
 * Everything runs in ONE interactive transaction, so a failure never leaves a
 * half-restored workspace. The password hashes are computed by the service
 * BEFORE the transaction (bcrypt is intentionally not run while holding a DB
 * connection).
 *
 * Table decisions:
 *  - Agents: `mustResetPassword=true`, no 2FA secret, `isPlatformAdmin=false`.
 *    A backup can never re-grant the platform-admin flag.
 *  - Accounts: always `DISCONNECTED`, tokens/expiry cleared (the marketplace
 *    authorization belongs to the source workspace and must be redone).
 *  - Globally unique natural keys are disambiguated when the original still
 *    exists: agent e-mail (`+restored-...`), order external id and account
 *    external seller id (suffix). Message external ids and webhook event ids
 *    are preserved only when free; otherwise cleared (idempotency keys belong
 *    to the source workspace and must not collide).
 */
const RESTORE_TRANSACTION_TIMEOUT_MS = 120_000;
const RESTORE_TRANSACTION_MAX_WAIT_MS = 10_000;
const DEFAULT_AVATAR_COLOR = '#2563eb';
const DEFAULT_MAX_CONCURRENT = 20;

export class PrismaTenantRestoreRepository implements ITenantRestoreRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async restore(input: RestoreTenantInput): Promise<RestoreTenantOutcome> {
    try {
      return await this.prisma.$transaction(
        async (tx) => this.restoreInTransaction(tx, input),
        {
          timeout: RESTORE_TRANSACTION_TIMEOUT_MS,
          maxWait: RESTORE_TRANSACTION_MAX_WAIT_MS,
        },
      );
    } catch (error) {
      // The service checks the slug first; this covers two concurrent restores
      // racing for the same slug (or any residual unique collision).
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictError('Restore collided with an existing unique value', {
          code: 'RESTORE_CONFLICT',
        });
      }
      throw error;
    }
  }

  private async restoreInTransaction(
    tx: Prisma.TransactionClient,
    input: RestoreTenantInput,
  ): Promise<RestoreTenantOutcome> {
    const { payload } = input;
    if (input.passwordHashes.length !== payload.agents.length) {
      throw new ValidationError('Restore requires one password hash per agent', {
        agents: payload.agents.length,
        hashes: input.passwordHashes.length,
      });
    }

    // 1. The workspace. Status/commercial state is reset: a restored clone is
    //    active but starts a fresh trial; the plan/quotas are preserved.
    const tenant = await tx.tenant.create({
      data: {
        slug: input.newSlug,
        name: input.newName,
        status: 'ACTIVE',
        plan: payload.tenant.plan,
        maxAccounts: payload.tenant.maxAccounts,
        maxAgents: payload.tenant.maxAgents,
        billingStatus: 'TRIALING',
        trialEndsAt: null,
        billingEmail: payload.tenant.billingEmail,
        onboardingCompletedAt: null,
      },
    });

    const suffix = tenant.id.replace(/-/g, '').slice(0, 8);

    // 2. Operators: new ids, random passwords (hashed by the service), no 2FA
    //    secret and no platform-admin flag.
    const agentIds = new Map<string, string>();
    const takenEmails = await existingAgentEmails(
      tx,
      payload.agents.map((agent) => agent.email.trim().toLowerCase()),
    );
    const assignedEmails = new Set<string>();
    const agentData: Prisma.AgentCreateManyInput[] = payload.agents.map((agent, index) => {
      const id = randomUUID();
      agentIds.set(agent.id, id);

      const originalEmail = agent.email.trim().toLowerCase();
      let email = originalEmail;
      if (takenEmails.has(email) || assignedEmails.has(email)) {
        email = restoredEmail(originalEmail, input.newSlug, index);
      }
      assignedEmails.add(email);

      return {
        id,
        tenantId: tenant.id,
        email,
        name: truncate(agent.name, 120),
        passwordHash: input.passwordHashes[index] ?? '',
        role: agent.role,
        presence: 'OFFLINE',
        avatarColor: agent.avatarColor || DEFAULT_AVATAR_COLOR,
        maxConcurrent: Number.isFinite(agent.maxConcurrent)
          ? Math.max(1, Math.trunc(agent.maxConcurrent))
          : DEFAULT_MAX_CONCURRENT,
        isActive: agent.isActive !== false,
        lastSeenAt: null,
        emailVerifiedAt: optionalDate(agent.emailVerifiedAt),
        twoFactorSecretEnc: null,
        twoFactorEnabled: false,
        isPlatformAdmin: false,
        mustResetPassword: true,
        createdAt: optionalDate(agent.createdAt) ?? input.now,
        updatedAt: input.now,
      };
    });
    if (agentData.length > 0) await tx.agent.createMany({ data: agentData });

    // 3. Stores: DISCONNECTED and token-free. The composite unique key is
    //    disambiguated only when the original store still exists.
    const accountIds = new Map<string, string>();
    const takenAccounts = await existingAccountKeys(
      tx,
      payload.accounts.map((account) => ({
        marketplace: account.marketplace,
        externalSellerId: account.externalSellerId,
        marketplaceSiteId: account.marketplaceSiteId,
      })),
    );
    const assignedAccounts = new Set<string>();
    const accountData: Prisma.MarketplaceAccountCreateManyInput[] = payload.accounts.map(
      (account, index) => {
        const id = randomUUID();
        accountIds.set(account.id, id);

        const siteId = truncate(account.marketplaceSiteId, 32);
        let sellerId = truncate(account.externalSellerId, 128);
        const naturalKey = accountKey(account.marketplace, sellerId, siteId);
        if (takenAccounts.has(naturalKey) || assignedAccounts.has(naturalKey)) {
          const marker = `~r${suffix}${index + 1}`;
          sellerId = `${truncate(account.externalSellerId, 128 - marker.length)}${marker}`;
        }
        assignedAccounts.add(accountKey(account.marketplace, sellerId, siteId));

        return {
          id,
          tenantId: tenant.id,
          marketplace: account.marketplace,
          displayName: truncate(account.displayName, 160),
          externalSellerId: sellerId,
          marketplaceSiteId: siteId,
          accessTokenEnc: null,
          refreshTokenEnc: null,
          tokenExpiresAt: null,
          authExpiresAt: null,
          channelConfig: jsonObject(account.channelConfig),
          status: 'DISCONNECTED',
          lastTokenRefreshAt: null,
          lastErrorAt: null,
          lastError: null,
          createdAt: optionalDate(account.createdAt) ?? input.now,
          updatedAt: input.now,
        };
      },
    );
    if (accountData.length > 0) await tx.marketplaceAccount.createMany({ data: accountData });

    // 4. Orders BEFORE tickets: `support_tickets.order_cache_id` references the
    //    remapped order.
    const orderIds = new Map<string, string>();
    const takenOrders = await existingOrderKeys(
      tx,
      payload.orders.map((order) => ({
        marketplace: order.marketplace,
        externalOrderId: order.externalOrderId,
      })),
    );
    const assignedOrders = new Set<string>();
    const orderData: Prisma.OrderCacheCreateManyInput[] = payload.orders.map((order, index) => {
      const id = randomUUID();
      orderIds.set(order.id, id);

      const accountId = accountIds.get(order.accountId);
      if (accountId === undefined) {
        throw new ValidationError('Backup order references an unknown account', {
          orderId: order.id,
          accountId: order.accountId,
        });
      }

      let externalOrderId = truncate(order.externalOrderId, 128);
      const naturalKey = orderKey(order.marketplace, externalOrderId);
      if (takenOrders.has(naturalKey) || assignedOrders.has(naturalKey)) {
        const marker = `~r${suffix}${index + 1}`;
        externalOrderId = `${truncate(order.externalOrderId, 128 - marker.length)}${marker}`;
      }
      assignedOrders.add(orderKey(order.marketplace, externalOrderId));

      return {
        id,
        accountId,
        marketplace: order.marketplace,
        externalOrderId,
        packId: order.packId,
        buyerExternalId: order.buyerExternalId,
        buyerNameOrNick: order.buyerNameOrNick,
        buyerAnonymizedEmail: order.buyerAnonymizedEmail,
        orderStatus: truncate(order.orderStatus, 64),
        fulfillmentType: order.fulfillmentType,
        totalAmount:
          typeof order.totalAmount === 'number' && Number.isFinite(order.totalAmount)
            ? order.totalAmount
            : 0,
        currency: truncate(order.currency || 'BRL', 8),
        trackingNumber: order.trackingNumber,
        carrierName: order.carrierName,
        itemsSnapshot: jsonArray(order.itemsSnapshot),
        allowedActionsCache: jsonObject(order.allowedActionsCache),
        shippingSnapshot: jsonObject(order.shippingSnapshot),
        estimatedDeliveryAt: optionalDate(order.estimatedDeliveryAt),
        shippedAt: optionalDate(order.shippedAt),
        deliveredAt: optionalDate(order.deliveredAt),
        lastSyncedAt: optionalDate(order.lastSyncedAt) ?? input.now,
        createdAt: optionalDate(order.createdAt) ?? input.now,
        updatedAt: input.now,
      };
    });
    if (orderData.length > 0) await tx.orderCache.createMany({ data: orderData });

    // 5. Tickets: remap account/order/agent references.
    const ticketIds = new Map<string, string>();
    const ticketData: Prisma.SupportTicketCreateManyInput[] = payload.tickets.map((ticket) => {
      const id = randomUUID();
      ticketIds.set(ticket.id, id);

      const accountId = accountIds.get(ticket.accountId);
      if (accountId === undefined) {
        throw new ValidationError('Backup ticket references an unknown account', {
          ticketId: ticket.id,
          accountId: ticket.accountId,
        });
      }

      return {
        id,
        tenantId: tenant.id,
        accountId,
        marketplace: ticket.marketplace,
        ticketType: ticket.ticketType,
        externalReferenceId: truncate(ticket.externalReferenceId, 180),
        externalOrderId: ticket.externalOrderId,
        orderCacheId: ticket.orderCacheId ? orderIds.get(ticket.orderCacheId) ?? null : null,
        packId: ticket.packId,
        claimId: ticket.claimId,
        conversationId: ticket.conversationId,
        returnSn: ticket.returnSn,
        subject: ticket.subject,
        buyerExternalId: ticket.buyerExternalId,
        buyerDisplayName: ticket.buyerDisplayName,
        buyerAnonymizedEmail: ticket.buyerAnonymizedEmail,
        buyerContactHash: ticket.buyerContactHash,
        hasActiveClaim: ticket.hasActiveClaim === true,
        status: ticket.status,
        priority: ticket.priority,
        slaDeadlineAt: requiredDate(ticket.slaDeadlineAt, 'ticket.slaDeadlineAt'),
        slaTargetAt: optionalDate(ticket.slaTargetAt),
        slaLegMinutes: ticket.slaLegMinutes,
        slaBreached: ticket.slaBreached === true,
        slaState: ticket.slaState,
        firstResponseAt: optionalDate(ticket.firstResponseAt),
        resolvedAt: optionalDate(ticket.resolvedAt),
        lastInboundAt: optionalDate(ticket.lastInboundAt),
        lastOutboundAt: optionalDate(ticket.lastOutboundAt),
        lastMessageAt: optionalDate(ticket.lastMessageAt),
        unreadCount: Number.isFinite(ticket.unreadCount) ? Math.max(0, ticket.unreadCount) : 0,
        assignedAgentId: ticket.assignedAgentId
          ? agentIds.get(ticket.assignedAgentId) ?? null
          : null,
        assignedQueue: ticket.assignedQueue,
        channelMetadata: jsonObject(ticket.channelMetadata),
        tags: Array.isArray(ticket.tags)
          ? ticket.tags.filter((tag): tag is string => typeof tag === 'string')
          : [],
        createdAt: optionalDate(ticket.createdAt) ?? input.now,
        updatedAt: input.now,
      };
    });
    if (ticketData.length > 0) await tx.supportTicket.createMany({ data: ticketData });

    // 6. SLA policies hang off the (remapped) account.
    const slaData: Prisma.SlaPolicyCreateManyInput[] = payload.slaPolicies.map((policy) => ({
      id: randomUUID(),
      accountId: policy.accountId ? accountIds.get(policy.accountId) ?? null : null,
      marketplace: policy.marketplace,
      ticketType: policy.ticketType,
      firstResponseMinutes: policy.firstResponseMinutes,
      targetMinutes: policy.targetMinutes,
      warningMinutes: policy.warningMinutes,
      businessHoursOnly: policy.businessHoursOnly === true,
      isActive: policy.isActive !== false,
      createdAt: input.now,
    }));
    if (slaData.length > 0) await tx.slaPolicy.createMany({ data: slaData });

    // 7. Messages: external ids are idempotency keys of the SOURCE workspace.
    //    They are preserved only when globally free.
    const messageIds = new Map<string, string>();
    const takenMessageIds = await existingMessageExternalIds(
      tx,
      payload.messages
        .map((message) => message.externalMessageId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );
    const assignedMessageIds = new Set<string>();
    const messageData: Prisma.TicketMessageCreateManyInput[] = payload.messages.map((message) => {
      const id = randomUUID();
      messageIds.set(message.id, id);

      const ticketId = ticketIds.get(message.ticketId);
      if (ticketId === undefined) {
        throw new ValidationError('Backup message references an unknown ticket', {
          messageId: message.id,
          ticketId: message.ticketId,
        });
      }

      let externalMessageId = message.externalMessageId ?? null;
      if (externalMessageId !== null) {
        if (takenMessageIds.has(externalMessageId) || assignedMessageIds.has(externalMessageId)) {
          externalMessageId = null;
        } else {
          assignedMessageIds.add(externalMessageId);
        }
      }

      return {
        id,
        ticketId,
        externalMessageId,
        inReplyToId: message.inReplyToId,
        referencesIds: Array.isArray(message.referencesIds)
          ? message.referencesIds.filter((value): value is string => typeof value === 'string')
          : [],
        direction: message.direction,
        channelRouteUsed: message.channelRouteUsed,
        messageType: truncate(message.messageType || 'text', 32),
        bodyCleanText: message.bodyCleanText ?? '',
        bodyHtml: message.bodyHtml,
        contentPayload: jsonObject(message.contentPayload),
        bodyRawS3Uri: message.bodyRawS3Uri,
        deliveryStatus: message.deliveryStatus,
        errorDetail: message.errorDetail,
        isInternalNote: message.isInternalNote === true,
        authorAgentId: message.authorAgentId
          ? agentIds.get(message.authorAgentId) ?? null
          : null,
        marketplaceCreatedAt: requiredDate(
          message.marketplaceCreatedAt,
          'message.marketplaceCreatedAt',
        ),
        sentAt: optionalDate(message.sentAt),
        deliveredAt: optionalDate(message.deliveredAt),
        readAt: optionalDate(message.readAt),
        createdAt: optionalDate(message.createdAt) ?? input.now,
        updatedAt: input.now,
      };
    });
    if (messageData.length > 0) await tx.ticketMessage.createMany({ data: messageData });

    // 8. Attachments: metadata only (the binary stays in object storage).
    const attachmentData: Prisma.MessageAttachmentCreateManyInput[] = payload.attachments.map(
      (attachment) => {
        const messageId = messageIds.get(attachment.messageId);
        if (messageId === undefined) {
          throw new ValidationError('Backup attachment references an unknown message', {
            attachmentId: attachment.id,
            messageId: attachment.messageId,
          });
        }
        return {
          id: randomUUID(),
          messageId,
          fileName: truncate(attachment.fileName, 255),
          mimeType: truncate(attachment.mimeType, 120),
          sizeBytes: Number.isFinite(attachment.sizeBytes)
            ? Math.max(0, Math.trunc(attachment.sizeBytes))
            : 0,
          sha256: attachment.sha256,
          s3Uri: truncate(attachment.s3Uri, 512),
          externalUploadId: attachment.externalUploadId,
          isEvidence: attachment.isEvidence === true,
          createdAt: optionalDate(attachment.createdAt) ?? input.now,
        };
      },
    );
    if (attachmentData.length > 0) {
      await tx.messageAttachment.createMany({ data: attachmentData });
    }

    // 9. Audit timeline.
    const eventData: Prisma.TicketEventCreateManyInput[] = payload.events.map((event) => {
      const ticketId = ticketIds.get(event.ticketId);
      if (ticketId === undefined) {
        throw new ValidationError('Backup event references an unknown ticket', {
          eventId: event.id,
          ticketId: event.ticketId,
        });
      }
      return {
        id: randomUUID(),
        ticketId,
        eventType: truncate(event.eventType, 64),
        actorAgentId: event.actorAgentId ? agentIds.get(event.actorAgentId) ?? null : null,
        actorLabel: event.actorLabel,
        payload: jsonObject(event.payload),
        createdAt: optionalDate(event.createdAt) ?? input.now,
      };
    });
    if (eventData.length > 0) await tx.ticketEvent.createMany({ data: eventData });

    // 10. Routing audit.
    const attemptData: Prisma.OutboundAttemptCreateManyInput[] = payload.outboundAttempts.map(
      (attempt) => {
        const ticketId = ticketIds.get(attempt.ticketId);
        if (ticketId === undefined) {
          throw new ValidationError('Backup outbound attempt references an unknown ticket', {
            attemptId: attempt.id,
            ticketId: attempt.ticketId,
          });
        }
        return {
          id: randomUUID(),
          ticketId,
          messageId: attempt.messageId ? messageIds.get(attempt.messageId) ?? null : null,
          channelRoute: attempt.channelRoute,
          status: attempt.status,
          requestPayload: jsonObject(attempt.requestPayload),
          responsePayload: jsonObject(attempt.responsePayload),
          httpStatus: attempt.httpStatus,
          attempt: Number.isFinite(attempt.attempt) ? Math.max(1, attempt.attempt) : 1,
          errorCode: attempt.errorCode,
          errorMessage: attempt.errorMessage,
          durationMs: attempt.durationMs,
          createdAt: optionalDate(attempt.createdAt) ?? input.now,
        };
      },
    );
    if (attemptData.length > 0) {
      await tx.outboundAttempt.createMany({ data: attemptData });
    }

    // 11. Webhook audit rows: no raw payload, no S3 pointer, no `resource`.
    const takenEvents = await existingWebhookEventKeys(
      tx,
      payload.webhookEvents
        .filter((event) => typeof event.eventId === 'string' && event.eventId.length > 0)
        .map((event) => ({ marketplace: event.marketplace, eventId: event.eventId as string })),
    );
    const assignedEvents = new Set<string>();
    const webhookData: Prisma.WebhookEventCreateManyInput[] = payload.webhookEvents.map(
      (event) => {
        let eventId = event.eventId ?? null;
        if (eventId !== null) {
          const naturalKey = `${event.marketplace}\u0000${eventId}`;
          if (takenEvents.has(naturalKey) || assignedEvents.has(naturalKey)) {
            eventId = null;
          } else {
            assignedEvents.add(naturalKey);
          }
        }

        return {
          id: randomUUID(),
          marketplace: event.marketplace,
          accountId: event.accountId ? accountIds.get(event.accountId) ?? null : null,
          tenantId: tenant.id,
          eventId,
          topic: event.topic,
          resource: null,
          status: event.status,
          signatureValid: event.signatureValid === true,
          payload: {},
          payloadS3Uri: null,
          attempts: Number.isFinite(event.attempts) ? Math.max(0, event.attempts) : 0,
          error: null,
          receivedAt: optionalDate(event.receivedAt) ?? input.now,
          processedAt: optionalDate(event.processedAt),
        };
      },
    );
    if (webhookData.length > 0) await tx.webhookEvent.createMany({ data: webhookData });

    // 12. Index the restored artifact under the NEW workspace, so the console
    //     can see where the data came from.
    const counts = countsOf(payload);
    await tx.tenantBackup.create({
      data: {
        tenantId: tenant.id,
        s3Key: truncate(input.backupKey, 512),
        sizeBytes: input.sizeBytes,
        counts: counts as unknown as Prisma.InputJsonValue,
        createdBy: input.createdBy,
        createdAt: input.now,
      },
    });

    return { tenantId: tenant.id, slug: tenant.slug, counts };
  }
}

/* ====================================================================== */
/* Helpers                                                                */
/* ====================================================================== */

function countsOf(payload: RestoreTenantInput['payload']): TenantBackupCounts {
  const counts = emptyBackupCounts();
  counts.agents = payload.agents.length;
  counts.accounts = payload.accounts.length;
  counts.tickets = payload.tickets.length;
  counts.messages = payload.messages.length;
  counts.attachments = payload.attachments.length;
  counts.events = payload.events.length;
  counts.outboundAttempts = payload.outboundAttempts.length;
  counts.orders = payload.orders.length;
  counts.slaPolicies = payload.slaPolicies.length;
  counts.webhookEvents = payload.webhookEvents.length;
  return counts;
}

function truncate(value: string, max: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length <= max ? text : text.slice(0, max);
}

function optionalDate(value: string | null | undefined): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function requiredDate(value: string, field: string): Date {
  const date = optionalDate(value);
  if (date === null) {
    throw new ValidationError(`Backup field "${field}" is not a valid date`, { field });
  }
  return date;
}

function jsonObject(value: unknown): Prisma.InputJsonValue {
  return (value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}) as Prisma.InputJsonValue;
}

function jsonArray(value: unknown): Prisma.InputJsonValue {
  return (Array.isArray(value) ? value : []) as Prisma.InputJsonValue;
}

function accountKey(
  marketplace: string,
  externalSellerId: string,
  marketplaceSiteId: string,
): string {
  return `${marketplace}\u0000${externalSellerId}\u0000${marketplaceSiteId}`;
}

function orderKey(marketplace: string, externalOrderId: string): string {
  return `${marketplace}\u0000${externalOrderId}`;
}

/**
 * Alias for an e-mail that already exists in the database. Keeps the original
 * local part and domain (so the operator recognizes the address) and adds a
 * deterministic `+restored-<slug>-<n>` tag, capped at the column length.
 */
function restoredEmail(email: string, slug: string, index: number): string {
  const at = email.lastIndexOf('@');
  const local = at > 0 ? email.slice(0, at) : email;
  const domain = at > 0 ? email.slice(at) : '@restored.local';
  const tag = `+restored-${slug}-${index + 1}`;
  const maxLocal = Math.max(1, 180 - domain.length - tag.length);
  return `${local.slice(0, maxLocal)}${tag}${domain}`.slice(0, 180);
}

async function existingAgentEmails(
  tx: Prisma.TransactionClient,
  emails: string[],
): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await tx.agent.findMany({
    where: { email: { in: emails } },
    select: { email: true },
  });
  return new Set(rows.map((row) => row.email));
}

async function existingAccountKeys(
  tx: Prisma.TransactionClient,
  accounts: Array<{
    marketplace: Marketplace;
    externalSellerId: string;
    marketplaceSiteId: string;
  }>,
): Promise<Set<string>> {
  if (accounts.length === 0) return new Set();
  const rows = await tx.marketplaceAccount.findMany({
    where: {
      OR: accounts.map((account) => ({
        marketplace: account.marketplace,
        externalSellerId: account.externalSellerId,
        marketplaceSiteId: account.marketplaceSiteId,
      })),
    },
    select: { marketplace: true, externalSellerId: true, marketplaceSiteId: true },
  });
  return new Set(
    rows.map((row) => accountKey(row.marketplace, row.externalSellerId, row.marketplaceSiteId)),
  );
}

async function existingOrderKeys(
  tx: Prisma.TransactionClient,
  orders: Array<{ marketplace: Marketplace; externalOrderId: string }>,
): Promise<Set<string>> {
  if (orders.length === 0) return new Set();
  const rows = await tx.orderCache.findMany({
    where: {
      OR: orders.map((order) => ({
        marketplace: order.marketplace,
        externalOrderId: order.externalOrderId,
      })),
    },
    select: { marketplace: true, externalOrderId: true },
  });
  return new Set(rows.map((row) => orderKey(row.marketplace, row.externalOrderId)));
}

async function existingMessageExternalIds(
  tx: Prisma.TransactionClient,
  externalIds: string[],
): Promise<Set<string>> {
  if (externalIds.length === 0) return new Set();
  const rows = await tx.ticketMessage.findMany({
    where: { externalMessageId: { in: externalIds } },
    select: { externalMessageId: true },
  });
  return new Set(
    rows
      .map((row) => row.externalMessageId)
      .filter((value): value is string => typeof value === 'string'),
  );
}

async function existingWebhookEventKeys(
  tx: Prisma.TransactionClient,
  events: Array<{ marketplace: Marketplace; eventId: string }>,
): Promise<Set<string>> {
  if (events.length === 0) return new Set();
  const rows = await tx.webhookEvent.findMany({
    where: {
      OR: events.map((event) => ({
        marketplace: event.marketplace,
        eventId: event.eventId,
      })),
    },
    select: { marketplace: true, eventId: true },
  });
  return new Set(
    rows
      .filter((row) => typeof row.eventId === 'string')
      .map((row) => `${row.marketplace}\u0000${row.eventId as string}`),
  );
}

export function createTenantRestoreRepository(prisma: PrismaClient): PrismaTenantRestoreRepository {
  return new PrismaTenantRestoreRepository(prisma);
}
