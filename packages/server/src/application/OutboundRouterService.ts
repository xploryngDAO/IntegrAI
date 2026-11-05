import {
  CACHE_KEYS,
  RETRY_POLICY,
  computeBackoffDelay,
  isAppError,
  redactPiiForLogs,
} from '@sac/shared';
import type {
  AccountStatus,
  ChannelActionKind,
  ChannelActionRequest,
  ChannelActionResult,
  ChannelRoute,
  ChannelRuntimeConfig,
  DeliveryStatus,
  ExecuteActionCommand,
  IAccountRepository,
  IAdapterRegistry,
  IAttachmentRepository,
  ICache,
  IClock,
  IFileService,
  ILogger,
  IMarketplaceChannelAdapter,
  IMessageRepository,
  IOrderRepository,
  IOutboundRouterService,
  IQueuePublisher,
  IRealtimePublisher,
  ITicketEventRepository,
  ITicketRepository,
  IUnifiedTicketService,
  MarketplaceAccountRecord,
  OutboundAttachmentInput,
  OutboundDraft,
  OutboundJobPayload,
  OutboundResult,
  OutboundValidationInput,
  PolicyEvaluation,
  PreviewPolicyCommand,
  RouteDecision,
  SendMessageCommand,
  SendMessageResult,
  SupportTicketRecord,
  TicketMessageRecord,
  TicketStatus,
  OrderCacheRecord,
  PolicyViolation,
} from '@sac/shared';
import {
  ConflictError,
  MarketplaceApiError,
  NotFoundError,
  PolicyViolationError,
  toAppError,
} from '@sac/shared';

import { enqueueOutboundRetry } from '../queues/producers';
import { defaultRouteForMarketplace, sanitizeFileName } from './UnifiedTicketService';

/**
 * ============================================================================
 * OutboundRouterService
 * ============================================================================
 *
 * The only path that can deliver a message to a buyer.
 *
 * The composer never decides the route: this service reloads the ticket, the
 * account and the order cache, then asks the channel adapter to recompute the
 * route/policy from scratch (`validateOutbound` + `resolveRoute`). A blocked
 * policy throws `PolicyViolationError` (HTTP 422) before anything is queued.
 *
 * Delivery is journaled twice: the outbox row (`ticket_messages`, status QUEUED
 * -> SENT/FAILED) and one `outbound_attempts` row per HTTP attempt (route,
 * status, httpStatus, durationMs, error) for operations triage.
 */

const OUTBOUND_ATTEMPTS = RETRY_POLICY.outbound.attempts;
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export interface OutboundAttemptRecordInput {
  ticketId: string;
  messageId: string | null;
  channelRoute: ChannelRoute;
  status: DeliveryStatus;
  attempt: number;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown>;
  httpStatus?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  durationMs?: number | null;
}

/**
 * Port for the `outbound_attempts` audit table.
 *
 * The shared package exposes no repository port for this table, so the container
 * provides a narrow Prisma-backed implementation. Keeping it as an interface
 * here means the router itself stays storage-agnostic and unit-testable.
 */
export interface IOutboundAttemptRecorder {
  record(input: OutboundAttemptRecordInput): Promise<void>;
}

export interface OutboundRouterServiceDependencies {
  logger: ILogger;
  clock: IClock;
  cache: ICache;
  queue: IQueuePublisher;
  realtime: IRealtimePublisher;
  config: ChannelRuntimeConfig;
  adapters: IAdapterRegistry;
  files: IFileService;
  ticketCommands: IUnifiedTicketService;
  attempts: IOutboundAttemptRecorder;
  repos: {
    accounts: IAccountRepository;
    tickets: ITicketRepository;
    messages: IMessageRepository;
    orders: IOrderRepository;
    attachments: IAttachmentRepository;
    ticketEvents: ITicketEventRepository;
  };
}

interface DeliveryContext {
  ticket: SupportTicketRecord;
  account: MarketplaceAccountRecord;
  order: OrderCacheRecord | null;
}

interface DraftFields {
  bodyText: string;
  bodyHtml?: string | null;
  subject?: string | null;
  recipient: 'BUYER' | 'MEDIATOR';
  attachments: OutboundAttachmentInput[];
  forceImportant?: boolean;
  closeWithoutResponse?: boolean;
  meliActionGuideReasonId?: string | null;
  shopeeMessageType?: 'text' | 'image' | 'order' | 'item';
  shopeeOrderCardOrderSn?: string | null;
  shopeeItemCardItemId?: number | null;
  agent: { id: string; name: string; email: string };
  metadata?: Record<string, unknown>;
}

interface DeliveryOutcome {
  message: TicketMessageRecord;
  routeUsed: ChannelRoute;
  deliveryStatus: DeliveryStatus;
  externalMessageId: string | null;
  asyncRetryScheduled: boolean;
  warnings: string[];
}

export class OutboundRouterService implements IOutboundRouterService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly cache: ICache;
  private readonly queue: IQueuePublisher;
  private readonly realtime: IRealtimePublisher;
  private readonly config: ChannelRuntimeConfig;
  private readonly adapters: IAdapterRegistry;
  private readonly files: IFileService;
  private readonly ticketCommands: IUnifiedTicketService;
  private readonly attempts: IOutboundAttemptRecorder;
  private readonly repos: OutboundRouterServiceDependencies['repos'];

  constructor(deps: OutboundRouterServiceDependencies) {
    this.logger = deps.logger.child({ component: 'OutboundRouterService' });
    this.clock = deps.clock;
    this.cache = deps.cache;
    this.queue = deps.queue;
    this.realtime = deps.realtime;
    this.config = deps.config;
    this.adapters = deps.adapters;
    this.files = deps.files;
    this.ticketCommands = deps.ticketCommands;
    this.attempts = deps.attempts;
    this.repos = deps.repos;
  }

  /* ==================================================================== */
  /* Send                                                                 */
  /* ==================================================================== */

  async send(command: SendMessageCommand): Promise<SendMessageResult> {
    const context = await this.loadContext(command.ticketId);
    const { ticket, account } = context;
    const adapter = this.adapters.get(ticket.marketplace);
    const warnings: string[] = [];

    if (account.status === 'DISCONNECTED') {
      throw new ConflictError(`Account ${account.displayName} is disconnected`, {
        accountId: account.id,
      });
    }

    const attachments = command.attachmentS3Keys?.length
      ? await this.files.resolveAttachmentInputs(command.attachmentS3Keys)
      : [];

    const fields: DraftFields = {
      bodyText: command.bodyText ?? '',
      bodyHtml: command.bodyHtml ?? null,
      subject: command.subject ?? null,
      recipient: command.recipient ?? 'BUYER',
      attachments,
      forceImportant: command.forceImportant === true,
      closeWithoutResponse: command.closeWithoutResponse === true,
      meliActionGuideReasonId: command.meliActionGuideReasonId ?? null,
      shopeeMessageType: command.shopeeMessageType ?? 'text',
      shopeeOrderCardOrderSn: command.shopeeOrderCardOrderSn ?? null,
      shopeeItemCardItemId: command.shopeeItemCardItemId ?? null,
      agent: command.agent,
      metadata: command.idempotencyKey ? { idempotency_key: command.idempotencyKey } : undefined,
    };

    const validation = await this.validate(context, adapter, fields);
    warnings.push(...validation.violations.filter((v) => v.severity === 'WARN').map((v) => v.message));
    warnings.push(...validation.notes);
    const route = validation.routePreview;
    this.assertRouteAllowed(ticket.marketplace, validation, route);

    // Silent close (Amazon Route 3): status transition only, nothing is sent.
    // Shopee still mirrors the read to protect the CRR index.
    if (fields.closeWithoutResponse) {
      const closed = await this.ticketCommands.closeWithoutResponse(ticket.id, {
        id: command.agent.id,
        name: command.agent.name,
      });
      if (ticket.marketplace === 'SHOPEE') {
        try {
          await this.ticketCommands.markAsRead(ticket.id, command.agent);
        } catch (error) {
          warnings.push('SHOPEE_MARK_READ_FAILED');
          this.logger.warn('outbound.close_without_response.mark_read_failed', {
            ticketId: ticket.id,
            error: errorMessage(error),
          });
        }
      }
      await this.recordAttempt({
        ticketId: ticket.id,
        messageId: null,
        channelRoute: route.route,
        status: 'SENT',
        attempt: 1,
        requestPayload: { close_without_response: true, recipient: fields.recipient },
        responsePayload: { status: 'NO_RESPONSE_NEEDED' },
        durationMs: 0,
      });
      await this.appendEvent(ticket.id, 'CLOSED_WITHOUT_RESPONSE', command.agent, {
        route: route.route,
        label: route.label,
      });
      this.emitTicketUpdated(closed);
      return {
        messageId: '',
        routeUsed: route.route,
        deliveryStatus: 'SENT',
        warnings,
        ticket: closed,
      };
    }

    // Idempotency-Key replay guard (the HTTP controller forwards the header).
    if (command.idempotencyKey) {
      const claimed = await this.cache.setNx(
        CACHE_KEYS.outboundDedupe(ticket.id, command.idempotencyKey),
        '1',
        IDEMPOTENCY_TTL_SECONDS,
      );
      if (!claimed) {
        throw new ConflictError(
          'A message with this Idempotency-Key was already processed for this ticket',
          { ticketId: ticket.id },
        );
      }
    }

    const now = this.clock.now();
    const outbox = await this.repos.messages.createIdempotent({
      ticketId: ticket.id,
      externalMessageId: null,
      inReplyToId: null,
      referencesIds: [],
      direction: 'OUTBOUND_AGENT',
      channelRouteUsed: route.route,
      messageType: fields.shopeeMessageType ?? 'text',
      bodyCleanText: (validation.sanitizedText ?? fields.bodyText).slice(0, 200_000),
      bodyHtml: validation.sanitizedHtml ?? fields.bodyHtml ?? null,
      contentPayload: this.buildOutboxPayload(command, route, validation, fields),
      bodyRawS3Uri: null,
      deliveryStatus: 'QUEUED',
      errorDetail: null,
      isInternalNote: false,
      authorAgentId: command.agent.id,
      marketplaceCreatedAt: now,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
    });

    const message = outbox.record;

    if (!outbox.created) {
      warnings.push('OUTBOX_DUPLICATE_REPLAY');
    }

    const outcome = await this.deliver(context, adapter, route, fields, message, {
      startAttempt: 0,
      maxInlineAttempts: OUTBOUND_ATTEMPTS,
      allowAsyncRetry: true,
      warnings,
    });

    const updatedTicket = await this.applyDeliveryEffects(
      context.ticket,
      outcome.message,
      route,
      outcome.deliveryStatus,
      command.agent,
      warnings,
    );

    return {
      messageId: outcome.message.id,
      routeUsed: outcome.routeUsed,
      deliveryStatus: outcome.deliveryStatus,
      warnings: outcome.warnings,
      ticket: updatedTicket,
    };
  }

  /* ==================================================================== */
  /* Queued re-delivery (queue.outbound.dispatch worker)                  */
  /* ==================================================================== */

  /**
   * Re-sends an existing outbox row. Used by `queue.outbound.dispatch`; it
   * never creates a second `ticket_messages` row and re-runs the policy so a
   * queued message cannot bypass a claim/cancellation that happened meanwhile.
   */
  async resendQueued(payload: OutboundJobPayload): Promise<DeliveryOutcome> {
    const context = await this.loadContext(payload.ticketId);
    const { ticket } = context;
    const adapter = this.adapters.get(ticket.marketplace);
    const message = await this.repos.messages.findById(payload.messageId);
    if (!message) throw new NotFoundError('TicketMessage', payload.messageId);
    if (message.deliveryStatus !== 'QUEUED' && message.deliveryStatus !== 'FAILED') {
      return {
        message,
        routeUsed: message.channelRouteUsed,
        deliveryStatus: message.deliveryStatus,
        externalMessageId: message.externalMessageId,
        asyncRetryScheduled: false,
        warnings: ['MESSAGE_ALREADY_DELIVERED'],
      };
    }

    const fields = this.fieldsFromOutbox(ticket.marketplace, message);
    // Attachments are not embedded in the outbox payload; resolve the stored
    // keys again so a retry sends exactly the same files.
    const attachmentKeys = readStringArray(message.contentPayload?.attachment_keys);
    if (attachmentKeys && attachmentKeys.length > 0) {
      fields.attachments = await this.files.resolveAttachmentInputs(attachmentKeys);
    }
    const validation = await this.validate(context, adapter, fields);
    this.assertRouteAllowed(ticket.marketplace, validation, validation.routePreview);

    const warnings: string[] = [
      ...validation.violations.filter((v) => v.severity === 'WARN').map((v) => v.message),
    ];

    const attempt = Number.isFinite(payload.attempt) ? Math.max(0, payload.attempt) : 0;
    if (attempt >= OUTBOUND_ATTEMPTS) {
      await this.repos.messages.updateDeliveryStatus(message.id, 'FAILED', {
        errorDetail: 'Outbound retry budget exhausted',
      });
      await this.appendEvent(ticket.id, 'OUTBOUND_FAILED', fields.agent, {
        messageId: message.id,
        attempts: attempt,
        reason: 'RETRY_BUDGET_EXHAUSTED',
      });
      throw new MarketplaceApiError(ticket.marketplace, 502, 'Outbound retry budget exhausted', {
        messageId: message.id,
      });
    }

    try {
      return await this.deliver(context, adapter, validation.routePreview, fields, message, {
        startAttempt: attempt,
        maxInlineAttempts: 1,
        allowAsyncRetry: false,
        warnings,
      });
    } catch (error) {
      // Let BullMQ apply its own backoff for retryable marketplace failures.
      if (isAppError(error) && error.retryable) {
        await this.repos.messages.updateDeliveryStatus(message.id, 'QUEUED', {
          errorDetail: redactPiiForLogs(error.message),
        });
      } else {
        await this.repos.messages.updateDeliveryStatus(message.id, 'FAILED', {
          errorDetail: redactPiiForLogs(errorMessage(error)),
        });
      }
      throw error;
    }
  }

  /* ==================================================================== */
  /* Structured actions                                                   */
  /* ==================================================================== */

  async executeAction(command: ExecuteActionCommand): Promise<ChannelActionResult> {
    const context = await this.loadContext(command.ticketId);
    const { ticket, account } = context;
    const adapter = this.adapters.get(ticket.marketplace);

    const request: ChannelActionRequest = {
      kind: command.kind,
      ticketId: ticket.id,
      accountId: ticket.accountId,
      marketplace: ticket.marketplace,
      externalOrderId: ticket.externalOrderId,
      packId: ticket.packId,
      claimId: ticket.claimId,
      conversationId: ticket.conversationId,
      returnSn: ticket.returnSn,
      questionId:
        ticket.marketplace === 'MERCADO_LIVRE' && ticket.ticketType === 'PRE_SALE'
          ? ticket.externalReferenceId
          : null,
      actionName: readActionName(command.payload),
      bodyText: command.bodyText,
      attachments: command.attachments ?? [],
      lastReadMessageId: command.lastReadMessageId ?? null,
      agent: command.agent,
      payload: command.payload ?? {},
    };

    const started = Date.now();
    let result: ChannelActionResult;
    try {
      result = await adapter.executeAction(request);
    } catch (error) {
      await this.recordAttempt({
        ticketId: ticket.id,
        messageId: null,
        channelRoute: this.actionRoute(command.kind, ticket.marketplace),
        status: 'FAILED',
        attempt: 1,
        requestPayload: { kind: command.kind, actionName: request.actionName ?? null },
        responsePayload: {},
        errorCode: errorCodeOf(error),
        errorMessage: redactPiiForLogs(errorMessage(error)),
        durationMs: Date.now() - started,
      });
      await this.appendEvent(ticket.id, 'ACTION_FAILED', command.agent, {
        kind: command.kind,
        error: errorCodeOf(error) ?? 'UNKNOWN',
      });
      throw toAppError(error);
    }

    const durationMs = Date.now() - started;
    await this.recordAttempt({
      ticketId: ticket.id,
      messageId: null,
      channelRoute: result.routeUsed ?? this.actionRoute(command.kind, ticket.marketplace),
      status: result.ok ? 'SENT' : 'FAILED',
      attempt: 1,
      requestPayload: { kind: command.kind, actionName: request.actionName ?? null },
      responsePayload: { ok: result.ok, externalId: result.externalId ?? null },
      errorCode: result.ok ? null : 'ACTION_REJECTED',
      errorMessage: result.ok ? null : redactPiiForLogs(result.message),
      durationMs,
    });

    if (result.ok) {
      await this.applyActionStatusTransition(ticket, command.kind, command.agent);
    }

    await this.appendEvent(ticket.id, result.ok ? 'ACTION_EXECUTED' : 'ACTION_REJECTED', command.agent, {
      kind: command.kind,
      ok: result.ok,
      message: redactPiiForLogs(result.message),
      externalId: result.externalId ?? null,
      routeUsed: result.routeUsed ?? null,
    });

    const refreshed = await this.repos.tickets.findById(ticket.id);
    if (refreshed) this.emitTicketUpdated(refreshed);
    this.realtime.queueChanged({
      reason: 'action_executed',
      ticketId: ticket.id,
      at: this.clock.now().toISOString(),
    });

    // Account health hint: a 401/403 from a token endpoint marks the account.
    if (!result.ok && /token|auth|unauthori[sz]ed|forbidden/i.test(result.message)) {
      await this.flagAccountIfAuthFailure(account, result.message);
    }

    return result;
  }

  /* ==================================================================== */
  /* Preview + route                                                      */
  /* ==================================================================== */

  /** True only when the buyer actually wrote to us (not a seller-panel note). */
  private async hasBuyerInbound(ticketId: string): Promise<boolean> {
    const last = await this.repos.messages.lastByDirection(ticketId, 'INBOUND_BUYER');
    return last !== null;
  }

  async previewPolicy(command: PreviewPolicyCommand): Promise<PolicyEvaluation> {    const context = await this.loadContext(command.ticketId);
    const adapter = this.adapters.get(context.ticket.marketplace);
    const draft = command.draft;
    const input: OutboundValidationInput = {
      marketplace: context.ticket.marketplace,
      ticketType: context.ticket.ticketType,
      hasActiveClaim: context.ticket.hasActiveClaim,
      bodyText: draft.bodyText ?? '',
      bodyHtml: draft.bodyHtml ?? null,
      subject: draft.subject ?? null,
      recipient: draft.recipient ?? 'BUYER',
      attachments: draft.attachments ?? [],
      forceImportant: draft.forceImportant,
      hasPriorInbound: await this.hasBuyerInbound(context.ticket.id),
      allowedActions: context.order?.allowedActionsCache ?? {},
      closeWithoutResponse: draft.closeWithoutResponse,
      ...this.validationContext(context),
    };
    return adapter.validateOutbound(input);
  }

  async resolveRoute(ticketId: string, recipient?: 'BUYER' | 'MEDIATOR'): Promise<RouteDecision> {
    const context = await this.loadContext(ticketId);
    const adapter = this.adapters.get(context.ticket.marketplace);
    const input: OutboundValidationInput = {
      marketplace: context.ticket.marketplace,
      ticketType: context.ticket.ticketType,
      hasActiveClaim: context.ticket.hasActiveClaim,
      bodyText: '',
      bodyHtml: null,
      subject: null,
      recipient: recipient ?? 'BUYER',
      attachments: [],
      forceImportant: false,
      hasPriorInbound: await this.hasBuyerInbound(context.ticket.id),
      allowedActions: context.order?.allowedActionsCache ?? {},
      closeWithoutResponse: false,
      ...this.validationContext(context),
    };
    return adapter.resolveRoute(input);
  }

  /* ==================================================================== */
  /* Delivery core                                                        */
  /* ==================================================================== */

  private async deliver(
    context: DeliveryContext,
    adapter: IMarketplaceChannelAdapter,
    route: RouteDecision,
    fields: DraftFields,
    message: TicketMessageRecord,
    options: {
      startAttempt: number;
      maxInlineAttempts: number;
      allowAsyncRetry: boolean;
      warnings: string[];
    },
  ): Promise<DeliveryOutcome> {
    const { ticket } = context;
    const draft = await this.composeDraft(context, route, fields, message.id);
    const policy = RETRY_POLICY.outbound;
    const warnings = [...options.warnings];
    const attemptsBudget = Math.min(
      policy.attempts,
      (options.startAttempt > 0 ? options.startAttempt : 0) + options.maxInlineAttempts,
    );

    let attempt = options.startAttempt;
    let result: OutboundResult | null = null;
    let lastError: unknown = null;
    let lastRetryable = false;

    while (attempt < attemptsBudget) {
      attempt += 1;
      const attemptStarted = Date.now();
      try {
        result = await adapter.send(draft);
        await this.recordAttempt({
          ticketId: ticket.id,
          messageId: message.id,
          channelRoute: result.routeUsed,
          status: result.deliveryStatus,
          attempt,
          requestPayload: safeRequestPayload(draft),
          responsePayload: {
            external_message_id: result.externalMessageId ?? null,
            delivery_status: result.deliveryStatus,
          },
          durationMs: Date.now() - attemptStarted,
        });
        break;
      } catch (error) {
        lastError = error;
        lastRetryable = isAppError(error) ? error.retryable : false;
        await this.recordAttempt({
          ticketId: ticket.id,
          messageId: message.id,
          channelRoute: route.route,
          status: 'FAILED',
          attempt,
          requestPayload: safeRequestPayload(draft),
          responsePayload: {},
          httpStatus: error instanceof MarketplaceApiError ? error.status : null,
          errorCode: errorCodeOf(error),
          errorMessage: redactPiiForLogs(errorMessage(error)),
          durationMs: Date.now() - attemptStarted,
        });

        if (lastRetryable && attempt < attemptsBudget) {
          const delay = computeBackoffDelay(attempt, policy);
          this.logger.warn('outbound.send.retrying', {
            ticketId: ticket.id,
            marketplace: ticket.marketplace,
            attempt,
            delayMs: delay,
            error: errorCodeOf(error),
          });
          await sleep(delay);
          continue;
        }
        break;
      }
    }

    if (result) {
      const deliveryStatus = result.deliveryStatus;
      await this.repos.messages.updateDeliveryStatus(message.id, deliveryStatus, {
        sentAt: this.clock.now(),
        deliveredAt: deliveryStatus === 'DELIVERED' || deliveryStatus === 'READ' ? this.clock.now() : null,
      });
      await this.persistOutboundAttachments(message.id, result);
      return {
        message,
        routeUsed: result.routeUsed,
        deliveryStatus,
        externalMessageId: result.externalMessageId,
        asyncRetryScheduled: false,
        warnings,
      };
    }

    // Failure ------------------------------------------------------------
    const errorDetail = redactPiiForLogs(errorMessage(lastError));

    if (lastRetryable && options.allowAsyncRetry) {
      await this.repos.messages.updateDeliveryStatus(message.id, 'QUEUED', { errorDetail });
      warnings.push('ASYNC_RETRY_SCHEDULED');
      try {
        await enqueueOutboundRetry(this.queue, {
          ticketId: ticket.id,
          messageId: message.id,
          accountId: ticket.accountId,
          marketplace: ticket.marketplace,
          attempt,
        });
      } catch (error) {
        this.logger.error('outbound.retry_enqueue_failed', {
          ticketId: ticket.id,
          messageId: message.id,
          error: errorMessage(error),
        });
      }
      await this.appendEvent(ticket.id, 'OUTBOUND_RETRY_SCHEDULED', fields.agent, {
        messageId: message.id,
        attempts: attempt,
        error: errorCodeOf(lastError) ?? 'UNKNOWN',
      });
      return {
        message,
        routeUsed: route.route,
        deliveryStatus: 'QUEUED',
        externalMessageId: null,
        asyncRetryScheduled: true,
        warnings,
      };
    }

    await this.repos.messages.updateDeliveryStatus(message.id, 'FAILED', { errorDetail });
    await this.appendEvent(ticket.id, 'OUTBOUND_FAILED', fields.agent, {
      messageId: message.id,
      attempts: attempt,
      error: errorCodeOf(lastError) ?? 'UNKNOWN',
    });
    throw toAppError(lastError ?? new Error('Outbound delivery failed'));
  }

  private async composeDraft(
    context: DeliveryContext,
    route: RouteDecision,
    fields: DraftFields,
    messageId: string,
  ): Promise<OutboundDraft> {
    const { ticket, account } = context;
    let lastInbound: TicketMessageRecord | null = null;
    try {
      lastInbound = await this.repos.messages.lastByDirection(ticket.id, 'INBOUND_BUYER');
    } catch (error) {
      this.logger.warn('outbound.compose.last_inbound_failed', {
        ticketId: ticket.id,
        error: errorMessage(error),
      });
    }

    const references = new Set<string>();
    if (lastInbound?.externalMessageId) references.add(lastInbound.externalMessageId);
    for (const reference of lastInbound?.referencesIds ?? []) {
      if (reference) references.add(reference);
    }

    const smtpSenderEmail = readString(account.channelConfig.smtp_sender_email);
    const questionId =
      ticket.marketplace === 'MERCADO_LIVRE' && ticket.ticketType === 'PRE_SALE'
        ? ticket.externalReferenceId
        : readString(account.channelConfig.question_id);

    return {
      ticketId: ticket.id,
      outboxMessageId: messageId,
      accountId: ticket.accountId,
      marketplace: ticket.marketplace,
      ticketType: ticket.ticketType,
      hasActiveClaim: ticket.hasActiveClaim,
      externalReferenceId: ticket.externalReferenceId,
      externalOrderId: ticket.externalOrderId,
      packId: ticket.packId,
      claimId: ticket.claimId,
      conversationId: ticket.conversationId,
      returnSn: ticket.returnSn,
      questionId,
      buyerExternalId: ticket.buyerExternalId,
      buyerDisplayName: ticket.buyerDisplayName,
      buyerAnonymizedEmail: ticket.buyerAnonymizedEmail,
      recipient: route.recipient ?? fields.recipient,
      subject: fields.subject ?? ticket.subject,
      bodyText: fields.bodyText,
      bodyHtml: fields.bodyHtml ?? null,
      attachments: fields.attachments,
      forceImportant: fields.forceImportant === true,
      closeWithoutResponse: fields.closeWithoutResponse === true,
      inReplyToId: lastInbound?.externalMessageId ?? null,
      references: [...references],
      smtpSenderEmail,
      meliActionGuideReasonId: fields.meliActionGuideReasonId ?? null,
      shopeeMessageType: fields.shopeeMessageType ?? 'text',
      shopeeOrderCardOrderSn: fields.shopeeOrderCardOrderSn ?? null,
      shopeeItemCardItemId: fields.shopeeItemCardItemId ?? null,
      agent: fields.agent,
      metadata: fields.metadata ?? {},
    };
  }

  /* ==================================================================== */
  /* Post-delivery ticket effects                                         */
  /* ==================================================================== */

  private async applyDeliveryEffects(
    ticket: SupportTicketRecord,
    message: TicketMessageRecord,
    route: RouteDecision,
    deliveryStatus: DeliveryStatus,
    agent: { id: string; name: string },
    warnings: string[],
  ): Promise<SupportTicketRecord> {
    const now = this.clock.now();
    // A queued message is not a delivered response yet: only count the
    // first-response / last-outbound timestamps on an actual send.
    const delivered = deliveryStatus !== 'QUEUED';
    const patch: Parameters<ITicketRepository['update']>[1] = {
      lastMessageAt: now,
    };
    if (delivered) {
      patch.lastOutboundAt = now;
      if (!ticket.firstResponseAt) patch.firstResponseAt = now;
    } else {
      warnings.push('MESSAGE_QUEUED_FOR_RETRY');
    }
    if (ticket.status !== 'MEDIATION' && ticket.status !== 'RESOLVED' && ticket.status !== 'NO_RESPONSE_NEEDED') {
      patch.status = 'WAITING_BUYER';
    }
    if (ticket.unreadCount > 0) patch.unreadCount = 0;

    let updated = ticket;
    try {
      updated = await this.repos.tickets.update(ticket.id, patch);
    } catch (error) {
      warnings.push('TICKET_UPDATE_AFTER_SEND_FAILED');
      this.logger.error('outbound.ticket_update_failed', {
        ticketId: ticket.id,
        error: errorMessage(error),
      });
    }

    await this.appendEvent(ticket.id, 'MESSAGE_SENT', agent, {
      messageId: message.id,
      route: route.route,
      routeLabel: route.label,
      deliveryStatus,
      attempt: 1,
    });

    try {
      this.realtime.messageCreated({
        ticketId: ticket.id,
        messageId: message.id,
        direction: 'OUTBOUND_AGENT',
        channelRouteUsed: route.route,
        preview: (message.bodyCleanText ?? '').replace(/\s+/g, ' ').trim().slice(0, 180),
        marketplaceCreatedAt: message.marketplaceCreatedAt.toISOString(),
      });
      this.realtime.ticketUpdated({
        ticketId: updated.id,
        marketplace: updated.marketplace,
        status: updated.status,
        priority: updated.priority,
        slaDeadlineAt: updated.slaDeadlineAt.toISOString(),
        assignedAgentId: updated.assignedAgentId,
        unreadCount: updated.unreadCount,
        updatedAt: updated.updatedAt.toISOString(),
      });
      this.realtime.queueChanged({
        reason: 'outbound_sent',
        ticketId: updated.id,
        at: now.toISOString(),
      });
    } catch (error) {
      this.logger.warn('outbound.realtime_emit_failed', {
        ticketId: ticket.id,
        error: errorMessage(error),
      });
    }

    return updated;
  }

  private async applyActionStatusTransition(
    ticket: SupportTicketRecord,
    kind: ChannelActionKind,
    agent: { id: string; name: string },
  ): Promise<void> {
    const next = ACTION_STATUS_TRANSITIONS[kind];
    if (!next || next === ticket.status) return;
    try {
      if (next === 'NO_RESPONSE_NEEDED') {
        await this.ticketCommands.closeWithoutResponse(ticket.id, agent);
      } else {
        await this.ticketCommands.changeStatus(ticket.id, next, {
          agentId: agent.id,
          label: agent.name,
        });
      }
    } catch (error) {
      this.logger.warn('outbound.action_status_transition_failed', {
        ticketId: ticket.id,
        kind,
        next,
        error: errorMessage(error),
      });
    }
  }

  /* ==================================================================== */
  /* Helpers                                                              */
  /* ==================================================================== */

  private async loadContext(ticketId: string): Promise<DeliveryContext> {
    const ticket = await this.repos.tickets.findById(ticketId);
    if (!ticket) throw new NotFoundError('SupportTicket', ticketId);
    const account = await this.repos.accounts.findById(ticket.accountId);
    if (!account) throw new NotFoundError('MarketplaceAccount', ticket.accountId);

    let order: OrderCacheRecord | null = null;
    if (ticket.orderCacheId) order = await this.repos.orders.findById(ticket.orderCacheId);
    if (!order && ticket.externalOrderId) {
      order = await this.repos.orders.findByExternalOrderId(ticket.marketplace, ticket.externalOrderId);
    }
    return { ticket, account, order };
  }

  private async validate(
    context: DeliveryContext,
    adapter: IMarketplaceChannelAdapter,
    fields: DraftFields,
  ): Promise<PolicyEvaluation> {
    const input: OutboundValidationInput = {
      marketplace: context.ticket.marketplace,
      ticketType: context.ticket.ticketType,
      hasActiveClaim: context.ticket.hasActiveClaim,
      bodyText: fields.bodyText,
      bodyHtml: fields.bodyHtml ?? null,
      subject: fields.subject ?? null,
      recipient: fields.recipient,
      attachments: fields.attachments,
      forceImportant: fields.forceImportant,
      hasPriorInbound: await this.hasBuyerInbound(context.ticket.id),
      allowedActions: context.order?.allowedActionsCache ?? {},
      closeWithoutResponse: fields.closeWithoutResponse,
      ...this.validationContext(context),
    };
    return adapter.validateOutbound(input);
  }

  /**
   * Context the adapters need to make policy decisions without doing their own
   * I/O: approved link domains, the verified SMTP sender, buyer opt-out flag and
   * the raw channel metadata.
   */
  private validationContext(context: DeliveryContext): Partial<OutboundValidationInput> {
    const channelConfig = context.account.channelConfig ?? {};
    const ticketMetadata = context.ticket.channelMetadata ?? {};
    return {
      accountId: context.ticket.accountId,
      allowedLinkDomains: readStringArray(channelConfig.approved_sender_domains),
      smtpSenderEmail: readString(channelConfig.smtp_sender_email),
      buyerOptOut: ticketMetadata.buyer_opt_out === true,
      channelMetadata: ticketMetadata,
    };
  }

  private assertRouteAllowed(
    marketplace: string,
    evaluation: PolicyEvaluation,
    route: RouteDecision,
  ): void {
    const blocking: Array<{ code: string; message: string; match?: string }> = evaluation.violations
      .filter((violation: PolicyViolation) => violation.severity === 'BLOCK')
      .map((violation) => ({
        code: violation.code,
        message: violation.message,
        ...(violation.match ? { match: violation.match } : {}),
      }));

    if (route.blocked) {
      blocking.push({
        code: 'ROUTE_BLOCKED',
        message: route.blockedReason ?? 'No allowed outbound route for this ticket right now.',
      });
    }

    if (blocking.length > 0) {
      throw new PolicyViolationError(blocking, marketplace);
    }
  }

  private buildOutboxPayload(
    command: SendMessageCommand,
    route: RouteDecision,
    validation: PolicyEvaluation,
    fields: DraftFields,
  ): Record<string, unknown> {
    return {
      outbox: true,
      route: route.route,
      route_label: route.label,
      recipient: route.recipient ?? fields.recipient,
      force_important: fields.forceImportant === true,
      subject: fields.subject ?? null,
      body_text: validation.sanitizedText ?? fields.bodyText,
      body_html: validation.sanitizedHtml ?? fields.bodyHtml ?? null,
      attachment_keys: command.attachmentS3Keys ?? [],
      attachment_count: fields.attachments.length,
      meli_action_guide_reason_id: fields.meliActionGuideReasonId ?? null,
      shopee_message_type: fields.shopeeMessageType ?? 'text',
      shopee_order_card_order_sn: fields.shopeeOrderCardOrderSn ?? null,
      shopee_item_card_item_id: fields.shopeeItemCardItemId ?? null,
      idempotency_key: command.idempotencyKey ?? null,
      agent: command.agent,
    };
  }

  private fieldsFromOutbox(marketplace: string, message: TicketMessageRecord): DraftFields {
    const content = message.contentPayload ?? {};
    const agent = parseAgent(content.agent);
    return {
      bodyText: readString(content.body_text) ?? message.bodyCleanText,
      bodyHtml: readString(content.body_html) ?? message.bodyHtml,
      subject: readString(content.subject),
      recipient: readString(content.recipient) === 'MEDIATOR' ? 'MEDIATOR' : 'BUYER',
      attachments: [],
      forceImportant: content.force_important === true,
      meliActionGuideReasonId: readString(content.meli_action_guide_reason_id),
      shopeeMessageType: parseShopeeType(content.shopee_message_type),
      shopeeOrderCardOrderSn: readString(content.shopee_order_card_order_sn),
      shopeeItemCardItemId:
        typeof content.shopee_item_card_item_id === 'number'
          ? content.shopee_item_card_item_id
          : null,
      agent,
      metadata: { marketplace },
    };
  }

  private async persistOutboundAttachments(
    messageId: string,
    result: OutboundResult,
  ): Promise<void> {
    if (!result.attachments || result.attachments.length === 0) return;
    try {
      await this.repos.attachments.createMany(
        result.attachments.map((attachment) => ({
          messageId,
          fileName: attachment.fileName || sanitizeFileName(attachment.s3Uri),
          mimeType: attachment.mimeType || 'application/octet-stream',
          sizeBytes: 0,
          sha256: null,
          s3Uri: attachment.s3Uri,
          externalUploadId: attachment.externalUploadId ?? null,
          isEvidence: false,
        })),
      );
    } catch (error) {
      this.logger.warn('outbound.persist_attachments_failed', {
        messageId,
        error: errorMessage(error),
      });
    }
  }

  private async recordAttempt(input: OutboundAttemptRecordInput): Promise<void> {
    try {
      await this.attempts.record({
        ...input,
        errorMessage: input.errorMessage ? redactPiiForLogs(input.errorMessage) : input.errorMessage,
      });
    } catch (error) {
      this.logger.warn('outbound.attempt_record_failed', {
        ticketId: input.ticketId,
        error: errorMessage(error),
      });
    }
  }

  private async appendEvent(
    ticketId: string,
    eventType: string,
    agent: { id: string; name: string },
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.repos.ticketEvents.append({
        ticketId,
        eventType,
        actorAgentId: agent.id,
        actorLabel: agent.name,
        payload,
      });
    } catch (error) {
      this.logger.warn('outbound.event_append_failed', {
        ticketId,
        eventType,
        error: errorMessage(error),
      });
    }
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
      this.logger.warn('outbound.realtime_emit_failed', {
        ticketId: ticket.id,
        error: errorMessage(error),
      });
    }
  }

  private async flagAccountIfAuthFailure(
    account: MarketplaceAccountRecord,
    message: string,
  ): Promise<void> {
    try {
      await this.repos.accounts.setStatus(
        account.id,
        'TOKEN_EXPIRED' as AccountStatus,
        redactPiiForLogs(message).slice(0, 500),
      );
    } catch (error) {
      this.logger.warn('outbound.account_flag_failed', {
        accountId: account.id,
        error: errorMessage(error),
      });
    }
  }

  private actionRoute(kind: ChannelActionKind, marketplace: string): ChannelRoute {
    switch (kind) {
      case 'MELI_ALLOW_RETURN':
      case 'MELI_REFUND':
      case 'MELI_OPEN_DISPUTE':
      case 'MELI_SEND_CLAIM_MESSAGE':
        return 'MELI_CLAIMS_API';
      case 'MELI_ANSWER_QUESTION':
        return 'MELI_QUESTIONS_API';
      case 'MELI_SEND_POST_SALE_MESSAGE':
        return 'MELI_MESSAGES_API';
      case 'SHOPEE_CONFIRM_RETURN':
      case 'SHOPEE_DISPUTE_RETURN':
        return 'SHOPEE_RETURNS_API';
      case 'SHOPEE_SEND_CHAT_MESSAGE':
      case 'SHOPEE_MARK_READ':
        return 'SHOPEE_CHAT_API';
      default:
        return marketplace === 'AMAZON'
          ? 'AMAZON_SP_API_MESSAGING'
          : defaultRouteForMarketplace(marketplace as 'AMAZON' | 'MERCADO_LIVRE' | 'SHOPEE');
    }
  }
}

/* ---------------------------------------------------------------------- */
/* Static maps + helpers                                                  */
/* ---------------------------------------------------------------------- */

const ACTION_STATUS_TRANSITIONS: Partial<Record<ChannelActionKind, TicketStatus>> = {
  AMAZON_CONFIRM_DELIVERY_DETAILS: 'WAITING_BUYER',
  AMAZON_UNEXPECTED_PROBLEM: 'WAITING_BUYER',
  AMAZON_WARRANTY: 'WAITING_BUYER',
  AMAZON_CONFIRM_CUSTOMIZATION: 'WAITING_BUYER',
  AMAZON_NO_RESPONSE_NEEDED: 'NO_RESPONSE_NEEDED',
  MELI_ANSWER_QUESTION: 'WAITING_BUYER',
  MELI_SEND_POST_SALE_MESSAGE: 'WAITING_BUYER',
  MELI_SEND_CLAIM_MESSAGE: 'MEDIATION',
  MELI_ALLOW_RETURN: 'RESOLVED',
  MELI_REFUND: 'RESOLVED',
  MELI_OPEN_DISPUTE: 'MEDIATION',
  SHOPEE_SEND_CHAT_MESSAGE: 'WAITING_BUYER',
  SHOPEE_CONFIRM_RETURN: 'RESOLVED',
  SHOPEE_DISPUTE_RETURN: 'MEDIATION',
  SHOPEE_ACCEPT_CANCELLATION: 'RESOLVED',
};

function readString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  return null;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
  return strings.length > 0 ? strings : undefined;
}

function readActionName(payload: Record<string, unknown> | undefined): string | null {
  if (!payload) return null;
  return readString(payload.actionName) ?? readString(payload.action_name);
}

function parseShopeeType(value: unknown): 'text' | 'image' | 'order' | 'item' {
  return value === 'image' || value === 'order' || value === 'item' ? value : 'text';
}

function parseAgent(value: unknown): { id: string; name: string; email: string } {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const id = readString(record.id) ?? 'system';
    const name = readString(record.name) ?? 'SAC Hub';
    const email = readString(record.email) ?? 'system@sachub.local';
    return { id, name, email };
  }
  return { id: 'system', name: 'SAC Hub', email: 'system@sachub.local' };
}

function safeRequestPayload(draft: OutboundDraft): Record<string, unknown> {
  return {
    route: draft.metadata && typeof draft.metadata.route === 'string' ? draft.metadata.route : null,
    recipient: draft.recipient,
    body_length: draft.bodyText.length,
    attachment_count: draft.attachments.length,
    force_important: draft.forceImportant === true,
    ticket_type: draft.ticketType,
    has_active_claim: draft.hasActiveClaim,
  };
}

function errorCodeOf(error: unknown): string | null {
  if (isAppError(error)) return error.code;
  if (error instanceof Error) return error.name;
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

