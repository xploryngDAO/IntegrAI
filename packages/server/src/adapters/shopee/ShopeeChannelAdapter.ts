import {
  ROUTE_TIMELINE_LABEL,
  evaluateOutboundPolicy,
  isAppError,
  redactPiiForLogs,
  type AdapterDependencies,
  type BuyerPiiSnapshot,
  type ChannelActionRequest,
  type ChannelActionResult,
  type ChannelRoute,
  type HydratedInboundMessage,
  type IMarketplaceChannelAdapter,
  type ILogger,
  type InboundEnvelope,
  type NormalizedOrderSnapshot,
  type OutboundDraft,
  type OutboundResult,
  type OutboundValidationInput,
  type PolicyEvaluation,
  type RawWebhookRequest,
  type RouteDecision,
  type SupportTicketRecord,
  type WebhookVerification,
} from '@sac/shared';
import { ShopeeClient } from './client/ShopeeClient';
import { ShopeeAuth } from './client/ShopeeAuth';
import { ShopeeWebhookParser } from './inbound/ShopeeWebhookParser';
import { ShopeeHydrator } from './inbound/ShopeeHydrator';
import { ShopeeChat } from './outbound/ShopeeChat';
import { ShopeeReturns } from './outbound/ShopeeReturns';
import { ShopeeMaintenance, type ShopeeMaintenanceTask } from './ShopeeMaintenance';
import { asNumber, asRecord, pickNumber, pickString, toEpochMs } from './mappers';
import { SHOPEE_CRR_METADATA_KEYS } from './types';

const CRR_RISK_HOURS = 12;

type ShopeeChatMessageType = NonNullable<OutboundDraft['shopeeMessageType']>;

/**
 * Shopee Open Platform v2 channel adapter.
 *
 * Composes the small collaborators (client/auth/parser/hydrator/chat/returns/
 * maintenance) and keeps every dependency injected through `AdapterDependencies`
 * - the adapter never touches Prisma/Redis/S3 directly.
 */
export class ShopeeChannelAdapter implements IMarketplaceChannelAdapter {
  readonly marketplace = 'SHOPEE' as const;

  private readonly deps: AdapterDependencies;
  private readonly logger: ILogger;
  private readonly client: ShopeeClient;
  private readonly auth: ShopeeAuth;
  private readonly webhookParser: ShopeeWebhookParser;
  private readonly hydrator: ShopeeHydrator;
  private readonly chat: ShopeeChat;
  private readonly returns: ShopeeReturns;
  private readonly maintenance: ShopeeMaintenance;

  constructor(deps: AdapterDependencies) {
    this.deps = deps;
    this.logger = deps.logger.child({ component: 'shopee.adapter' });

    this.client = new ShopeeClient(deps);
    this.auth = new ShopeeAuth(deps, this.client);
    this.client.attachTokenProvider({
      getCredentials: (accountId: string) => this.auth.getCredentials(accountId),
      forceRefresh: (accountId: string) => this.auth.forceRefreshCredentials(accountId),
    });

    this.webhookParser = new ShopeeWebhookParser(deps);
    this.hydrator = new ShopeeHydrator(deps, this.client);
    this.chat = new ShopeeChat(deps, this.client);
    this.returns = new ShopeeReturns(deps, this.client, this.chat);
    this.maintenance = new ShopeeMaintenance(deps, this.client, this.auth);
  }

  /** Store authorization URL (`/api/v2/shop/auth_partner`) for the AccountService. */
  buildAuthorizeUrl(redirectUri?: string): string {
    return this.auth.buildAuthorizeUrl(redirectUri);
  }

  verifyInbound(request: RawWebhookRequest): Promise<WebhookVerification> {
    return this.webhookParser.verify(request);
  }

  hydrate(envelope: InboundEnvelope): Promise<HydratedInboundMessage[]> {
    return this.hydrator.hydrate(envelope);
  }

  enrichOrder(input: {
    accountId: string;
    externalOrderId: string;
    ticketId: string;
  }): Promise<{ order: NormalizedOrderSnapshot; buyerPii?: BuyerPiiSnapshot | null } | null> {
    return this.hydrator.enrichOrder(input);
  }

  send(draft: OutboundDraft): Promise<OutboundResult> {
    return this.chat.send(draft);
  }

  async executeAction(request: ChannelActionRequest): Promise<ChannelActionResult> {
    if (request.marketplace !== 'SHOPEE') {
      return {
        action: request.kind,
        ok: false,
        message: `A ação ${request.kind} não pertence ao canal Shopee.`,
      };
    }

    try {
      switch (request.kind) {
        case 'SHOPEE_MARK_READ':
          return await this.executeMarkRead(request);
        case 'SHOPEE_CONFIRM_RETURN':
          return await this.executeConfirmReturn(request);
        case 'SHOPEE_DISPUTE_RETURN':
          return await this.executeDisputeReturn(request);
        case 'SHOPEE_ACCEPT_CANCELLATION':
          return await this.executeAcceptCancellation(request);
        case 'SHOPEE_SEND_CHAT_MESSAGE':
          return await this.executeSendChatMessage(request);
        default:
          return {
            action: request.kind,
            ok: false,
            message: `Ação ${request.kind} não é suportada pelo adapter Shopee.`,
          };
      }
    } catch (error) {
      this.logger.warn('Shopee action failed', {
        action: request.kind,
        ticketId: request.ticketId,
        accountId: request.accountId,
        error: this.describeError(error),
      });
      return {
        action: request.kind,
        ok: false,
        message: this.describeError(error),
        data: this.errorData(error),
      };
    }
  }

  validateOutbound(input: OutboundValidationInput): PolicyEvaluation {
    const policy = evaluateOutboundPolicy({
      text: input.bodyText ?? '',
      html: input.bodyHtml ?? null,
      subject: input.subject ?? null,
      marketplace: 'SHOPEE',
      allowedLinkDomains: input.allowedLinkDomains,
    });

    const notes = [...policy.notes];
    const crrNote = this.crrRiskNote(input);
    if (crrNote) notes.push(crrNote);

    return {
      violations: policy.violations,
      blocked: policy.blocked,
      sanitizedText: policy.sanitizedText,
      sanitizedHtml: policy.sanitizedHtml,
      notes,
      routePreview: this.resolveRoute(input),
    };
  }

  resolveRoute(input: OutboundValidationInput): RouteDecision {
    const route: ChannelRoute = 'SHOPEE_CHAT_API';
    const hasAttachments = input.attachments.length > 0;
    return {
      route,
      label: ROUTE_TIMELINE_LABEL[route],
      reason: hasAttachments
        ? 'Shopee Open Platform v2 sellerchat: upload da imagem em /sellerchat/upload_image e envio; proteção de CRR via read_conversation logo após o send.'
        : 'Shopee Open Platform v2 sellerchat com proteção de CRR: read_conversation após cada envio garante que a última mensagem da conversa seja OUTBOUND.',
      recipient: input.recipient,
      requiresAttachmentUpload: hasAttachments,
      blocked: false,
      actionName: null,
    };
  }

  runMaintenance(): Promise<ShopeeMaintenanceTask[]> {
    return this.maintenance.run();
  }

  /* ==========================================================================
   * Structured cockpit actions
   * ========================================================================== */

  private async executeMarkRead(request: ChannelActionRequest): Promise<ChannelActionResult> {
    const ticket = await this.loadTicket(request.ticketId);
    const payload = asRecord(request.payload) ?? {};
    const conversationId =
      request.conversationId ??
      ticket?.conversationId ??
      (ticket ? pickString(ticket.channelMetadata, ['conversation_id']) : null);
    const lastReadMessageId =
      request.lastReadMessageId ??
      pickString(payload, ['last_read_message_id', 'lastReadMessageId']);

    const result = await this.chat.markRead({
      accountId: request.accountId,
      conversationId: conversationId ?? null,
      lastReadMessageId,
      ticketId: request.ticketId,
    });

    return {
      action: request.kind,
      ok: true,
      message: 'Conversa marcada como lida — CRR da loja protegido.',
      routeUsed: 'SHOPEE_CHAT_API',
      externalId: result.lastReadMessageId,
      data: {
        request_id: result.requestId,
        conversation_id: result.conversationId,
        last_read_message_id: result.lastReadMessageId,
        crr_safe: true,
      },
    };
  }

  private async executeConfirmReturn(request: ChannelActionRequest): Promise<ChannelActionResult> {
    const ticket = await this.loadTicket(request.ticketId);
    const payload = asRecord(request.payload) ?? {};
    const returnSn =
      request.returnSn ?? ticket?.returnSn ?? pickString(payload, ['return_sn', 'returnSn']);

    const result = await this.returns.confirmReturn({
      accountId: request.accountId,
      returnSn: returnSn ?? '',
    });

    return {
      action: request.kind,
      ok: true,
      message: `Devolução ${returnSn ?? ''} confirmada na Shopee.`,
      routeUsed: 'SHOPEE_RETURNS_API',
      externalId: returnSn ?? null,
      data: {
        request_id: result.requestId,
        return_sn: returnSn ?? null,
        response: result.data,
      },
    };
  }

  private async executeDisputeReturn(request: ChannelActionRequest): Promise<ChannelActionResult> {
    const ticket = await this.loadTicket(request.ticketId);
    const payload = asRecord(request.payload) ?? {};
    const returnSn =
      request.returnSn ?? ticket?.returnSn ?? pickString(payload, ['return_sn', 'returnSn']);
    const attachments = request.attachments ?? [];

    const result = await this.returns.disputeReturn({
      accountId: request.accountId,
      returnSn: returnSn ?? '',
      disputeReason:
        pickNumber(payload, ['dispute_reason', 'disputeReason']) ??
        pickNumber({ ...(ticket?.channelMetadata ?? {}) }, ['dispute_reason']),
      disputeTextReason:
        pickString(payload, ['dispute_text_reason', 'disputeTextReason', 'reason_text']) ??
        pickString(request.payload ?? null, ['text']),
      attachments,
    });

    return {
      action: request.kind,
      ok: true,
      message: `Devolução ${returnSn ?? ''} disputada com ${result.imageUrls.length} evidência(s).`,
      routeUsed: 'SHOPEE_RETURNS_API',
      externalId: returnSn ?? null,
      data: {
        request_id: result.requestId,
        return_sn: returnSn ?? null,
        image_urls: result.imageUrls,
        response: result.data,
      },
    };
  }

  private async executeAcceptCancellation(
    request: ChannelActionRequest,
  ): Promise<ChannelActionResult> {
    const ticket = await this.loadTicket(request.ticketId);
    const payload = asRecord(request.payload) ?? {};
    const orderSn =
      request.externalOrderId ??
      ticket?.externalOrderId ??
      pickString(payload, ['order_sn', 'ordersn']);

    const result = await this.returns.acceptCancellation({
      accountId: request.accountId,
      orderSn: orderSn ?? '',
    });

    return {
      action: request.kind,
      ok: true,
      message: `Cancelamento do pedido ${orderSn ?? ''} aceito na Shopee.`,
      routeUsed: 'SHOPEE_RETURNS_API',
      externalId: orderSn ?? null,
      data: {
        request_id: result.requestId,
        order_sn: orderSn ?? null,
        response: result.data,
      },
    };
  }

  private async executeSendChatMessage(
    request: ChannelActionRequest,
  ): Promise<ChannelActionResult> {
    const ticket = await this.loadTicket(request.ticketId);
    const payload = asRecord(request.payload) ?? {};
    const messageType = this.resolvePayloadMessageType(payload);

    const draft: OutboundDraft = {
      ticketId: request.ticketId,
      outboxMessageId: pickString(payload, ['outbox_message_id']) ?? null,
      accountId: request.accountId,
      marketplace: 'SHOPEE',
      ticketType: ticket?.ticketType ?? 'POST_SALE_ORDER',
      hasActiveClaim: ticket?.hasActiveClaim ?? false,
      externalReferenceId: ticket?.externalReferenceId ?? request.conversationId ?? '',
      externalOrderId: request.externalOrderId ?? ticket?.externalOrderId ?? null,
      packId: ticket?.packId ?? null,
      claimId: ticket?.claimId ?? null,
      conversationId: request.conversationId ?? ticket?.conversationId ?? null,
      returnSn: ticket?.returnSn ?? null,
      questionId: null,
      buyerExternalId:
        ticket?.buyerExternalId ?? pickString(payload, ['buyer_external_id', 'to_id']),
      buyerDisplayName: ticket?.buyerDisplayName ?? null,
      buyerAnonymizedEmail: ticket?.buyerAnonymizedEmail ?? null,
      recipient: 'BUYER',
      subject: null,
      bodyText: request.bodyText ?? '',
      bodyHtml: null,
      attachments: request.attachments ?? [],
      forceImportant: false,
      closeWithoutResponse: false,
      inReplyToId: null,
      references: [],
      shopeeMessageType: messageType,
      shopeeOrderCardOrderSn: pickString(payload, ['order_sn', 'ordersn']),
      shopeeItemCardItemId: pickNumber(payload, ['item_id', 'itemid']),
      agent: request.agent ?? { id: 'sac-system', name: 'SAC Hub', email: 'sac@internal' },
    };

    const result = await this.chat.send(draft);
    return {
      action: request.kind,
      ok: true,
      message: 'Mensagem enviada via Shopee Chat API.',
      routeUsed: result.routeUsed,
      externalId: result.externalMessageId,
      data: {
        ...result.contentPayload,
        delivery_status: result.deliveryStatus,
      },
    };
  }

  /* ==========================================================================
   * Helpers
   * ========================================================================== */

  private async loadTicket(ticketId: string): Promise<SupportTicketRecord | null> {
    try {
      return await this.deps.repos.tickets.findById(ticketId);
    } catch (error) {
      this.logger.debug('Shopee: ticket lookup failed', {
        ticketId,
        error: this.describeError(error),
      });
      return null;
    }
  }

  private resolvePayloadMessageType(
    payload: Record<string, unknown>,
  ): ShopeeChatMessageType | undefined {
    const raw = pickString(payload, ['message_type', 'shopeeMessageType', 'shopee_message_type']);
    if (raw === 'text' || raw === 'image' || raw === 'order' || raw === 'item') return raw;
    if (pickString(payload, ['order_sn', 'ordersn'])) return 'order';
    const itemId = asNumber(payload['item_id']);
    if (itemId !== null) return 'item';
    return undefined;
  }

  /**
   * Uses the (new) optional `channelMetadata`/`allowedActions` context so the
   * CRR risk note stays synchronous and I/O free.
   */
  private crrRiskNote(input: OutboundValidationInput): string | null {
    const metadata = input.channelMetadata ?? {};
    const allowedActions = input.allowedActions ?? {};
    const direction =
      pickString(metadata, [SHOPEE_CRR_METADATA_KEYS.lastMessageDirection]) ??
      pickString(allowedActions, [SHOPEE_CRR_METADATA_KEYS.lastMessageDirection]);
    const crrSafeRaw = metadata[SHOPEE_CRR_METADATA_KEYS.crrSafe] ?? allowedActions[SHOPEE_CRR_METADATA_KEYS.crrSafe];
    const crrSafe = crrSafeRaw === true;

    let hoursSinceLastInbound =
      pickNumber(metadata, [SHOPEE_CRR_METADATA_KEYS.hoursSinceLastInbound]) ??
      pickNumber(allowedActions, [SHOPEE_CRR_METADATA_KEYS.hoursSinceLastInbound]);
    if (hoursSinceLastInbound === null) {
      const lastInboundRaw =
        metadata[SHOPEE_CRR_METADATA_KEYS.lastInboundAt] ??
        allowedActions[SHOPEE_CRR_METADATA_KEYS.lastInboundAt];
      const lastInboundMs = toEpochMs(lastInboundRaw);
      if (lastInboundMs !== null) {
        hoursSinceLastInbound =
          (this.deps.clock.now().getTime() - lastInboundMs) / 3_600_000;
      }
    }

    if (direction !== 'INBOUND_BUYER' || crrSafe) return null;
    if (hoursSinceLastInbound !== null && hoursSinceLastInbound > CRR_RISK_HOURS) {
      return `CRR_RISK: a última mensagem da conversa é do comprador há ${hoursSinceLastInbound.toFixed(
        1,
      )}h (limite ${CRR_RISK_HOURS}h). Responda para proteger o Chat Response Rate da loja.`;
    }
    return null;
  }

  private errorData(error: unknown): Record<string, unknown> {
    if (!isAppError(error)) {
      return { error: this.describeError(error) };
    }
    const data: Record<string, unknown> = {
      code: error.code,
      retryable: error.retryable,
    };
    if (error.details) data['details'] = error.details;
    return data;
  }

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return redactPiiForLogs(message).slice(0, 500);
  }
}
