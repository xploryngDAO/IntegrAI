import { createHash, randomUUID } from 'node:crypto';

import {
  CACHE_KEYS,
  QUEUE_NAMES,
  RETRY_POLICY,
  TERMINAL_TICKET_STATUSES,
} from '@sac/shared';
import type {
  BuyerPiiRecord,
  BuyerPiiSnapshot,
  ChannelRoute,
  ChannelRuntimeConfig,
  CreateAttachmentInput,
  DeliveryStatus,
  HydratedInboundMessage,
  IAccountRepository,
  IAdapterRegistry,
  IAgentRepository,
  IAttachmentRepository,
  ICache,
  IClock,
  IHttpClient,
  ILogger,
  IMessageRepository,
  IObjectStorage,
  IOrderRepository,
  IPiiVaultRepository,
  IQueuePublisher,
  IRealtimePublisher,
  ISlaPolicyRepository,
  ITicketEventRepository,
  ITicketRepository,
  IngestOutcome,
  IUnifiedTicketService,
  Marketplace,
  MessageDirection,
  OrderCacheRecord,
  SupportTicketRecord,
  TicketMessageRecord,
  TicketPriority,
  TicketStatus,
  TicketType,
} from '@sac/shared';
import { ConflictError, NotFoundError, ValidationError } from '@sac/shared';

import { readDueDate, readStringMetadata } from './mappers';
import { enqueueEnrichment } from '../queues/producers';
import type { SlaEngine, SlaPlan } from './sla/SlaEngine';

/**
 * ============================================================================
 * UnifiedTicketService
 * ============================================================================
 *
 * The write-side heart of the hub: turns a normalized inbound message from any
 * channel into (or onto) a unified ticket.
 *
 * Threading order (Amazon blueprint, generalized):
 *   1. exact `external_reference_id` match while the thread is still usable;
 *   2. `In-Reply-To` / `References` resolved against
 *      `ticket_messages.external_message_id`;
 *   3. the marketplace adapter resolver (`findThreadingMatch` on Amazon:
 *      headers -> order id (< 30 days) -> open PRE_SALE by buyer e-mail);
 *   4. active ticket by external order id;
 *   5. open PRE_SALE ticket by anonymized buyer e-mail;
 *   6. a brand-new ticket with an SLA computed by `SlaEngine`.
 *
 * Every message is inserted with `messages.createIdempotent`, so a webhook
 * replay is a no-op. Counters, SLA legs, first-response, order links and the PII
 * vault are updated in the same call; realtime events are published last.
 */

const MAX_TEXT_LENGTH = 200_000;
const THREAD_LOOKBACK_DAYS = 30;
const CLOSED_THREAD_REOPEN_DAYS = 3;
const PII_CACHE_TTL_SECONDS = 900;
const STICKY_AGENT_TTL_SECONDS = 2 * 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

const ALLOWED_DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'BOUNCED_BLOCKED',
  'MODERATION_REJECTED',
  'FAILED',
];

export interface UnifiedTicketServiceDependencies {
  logger: ILogger;
  clock: IClock;
  cache: ICache;
  queue: IQueuePublisher;
  realtime: IRealtimePublisher;
  config: ChannelRuntimeConfig;
  storage: IObjectStorage;
  http?: IHttpClient;
  slaEngine: SlaEngine;
  adapters: IAdapterRegistry;
  repos: {
    accounts: IAccountRepository;
    agents: IAgentRepository;
    tickets: ITicketRepository;
    messages: IMessageRepository;
    orders: IOrderRepository;
    attachments: IAttachmentRepository;
    piiVault: IPiiVaultRepository;
    ticketEvents: ITicketEventRepository;
    slaPolicies: ISlaPolicyRepository;
  };
}

interface ThreadResolution {
  ticket: SupportTicketRecord | null;
  strategy: string;
  created: boolean;
}

export class UnifiedTicketService implements IUnifiedTicketService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly cache: ICache;
  private readonly queue: IQueuePublisher;
  private readonly realtime: IRealtimePublisher;
  private readonly config: ChannelRuntimeConfig;
  private readonly storage: IObjectStorage;
  private readonly http: IHttpClient | null;
  private readonly slaEngine: SlaEngine;
  private readonly adapters: IAdapterRegistry;
  private readonly repos: UnifiedTicketServiceDependencies['repos'];

  constructor(deps: UnifiedTicketServiceDependencies) {
    this.logger = deps.logger.child({ component: 'UnifiedTicketService' });
    this.clock = deps.clock;
    this.cache = deps.cache;
    this.queue = deps.queue;
    this.realtime = deps.realtime;
    this.config = deps.config;
    this.storage = deps.storage;
    this.http = deps.http ?? null;
    this.slaEngine = deps.slaEngine;
    this.adapters = deps.adapters;
    this.repos = deps.repos;
  }

  /* ==================================================================== */
  /* Ingest                                                               */
  /* ==================================================================== */

  async ingest(message: HydratedInboundMessage): Promise<IngestOutcome> {
    const warnings: string[] = [...(message.warnings ?? [])];
    const now = this.clock.now();

    const account = await this.repos.accounts.findById(message.accountId);
    if (!account) {
      throw new NotFoundError('MarketplaceAccount', message.accountId);
    }

    // 1. Resolve (or create) the ticket -----------------------------------
    const resolution = await this.resolveThread(message);
    const plan = await this.computePlan(message);

    let ticket = resolution.ticket;
    let created = false;

    if (!ticket) {
      ticket = await this.createTicket(message, plan);
      created = true;
    }

    // 2. Idempotent message insert ----------------------------------------
    const messageResult = await this.repos.messages.createIdempotent({
      ticketId: ticket.id,
      externalMessageId: message.externalMessageId || null,
      inReplyToId: message.inReplyToId ?? null,
      referencesIds: message.references ?? [],
      direction: message.direction,
      channelRouteUsed: message.channelRouteUsed,
      messageType: message.messageType || 'text',
      bodyCleanText: truncate(message.bodyCleanText ?? '', MAX_TEXT_LENGTH),
      bodyHtml: message.bodyHtml ? truncate(message.bodyHtml, MAX_TEXT_LENGTH) : null,
      contentPayload: this.buildContentPayload(message),
      bodyRawS3Uri: message.bodyRawS3Uri ?? null,
      deliveryStatus: this.inboundDeliveryStatus(message),
      isInternalNote: false,
      authorAgentId: null,
      marketplaceCreatedAt: this.safeMarketplaceDate(message.marketplaceCreatedAt, now),
      sentAt: null,
      deliveredAt: null,
      readAt: null,
    });

    if (!messageResult.created) {
      this.logger.debug('ticket.ingest.duplicate_message', {
        ticketId: ticket.id,
        marketplace: message.marketplace,
        externalMessageId: message.externalMessageId,
      });
      return {
        ticketId: ticket.id,
        created,
        messageId: messageResult.record.id,
        duplicate: true,
        warnings,
      };
    }

    const storedMessage = messageResult.record;

    // 3. Upsert the order snapshot and link it (only for a new message: a
    //    webhook replay must not touch anything).
    const order = await this.syncOrder(message, ticket, warnings);

    // 4. Attachments ------------------------------------------------------
    const attachmentCount = await this.persistAttachments(storedMessage.id, message, warnings);

    // 5. Ticket counters / status / SLA leg -------------------------------
    const updatedTicket = await this.applyTicketEffects(
      ticket,
      message,
      plan,
      storedMessage,
      order,
      created,
      warnings,
    );

    // 6. PII vault (Amazon restricted data) -------------------------------
    if (message.buyerPii) {
      await this.persistPii(message, updatedTicket.id, warnings);
    }

    // 7. Audit timeline ---------------------------------------------------
    if (created) {
      await this.appendEvent(updatedTicket.id, 'TICKET_CREATED', null, 'adapter', {
        marketplace: message.marketplace,
        ticketType: message.ticketType,
        strategy: resolution.strategy,
        slaSource: plan.source,
        queue: plan.queue,
        slaDeadlineAt: plan.deadlineAt.toISOString(),
      });
    }
    await this.appendEvent(
      updatedTicket.id,
      this.eventTypeForDirection(message.direction),
      null,
      this.actorLabelForMessage(message),
      {
        messageId: storedMessage.id,
        externalMessageId: message.externalMessageId,
        direction: message.direction,
        channelRouteUsed: message.channelRouteUsed,
        messageType: message.messageType,
        attachments: attachmentCount,
      },
    );
    if (order && (created || !ticket.orderCacheId)) {
      await this.appendEvent(updatedTicket.id, 'ORDER_LINKED', null, 'system', {
        externalOrderId: order.externalOrderId,
        orderCacheId: order.id,
      });
    }

    // 8. Realtime ---------------------------------------------------------
    this.emitTicketUpdated(updatedTicket);
    this.emitMessageCreated(updatedTicket.id, storedMessage);
    this.realtime.queueChanged({
      reason: created ? 'ticket_created' : 'inbound_message',
      ticketId: updatedTicket.id,
      at: now.toISOString(),
    });

    // 9. Lazy order enrichment (Amazon) -----------------------------------
    await this.maybeEnqueueEnrichment(message, updatedTicket, order, created);

    if (warnings.length > 0) {
      this.logger.debug('ticket.ingest.warnings', {
        ticketId: updatedTicket.id,
        marketplace: message.marketplace,
        warnings,
      });
    }

    return {
      ticketId: updatedTicket.id,
      created,
      messageId: storedMessage.id,
      duplicate: false,
      warnings,
    };
  }

  /* ==================================================================== */
  /* Thread resolution                                                    */
  /* ==================================================================== */

  private async resolveThread(message: HydratedInboundMessage): Promise<ThreadResolution> {
    const marketplace = message.marketplace;

    // 1. Exact external reference (Meli question/claim, Shopee conversation,
    //    Amazon order id). Only if the thread is still usable.
    if (message.externalReferenceId) {
      const byReference = await this.repos.tickets.findByExternalReference(
        marketplace,
        message.externalReferenceId,
      );
      if (byReference && this.canContinueThread(byReference, message.marketplaceCreatedAt)) {
        return { ticket: byReference, strategy: 'EXTERNAL_REFERENCE', created: false };
      }
    }

    // 2. Reply headers against persisted marketplace message ids.
    const byHeaders = await this.findByReplyHeaders(message);
    if (byHeaders) {
      return { ticket: byHeaders, strategy: 'REPLY_HEADERS', created: false };
    }

    // 3. Adapter resolver (Amazon blueprint: headers -> order -> e-mail).
    try {
      const adapterMatch = await this.repos.tickets.findThreadingMatch({
        marketplace,
        accountId: message.accountId,
        inReplyToIds: this.collectReplyIds(message),
        externalOrderId: message.externalOrderId ?? null,
        buyerAnonymizedEmail: message.buyer.anonymizedEmail ?? null,
        activeWithinDays: THREAD_LOOKBACK_DAYS,
      });
      if (adapterMatch && this.canContinueThread(adapterMatch, message.marketplaceCreatedAt)) {
        return { ticket: adapterMatch, strategy: 'THREADING_MATCH', created: false };
      }
    } catch (error) {
      this.logger.warn('ticket.ingest.threading_lookup_failed', {
        marketplace,
        error: errorMessage(error),
      });
    }

    // 4. Active ticket by external order id (< 30 days).
    if (message.externalOrderId) {
      const byOrder = await this.repos.tickets.findActiveByExternalOrderId(
        marketplace,
        message.externalOrderId,
        THREAD_LOOKBACK_DAYS,
      );
      if (byOrder && this.canContinueThread(byOrder, message.marketplaceCreatedAt)) {
        return { ticket: byOrder, strategy: 'EXTERNAL_ORDER_ID', created: false };
      }
    }

    // 5. Open pre-sale ticket by anonymized buyer e-mail.
    if (message.buyer.anonymizedEmail) {
      const byEmail = await this.repos.tickets.findOpenPreSaleByBuyerEmail(
        marketplace,
        message.buyer.anonymizedEmail,
      );
      if (byEmail && this.canContinueThread(byEmail, message.marketplaceCreatedAt)) {
        return { ticket: byEmail, strategy: 'PRE_SALE_EMAIL', created: false };
      }
    }

    return { ticket: null, strategy: 'NEW_TICKET', created: true };
  }

  private async findByReplyHeaders(message: HydratedInboundMessage): Promise<SupportTicketRecord | null> {
    const ids = this.collectReplyIds(message);
    for (const id of ids) {
      if (!id) continue;
      try {
        const stored = await this.repos.messages.findByExternalMessageId(id);
        if (!stored) continue;
        const ticket = await this.repos.tickets.findById(stored.ticketId);
        if (ticket && this.canContinueThread(ticket, message.marketplaceCreatedAt)) {
          return ticket;
        }
      } catch (error) {
        this.logger.debug('ticket.ingest.reply_lookup_failed', {
          marketplace: message.marketplace,
          error: errorMessage(error),
        });
      }
    }
    return null;
  }

  private collectReplyIds(message: HydratedInboundMessage): string[] {
    const ids: string[] = [];
    if (message.inReplyToId) ids.push(message.inReplyToId);
    for (const reference of message.references ?? []) {
      if (reference) ids.push(reference);
    }
    return ids;
  }

  /**
   * A closed thread is reopened by a late buyer reply for up to 3 days; after
   * that we create a new ticket so the queue does not resurrect ancient items.
   */
  private canContinueThread(ticket: SupportTicketRecord, at: Date): boolean {
    if (!(TERMINAL_TICKET_STATUSES as readonly string[]).includes(ticket.status)) return true;
    const anchor = ticket.lastMessageAt ?? ticket.updatedAt ?? ticket.createdAt;
    return at.getTime() - anchor.getTime() <= CLOSED_THREAD_REOPEN_DAYS * DAY_MS;
  }

  /* ==================================================================== */
  /* Ticket creation / update                                             */
  /* ==================================================================== */

  private async computePlan(message: HydratedInboundMessage): Promise<SlaPlan> {
    return this.slaEngine.computePlan({
      accountId: message.accountId,
      marketplace: message.marketplace,
      ticketType: message.ticketType,
      receivedAt: message.marketplaceCreatedAt,
      hasActiveClaim: message.hasActiveClaim === true || message.ticketType === 'CLAIM_DISPUTE',
      claimDueDate: message.slaDeadlineAt ?? readDueDate(message.channelMetadata),
      priorityHint: message.priority,
      queueHint: readStringMetadata(message.channelMetadata, 'queue'),
      metadata: message.channelMetadata,
    });
  }

  private async createTicket(
    message: HydratedInboundMessage,
    plan: SlaPlan,
  ): Promise<SupportTicketRecord> {
    const now = this.clock.now();
    const status = this.initialStatus(message);
    const isInbound = this.isBuyerInbound(message.direction);
    const isOutboundAgent = message.direction === 'OUTBOUND_AGENT';
    const terminal = (TERMINAL_TICKET_STATUSES as readonly string[]).includes(status);

    const externalReferenceId =
      message.externalReferenceId ||
      message.externalOrderId ||
      message.buyer.anonymizedEmail ||
      `${message.marketplace}:${message.externalMessageId || randomUUID()}`;

    const channelMetadata: Record<string, unknown> = {
      ...message.channelMetadata,
    };
    if (message.hasActiveClaim) channelMetadata.has_active_claim = true;
    if (!channelMetadata['marketplace_site']) {
      channelMetadata['marketplace_site'] = message.marketplace;
    }

    const ticket = await this.repos.tickets.create({
      accountId: message.accountId,
      marketplace: message.marketplace,
      ticketType: message.ticketType,
      externalReferenceId,
      externalOrderId: message.externalOrderId ?? null,
      packId: message.packId ?? null,
      claimId: message.claimId ?? null,
      conversationId: message.conversationId ?? null,
      returnSn: message.returnSn ?? null,
      subject: this.deriveSubject(message),
      buyerExternalId: message.buyer.externalId ?? null,
      buyerDisplayName: message.buyer.displayName ?? null,
      buyerAnonymizedEmail: message.buyer.anonymizedEmail ?? null,
      buyerContactHash: message.buyer.contactHash ?? null,
      hasActiveClaim:
        message.hasActiveClaim === true || message.ticketType === 'CLAIM_DISPUTE',
      status,
      priority: plan.priority,
      slaDeadlineAt: plan.deadlineAt,
      slaTargetAt: plan.targetAt,
      slaLegMinutes: plan.slaLegMinutes,
      assignedQueue: plan.queue,
      channelMetadata,
      tags: this.tagsFor(message),
      isDemo: false,
    });

    // Fields that the repository's create input intentionally does not accept
    // but that the unified record exposes are patched immediately.
    const patch: Parameters<ITicketRepository['update']>[1] = {};
    if (isInbound) {
      patch.lastInboundAt = message.marketplaceCreatedAt;
      patch.unreadCount = 1;
    } else if (isOutboundAgent) {
      patch.lastOutboundAt = message.marketplaceCreatedAt;
      patch.firstResponseAt = message.marketplaceCreatedAt;
    }
    patch.lastMessageAt = message.marketplaceCreatedAt;
    if (terminal) {
      patch.resolvedAt = now;
    }
    if (Object.keys(patch).length > 0) {
      return this.repos.tickets.update(ticket.id, patch);
    }
    return ticket;
  }

  private async applyTicketEffects(
    ticket: SupportTicketRecord,
    message: HydratedInboundMessage,
    plan: SlaPlan,
    storedMessage: TicketMessageRecord,
    order: OrderCacheRecord | null,
    created: boolean,
    warnings: string[],
  ): Promise<SupportTicketRecord> {
    const now = this.clock.now();
    const patch: Parameters<ITicketRepository['update']>[1] = {};

    const isInbound = this.isBuyerInbound(message.direction);
    const isOutboundAgent = message.direction === 'OUTBOUND_AGENT';
    const isExternalPanel = message.direction === 'EXTERNAL_SELLER_PANEL';
    const isMediator = message.direction === 'MEDIATOR';
    const isSystem = message.direction === 'OUTBOUND_SYSTEM';

    // --- status transition ------------------------------------------------
    const nextStatus = this.nextStatus(ticket, message);
    if (nextStatus !== ticket.status) patch.status = nextStatus;

    // --- unread counter ---------------------------------------------------
    if ((isInbound || isMediator) && !isSystem) {
      if (created) patch.unreadCount = 1;
      else {
        try {
          const unread = await this.repos.tickets.incrementUnread(ticket.id, 1);
          patch.unreadCount = unread;
        } catch (error) {
          warnings.push('UNREAD_COUNTER_FAILED');
          this.logger.warn('ticket.ingest.unread_failed', {
            ticketId: ticket.id,
            error: errorMessage(error),
          });
        }
      }
    }

    // --- timestamps -------------------------------------------------------
    if (isInbound || isExternalPanel || isMediator) {
      patch.lastInboundAt = laterOf(ticket.lastInboundAt, message.marketplaceCreatedAt);
    }
    if (isOutboundAgent) {
      patch.lastOutboundAt = laterOf(ticket.lastOutboundAt, message.marketplaceCreatedAt);
      if (!ticket.firstResponseAt) patch.firstResponseAt = message.marketplaceCreatedAt;
    }
    patch.lastMessageAt = laterOf(ticket.lastMessageAt, message.marketplaceCreatedAt);

    // --- SLA leg ----------------------------------------------------------
    if ((isInbound || isMediator) && !created) {
      patch.slaDeadlineAt = plan.deadlineAt;
      patch.slaTargetAt = plan.targetAt;
      patch.slaLegMinutes = plan.slaLegMinutes;
      patch.slaState = 'ON_TRACK';
      patch.slaBreached = false;
      patch.priority = strongestPriority(ticket.priority, plan.priority);
    }

    // --- terminal re-open / resolution -----------------------------------
    if (isInbound && (TERMINAL_TICKET_STATUSES as readonly string[]).includes(ticket.status)) {
      patch.resolvedAt = null;
    }
    if (nextStatus === 'RESOLVED') patch.resolvedAt = now;
    if (nextStatus === 'NO_RESPONSE_NEEDED' && !ticket.resolvedAt) patch.resolvedAt = now;
    if ((TERMINAL_TICKET_STATUSES as readonly string[]).includes(nextStatus)) {
      patch.slaState = 'MET';
    }

    // --- claim propagation ------------------------------------------------
    const claimId = message.claimId ?? readStringMetadata(message.channelMetadata, 'claim_id');
    if (claimId && claimId !== ticket.claimId) patch.claimId = claimId;
    const claimFlag = this.readClaimFlag(message);
    if (claimFlag !== null) patch.hasActiveClaim = claimFlag;
    else if (message.hasActiveClaim === true) patch.hasActiveClaim = true;

    // --- order link -------------------------------------------------------
    if (order && order.id !== ticket.orderCacheId) patch.orderCacheId = order.id;
    if (message.externalOrderId && message.externalOrderId !== ticket.externalOrderId) {
      patch.externalOrderId = message.externalOrderId;
    }
    if (message.packId && !ticket.packId) patch.packId = message.packId;
    if (message.conversationId && !ticket.conversationId) patch.conversationId = message.conversationId;
    if (message.returnSn && !ticket.returnSn) patch.returnSn = message.returnSn;

    // --- buyer identity (never PII: nickname / anonymized only) -----------
    if (!ticket.buyerDisplayName && message.buyer.displayName) {
      patch.buyerDisplayName = message.buyer.displayName;
    }
    if (!ticket.buyerAnonymizedEmail && message.buyer.anonymizedEmail) {
      patch.buyerAnonymizedEmail = message.buyer.anonymizedEmail;
    }
    // `buyerExternalId` / `buyerContactHash` are only writable at creation time
    // (the repository update patch intentionally excludes identity columns).
    if (!ticket.subject) {
      const subject = this.deriveSubject(message);
      if (subject) patch.subject = subject;
    }

    // --- channel metadata merge ------------------------------------------
    const metadataPatch = this.buildMetadataPatch(message);
    if (Object.keys(metadataPatch).length > 0) {
      patch.channelMetadata = metadataPatch;
    }

    if (Object.keys(patch).length === 0) return ticket;
    return this.repos.tickets.update(ticket.id, patch, { mergeChannelMetadata: true });
  }

  private nextStatus(ticket: SupportTicketRecord, message: HydratedInboundMessage): TicketStatus {
    if (message.statusHint) return message.statusHint;
    switch (message.direction) {
      case 'INBOUND_BUYER':
        // A fresh buyer message on a ticket already claimed by an agent becomes
        // UNREAD; an unassigned ticket waits in the general queue.
        return ticket.assignedAgentId ? 'UNREAD' : 'OPEN_WAITING_AGENT';
      case 'MEDIATOR':
        return 'MEDIATION';
      case 'EXTERNAL_SELLER_PANEL':
        return 'WAITING_BUYER';
      case 'OUTBOUND_AGENT':
        return (TERMINAL_TICKET_STATUSES as readonly string[]).includes(ticket.status)
          ? ticket.status
          : 'WAITING_BUYER';
      case 'OUTBOUND_SYSTEM':
      default:
        return ticket.status;
    }
  }

  private initialStatus(message: HydratedInboundMessage): TicketStatus {
    if (message.statusHint) return message.statusHint;
    switch (message.direction) {
      case 'INBOUND_BUYER':
        return 'UNREAD';
      case 'MEDIATOR':
        return 'MEDIATION';
      case 'EXTERNAL_SELLER_PANEL':
        return 'WAITING_BUYER';
      case 'OUTBOUND_AGENT':
        return 'WAITING_BUYER';
      case 'OUTBOUND_SYSTEM':
        return 'NO_RESPONSE_NEEDED';
      default:
        return 'OPEN_WAITING_AGENT';
    }
  }

  private deriveSubject(message: HydratedInboundMessage): string | null {
    const fromMetadata =
      readStringMetadata(message.channelMetadata, 'subject') ??
      readStringMetadata(message.channelMetadata, 'item_title') ??
      readStringMetadata(message.channelMetadata, 'conversation_subject');
    if (fromMetadata) return truncate(fromMetadata, 400);

    if (message.ticketType === 'PRE_SALE') {
      const body = (message.bodyCleanText ?? '').replace(/\s+/g, ' ').trim();
      if (body) return truncate(body, 200);
    }
    if (message.externalOrderId) return `Pedido ${message.externalOrderId}`;
    return null;
  }

  private tagsFor(message: HydratedInboundMessage): string[] {
    const tags = new Set<string>();
    const raw = message.channelMetadata.tags;
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (typeof entry === 'string' && entry.trim() !== '') tags.add(entry.trim());
      }
    }
    if (message.ticketType === 'CLAIM_DISPUTE') tags.add('claim');
    if (message.marketplace === 'AMAZON') tags.add('amazon-relay');
    return [...tags];
  }

  private buildMetadataPatch(message: HydratedInboundMessage): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    const metadata = message.channelMetadata ?? {};
    const allowList = [
      'no_response_link',
      'buyer_opt_out',
      'conversation_status',
      'action_guide',
      'available_actions',
      'unread_count',
      'crr_safe',
      'item_snapshot',
      'preferred_agent_id',
      'smtp_sender_email',
      'ticket_status',
      'question_status',
      'claim_status',
      'claim_type',
      'return_status',
      'site_id',
      'region',
    ] as const;
    for (const key of allowList) {
      if (metadata[key] !== undefined) patch[key] = metadata[key];
    }
    if (message.hasActiveClaim !== undefined) patch['has_active_claim'] = message.hasActiveClaim;
    if (message.claimId) patch['claim_id'] = message.claimId;
    if (message.returnSn) patch['return_sn'] = message.returnSn;
    if (message.conversationId) patch['conversation_id'] = message.conversationId;
    return patch;
  }

  /* ==================================================================== */
  /* Orders + PII + attachments                                           */
  /* ==================================================================== */

  private async syncOrder(
    message: HydratedInboundMessage,
    ticket: SupportTicketRecord,
    warnings: string[],
  ): Promise<OrderCacheRecord | null> {
    if (!message.order) return null;
    try {
      const snapshot = message.order;
      const order = await this.repos.orders.upsert({
        accountId: message.accountId,
        marketplace: message.marketplace,
        externalOrderId: snapshot.externalOrderId,
        packId: snapshot.packId ?? message.packId ?? null,
        buyerExternalId: snapshot.buyerExternalId ?? message.buyer.externalId ?? null,
        buyerNameOrNick: snapshot.buyerNameOrNick ?? message.buyer.displayName ?? null,
        buyerAnonymizedEmail:
          snapshot.buyerAnonymizedEmail ?? message.buyer.anonymizedEmail ?? null,
        orderStatus: snapshot.orderStatus,
        fulfillmentType: snapshot.fulfillmentType ?? null,
        totalAmount: snapshot.totalAmount,
        currency: snapshot.currency ?? 'BRL',
        trackingNumber: snapshot.trackingNumber ?? null,
        carrierName: snapshot.carrierName ?? null,
        itemsSnapshot: snapshot.items ?? [],
        allowedActionsCache: snapshot.allowedActions ?? {},
        shippingSnapshot: snapshot.shipping ?? {},
        estimatedDeliveryAt: snapshot.estimatedDeliveryAt ?? null,
        shippedAt: snapshot.shippedAt ?? null,
        deliveredAt: snapshot.deliveredAt ?? null,
      });
      if (order.id !== ticket.orderCacheId) {
        await this.repos.tickets.update(ticket.id, { orderCacheId: order.id });
      }
      return order;
    } catch (error) {
      warnings.push('ORDER_SYNC_FAILED');
      this.logger.warn('ticket.ingest.order_upsert_failed', {
        ticketId: ticket.id,
        marketplace: message.marketplace,
        error: errorMessage(error),
      });
      return null;
    }
  }

  private async persistPii(
    message: HydratedInboundMessage,
    ticketId: string,
    warnings: string[],
  ): Promise<void> {
    const pii = message.buyerPii;
    if (!pii) return;
    if (
      !pii.name &&
      !pii.email &&
      !pii.document &&
      !pii.phone &&
      !pii.shippingAddress
    ) {
      return;
    }

    try {
      const existing = await this.repos.piiVault.findByTicketId(ticketId);
      const candidateExpiry = new Date(
        this.clock.now().getTime() + this.config.piiRetentionDays * DAY_MS,
      );
      const expiresAt =
        existing && existing.expiresAt.getTime() < candidateExpiry.getTime()
          ? existing.expiresAt
          : candidateExpiry;

      await this.repos.piiVault.upsert({
        ticketId,
        marketplace: message.marketplace,
        buyerName: pii.name ?? existing?.buyerName ?? null,
        buyerEmail: pii.email ?? existing?.buyerEmail ?? null,
        buyerDocument: pii.document ?? existing?.buyerDocument ?? null,
        buyerPhone: pii.phone ?? existing?.buyerPhone ?? null,
        shippingAddress: pii.shippingAddress ?? existing?.shippingAddress ?? {},
        sourceEndpoints: mergeStrings(existing?.sourceEndpoints, pii.sourceEndpoints),
        expiresAt,
      });

      // Short-TTL cache used by the detail projection / hit-path.
      await this.cache.set(
        CACHE_KEYS.piiTicket(ticketId),
        this.serializePii(pii, expiresAt),
        PII_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      warnings.push('PII_VAULT_WRITE_FAILED');
      this.logger.warn('ticket.ingest.pii_write_failed', {
        ticketId,
        marketplace: message.marketplace,
        error: errorMessage(error),
      });
    }
  }

  private serializePii(pii: BuyerPiiSnapshot, expiresAt: Date): Record<string, unknown> {
    return {
      name: pii.name ?? null,
      email: pii.email ?? null,
      document: pii.document ?? null,
      phone: pii.phone ?? null,
      shippingAddress: pii.shippingAddress ?? {},
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async persistAttachments(
    messageId: string,
    message: HydratedInboundMessage,
    warnings: string[],
  ): Promise<number> {
    const descriptors = message.attachments ?? [];
    if (descriptors.length === 0) return 0;

    const rows: CreateAttachmentInput[] = [];
    for (const descriptor of descriptors) {
      try {
        const resolved = await this.materializeAttachment(descriptor);
        if (!resolved) {
          warnings.push(`ATTACHMENT_UNRESOLVED:${descriptor.fileName}`);
          continue;
        }
        rows.push({
          messageId,
          fileName: descriptor.fileName || 'attachment',
          mimeType: descriptor.mimeType || 'application/octet-stream',
          sizeBytes: resolved.size,
          sha256: resolved.sha256,
          s3Uri: resolved.uri,
          externalUploadId: descriptor.externalUploadId ?? null,
          isEvidence: descriptor.isEvidence ?? false,
        });
      } catch (error) {
        warnings.push(`ATTACHMENT_FAILED:${descriptor.fileName}`);
        this.logger.warn('ticket.ingest.attachment_failed', {
          messageId,
          fileName: descriptor.fileName,
          error: errorMessage(error),
        });
      }
    }

    if (rows.length === 0) return 0;
    const created = await this.repos.attachments.createMany(rows);
    return created.length;
  }

  private async materializeAttachment(
    descriptor: HydratedInboundMessage['attachments'][number],
  ): Promise<{ uri: string; size: number; sha256: string | null } | null> {
    if (descriptor.s3Key) {
      return {
        uri: this.storage.buildUri(descriptor.s3Key),
        size: descriptor.sizeBytes ?? 0,
        sha256: descriptor.sha256 ?? null,
      };
    }

    let buffer: Buffer | null = null;
    if (descriptor.contentBase64) {
      buffer = Buffer.from(descriptor.contentBase64, 'base64');
    } else if (descriptor.sourceUrl && this.http) {
      const response = await this.http.requestBinary({
        method: 'GET',
        url: descriptor.sourceUrl,
        timeoutMs: 20_000,
        retries: 2,
      });
      if (response.ok) buffer = response.body;
    }

    if (!buffer || buffer.length === 0) return null;

    const key = buildAttachmentKey(descriptor.fileName, buffer);
    const stored = await this.storage.putObject({
      key,
      body: buffer,
      contentType: descriptor.mimeType || 'application/octet-stream',
      metadata: { source: 'inbound' },
    });
    return { uri: stored.uri, size: stored.size, sha256: stored.sha256 };
  }

  /* ==================================================================== */
  /* Commands                                                             */
  /* ==================================================================== */

  async assign(ticketId: string, agentId: string, actorLabel?: string): Promise<SupportTicketRecord> {
    const ticket = await this.requireTicket(ticketId);
    const agent = await this.repos.agents.findById(agentId);
    if (!agent) throw new NotFoundError('Agent', agentId);

    const patch: Parameters<ITicketRepository['update']>[1] = { assignedAgentId: agent.id };
    if (ticket.status === 'UNREAD' || ticket.status === 'OPEN_WAITING_AGENT') {
      patch.status = 'OPEN_WAITING_AGENT';
    }
    const updated = await this.repos.tickets.update(ticketId, patch);

    if (ticket.conversationId || ticket.externalReferenceId) {
      await this.cache.set(
        CACHE_KEYS.stickyAgent(ticket.conversationId ?? ticket.externalReferenceId),
        agent.id,
        STICKY_AGENT_TTL_SECONDS,
      );
    }

    await this.appendEvent(ticketId, 'TICKET_ASSIGNED', agent.id, actorLabel ?? agent.name, {
      assignedAgentId: agent.id,
      assignedAgentName: agent.name,
    });
    this.realtime.agentPresence({
      agentId: agent.id,
      agentName: agent.name,
      presence: agent.presence,
      queueChange: ticket.assignedQueue ?? undefined,
      at: this.clock.now().toISOString(),
    });
    this.emitTicketUpdated(updated);
    this.realtime.queueChanged({
      reason: 'ticket_assigned',
      ticketId,
      at: this.clock.now().toISOString(),
    });
    return updated;
  }

  async changeStatus(
    ticketId: string,
    status: TicketStatus,
    actor?: { agentId?: string; label?: string },
  ): Promise<SupportTicketRecord> {
    const ticket = await this.requireTicket(ticketId);
    if (ticket.status === status) return ticket;

    const now = this.clock.now();
    const patch: Parameters<ITicketRepository['update']>[1] = { status };
    if (status === 'RESOLVED') {
      patch.resolvedAt = now;
      patch.slaState = 'MET';
    } else if (status === 'NO_RESPONSE_NEEDED') {
      patch.resolvedAt = ticket.resolvedAt ?? now;
      patch.slaState = 'MET';
    } else {
      patch.resolvedAt = null;
    }

    const updated = await this.repos.tickets.update(ticketId, patch);
    await this.appendEvent(ticketId, 'STATUS_CHANGED', actor?.agentId ?? null, actor?.label ?? null, {
      from: ticket.status,
      to: status,
    });
    this.emitTicketUpdated(updated);
    this.realtime.queueChanged({
      reason: 'status_changed',
      ticketId,
      at: now.toISOString(),
    });
    return updated;
  }

  async closeWithoutResponse(
    ticketId: string,
    agent: { id: string; name: string },
  ): Promise<SupportTicketRecord> {
    const ticket = await this.requireTicket(ticketId);
    if (ticket.status === 'NO_RESPONSE_NEEDED') return ticket;

    const now = this.clock.now();
    const updated = await this.repos.tickets.update(ticketId, {
      status: 'NO_RESPONSE_NEEDED',
      resolvedAt: now,
      slaState: 'MET',
      assignedAgentId: ticket.assignedAgentId ?? agent.id,
    });
    await this.appendEvent(ticketId, 'CLOSED_WITHOUT_RESPONSE', agent.id, agent.name, {
      previousStatus: ticket.status,
    });
    this.emitTicketUpdated(updated);
    this.realtime.queueChanged({
      reason: 'closed_without_response',
      ticketId,
      at: now.toISOString(),
    });
    return updated;
  }

  async markAsRead(ticketId: string, agent?: { id: string; name: string }): Promise<SupportTicketRecord> {
    const ticket = await this.requireTicket(ticketId);
    const updated = await this.repos.tickets.update(ticketId, { unreadCount: 0 });

    // Shopee: reading the conversation locally must be mirrored to the API or
    // the 12h Chat Response Rate index keeps the conversation as unanswered.
    if (ticket.marketplace === 'SHOPEE') {
      await this.markShopeeConversationRead(ticket, agent);
    }

    await this.appendEvent(ticketId, 'MARKED_READ', agent?.id ?? null, agent?.name ?? null, {
      previousUnread: ticket.unreadCount,
    });
    this.emitTicketUpdated(updated);
    return updated;
  }

  private async markShopeeConversationRead(
    ticket: SupportTicketRecord,
    agent?: { id: string; name: string },
  ): Promise<void> {
    try {
      const lastInbound = await this.repos.messages.lastByDirection(ticket.id, 'INBOUND_BUYER');
      const adapter = this.adapters.get('SHOPEE');
      const result = await adapter.executeAction({
        kind: 'SHOPEE_MARK_READ',
        ticketId: ticket.id,
        accountId: ticket.accountId,
        marketplace: 'SHOPEE',
        conversationId: ticket.conversationId,
        externalOrderId: ticket.externalOrderId,
        lastReadMessageId: lastInbound?.externalMessageId ?? null,
        agent: agent
          ? { id: agent.id, name: agent.name, email: '' }
          : { id: 'system', name: 'SAC Hub', email: 'system@sachub.local' },
        payload: {},
      });
      if (ticket.conversationId) {
        await this.cache.set(
          CACHE_KEYS.conversationRead(ticket.conversationId),
          result.ok ? '1' : '0',
          3600,
        );
      }
    } catch (error) {
      this.logger.warn('ticket.mark_read.shopee_failed', {
        ticketId: ticket.id,
        error: errorMessage(error),
      });
    }
  }

  async addInternalNote(
    ticketId: string,
    agent: { id: string; name: string },
    text: string,
  ): Promise<TicketMessageRecord> {
    const trimmed = (text ?? '').trim();
    if (trimmed === '') throw new ValidationError('Internal note text is required');
    const ticket = await this.requireTicket(ticketId);
    const now = this.clock.now();

    const result = await this.repos.messages.createIdempotent({
      ticketId,
      externalMessageId: null,
      inReplyToId: null,
      referencesIds: [],
      direction: 'OUTBOUND_AGENT',
      channelRouteUsed: defaultRouteForMarketplace(ticket.marketplace),
      messageType: 'internal_note',
      bodyCleanText: truncate(trimmed, MAX_TEXT_LENGTH),
      bodyHtml: null,
      contentPayload: { internal_note: true },
      bodyRawS3Uri: null,
      deliveryStatus: 'SENT',
      errorDetail: null,
      isInternalNote: true,
      authorAgentId: agent.id,
      marketplaceCreatedAt: now,
      sentAt: now,
      deliveredAt: null,
      readAt: null,
    });

    await this.repos.tickets.update(ticketId, {
      lastMessageAt: laterOf(ticket.lastMessageAt, now),
    });
    await this.appendEvent(ticketId, 'NOTE_ADDED', agent.id, agent.name, {
      messageId: result.record.id,
      length: trimmed.length,
    });

    const updated = await this.repos.tickets.findById(ticketId);
    if (updated) this.emitTicketUpdated(updated);
    this.emitMessageCreated(ticketId, result.record);
    return result.record;
  }

  async refreshSla(ticketId: string): Promise<SupportTicketRecord> {
    const ticket = await this.requireTicket(ticketId);
    const snapshot = await this.slaEngine.refresh(ticket);
    const patch: Parameters<ITicketRepository['update']>[1] = {
      slaDeadlineAt: snapshot.deadlineAt,
      slaTargetAt: snapshot.targetAt,
      slaState: snapshot.state,
    };
    if (snapshot.isBreached && !ticket.slaBreached) {
      try {
        await this.repos.tickets.markBreached([ticket.id], this.clock.now());
      } catch (error) {
        this.logger.warn('ticket.refresh_sla.mark_breached_failed', {
          ticketId,
          error: errorMessage(error),
        });
      }
      patch.slaBreached = true;
    }

    const updated = await this.repos.tickets.update(ticketId, patch);
    await this.appendEvent(ticketId, 'SLA_REFRESHED', null, 'system', {
      state: snapshot.state,
      deadlineAt: snapshot.deadlineAt.toISOString(),
      warningMinutes: snapshot.warningMinutes,
    });
    this.emitTicketUpdated(updated);
    return updated;
  }

  /* ==================================================================== */
  /* Enrichment                                                           */
  /* ==================================================================== */

  private async maybeEnqueueEnrichment(
    message: HydratedInboundMessage,
    ticket: SupportTicketRecord,
    order: OrderCacheRecord | null,
    created: boolean,
  ): Promise<void> {
    if (message.marketplace !== 'AMAZON') return;
    if (order) return;
    if (!message.externalOrderId) return;
    // Amazon tickets that still lack order data (including brand-new fallback
    // tickets whose email could not be enriched inline) are hydrated lazily.
    if (ticket.orderCacheId) return;

    try {
      await enqueueEnrichment(this.queue, {
        ticketId: ticket.id,
        accountId: message.accountId,
        marketplace: 'AMAZON',
        externalOrderId: message.externalOrderId,
        reason: created ? 'new_amazon_ticket' : 'missing_order_cache',
      });
    } catch (error) {
      this.logger.warn('ticket.ingest.enrichment_enqueue_failed', {
        ticketId: ticket.id,
        error: errorMessage(error),
      });
    }
  }

  /* ==================================================================== */
  /* Helpers                                                              */
  /* ==================================================================== */

  private async requireTicket(ticketId: string): Promise<SupportTicketRecord> {
    const ticket = await this.repos.tickets.findById(ticketId);
    if (!ticket) throw new NotFoundError('SupportTicket', ticketId);
    return ticket;
  }

  private isBuyerInbound(direction: MessageDirection): boolean {
    return direction === 'INBOUND_BUYER';
  }

  private inboundDeliveryStatus(message: HydratedInboundMessage): DeliveryStatus {
    // Adapters may force a delivery state (Amazon bounce/block notices arrive as
    // OUTBOUND_SYSTEM + BOUNCED_BLOCKED); never overwrite it.
    if (message.deliveryStatus) return message.deliveryStatus;
    const raw = message.channelMetadata.delivery_status;
    if (typeof raw === 'string' && (ALLOWED_DELIVERY_STATUSES as readonly string[]).includes(raw)) {
      return raw as DeliveryStatus;
    }
    switch (message.direction) {
      case 'INBOUND_BUYER':
      case 'OUTBOUND_SYSTEM':
      case 'MEDIATOR':
        return 'DELIVERED';
      case 'EXTERNAL_SELLER_PANEL':
      case 'OUTBOUND_AGENT':
      default:
        return 'SENT';
    }
  }

  private buildContentPayload(message: HydratedInboundMessage): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...message.contentPayload };
    if (Object.keys(message.channelMetadata ?? {}).length > 0) {
      payload['channel_metadata'] = message.channelMetadata;
    }
    return payload;
  }

  private eventTypeForDirection(direction: MessageDirection): string {
    switch (direction) {
      case 'INBOUND_BUYER':
        return 'INBOUND_MESSAGE';
      case 'MEDIATOR':
        return 'MEDIATOR_MESSAGE';
      case 'EXTERNAL_SELLER_PANEL':
        return 'EXTERNAL_SELLER_REPLY';
      case 'OUTBOUND_AGENT':
        return 'OUTBOUND_MESSAGE';
      case 'OUTBOUND_SYSTEM':
      default:
        return 'SYSTEM_MESSAGE';
    }
  }

  private actorLabelForMessage(message: HydratedInboundMessage): string {
    if (message.direction === 'EXTERNAL_SELLER_PANEL') return 'seller-panel';
    if (message.isSystemEvent) return 'system';
    return message.marketplace;
  }

  private readClaimFlag(message: HydratedInboundMessage): boolean | null {
    if (typeof message.hasActiveClaim === 'boolean') return message.hasActiveClaim;
    const raw = message.channelMetadata.has_active_claim;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
    }
    return null;
  }

  private safeMarketplaceDate(value: Date, fallback: Date): Date {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    return fallback;
  }

  private emitTicketUpdated(ticket: SupportTicketRecord): void {
    try {
      this.realtime.ticketUpdated({
        ticketId: ticket.id,
        marketplace: ticket.marketplace,
        status: ticket.status,
        priority: ticket.priority,
        slaDeadlineAt: ticket.slaDeadlineAt.toISOString(),
        assignedAgentId: ticket.assignedAgentId,
        unreadCount: ticket.unreadCount,
        updatedAt: ticket.updatedAt.toISOString(),
      });
    } catch (error) {
      this.logger.warn('ticket.realtime.ticket_updated_failed', {
        ticketId: ticket.id,
        error: errorMessage(error),
      });
    }
  }

  private emitMessageCreated(ticketId: string, message: TicketMessageRecord): void {
    try {
      this.realtime.messageCreated({
        ticketId,
        messageId: message.id,
        direction: message.direction,
        channelRouteUsed: message.channelRouteUsed,
        preview: previewOf(message.bodyCleanText, message.messageType),
        marketplaceCreatedAt: message.marketplaceCreatedAt.toISOString(),
      });
    } catch (error) {
      this.logger.warn('ticket.realtime.message_created_failed', {
        ticketId,
        error: errorMessage(error),
      });
    }
  }

  private async appendEvent(
    ticketId: string,
    eventType: string,
    actorAgentId: string | null,
    actorLabel: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.repos.ticketEvents.append({
        ticketId,
        eventType,
        actorAgentId,
        actorLabel,
        payload,
      });
    } catch (error) {
      this.logger.warn('ticket.event_append_failed', {
        ticketId,
        eventType,
        error: errorMessage(error),
      });
    }
  }
}

/* ---------------------------------------------------------------------- */
/* Module helpers                                                         */
/* ---------------------------------------------------------------------- */

export function buildAttachmentKey(fileName: string, buffer: Buffer): string {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 8);
  const safeName = sanitizeFileName(fileName);
  return `attachments/${year}/${month}/${hash}-${safeName}`;
}

export function sanitizeFileName(fileName: string): string {
  const base = (fileName || 'file').split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-{2,}/g, '-');
  const trimmed = cleaned.replace(/^[-.]+/, '').slice(0, 120);
  return trimmed === '' ? 'file' : trimmed;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function laterOf(current: Date | null, candidate: Date): Date {
  if (!current) return candidate;
  return candidate.getTime() > current.getTime() ? candidate : current;
}

function mergeStrings(a: string[] | undefined | null, b: string[] | undefined | null): string[] {
  const merged = new Set<string>();
  for (const value of a ?? []) merged.add(value);
  for (const value of b ?? []) merged.add(value);
  return [...merged];
}

function strongestPriority(current: TicketPriority, candidate: TicketPriority): TicketPriority {
  const rank: Record<TicketPriority, number> = {
    CRITICAL_SLA: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
  };
  return rank[candidate] <= rank[current] ? candidate : current;
}

export function defaultRouteForMarketplace(marketplace: Marketplace): ChannelRoute {
  switch (marketplace) {
    case 'AMAZON':
      return 'AMAZON_EMAIL_RELAY';
    case 'MERCADO_LIVRE':
      return 'MELI_MESSAGES_API';
    case 'SHOPEE':
      return 'SHOPEE_CHAT_API';
    default:
      return 'AMAZON_EMAIL_RELAY';
  }
}

function previewOf(text: string, messageType: string): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length > 0) return normalized.slice(0, 180);
  return messageType ? `[${messageType}]` : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
