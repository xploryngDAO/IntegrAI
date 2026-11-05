import type {
  AdapterDependencies,
  HydratedInboundMessage,
  ILogger,
  MarketplaceAccountRecord,
  NormalizedOrderSnapshot,
} from '@sac/shared';
import type { MeliClient } from '../client/MeliClient';
import {
  asArray,
  asString,
  buildOrderSnapshot,
  directionFromUserIds,
  errorMessage,
  extractPackIdFromMessageResources,
  extractText,
  isOpaqueMessageResource,
  normalizeActionGuide,
  normalizeAttachments,
  parseDate,
  truncateText,
} from '../mappers';
import type {
  MeliActionGuide,
  MeliMessageDetail,
  MeliOrder,
  MeliPackMessage,
  MeliPackMessagesResponse,
} from '../types';
import { fetchOrderWithShipment, findActiveTicketForOrder, upsertOrderCache } from './common';

interface ResolvedPack {
  packId: string;
  orderId: string | null;
  order: MeliOrder | null;
}

/**
 * Hydrates a `messages` push (post-sale pack chat).
 *
 * The push only tells us a pack (or a raw message id) changed, so we resolve the
 * pack id, read the full thread plus the order snapshot, and emit one message per
 * marketplace message we have not persisted yet. When the conversation is
 * `blocked` the structured action guide is attached to `channel_metadata` so the
 * composer can offer the reasons.
 */
export class MessagesHydrator {
  private readonly logger: ILogger;

  constructor(
    private readonly deps: AdapterDependencies,
    private readonly client: MeliClient,
  ) {
    this.logger = deps.logger.child({ adapter: 'mercadolivre', component: 'messages' });
  }

  async hydrate(
    account: MarketplaceAccountRecord,
    resource: string | null,
    payload: Record<string, unknown>,
  ): Promise<HydratedInboundMessage[]> {
    const resolved = await this.resolvePack(account, resource, payload);
    if (!resolved) {
      this.logger.warn('meli.messages.unresolved_resource', {
        accountId: account.id,
        resource,
      });
      return [];
    }

    const { packId } = resolved;
    let orderId = resolved.orderId;
    if (!orderId) {
      const cachedOrder = await this.deps.repos.orders.findByPackId(account.id, packId);
      orderId = cachedOrder?.externalOrderId ?? null;
    }

    const warnings: string[] = [];
    let snapshot: NormalizedOrderSnapshot | null = null;
    if (resolved.order && orderId) {
      snapshot = buildOrderSnapshot(orderId, resolved.order, null);
    }
    if (!snapshot && orderId) {
      const fetched = await fetchOrderWithShipment(this.client, account.id, orderId);
      if (fetched) {
        snapshot = fetched.snapshot;
      } else {
        warnings.push('MELI_ORDER_SNAPSHOT_UNAVAILABLE');
      }
    }
    if (snapshot) {
      await upsertOrderCache(this.deps, this.logger, account.id, snapshot);
    }

    const pack = await this.client.get<MeliPackMessagesResponse>(
      account.id,
      `/messages/packs/${packId}/sellers/${account.externalSellerId}`,
      // `mark_as_read=false`: hydrating must not consume the seller's unread
      // messages (official parameter of the messaging-after-sale resource).
      { tag: 'post_sale', mark_as_read: false },
    );

    const conversation = pack.conversation_status ?? null;
    const conversationStatus = asString(conversation?.status);
    // `blocked-messages` documents `claim_ids` (array); legacy payloads use
    // `claim_id`.
    const conversationClaimId =
      asString(conversation?.claim_id) ??
      asString(asArray<number | string>(conversation?.claim_ids)[0]);
    const existingTicket = await findActiveTicketForOrder(this.deps, orderId);
    const hasActiveClaim =
      existingTicket?.hasActiveClaim === true || conversationClaimId !== null;
    const blocked = conversationStatus === 'blocked';

    let actionGuide: Record<string, unknown> | null = null;
    if (blocked) {
      try {
        const guide = await this.client.get<MeliActionGuide>(
          account.id,
          `/messages/action_guide/packs/${packId}`,
          { tag: 'post_sale' },
        );
        actionGuide = normalizeActionGuide(guide);
      } catch (error) {
        warnings.push('MELI_ACTION_GUIDE_UNAVAILABLE');
        this.logger.warn('meli.messages.action_guide_failed', {
          accountId: account.id,
          packId,
          error: errorMessage(error),
        });
      }
    }

    const buyerId = snapshot?.buyerExternalId ?? null;
    const sellerId = account.externalSellerId;
    const conversationId = asString(conversation?.path) ?? null;
    const ticketType = existingTicket?.ticketType ?? 'POST_SALE_ORDER';

    const messages = [...(pack.messages ?? [])].sort((left, right) => {
      const leftAt = this.messageDate(left)?.getTime() ?? 0;
      const rightAt = this.messageDate(right)?.getTime() ?? 0;
      return leftAt - rightAt;
    });

    const hydrated: HydratedInboundMessage[] = [];
    for (const message of messages) {
      const externalMessageId = asString(message.id) ?? asString(message.message_id);
      if (!externalMessageId) continue;

      const bodyText = truncateText(extractText(message.text));
      const attachments = normalizeAttachments(message.message_attachments ?? message.attachments);
      if (bodyText.length === 0 && attachments.length === 0) continue;

      const alreadyKnown = await this.deps.repos.messages.findByExternalMessageId(externalMessageId);
      if (alreadyKnown) continue;

      const fromUserId = asString(message.from?.user_id);
      const channelMetadata: Record<string, unknown> = {
        pack_id: packId,
        conversation_status: conversation,
        conversation_blocked: blocked,
        claim_id: conversationClaimId,
        has_active_claim: hasActiveClaim,
      };
      if (actionGuide) channelMetadata.action_guide = actionGuide;

      hydrated.push({
        accountId: account.id,
        marketplace: 'MERCADO_LIVRE',
        externalReferenceId: packId,
        ticketType,
        externalOrderId: orderId,
        packId,
        claimId: conversationClaimId,
        conversationId,
        returnSn: null,
        externalMessageId,
        direction: directionFromUserIds(fromUserId, buyerId, sellerId),
        channelRouteUsed: 'MELI_MESSAGES_API',
        messageType: 'text',
        bodyCleanText: bodyText,
        contentPayload: {
          pack_id: packId,
          message_id: externalMessageId,
          from_user_id: fromUserId,
          conversation_status: conversationStatus,
          message_status: asString(message.status),
        },
        marketplaceCreatedAt: this.messageDate(message) ?? this.deps.clock.now(),
        deliveryStatus: 'DELIVERED',
        buyer: {
          externalId: buyerId,
          displayName: snapshot?.buyerNameOrNick ?? null,
          anonymizedEmail: null,
        },
        order: snapshot,
        attachments,
        channelMetadata,
        hasActiveClaim,
        priority: 'HIGH',
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    }

    this.logger.info('meli.messages.hydrated', {
      accountId: account.id,
      packId,
      orderId,
      emitted: hydrated.length,
      blocked,
      hasActiveClaim,
    });
    return hydrated;
  }

  private messageDate(message: MeliPackMessage): Date | null {
    return parseDate(message.date) ?? parseDate(message.message_date?.created);
  }

  /**
   * Resolves the thread identifier from the push resource. Mercado Livre sends
   * `/messages/packs/{packId}`, `/messages/{messageId}` (hex or numeric) or an
   * order resource; the order response is used to derive `pack_id`.
   */
  private async resolvePack(
    account: MarketplaceAccountRecord,
    resource: string | null,
    payload: Record<string, unknown>,
  ): Promise<ResolvedPack | null> {
    const payloadOrderId =
      asString(payload.order_id) ??
      asString(payload.orderId) ??
      asString(payload.resource_id);

    if (!resource) {
      return payloadOrderId
        ? { packId: payloadOrderId, orderId: payloadOrderId, order: null }
        : null;
    }

    const clean = resource.split('?')[0]?.split('#')[0] ?? resource;

    const packMatch = /\/messages\/packs\/([^/]+)/.exec(clean);
    if (packMatch?.[1]) {
      return { packId: packMatch[1], orderId: payloadOrderId, order: null };
    }

    const orderMatch = /\/orders\/([^/]+)/.exec(clean);
    if (orderMatch?.[1]) {
      const orderId = orderMatch[1];
      const fetched = await fetchOrderWithShipment(this.client, account.id, orderId);
      return {
        packId: fetched?.snapshot.packId ?? asString(fetched?.order.pack_id) ?? orderId,
        orderId,
        order: fetched?.order ?? null,
      };
    }

    const messageMatch = /\/messages\/([^/]+)/.exec(clean);
    if (messageMatch?.[1]) {
      const messageKey = messageMatch[1];
      // Pack ids are numeric; hash/hex values are individual messages.
      if (/^\d+$/.test(messageKey)) {
        return { packId: messageKey, orderId: payloadOrderId, order: null };
      }
      return this.resolveMessageHash(account, messageKey, payloadOrderId);
    }

    // New sub-topic model: `resource` is an opaque message hash with no path
    // (`GET /messages/{resource}` resolves it, per the notifications docs).
    if (isOpaqueMessageResource(clean)) {
      return this.resolveMessageHash(account, clean, payloadOrderId);
    }

    return null;
  }

  /**
   * Resolves an individual message id (the `resource` hash of a `messages`
   * notification) to its pack/order ids via `GET /messages/{id}`.
   */
  private async resolveMessageHash(
    account: MarketplaceAccountRecord,
    messageKey: string,
    payloadOrderId: string | null,
  ): Promise<ResolvedPack | null> {
    try {
      const detail = await this.client.get<MeliMessageDetail>(
        account.id,
        `/messages/${messageKey}`,
      );
      const packId =
        extractPackIdFromMessageResources(detail.message_resources) ??
        asString(detail.pack_id) ??
        messageKey;
      const orderId =
        asString(detail.order_id) ??
        asString(detail.resource_id) ??
        payloadOrderId;
      return { packId, orderId, order: null };
    } catch (error) {
      this.logger.warn('meli.messages.message_lookup_failed', {
        accountId: account.id,
        messageKey,
        error: errorMessage(error),
      });
      return null;
    }
  }
}
