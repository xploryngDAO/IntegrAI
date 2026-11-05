import {
  MarketplaceApiError,
  type AdapterDependencies,
  type HydratedInboundMessage,
  type ILogger,
  type MarketplaceAccountRecord,
  type NormalizedOrderSnapshot,
} from '@sac/shared';
import type { MeliClient } from '../client/MeliClient';
import {
  asString,
  claimHasMediator,
  claimMessageExternalId,
  claimPlayersMetadata,
  directionFromClaimSenderRole,
  directionFromClaimUserIds,
  errorMessage,
  extractClaimMessageText,
  extractClaimOrderId,
  extractRespondentActions,
  findClaimPlayer,
  normalizeAttachments,
  parseDate,
  truncateText,
} from '../mappers';
import type {
  MeliClaim,
  MeliClaimMessage,
  MeliClaimMessagesResponse,
} from '../types';
import { fetchOrderWithShipment, upsertOrderCache } from './common';

/** 404/405 on a documented endpoint variant: try the other API base. */
function isMissingEndpoint(error: unknown): boolean {
  return error instanceof MarketplaceApiError && (error.status === 404 || error.status === 405);
}

/**
 * Hydrates a `claims` / `post_purchase` push:
 * `GET /post-purchase/v1/claims/{claimId}` +
 * `GET /post-purchase/v1/claims/{claimId}/messages`.
 *
 * The seller's `available_actions` (players[role=respondent]) and the claim
 * `due_date` are propagated through `channel_metadata`/`slaDeadlineAt` so the
 * cockpit can only offer actions Mercado Livre actually allows and the SLA uses
 * the marketplace deadline. `hasActiveClaim` is always true.
 */
export class ClaimsHydrator {
  private readonly logger: ILogger;

  constructor(
    private readonly deps: AdapterDependencies,
    private readonly client: MeliClient,
  ) {
    this.logger = deps.logger.child({ adapter: 'mercadolivre', component: 'claims' });
  }

  async hydrate(
    account: MarketplaceAccountRecord,
    claimId: string,
  ): Promise<HydratedInboundMessage[]> {
    const claim = await this.fetchClaim(account.id, claimId);
    const resolvedClaimId = asString(claim.id) ?? claimId;
    const orderId = extractClaimOrderId(claim);
    const warnings: string[] = [];

    let snapshot: NormalizedOrderSnapshot | null = null;
    if (orderId) {
      const fetched = await fetchOrderWithShipment(this.client, account.id, orderId);
      if (fetched) {
        snapshot = fetched.snapshot;
        await upsertOrderCache(this.deps, this.logger, account.id, snapshot);
      } else {
        warnings.push('MELI_ORDER_SNAPSHOT_UNAVAILABLE');
      }
    }

    const complainant = findClaimPlayer(claim, 'complainant');
    const respondent = findClaimPlayer(claim, 'respondent');
    const mediator = findClaimPlayer(claim, 'mediator');
    const mediatorPresent = claimHasMediator(claim);
    const buyerId = asString(complainant?.user_id);
    const sellerId = asString(respondent?.user_id) ?? account.externalSellerId;
    const mediatorId = asString(mediator?.user_id);
    const availableActions = extractRespondentActions(claim);
    // `claim.due_date` is authoritative when present; otherwise use the earliest
    // seller action deadline (available_actions[].due_date).
    const actionDueDates = availableActions
      .map((action) => parseDate(action.due_date))
      .filter((date): date is Date => date !== null)
      .sort((left, right) => left.getTime() - right.getTime());
    const dueDate = parseDate(claim.due_date) ?? actionDueDates[0] ?? null;
    const claimStatus = asString(claim.status);
    const claimStage = asString(claim.stage);
    const claimType = asString(claim.type);

    const baseMetadata: Record<string, unknown> = {
      claim_id: resolvedClaimId,
      claim_status: claimStatus,
      claim_stage: claimStage,
      claim_type: claimType,
      due_date: asString(claim.due_date),
      available_actions: availableActions,
      players: claimPlayersMetadata(claim),
      mediator_present: mediatorPresent,
    };

    let claimMessages: MeliClaimMessage[] = [];
    try {
      claimMessages = await this.fetchClaimMessages(account.id, resolvedClaimId);
    } catch (error) {
      warnings.push('MELI_CLAIM_MESSAGES_UNAVAILABLE');
      this.logger.warn('meli.claims.messages_failed', {
        accountId: account.id,
        claimId: resolvedClaimId,
        error: errorMessage(error),
      });
    }

    const hydrated: HydratedInboundMessage[] = [];
    for (const [index, message] of claimMessages.entries()) {
      const directMessageId = asString(message.id) ?? asString(message.message_id);
      const externalMessageId = claimMessageExternalId(resolvedClaimId, message, index);
      const alreadyKnown =
        await this.deps.repos.messages.findByExternalMessageId(externalMessageId);
      if (alreadyKnown) continue;

      const bodyText = truncateText(extractClaimMessageText(message));
      const attachments = normalizeAttachments(message.attachments);
      if (bodyText.length === 0 && attachments.length === 0) continue;

      const fromUserId = asString(message.from?.user_id);
      const senderRole = asString(message.sender_role);
      const direction = fromUserId
        ? directionFromClaimUserIds(fromUserId, buyerId, sellerId, mediatorId)
        : (directionFromClaimSenderRole(senderRole) ?? 'MEDIATOR');

      hydrated.push({
        ...this.baseMessage(account, resolvedClaimId, orderId, snapshot, baseMetadata, dueDate, mediatorPresent),
        externalMessageId,
        direction,
        messageType: 'text',
        bodyCleanText: bodyText,
        contentPayload: {
          claim_id: resolvedClaimId,
          claim_message_id: directMessageId,
          claim_status: claimStatus,
          claim_stage: claimStage,
          claim_type: claimType,
          sender_role: senderRole,
          receiver_role: asString(message.receiver_role),
          from_user_id: fromUserId,
        },
        marketplaceCreatedAt:
          parseDate(message.date) ??
          parseDate(message.message_date) ??
          parseDate(message.date_created) ??
          this.deps.clock.now(),
        attachments,
      });
    }

    // A claim push must always produce a message (otherwise the ticket is never
    // created/flipped). Only synthesize the status event when the thread could
    // not be read — an all-duplicates replay must stay a no-op.
    if (hydrated.length === 0 && claimMessages.length === 0) {
      hydrated.push({
        ...this.baseMessage(account, resolvedClaimId, orderId, snapshot, baseMetadata, dueDate, mediatorPresent),
        externalMessageId: `claim:${resolvedClaimId}`,
        direction: 'OUTBOUND_SYSTEM',
        messageType: 'action_system',
        bodyCleanText: truncateText(
          `Reclamação ${resolvedClaimId} — status ${claimStatus ?? 'desconhecido'}${
            claimStage ? ` / ${claimStage}` : ''
          }`,
        ),
        contentPayload: {
          claim_id: resolvedClaimId,
          claim_status: claimStatus,
          claim_stage: claimStage,
          claim_type: claimType,
        },
        marketplaceCreatedAt:
          parseDate(claim.last_updated) ?? parseDate(claim.date_created) ?? this.deps.clock.now(),
        attachments: [],
        isSystemEvent: true,
      });
    }

    this.logger.info('meli.claims.hydrated', {
      accountId: account.id,
      claimId: resolvedClaimId,
      orderId,
      emitted: hydrated.length,
      mediatorPresent,
    });
    return hydrated;
  }

  /**
   * Claim detail. `post-purchase/v1` is the documented resource for local
   * sellers (and the contract path); Global Selling CBT sellers are served by
   * `marketplace/v2`, so a missing endpoint falls back once.
   */
  private async fetchClaim(accountId: string, claimId: string): Promise<MeliClaim> {
    try {
      return await this.client.get<MeliClaim>(
        accountId,
        `/post-purchase/v1/claims/${claimId}`,
      );
    } catch (error) {
      if (!isMissingEndpoint(error)) throw error;
      return this.client.get<MeliClaim>(accountId, `/marketplace/v2/claims/${claimId}`);
    }
  }

  /** `GET .../claims/{id}/messages` with the CBT (`marketplace/v2`) fallback. */
  private async fetchClaimMessages(
    accountId: string,
    claimId: string,
  ): Promise<MeliClaimMessage[]> {
    let response: MeliClaimMessagesResponse | MeliClaimMessage[];
    try {
      response = await this.client.get<MeliClaimMessagesResponse | MeliClaimMessage[]>(
        accountId,
        `/post-purchase/v1/claims/${claimId}/messages`,
      );
    } catch (error) {
      if (!isMissingEndpoint(error)) throw error;
      response = await this.client.get<MeliClaimMessagesResponse | MeliClaimMessage[]>(
        accountId,
        `/marketplace/v2/claims/${claimId}/messages`,
      );
    }
    return Array.isArray(response) ? response : (response.messages ?? []);
  }

  /** Fields shared by every message of the claim thread. */
  private baseMessage(
    account: MarketplaceAccountRecord,
    claimId: string,
    orderId: string | null,
    snapshot: NormalizedOrderSnapshot | null,
    channelMetadata: Record<string, unknown>,
    dueDate: Date | null,
    mediatorPresent: boolean,
  ): HydratedInboundMessage {
    return {
      accountId: account.id,
      marketplace: 'MERCADO_LIVRE',
      externalReferenceId: claimId,
      ticketType: 'CLAIM_DISPUTE',
      externalOrderId: orderId,
      packId: snapshot?.packId ?? null,
      claimId,
      conversationId: null,
      returnSn: null,
      externalMessageId: `claim:${claimId}`,
      direction: 'INBOUND_BUYER',
      channelRouteUsed: 'MELI_CLAIMS_API',
      messageType: 'text',
      bodyCleanText: '',
      contentPayload: { claim_id: claimId },
      marketplaceCreatedAt: this.deps.clock.now(),
      deliveryStatus: 'DELIVERED',
      buyer: {
        externalId: snapshot?.buyerExternalId ?? null,
        displayName: snapshot?.buyerNameOrNick ?? null,
        anonymizedEmail: null,
      },
      order: snapshot,
      attachments: [],
      channelMetadata,
      hasActiveClaim: true,
      priority: 'CRITICAL_SLA',
      slaDeadlineAt: dueDate,
      statusHint: mediatorPresent ? 'MEDIATION' : undefined,
    };
  }
}
