import {
  CACHE_KEYS,
  DEFAULT_QUEUE_BY_MARKETPLACE,
  SHOPEE_SPECIALIZED_QUEUE,
  SLA_DEFAULTS,
  ValidationError,
  redactPiiForLogs,
  type AdapterDependencies,
  type BuyerPiiSnapshot,
  type HydratedInboundMessage,
  type InboundAttachmentDescriptor,
  type InboundEnvelope,
  type ILogger,
  type MarketplaceAccountRecord,
  type NormalizedOrderSnapshot,
  type OrderCacheRecord,
  type OrderItemSnapshot,
  type SupportTicketRecord,
} from '@sac/shared';
import { ShopeeClient } from '../client/ShopeeClient';
import { loadShopeeAccount, shopIdOf } from '../client/ShopeeAuth';
import {
  SHOPEE_API_PATHS,
  type ShopeeOrderContext,
  type ShopeePushPayload,
  type ShopeeTrackingSnapshot,
} from '../types';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  buildItemSnapshot,
  buildOrderContext,
  buildTrackingSnapshot,
  clampText,
  describeLogisticsStatus,
  describeOrderStatus,
  mapChatTriage,
  normalizeConversationId,
  normalizeOrderSn,
  normalizePushRecord,
  normalizeReturnSn,
  pickArray,
  pickNumber,
  pickString,
  toEpochMs,
  toShopeeId,
  triageShopeePush,
} from '../mappers';

/**
 * Expands a verified Shopee push into normalized inbound messages.
 *
 * Triage matrix (see `CHANNEL_CONTRACTS.md` and `mappers.triageShopeePush`):
 *  - `4` sellerchat without `order_sn` -> PRE_SALE / MEDIUM / `COMERCIAL::Pre-Venda`;
 *  - `4` sellerchat with `order_sn`     -> POST_SALE_ORDER / HIGH / `SAC::Shopee-N1`
 *    (order + tracking enriched in parallel with `Promise.allSettled`);
 *  - `6` return / `7` cancellation      -> RETURN_REFUND|CANCELLATION / CRITICAL_SLA /
 *    `SAC::Shopee-N2-Retencao`;
 *  - `2` order status / `3` tracking    -> system message + order cache refresh;
 *  - `10` shipping document             -> cache refresh only (no message).
 *
 * Thread ordering always uses Shopee's official `created_timestamp` (seconds).
 */

const STICKY_WINDOW_MS = 48 * 3600 * 1000;
const MAX_FETCHED_MESSAGES = 50;
const OPEN_STATUS = 'UNREAD';

interface ChatContextResult {
  orderContext: ShopeeOrderContext | null;
  itemSnapshot: OrderItemSnapshot | null;
  warnings: string[];
}

interface StickyResolution {
  preferredAgentId: string | null;
  buyerRepliedWithin48h: boolean;
}

export class ShopeeHydrator {
  private readonly deps: AdapterDependencies;
  private readonly client: ShopeeClient;
  private readonly logger: ILogger;

  constructor(deps: AdapterDependencies, client: ShopeeClient) {
    this.deps = deps;
    this.client = client;
    this.logger = deps.logger.child({ component: 'shopee.hydrator' });
  }

  async hydrate(envelope: InboundEnvelope): Promise<HydratedInboundMessage[]> {
    if (envelope.marketplace !== 'SHOPEE') return [];

    const account = await loadShopeeAccount(this.deps, envelope.accountId);
    const payload = this.readPayload(envelope);
    if (!payload) {
      throw new ValidationError('SHOPEE_PUSH_UNPARSEABLE', {
        accountId: envelope.accountId,
        eventId: envelope.eventId ?? null,
      });
    }

    switch (payload.code) {
      case 4:
        return this.hydrateChat(account, payload, envelope);
      case 6:
        return this.hydrateReturn(account, payload, envelope);
      case 7:
        return this.hydrateCancellation(account, payload, envelope);
      case 2:
        return this.hydrateOrderStatus(account, payload, envelope);
      case 3:
        return this.hydrateTracking(account, payload, envelope);
      case 10: {
        // Shipping-document push: no message, but the order snapshot may carry
        // fresh label/package data, so refresh the order cache when possible.
        const orderSn = normalizeOrderSn(payload.data);
        if (orderSn) await this.safeOrderContext(account, orderSn, []);
        this.logger.debug('Shopee shipping-document push: cache refreshed', {
          accountId: account.id,
          orderSn,
        });
        return [];
      }
      case 1:
        this.logger.info('Shopee shop-authorization push received', { accountId: account.id });
        return [];
      case 5: {
        this.logger.debug('Shopee item push: cache refresh only', { accountId: account.id });
        return [];
      }
      default:
        this.logger.warn('Shopee push code not handled by the adapter', {
          accountId: account.id,
          code: payload.code,
        });
        return [];
    }
  }

  /* ==========================================================================
   * Sellerchat (code 4) - CRR protected triage
   * ========================================================================== */

  private async hydrateChat(
    account: MarketplaceAccountRecord,
    payload: ShopeePushPayload,
    envelope: InboundEnvelope,
  ): Promise<HydratedInboundMessage[]> {
    const data = payload.data;
    const conversationId = normalizeConversationId(data);
    if (!conversationId) {
      throw new ValidationError('SHOPEE_CHAT_CONVERSATION_MISSING', {
        accountId: account.id,
        eventId: envelope.eventId ?? null,
      });
    }

    const triage = mapChatTriage(data);
    const shopId = shopIdOf(account);
    const ticket = await this.deps.repos.tickets.findByExternalReference('SHOPEE', conversationId);
    const lastKnownMs = ticket
      ? (await this.deps.repos.messages.latestMarketplaceCreatedAt(ticket.id))?.getTime() ?? null
      : null;

    let rawMessages = this.extractChatMessages(data);
    if (rawMessages.length === 0) {
      rawMessages = await this.fetchConversationMessages(account, conversationId, lastKnownMs);
    }
    if (rawMessages.length === 0) {
      // Verified push without a retrievable message body (already processed or
      // an empty conversation update) - nothing to ingest.
      this.logger.debug('Shopee chat push produced no messages', {
        accountId: account.id,
        conversationId,
      });
      return [];
    }

    rawMessages.sort(
      (left, right) =>
        this.messageCreatedMs(left, payload, envelope) - this.messageCreatedMs(right, payload, envelope),
    );
    const windowed = rawMessages.slice(-MAX_FETCHED_MESSAGES);

    const context = await this.buildChatContext(account, triage.orderSn, triage.requiresItemEnrichment, data);
    const sticky = await this.resolveStickyAgent(conversationId, shopId, windowed, payload, envelope);
    const lastMessage = windowed[windowed.length - 1];
    const lastMessageIsOutbound = !this.isInboundMessage(lastMessage, shopId);
    const unreadCount =
      pickNumber(data, ['unread_count', 'unreadCount']) ??
      windowed.filter((message) => this.isInboundMessage(message, shopId)).length;

    return windowed.map((message) =>
      this.mapChatMessage({
        account,
        payload,
        envelope,
        ticket,
        conversationId,
        triage,
        context,
        sticky,
        unreadCount,
        lastMessageIsOutbound,
        message,
      }),
    );
  }

  private mapChatMessage(input: {
    account: MarketplaceAccountRecord;
    payload: ShopeePushPayload;
    envelope: InboundEnvelope;
    ticket: SupportTicketRecord | null;
    conversationId: string;
    triage: ReturnType<typeof mapChatTriage>;
    context: ChatContextResult;
    sticky: StickyResolution;
    unreadCount: number;
    lastMessageIsOutbound: boolean;
    message: Record<string, unknown>;
  }): HydratedInboundMessage {
    const {
      account,
      payload,
      envelope,
      ticket,
      conversationId,
      triage,
      context,
      sticky,
      unreadCount,
      lastMessageIsOutbound,
      message,
    } = input;
    const shopId = shopIdOf(account);
    const direction = this.isInboundMessage(message, shopId)
      ? ('INBOUND_BUYER' as const)
      : ('EXTERNAL_SELLER_PANEL' as const);
    const createdMs = this.messageCreatedMs(message, payload, envelope);
    const generatedId = `${conversationId}:${createdMs}:${direction}`;
    const externalMessageId =
      pickString(message, ['message_id', 'messageId', 'msg_id']) ??
      pickString(payload.data, ['message_id', 'messageId']) ??
      generatedId;

    const fromId = pickString(message, ['from_id', 'fromId', 'sender_id']);
    const toId = pickString(message, ['to_id', 'toId', 'recipient_id']);
    const buyerExternalId =
      direction === 'INBOUND_BUYER'
        ? fromId
        : toId !== null && toId !== shopId
          ? toId
          : pickString(payload.data, ['buyer_user_id', 'buyer_id']);

    const rawContent = message['content'];
    const contentRecord = asRecord(rawContent);
    const contentText = contentRecord
      ? pickString(contentRecord, ['text', 'plain_text'])
      : asString(rawContent);
    const imageUrl = contentRecord
      ? pickString(contentRecord, ['image_url', 'imageUrl'])
      : pickString(message, ['image_url']);
    const cardOrderSn =
      pickString(contentRecord, ['order_sn']) ?? pickString(message, ['order_sn']);
    const cardItemId = pickString(contentRecord, ['item_id']) ?? pickString(message, ['item_id']);
    const messageType =
      pickString(message, ['message_type', 'content_type', 'type']) ?? (imageUrl ? 'image' : 'text');
    const bodyText = this.buildChatBodyText({
      messageType,
      text: contentText,
      imageUrl,
      cardOrderSn,
      cardItemId,
    });
    const attachments = this.chatAttachments(imageUrl, externalMessageId);
    const order = context.orderContext?.order ?? null;

    const channelMetadata: Record<string, unknown> = {
      conversation_id: conversationId,
      unread_count: unreadCount,
      crr_safe: lastMessageIsOutbound,
      message_type: messageType,
      queue_hint: triage.queueHint,
      order_sn: triage.orderSn ?? cardOrderSn ?? null,
      item_id: cardItemId,
    };
    if (order) {
      channelMetadata['order_status'] = order.orderStatus;
      channelMetadata['tracking_number'] = order.trackingNumber;
    }
    if (context.itemSnapshot) channelMetadata['item_snapshot'] = context.itemSnapshot;
    if (sticky.preferredAgentId) channelMetadata['preferred_agent_id'] = sticky.preferredAgentId;
    channelMetadata['buyer_replied_within_48h'] = sticky.buyerRepliedWithin48h;

    return {
      accountId: account.id,
      marketplace: 'SHOPEE',
      externalReferenceId: conversationId,
      ticketType: triage.ticketType,
      externalOrderId: triage.orderSn,
      packId: order?.packId ?? null,
      claimId: null,
      conversationId,
      returnSn: null,
      externalMessageId,
      inReplyToId: null,
      references: [],
      direction,
      channelRouteUsed: 'SHOPEE_CHAT_API',
      messageType,
      bodyCleanText: clampText(bodyText),
      bodyHtml: null,
      contentPayload: {
        conversation_id: conversationId,
        message_id: externalMessageId,
        message_type: messageType,
        from_id: fromId,
        to_id: toId,
        image_url: imageUrl,
        order_sn: cardOrderSn ?? triage.orderSn,
        item_id: cardItemId,
        unread_count: unreadCount,
        crr_safe: lastMessageIsOutbound,
        queue_hint: triage.queueHint,
        preferred_agent_id: sticky.preferredAgentId,
      },
      bodyRawS3Uri: null,
      marketplaceCreatedAt: new Date(createdMs),
      buyer: {
        externalId: buyerExternalId,
        displayName: order?.buyerNameOrNick ?? ticket?.buyerDisplayName ?? null,
        anonymizedEmail: ticket?.buyerAnonymizedEmail ?? null,
        contactHash: ticket?.buyerContactHash ?? null,
      },
      order,
      buyerPii: null,
      attachments,
      channelMetadata,
      hasActiveClaim: false,
      priority: triage.priority,
      slaDeadlineAt: null,
      statusHint: direction === 'EXTERNAL_SELLER_PANEL' ? 'WAITING_BUYER' : OPEN_STATUS,
      isSystemEvent: false,
      deliveryStatus: 'DELIVERED',
      warnings: this.uniqueWarnings(context.warnings),
    };
  }

  private buildChatBodyText(input: {
    messageType: string;
    text: string | null;
    imageUrl: string | null;
    cardOrderSn: string | null;
    cardItemId: string | null;
  }): string {
    if (input.text) return input.text;
    if (input.imageUrl) return '[imagem enviada no chat]';
    if (input.cardOrderSn) return `[cartão do pedido ${input.cardOrderSn}]`;
    if (input.cardItemId) return `[cartão do item ${input.cardItemId}]`;
    return `[${input.messageType}]`;
  }

  private chatAttachments(
    imageUrl: string | null,
    externalMessageId: string,
  ): InboundAttachmentDescriptor[] {
    if (!imageUrl) return [];
    return [
      {
        fileName: `shopee-chat-${externalMessageId}.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: 0,
        sourceUrl: imageUrl,
        s3Key: null,
        contentBase64: null,
      },
    ];
  }

  private extractChatMessages(data: Record<string, unknown>): Array<Record<string, unknown>> {
    const looksLikeMessage =
      pickString(data, ['message_id', 'messageId', 'msg_id']) !== null ||
      asRecord(data['content']) !== null ||
      asString(data['content']) !== null ||
      toEpochMs(data['created_timestamp']) !== null ||
      pickString(data, ['message_type', 'content_type']) !== null;
    return looksLikeMessage ? [data] : [];
  }

  private async fetchConversationMessages(
    account: MarketplaceAccountRecord,
    conversationId: string,
    lastKnownMs: number | null,
  ): Promise<Array<Record<string, unknown>>> {
    const numericConversationId = toShopeeId(conversationId);
    if (numericConversationId === null) return [];

    const result = await this.client.request<Record<string, unknown>>({
      accountId: account.id,
      apiPath: SHOPEE_API_PATHS.getMessage,
      body: { conversation_id: numericConversationId, offset: 0 },
    });
    const response = asRecord(result.data) ?? {};
    const rawList = pickArray(response, ['messages', 'message_list', 'data', 'message']);
    const messages = rawList
      .map(asRecord)
      .filter((message): message is Record<string, unknown> => message !== null);

    const filtered = messages
      .map((message) => ({ message, createdMs: this.messageCreatedMs(message, null, null) }))
      .filter((entry) => lastKnownMs === null || entry.createdMs > lastKnownMs)
      .sort((left, right) => left.createdMs - right.createdMs)
      .map((entry) => entry.message);

    return filtered;
  }

  private async buildChatContext(
    account: MarketplaceAccountRecord,
    orderSn: string | null,
    requiresItemEnrichment: boolean,
    data: Record<string, unknown>,
  ): Promise<ChatContextResult> {
    const warnings: string[] = [];

    if (orderSn) {
      try {
        const orderContext = await this.fetchOrderContext(account, orderSn);
        return { orderContext, itemSnapshot: null, warnings };
      } catch (error) {
        warnings.push('SHOPEE_ORDER_ENRICHMENT_FAILED');
        this.logger.warn('Shopee chat order/tracking enrichment failed', {
          accountId: account.id,
          orderSn,
          error: this.describeError(error),
        });
        return { orderContext: null, itemSnapshot: null, warnings };
      }
    }

    if (!requiresItemEnrichment) return { orderContext: null, itemSnapshot: null, warnings };

    const itemId = pickNumber(data, ['item_id', 'itemid', 'product_id']);
    if (itemId === null) return { orderContext: null, itemSnapshot: null, warnings };

    try {
      const rawItem = await this.fetchItemBaseInfo(account, itemId);
      return {
        orderContext: null,
        itemSnapshot: rawItem ? buildItemSnapshot(rawItem) : null,
        warnings,
      };
    } catch (error) {
      warnings.push('SHOPEE_ITEM_ENRICHMENT_FAILED');
      this.logger.warn('Shopee item enrichment failed', {
        accountId: account.id,
        itemId,
        error: this.describeError(error),
      });
      return { orderContext: null, itemSnapshot: null, warnings };
    }
  }

  private async resolveStickyAgent(
    conversationId: string,
    shopId: string,
    messages: Array<Record<string, unknown>>,
    payload: ShopeePushPayload,
    envelope: InboundEnvelope,
  ): Promise<StickyResolution> {
    const stickyRaw = await this.deps.cache.get<unknown>(CACHE_KEYS.stickyAgent(conversationId));
    const agentId = this.stickyAgentId(stickyRaw);
    if (!agentId) return { preferredAgentId: null, buyerRepliedWithin48h: false };

    const inboundTimes = messages
      .filter((message) => this.isInboundMessage(message, shopId))
      .map((message) => this.messageCreatedMs(message, payload, envelope));
    if (this.isInboundMessage(payload.data, shopId)) {
      inboundTimes.push(this.messageCreatedMs(payload.data, payload, envelope));
    }
    if (inboundTimes.length === 0) return { preferredAgentId: null, buyerRepliedWithin48h: false };

    const latestInboundMs = Math.max(...inboundTimes);
    const nowMs = this.deps.clock.now().getTime();
    const ageMs = nowMs - latestInboundMs;
    if (ageMs < 0 || ageMs > STICKY_WINDOW_MS) {
      return { preferredAgentId: null, buyerRepliedWithin48h: false };
    }

    const online = await this.deps.cache.exists(CACHE_KEYS.agentPresence(agentId));
    return { preferredAgentId: online ? agentId : null, buyerRepliedWithin48h: true };
  }

  private stickyAgentId(value: unknown): string | null {
    const direct = asString(value);
    if (direct) return direct;
    const record = asRecord(value);
    return pickString(record, ['agent_id', 'agentId', 'id']);
  }

  /* ==========================================================================
   * Returns (6) / buyer cancellation (7) - N2 retention, SLA fatal
   * ========================================================================== */

  private async hydrateReturn(
    account: MarketplaceAccountRecord,
    payload: ShopeePushPayload,
    envelope: InboundEnvelope,
  ): Promise<HydratedInboundMessage[]> {
    const data = payload.data;
    const returnSn = normalizeReturnSn(data);
    const orderSn = normalizeOrderSn(data);
    const warnings: string[] = [];

    const orderContext = orderSn
      ? await this.safeOrderContext(account, orderSn, warnings)
      : null;

    let returnDetail: Record<string, unknown> | null = null;
    if (returnSn) {
      try {
        returnDetail = await this.fetchReturnDetail(account, returnSn);
      } catch (error) {
        warnings.push('SHOPEE_RETURN_DETAIL_FAILED');
        this.logger.warn('Shopee return detail enrichment failed', {
          accountId: account.id,
          returnSn,
          error: this.describeError(error),
        });
      }
    }

    const status =
      pickString(data, ['status', 'return_status', 'current_status']) ??
      pickString(returnDetail, ['status', 'return_status']) ??
      'RETURN_OPEN';
    const reason =
      pickString(data, ['reason', 'return_reason', 'text_reason']) ??
      pickString(returnDetail, ['reason', 'return_reason', 'text_reason']);
    const refundAmount =
      pickNumber(data, ['refund_amount', 'amount']) ??
      pickNumber(returnDetail, ['refund_amount', 'amount']);
    const createdMs = this.eventCreatedAt(data, payload, envelope);
    const externalReferenceId = returnSn ?? orderSn ?? `shopee:return:${createdMs}`;
    // Stable across replays (timestamp comes from the push) but unique per update.
    const externalMessageId = `${
      envelope.eventId ?? `return:${returnSn ?? orderSn ?? createdMs}`
    }:${status}:${createdMs}`;
    const order = orderContext?.order ?? null;
    const body = `Devolução ${returnSn ?? orderSn ?? ''}: ${status}${
      reason ? ` — motivo: ${reason}` : ''
    }`;

    return [
      {
        accountId: account.id,
        marketplace: 'SHOPEE',
        externalReferenceId,
        ticketType: 'RETURN_REFUND',
        externalOrderId: orderSn,
        packId: order?.packId ?? null,
        claimId: null,
        conversationId: null,
        returnSn,
        externalMessageId,
        inReplyToId: null,
        references: [],
        direction: 'INBOUND_BUYER',
        channelRouteUsed: 'SHOPEE_RETURNS_API',
        messageType: 'return_update',
        bodyCleanText: clampText(body),
        bodyHtml: null,
        contentPayload: {
          order_sn: orderSn,
          return_sn: returnSn,
          status,
          reason,
          refund_amount: refundAmount,
          return_detail: returnDetail,
          queue_hint: SHOPEE_SPECIALIZED_QUEUE,
          sla_fatal: true,
        },
        bodyRawS3Uri: null,
        marketplaceCreatedAt: new Date(createdMs),
        buyer: this.buildBuyer(orderContext, null),
        order,
        buyerPii: null,
        attachments: [],
        channelMetadata: {
          order_sn: orderSn,
          return_sn: returnSn,
          reason,
          status,
          refund_amount: refundAmount,
          queue_hint: SHOPEE_SPECIALIZED_QUEUE,
          sla_fatal: true,
        },
        hasActiveClaim: false,
        priority: 'CRITICAL_SLA',
        slaDeadlineAt: this.criticalSlaDeadline('RETURN_REFUND'),
        statusHint: OPEN_STATUS,
        isSystemEvent: false,
        deliveryStatus: 'DELIVERED',
        warnings: this.uniqueWarnings(warnings),
      },
    ];
  }

  private async hydrateCancellation(
    account: MarketplaceAccountRecord,
    payload: ShopeePushPayload,
    envelope: InboundEnvelope,
  ): Promise<HydratedInboundMessage[]> {
    const data = payload.data;
    const orderSn = normalizeOrderSn(data);
    const warnings: string[] = [];
    const orderContext = orderSn
      ? await this.safeOrderContext(account, orderSn, warnings)
      : null;

    const status =
      pickString(data, ['status', 'order_status', 'current_status']) ?? 'IN_CANCEL';
    const reason = pickString(data, ['reason', 'buyer_cancel_reason', 'cancel_reason']);
    const refundAmount = pickNumber(data, ['refund_amount', 'amount']);
    const createdMs = this.eventCreatedAt(data, payload, envelope);
    const externalReferenceId = orderSn ?? `shopee:cancel:${createdMs}`;
    // Stable across replays but unique per status transition.
    const externalMessageId = `${
      envelope.eventId ?? `cancel:${orderSn ?? createdMs}`
    }:${status}:${createdMs}`;
    const order = orderContext?.order ?? null;

    return [
      {
        accountId: account.id,
        marketplace: 'SHOPEE',
        externalReferenceId,
        ticketType: 'CANCELLATION',
        externalOrderId: orderSn,
        packId: order?.packId ?? null,
        claimId: null,
        conversationId: null,
        returnSn: null,
        externalMessageId,
        inReplyToId: null,
        references: [],
        direction: 'INBOUND_BUYER',
        channelRouteUsed: 'SHOPEE_RETURNS_API',
        messageType: 'order_cancellation',
        bodyCleanText: clampText(
          `Cancelamento do pedido ${orderSn ?? ''}: ${status}${reason ? ` — motivo: ${reason}` : ''}`,
        ),
        bodyHtml: null,
        contentPayload: {
          order_sn: orderSn,
          status,
          reason,
          refund_amount: refundAmount,
          queue_hint: SHOPEE_SPECIALIZED_QUEUE,
          sla_fatal: true,
        },
        bodyRawS3Uri: null,
        marketplaceCreatedAt: new Date(createdMs),
        buyer: this.buildBuyer(orderContext, null),
        order,
        buyerPii: null,
        attachments: [],
        channelMetadata: {
          order_sn: orderSn,
          return_sn: null,
          reason,
          status,
          refund_amount: refundAmount,
          queue_hint: SHOPEE_SPECIALIZED_QUEUE,
          sla_fatal: true,
        },
        hasActiveClaim: false,
        priority: 'CRITICAL_SLA',
        slaDeadlineAt: this.criticalSlaDeadline('CANCELLATION'),
        statusHint: OPEN_STATUS,
        isSystemEvent: false,
        deliveryStatus: 'DELIVERED',
        warnings: this.uniqueWarnings(warnings),
      },
    ];
  }

  private criticalSlaDeadline(
    ticketType: 'RETURN_REFUND' | 'CANCELLATION',
  ): Date {
    const policy = SLA_DEFAULTS.SHOPEE[ticketType];
    return new Date(this.deps.clock.now().getTime() + policy.targetMinutes * 60_000);
  }

  /* ==========================================================================
   * Order status (2) / tracking (3) - system messages
   * ========================================================================== */

  private async hydrateOrderStatus(
    account: MarketplaceAccountRecord,
    payload: ShopeePushPayload,
    envelope: InboundEnvelope,
  ): Promise<HydratedInboundMessage[]> {
    const data = payload.data;
    const orderSn = normalizeOrderSn(data);
    if (!orderSn) {
      this.logger.warn('Shopee order-status push without order_sn', { accountId: account.id });
      return [];
    }

    const ticket = await this.findTicketForOrder(orderSn);
    if (!ticket) {
      // Still keep the order cache warm even when there is no open ticket.
      const warnings: string[] = [];
      await this.safeOrderContext(account, orderSn, warnings);
      return [];
    }

    const warnings: string[] = [];
    const orderContext = await this.safeOrderContext(account, orderSn, warnings);
    const status =
      pickString(data, ['status', 'order_status', 'current_status']) ??
      orderContext?.order.orderStatus ??
      'UNKNOWN';
    const createdMs = this.eventCreatedAt(data, payload, envelope);

    return [
      this.buildSystemMessage({
        account,
        ticket,
        orderSn,
        createdMs,
        envelope,
        ticketType: 'POST_SALE_ORDER',
        messageType: 'action_system',
        systemEvent: 'order_status',
        bodyText: `Pedido ${orderSn}: ${describeOrderStatus(status)}`,
        orderContext,
        tracingData: { order_status: status },
        channelMetadata: {
          order_sn: orderSn,
          order_status: status,
          queue_hint: DEFAULT_QUEUE_BY_MARKETPLACE.SHOPEE,
          system_event: 'order_status',
        },
        warnings,
      }),
    ];
  }

  private async hydrateTracking(
    account: MarketplaceAccountRecord,
    payload: ShopeePushPayload,
    envelope: InboundEnvelope,
  ): Promise<HydratedInboundMessage[]> {
    const data = payload.data;
    const orderSn = normalizeOrderSn(data);
    if (!orderSn) {
      this.logger.warn('Shopee tracking push without order_sn', { accountId: account.id });
      return [];
    }

    const ticket = await this.findTicketForOrder(orderSn);
    if (!ticket) {
      // Keep the order cache warm even without an open ticket.
      await this.safeOrderContext(account, orderSn, []);
      return [];
    }

    const warnings: string[] = [];
    const pushStatus = pickString(data, ['logistics_status', 'status', 'current_status']);
    const pushTrackingNumber = pickString(data, ['tracking_number', 'tracking_no']);

    // Refresh the order cache with the official order + tracking data, but never
    // block the system message on a transient enrichment failure.
    const orderContext = await this.safeOrderContext(account, orderSn, warnings);
    const tracking =
      orderContext?.tracking ??
      buildTrackingSnapshot({
        ...data,
        logistics_status: pushStatus ?? undefined,
        tracking_number: pushTrackingNumber ?? undefined,
      });
    const status = pushStatus ?? tracking?.logisticsStatus ?? 'UNKNOWN';
    const trackingNumber = pushTrackingNumber ?? tracking?.trackingNumber ?? null;
    const createdMs = this.eventCreatedAt(data, payload, envelope);

    return [
      this.buildSystemMessage({
        account,
        ticket,
        orderSn,
        createdMs,
        envelope,
        ticketType: 'POST_SALE_ORDER',
        messageType: 'action_system',
        systemEvent: 'order_tracking',
        bodyText: `Rastreio do pedido ${orderSn}: ${describeLogisticsStatus(status)}${
          trackingNumber ? ` (${trackingNumber})` : ''
        }`,
        orderContext,
        tracingData: {
          logistics_status: status,
          tracking_number: trackingNumber,
          carrier: tracking?.carrierName ?? null,
        },
        channelMetadata: {
          order_sn: orderSn,
          logistics_status: status,
          tracking_number: trackingNumber,
          queue_hint: DEFAULT_QUEUE_BY_MARKETPLACE.SHOPEE,
          system_event: 'order_tracking',
        },
        warnings,
      }),
    ];
  }

  private buildSystemMessage(input: {
    account: MarketplaceAccountRecord;
    ticket: SupportTicketRecord;
    orderSn: string;
    createdMs: number;
    envelope: InboundEnvelope;
    ticketType: 'POST_SALE_ORDER';
    messageType: 'action_system';
    systemEvent: 'order_status' | 'order_tracking';
    bodyText: string;
    orderContext: ShopeeOrderContext | null;
    tracingData: Record<string, unknown>;
    channelMetadata: Record<string, unknown>;
    warnings: string[];
  }): HydratedInboundMessage {
    const { account, ticket, orderSn, createdMs } = input;
    const order = input.orderContext?.order ?? null;
    const stateKey = String(
      input.tracingData['order_status'] ?? input.tracingData['logistics_status'] ?? '',
    );
    // Never reuse the webhook event id here: one order can produce several
    // status/tracking updates, and `ticket_messages.external_message_id` is unique.
    const externalMessageId = `${input.systemEvent}:${orderSn}:${stateKey}:${createdMs}`;

    return {
      accountId: account.id,
      marketplace: 'SHOPEE',
      externalReferenceId: ticket.externalReferenceId,
      ticketType: input.ticketType,
      externalOrderId: orderSn,
      packId: ticket.packId ?? order?.packId ?? null,
      claimId: ticket.claimId,
      conversationId: ticket.conversationId,
      returnSn: ticket.returnSn,
      externalMessageId,
      inReplyToId: null,
      references: [],
      direction: 'OUTBOUND_SYSTEM',
      channelRouteUsed: 'SHOPEE_CHAT_API',
      messageType: input.messageType,
      bodyCleanText: clampText(input.bodyText),
      bodyHtml: null,
      contentPayload: {
        system_event: input.systemEvent,
        order_sn: orderSn,
        ...input.tracingData,
      },
      bodyRawS3Uri: null,
      marketplaceCreatedAt: new Date(createdMs),
      buyer: this.buildBuyer(input.orderContext, ticket),
      order,
      buyerPii: null,
      attachments: [],
      channelMetadata: input.channelMetadata,
      hasActiveClaim: ticket.hasActiveClaim,
      priority: undefined,
      slaDeadlineAt: null,
      statusHint: undefined,
      isSystemEvent: true,
      deliveryStatus: 'DELIVERED',
      warnings: this.uniqueWarnings(input.warnings),
    };
  }

  /* ==========================================================================
   * Explicit order enrichment (cockpit refresh / spapi.enrichment fallback)
   * ========================================================================== */

  async enrichOrder(input: {
    accountId: string;
    externalOrderId: string;
    ticketId: string;
  }): Promise<{ order: NormalizedOrderSnapshot; buyerPii?: BuyerPiiSnapshot | null } | null> {
    const account = await loadShopeeAccount(this.deps, input.accountId);
    const [orderResult, trackingResult] = await Promise.allSettled([
      this.fetchOrderDetail(account, input.externalOrderId),
      this.fetchTrackingInfo(account, input.externalOrderId),
    ]);

    if (orderResult.status === 'rejected') {
      this.logger.warn('Shopee enrichOrder failed: get_order_detail rejected', {
        accountId: account.id,
        orderSn: input.externalOrderId,
        error: this.describeError(orderResult.reason),
      });
      throw orderResult.reason;
    }
    if (!orderResult.value) return null;

    if (trackingResult.status === 'rejected') {
      this.logger.warn('Shopee enrichOrder: get_tracking_info rejected (order still refreshed)', {
        accountId: account.id,
        orderSn: input.externalOrderId,
        error: this.describeError(trackingResult.reason),
      });
    }
    const tracking =
      trackingResult.status === 'fulfilled' ? buildTrackingSnapshot(trackingResult.value) : null;
    const context = buildOrderContext({
      order: orderResult.value,
      tracking,
      fallbackOrderId: input.externalOrderId,
    });
    const cached = await this.upsertOrderCache(account, context);
    if (cached) {
      try {
        await this.deps.repos.tickets.update(input.ticketId, { orderCacheId: cached.id });
      } catch (error) {
        this.logger.debug('Shopee enrichOrder: could not link order cache to ticket', {
          ticketId: input.ticketId,
          error: this.describeError(error),
        });
      }
    }
    return { order: context.order, buyerPii: null };
  }

  /* ==========================================================================
   * Shared helpers
   * ========================================================================== */

  private readPayload(envelope: InboundEnvelope): ShopeePushPayload | null {
    const record = asRecord(envelope.payload);
    if (!record) return null;
    const normalized = normalizePushRecord(record);
    if (normalized) return normalized;
    const topicCode = asNumber(envelope.topic ?? null);
    if (topicCode !== null) return normalizePushRecord({ ...record, code: topicCode });
    return null;
  }

  private async findTicketForOrder(orderSn: string): Promise<SupportTicketRecord | null> {
    const active = await this.deps.repos.tickets.findActiveByExternalOrderId('SHOPEE', orderSn);
    if (active) return active;
    return this.deps.repos.tickets.findByExternalReference('SHOPEE', orderSn);
  }

  private async safeOrderContext(
    account: MarketplaceAccountRecord,
    orderSn: string,
    warnings: string[],
  ): Promise<ShopeeOrderContext | null> {
    try {
      return await this.fetchOrderContext(account, orderSn);
    } catch (error) {
      warnings.push('SHOPEE_ORDER_ENRICHMENT_FAILED');
      this.logger.warn('Shopee order enrichment failed', {
        accountId: account.id,
        orderSn,
        error: this.describeError(error),
      });
      return null;
    }
  }

  private async fetchOrderContext(
    account: MarketplaceAccountRecord,
    orderSn: string,
  ): Promise<ShopeeOrderContext> {
    const [orderResult, trackingResult] = await Promise.allSettled([
      this.fetchOrderDetail(account, orderSn),
      this.fetchTrackingInfo(account, orderSn),
    ]);

    if (orderResult.status === 'rejected') throw orderResult.reason;
    const rawOrder = orderResult.value;
    if (!rawOrder) {
      throw new ValidationError('SHOPEE_ORDER_NOT_FOUND', {
        accountId: account.id,
        orderSn,
      });
    }
    if (trackingResult.status === 'rejected') {
      this.logger.warn('Shopee tracking enrichment failed; keeping the order snapshot', {
        accountId: account.id,
        orderSn,
        error: this.describeError(trackingResult.reason),
      });
    }
    const tracking =
      trackingResult.status === 'fulfilled' ? buildTrackingSnapshot(trackingResult.value) : null;
    const context = buildOrderContext({ order: rawOrder, tracking, fallbackOrderId: orderSn });
    await this.upsertOrderCache(account, context);
    return context;
  }

  private async fetchOrderDetail(
    account: MarketplaceAccountRecord,
    orderSn: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.client.request<Record<string, unknown>>({
      accountId: account.id,
      apiPath: SHOPEE_API_PATHS.getOrderDetail,
      body: { order_sn: orderSn },
    });
    const data = asRecord(result.data);
    if (!data) return null;
    const orders = pickArray(data, ['order_list', 'order_list_v2', 'orders'])
      .map(asRecord)
      .filter((order): order is Record<string, unknown> => order !== null);
    if (orders.length > 0) return orders[0];
    return pickString(data, ['order_sn', 'orderSn']) ? data : null;
  }

  private async fetchTrackingInfo(
    account: MarketplaceAccountRecord,
    orderSn: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.client.request<Record<string, unknown>>({
      accountId: account.id,
      apiPath: SHOPEE_API_PATHS.getTrackingInfo,
      body: { order_sn: orderSn },
    });
    return asRecord(result.data);
  }

  private async fetchItemBaseInfo(
    account: MarketplaceAccountRecord,
    itemId: number,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.client.request<Record<string, unknown>>({
      accountId: account.id,
      apiPath: SHOPEE_API_PATHS.getItemBaseInfo,
      body: { item_id_list: [toShopeeId(itemId)] },
    });
    const data = asRecord(result.data);
    if (!data) return null;
    const items = pickArray(data, ['item_list', 'items'])
      .map(asRecord)
      .filter((item): item is Record<string, unknown> => item !== null);
    return items[0] ?? (pickString(data, ['item_id', 'item_name']) ? data : null);
  }

  private async fetchReturnDetail(
    account: MarketplaceAccountRecord,
    returnSn: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.client.request<Record<string, unknown>>({
      accountId: account.id,
      apiPath: SHOPEE_API_PATHS.getReturnDetail,
      body: { return_sn: returnSn },
    });
    const data = asRecord(result.data);
    if (!data) return null;
    return asRecord(data['return']) ?? data;
  }

  private async upsertOrderCache(
    account: MarketplaceAccountRecord,
    context: ShopeeOrderContext,
  ): Promise<OrderCacheRecord | null> {
    const order = context.order;
    try {
      return await this.deps.repos.orders.upsert({
        accountId: account.id,
        marketplace: 'SHOPEE',
        externalOrderId: order.externalOrderId,
        packId: order.packId ?? null,
        buyerExternalId: order.buyerExternalId ?? null,
        buyerNameOrNick: order.buyerNameOrNick ?? null,
        buyerAnonymizedEmail: order.buyerAnonymizedEmail ?? null,
        orderStatus: order.orderStatus,
        fulfillmentType: order.fulfillmentType ?? null,
        totalAmount: order.totalAmount,
        currency: order.currency,
        trackingNumber: order.trackingNumber ?? null,
        carrierName: order.carrierName ?? null,
        itemsSnapshot: context.items,
        allowedActionsCache: order.allowedActions,
        shippingSnapshot: order.shipping,
        estimatedDeliveryAt: order.estimatedDeliveryAt ?? null,
        shippedAt: order.shippedAt ?? null,
        deliveredAt: order.deliveredAt ?? null,
      });
    } catch (error) {
      this.logger.warn('Shopee order cache upsert failed', {
        accountId: account.id,
        orderSn: order.externalOrderId,
        error: this.describeError(error),
      });
      return null;
    }
  }

  private buildBuyer(
    orderContext: ShopeeOrderContext | null,
    ticket: SupportTicketRecord | null,
  ): HydratedInboundMessage['buyer'] {
    const order = orderContext?.order ?? null;
    return {
      externalId: order?.buyerExternalId ?? ticket?.buyerExternalId ?? null,
      displayName: order?.buyerNameOrNick ?? ticket?.buyerDisplayName ?? null,
      anonymizedEmail: ticket?.buyerAnonymizedEmail ?? null,
      contactHash: ticket?.buyerContactHash ?? null,
    };
  }

  private isInboundMessage(message: Record<string, unknown>, shopId: string): boolean {
    const fromId = pickString(message, ['from_id', 'fromId', 'sender_id']);
    const toId = pickString(message, ['to_id', 'toId', 'recipient_id']);
    if (fromId === null) {
      // A sellerchat push with no sender is a buyer message by definition.
      return pickString(message, ['direction', 'message_direction']) !== 'OUTBOUND';
    }
    if (fromId === shopId) return false;
    if (toId !== null && fromId === toId) return false;
    return true;
  }

  /** Official `created_timestamp` in ms (seconds -> *1000), with safe fallbacks. */
  private messageCreatedMs(
    message: Record<string, unknown> | null,
    payload: ShopeePushPayload | null,
    envelope: InboundEnvelope | null,
  ): number {
    const fromMessage = message
      ? toEpochMs(
          message['created_timestamp'] ??
            message['create_time'] ??
            message['created_at'] ??
            message['timestamp'],
        )
      : null;
    if (fromMessage !== null) return fromMessage;
    const fromPayload = payload ? toEpochMs(payload.timestamp) : null;
    if (fromPayload !== null) return fromPayload;
    return envelope ? envelope.receivedAt.getTime() : this.deps.clock.now().getTime();
  }

  private eventCreatedAt(
    data: Record<string, unknown>,
    payload: ShopeePushPayload,
    envelope: InboundEnvelope,
  ): number {
    const fromData =
      toEpochMs(data['update_time']) ??
      toEpochMs(data['create_time']) ??
      toEpochMs(data['timestamp']) ??
      toEpochMs(data['event_time']);
    if (fromData !== null) return fromData;
    const fromPush = toEpochMs(payload.timestamp);
    if (fromPush !== null) return fromPush;
    return envelope.receivedAt.getTime();
  }

  private uniqueWarnings(warnings: string[]): string[] {
    return [...new Set(warnings)];
  }

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return redactPiiForLogs(message).slice(0, 300);
  }
}
