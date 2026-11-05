import type {
  AdapterDependencies,
  HydratedInboundMessage,
  ILogger,
  MarketplaceAccountRecord,
  NormalizedOrderSnapshot,
} from '@sac/shared';
import type { MeliClient } from '../client/MeliClient';
import {
  asString,
  claimHasMediator,
  claimPlayersMetadata,
  directionFromClaimUserIds,
  errorMessage,
  extractClaimOrderId,
  extractRespondentActions,
  extractText,
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
    const claim = await this.client.get<MeliClaim>(
      account.id,
      `/post-purchase/v1/claims/${claimId}`,
    );
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
    const dueDate = parseDate(claim.due_date);
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
      const response = await this.client.get<MeliClaimMessagesResponse | MeliClaimMessage[]>(
        account.id,
        `/post-purchase/v1/claims/${resolvedClaimId}/messages`,
      );
      claimMessages = Array.isArray(response) ? response : (response.messages ?? []);
    } catch (error) {
      warnings.push('MELI_CLAIM_MESSAGES_UNAVAILABLE');
      this.logger.warn('meli.claims.messages_failed', {
        accountId: account.id,
        claimId: resolvedClaimId,
        error: errorMessage(error),
      });
    }

    const hydrated: HydratedInboundMessage[] = [];
    for (const message of claimMessages) {
      const claimMessageId = asString(message.id) ?? asString(message.message_id);
      if (!claimMessageId) continue;
      const externalMessageId = `claim:${resolvedClaimId}:${claimMessageId}`;
      const alreadyKnown = await this.deps.repos.messages.findByExternalMessageId(
        externalMessageId,
      );
      if (alreadyKnown) continue;

      const bodyText = truncateText(extractText(message.text));
      const attachments = normalizeAttachments(message.attachments);
      if (bodyText.length === 0 && attachments.length === 0) continue;

      const fromUserId = asString(message.from?.user_id);
      hydrated.push({
        ...this.baseMessage(account, resolvedClaimId, orderId, snapshot, baseMetadata, dueDate, mediatorPresent),
        externalMessageId,
        direction: directionFromClaimUserIds(fromUserId, buyerId, sellerId, mediatorId),
        messageType: 'text',
        bodyCleanText: bodyText,
        contentPayload: {
          claim_id: resolvedClaimId,
          claim_message_id: claimMessageId,
          claim_status: claimStatus,
          claim_stage: claimStage,
          claim_type: claimType,
          from_user_id: fromUserId,
        },
        marketplaceCreatedAt:
          parseDate(message.date) ?? parseDate(message.date_created) ?? this.deps.clock.now(),
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
