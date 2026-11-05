import {
  CACHE_KEYS,
  MarketplaceApiError,
  PolicyViolationError,
  ValidationError,
  evaluateOutboundPolicy,
  redactPiiForLogs,
  type AdapterDependencies,
  type ILogger,
  type MarketplaceAccountRecord,
  type OutboundAttachmentInput,
  type OutboundDraft,
  type OutboundResult,
  type SupportTicketRecord,
} from '@sac/shared';
import { ShopeeClient } from '../client/ShopeeClient';
import { loadShopeeAccount } from '../client/ShopeeAuth';
import { SHOPEE_API_PATHS } from '../types';
import { asRecord, pickString, toShopeeId } from '../mappers';

/**
 * Shopee sellerchat outbound.
 *
 * CRR (chat response rate) is a store-level metric: Shopee scores the store on
 * whether the LAST message of a conversation is outbound. Every successful send
 * is therefore followed immediately by `v2.sellerchat.read_conversation` with
 * the id returned by `send_message`, which marks the thread as read and keeps
 * the last message OUTBOUND. The same call powers `SHOPEE_MARK_READ`.
 */

interface SentChatMessage {
  messageId: string;
  requestId: string | null;
  envelope: Record<string, unknown>;
}

export interface ShopeeMarkReadInput {
  accountId: string;
  conversationId: string | null;
  lastReadMessageId?: string | null;
  ticketId?: string | null;
}

export interface ShopeeMarkReadResult {
  conversationId: string;
  lastReadMessageId: string;
  requestId: string | null;
  crrSafe: true;
}

export class ShopeeChat {
  private readonly deps: AdapterDependencies;
  private readonly client: ShopeeClient;
  private readonly logger: ILogger;

  constructor(deps: AdapterDependencies, client: ShopeeClient) {
    this.deps = deps;
    this.client = client;
    this.logger = deps.logger.child({ component: 'shopee.chat' });
  }

  async send(draft: OutboundDraft): Promise<OutboundResult> {
    if (draft.marketplace !== 'SHOPEE') {
      throw new ValidationError('ShopeeChat.send received a non-Shopee draft', {
        marketplace: draft.marketplace,
      });
    }

    const account = await loadShopeeAccount(this.deps, draft.accountId);
    const sanitizedText = this.assertPolicy(draft);

    const ticket = await this.deps.repos.tickets.findById(draft.ticketId);
    const conversationId = this.resolveConversationId(draft, ticket);
    const toId = draft.buyerExternalId ?? ticket?.buyerExternalId ?? null;
    if (toId === null || toId.trim().length === 0) {
      throw new ValidationError('SHOPEE_BUYER_ID_MISSING', {
        ticketId: draft.ticketId,
        accountId: account.id,
      });
    }

    const messageType = this.resolveMessageType(draft);
    const imageUploads: Array<{
      fileName: string;
      mimeType: string;
      s3Uri: string;
      externalUploadId: string | null;
    }> = [];
    const sentMessageIds: string[] = [];
    const imageUrls: string[] = [];
    let primaryRequestId: string | null = null;
    let primaryEnvelope: Record<string, unknown> = {};
    let lastMessageId = '';

    if (messageType === 'text') {
      const text = sanitizedText.trim();
      if (text.length === 0) {
        throw new ValidationError('SHOPEE_TEXT_BODY_EMPTY', { ticketId: draft.ticketId });
      }
      const sent = await this.sendChatMessage(account, toId, 'text', { text });
      sentMessageIds.push(sent.messageId);
      lastMessageId = sent.messageId;
      primaryRequestId = sent.requestId;
      primaryEnvelope = sent.envelope;
    } else if (messageType === 'image') {
      if (draft.attachments.length === 0) {
        throw new ValidationError('SHOPEE_IMAGE_WITHOUT_ATTACHMENT', {
          ticketId: draft.ticketId,
        });
      }
      for (const attachment of draft.attachments) {
        const uploaded = await this.uploadImage(account, attachment);
        imageUploads.push({
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          s3Uri: attachment.s3Key ? this.deps.storage.buildUri(attachment.s3Key) : '',
          externalUploadId: uploaded.imageUrl,
        });
        imageUrls.push(uploaded.imageUrl);

        const sent = await this.sendChatMessage(account, toId, 'image', {
          image_url: uploaded.imageUrl,
        });
        sentMessageIds.push(sent.messageId);
        lastMessageId = sent.messageId;
        primaryRequestId = sent.requestId;
        primaryEnvelope = sent.envelope;
      }
    } else if (messageType === 'order') {
      const orderSn = draft.shopeeOrderCardOrderSn;
      if (!orderSn) {
        throw new ValidationError('SHOPEE_ORDER_CARD_WITHOUT_ORDER_SN', {
          ticketId: draft.ticketId,
        });
      }
      const sent = await this.sendChatMessage(account, toId, 'order', { order_sn: orderSn });
      sentMessageIds.push(sent.messageId);
      lastMessageId = sent.messageId;
      primaryRequestId = sent.requestId;
      primaryEnvelope = sent.envelope;
    } else {
      const itemId = draft.shopeeItemCardItemId;
      if (itemId === null || itemId === undefined) {
        throw new ValidationError('SHOPEE_ITEM_CARD_WITHOUT_ITEM_ID', {
          ticketId: draft.ticketId,
        });
      }
      const sent = await this.sendChatMessage(account, toId, 'item', {
        item_id: toShopeeId(itemId),
      });
      sentMessageIds.push(sent.messageId);
      lastMessageId = sent.messageId;
      primaryRequestId = sent.requestId;
      primaryEnvelope = sent.envelope;
    }

    const warnings: string[] = [];
    let crrSafe = false;
    let lastReadMessageId: string | null = null;
    let crrError: string | null = null;

    // CRR protection: immediately mark the conversation read up to the message we
    // just sent so the thread never ends with a buyer message after our reply.
    if (conversationId) {
      try {
        const read = await this.markRead({
          accountId: account.id,
          conversationId,
          lastReadMessageId: lastMessageId,
          ticketId: draft.ticketId,
        });
        crrSafe = true;
        lastReadMessageId = read.lastReadMessageId;
      } catch (error) {
        crrError = this.describeError(error);
        warnings.push('SHOPEE_CRR_READ_FAILED');
        this.logger.warn('Shopee read_conversation CRR step failed after a successful send', {
          accountId: account.id,
          conversationId,
          messageId: lastMessageId,
          error: crrError,
        });
      }
    } else {
      crrError = 'SHOPEE_CONVERSATION_ID_MISSING';
      warnings.push('SHOPEE_CONVERSATION_ID_MISSING');
      this.logger.warn('Shopee send without conversation id: CRR cannot be guaranteed', {
        accountId: account.id,
        ticketId: draft.ticketId,
        messageId: lastMessageId,
      });
    }

    if (draft.ticketId) {
      await this.patchTicketCrr(draft.ticketId, {
        crr_safe: crrSafe,
        conversation_id: conversationId,
        last_read_message_id: lastReadMessageId,
        last_outbound_message_id: lastMessageId,
      });
    }

    return {
      routeUsed: 'SHOPEE_CHAT_API',
      externalMessageId: lastMessageId,
      deliveryStatus: 'SENT',
      contentPayload: {
        message_id: lastMessageId,
        message_ids: sentMessageIds,
        message_type: messageType,
        conversation_id: conversationId,
        to_id: toId,
        request_id: primaryRequestId,
        crr_safe: crrSafe,
        last_read_message_id: lastReadMessageId,
        crr_error: crrError,
        image_urls: imageUrls,
        order_sn: messageType === 'order' ? draft.shopeeOrderCardOrderSn ?? null : null,
        item_id: messageType === 'item' ? draft.shopeeItemCardItemId ?? null : null,
        warnings,
      },
      marketplaceCreatedAt: this.deps.clock.now(),
      attachments: imageUploads,
      rawResponse: primaryEnvelope,
    };
  }

  /** Uploads an outbound attachment and returns Shopee's CDN URL. */
  async uploadImage(
    account: MarketplaceAccountRecord,
    attachment: OutboundAttachmentInput,
  ): Promise<{ imageUrl: string; requestId: string | null }> {
    const buffer = await this.readAttachment(attachment);
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(buffer)], { type: attachment.mimeType }),
      attachment.fileName,
    );

    const result = await this.client.request<Record<string, unknown>>({
      accountId: account.id,
      apiPath: SHOPEE_API_PATHS.uploadImage,
      formData: form,
    });

    const data = asRecord(result.data) ?? {};
    const imageUrl =
      pickString(data, ['image_url', 'imageUrl', 'url']) ??
      pickString(result.envelope, ['image_url', 'imageUrl', 'url']);
    if (!imageUrl) {
      throw new MarketplaceApiError(
        'SHOPEE',
        502,
        'SHOPEE_UPLOAD_WITHOUT_IMAGE_URL',
        { request_id: result.requestId, fileName: attachment.fileName },
        false,
      );
    }
    return { imageUrl, requestId: result.requestId };
  }

  /**
   * `read_conversation` - marks the thread read up to `lastReadMessageId`.
   * Used both after every send (CRR) and by the `SHOPEE_MARK_READ` action.
   */
  async markRead(input: ShopeeMarkReadInput): Promise<ShopeeMarkReadResult> {
    const conversationId = input.conversationId;
    if (!conversationId) {
      throw new ValidationError('SHOPEE_CONVERSATION_ID_MISSING', {
        accountId: input.accountId,
        ticketId: input.ticketId ?? null,
      });
    }

    let lastReadMessageId = input.lastReadMessageId ?? null;
    if (!lastReadMessageId && input.ticketId) {
      const latestOutbound = await this.deps.repos.messages.lastByDirection(
        input.ticketId,
        'OUTBOUND_AGENT',
      );
      lastReadMessageId = latestOutbound?.externalMessageId ?? null;
    }
    if (!lastReadMessageId) {
      throw new ValidationError('SHOPEE_LAST_READ_MESSAGE_MISSING', {
        accountId: input.accountId,
        conversationId,
        ticketId: input.ticketId ?? null,
      });
    }
    if (!/^\d+$/.test(lastReadMessageId)) {
      throw new ValidationError('SHOPEE_LAST_READ_MESSAGE_INVALID', {
        accountId: input.accountId,
        conversationId,
      });
    }

    const result = await this.client.request<Record<string, unknown>>({
      accountId: input.accountId,
      apiPath: SHOPEE_API_PATHS.readConversation,
      body: {
        conversation_id: toShopeeId(conversationId),
        last_read_message_id: toShopeeId(lastReadMessageId),
      },
    });

    const data = asRecord(result.data) ?? {};
    const confirmed =
      pickString(data, ['last_read_message_id', 'message_id']) ?? lastReadMessageId;

    await this.deps.cache
      .set(CACHE_KEYS.conversationRead(conversationId), confirmed, 86_400)
      .catch(() => undefined);

    if (input.ticketId) {
      await this.patchTicketCrr(input.ticketId, {
        crr_safe: true,
        conversation_id: conversationId,
        last_read_message_id: confirmed,
      });
    }

    this.logger.info('Shopee conversation marked as read (CRR protected)', {
      accountId: input.accountId,
      conversationId,
      lastReadMessageId: confirmed,
      requestId: result.requestId,
    });

    return {
      conversationId,
      lastReadMessageId: confirmed,
      requestId: result.requestId,
      crrSafe: true,
    };
  }

  private async sendChatMessage(
    account: MarketplaceAccountRecord,
    toId: string,
    messageType: 'text' | 'image' | 'order' | 'item',
    content: Record<string, unknown>,
  ): Promise<SentChatMessage> {
    const result = await this.client.request<Record<string, unknown>>({
      accountId: account.id,
      apiPath: SHOPEE_API_PATHS.sendMessage,
      body: {
        to_id: toShopeeId(toId),
        message_type: messageType,
        content,
      },
    });

    const data = asRecord(result.data) ?? {};
    const messageId =
      pickString(data, ['message_id', 'messageId']) ??
      pickString(result.envelope, ['message_id', 'messageId']);
    if (!messageId) {
      // Never report a send as successful without the marketplace message id:
      // CRR protection and idempotency depend on it.
      throw new MarketplaceApiError(
        'SHOPEE',
        502,
        'SHOPEE_SEND_WITHOUT_MESSAGE_ID',
        { request_id: result.requestId, message_type: messageType },
        false,
      );
    }
    return {
      messageId,
      requestId: result.requestId,
      envelope: result.envelope as Record<string, unknown>,
    };
  }

  private resolveMessageType(
    draft: OutboundDraft,
  ): 'text' | 'image' | 'order' | 'item' {
    if (draft.shopeeMessageType) return draft.shopeeMessageType;
    if (draft.shopeeOrderCardOrderSn) return 'order';
    if (draft.shopeeItemCardItemId !== null && draft.shopeeItemCardItemId !== undefined) {
      return 'item';
    }
    if (draft.attachments.length > 0) return 'image';
    return 'text';
  }

  private resolveConversationId(
    draft: OutboundDraft,
    ticket: SupportTicketRecord | null,
  ): string | null {
    if (draft.conversationId && draft.conversationId.trim().length > 0) {
      return draft.conversationId;
    }
    if (ticket?.conversationId) return ticket.conversationId;
    return ticket ? pickString(ticket.channelMetadata, ['conversation_id']) : null;
  }

  private assertPolicy(draft: OutboundDraft): string {
    const policy = evaluateOutboundPolicy({
      text: draft.bodyText ?? '',
      html: draft.bodyHtml ?? null,
      subject: draft.subject ?? null,
      marketplace: 'SHOPEE',
    });
    if (policy.blocked) {
      const violations = policy.violations
        .filter((violation) => violation.severity === 'BLOCK')
        .map((violation) => ({ code: violation.code, message: violation.message, match: violation.match }));
      throw new PolicyViolationError(violations, 'SHOPEE');
    }
    // Shopee receives the sanitized text (e.g. tracking params stripped); the
    // full policy result is also exposed by `validateOutbound` to the composer.
    return policy.sanitizedText;
  }

  private async readAttachment(attachment: OutboundAttachmentInput): Promise<Buffer> {
    if (attachment.s3Key && attachment.s3Key.trim().length > 0) {
      try {
        return await this.deps.storage.getObject(attachment.s3Key);
      } catch (error) {
        this.logger.warn('Shopee upload: could not read attachment from storage', {
          fileName: attachment.fileName,
          error: this.describeError(error),
        });
      }
    }
    if (attachment.contentBase64) {
      return Buffer.from(attachment.contentBase64, 'base64');
    }
    throw new ValidationError('SHOPEE_ATTACHMENT_UNREADABLE', {
      fileName: attachment.fileName,
      s3Key: attachment.s3Key,
    });
  }

  private async patchTicketCrr(
    ticketId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.repos.tickets.update(
        ticketId,
        { channelMetadata: metadata },
        { mergeChannelMetadata: true },
      );
    } catch (error) {
      this.logger.debug('Shopee: could not merge CRR metadata into the ticket', {
        ticketId,
        error: this.describeError(error),
      });
    }
  }

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return redactPiiForLogs(message).slice(0, 300);
  }
}
