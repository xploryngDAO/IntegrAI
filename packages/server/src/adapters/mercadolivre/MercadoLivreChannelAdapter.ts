import {
  redactPiiForLogs,
  type AccountLookup,
  type AdapterDependencies,
  type ChannelActionRequest,
  type ChannelActionResult,
  type HydratedInboundMessage,
  type ILogger,
  type IMarketplaceChannelAdapter,
  type InboundEnvelope,
  type Marketplace,
  type NormalizedOrderSnapshot,
  type OutboundDraft,
  type OutboundResult,
  type OutboundValidationInput,
  type PolicyEvaluation,
  type RawWebhookRequest,
  type RouteDecision,
  type WebhookVerification,
} from '@sac/shared';
import { loadMeliAccount } from './account';
import { MeliAuth } from './client/MeliAuth';
import { MeliClient } from './client/MeliClient';
import { ClaimsHydrator } from './inbound/ClaimsHydrator';
import { MessagesHydrator } from './inbound/MessagesHydrator';
import { OrdersHydrator } from './inbound/OrdersHydrator';
import { QuestionsHydrator } from './inbound/QuestionsHydrator';
import { fetchOrderWithShipment, upsertOrderCache } from './inbound/common';
import {
  asString,
  errorMessage,
  extractResourceSegment,
  extractRespondentActions,
  isRecord,
  parseJsonBody,
} from './mappers';
import { MeliOutbound } from './outbound/MeliOutbound';
import type { MeliClaim } from './types';

const THIRTY_MINUTES_MS = 30 * 60 * 1000;

/**
 * Mercado Livre channel adapter.
 *
 * All I/O goes through `AdapterDependencies` (http, cache, lock, rate limiter,
 * repositories, cipher, logger); the class only wires the auth/client/hydrator/
 * outbound collaborators and implements `IMarketplaceChannelAdapter`.
 */
export class MercadoLivreChannelAdapter implements IMarketplaceChannelAdapter {
  readonly marketplace: Marketplace = 'MERCADO_LIVRE';

  private readonly logger: ILogger;
  private readonly auth: MeliAuth;
  private readonly client: MeliClient;
  private readonly questions: QuestionsHydrator;
  private readonly messages: MessagesHydrator;
  private readonly claims: ClaimsHydrator;
  private readonly orders: OrdersHydrator;
  private readonly outbound: MeliOutbound;

  constructor(private readonly deps: AdapterDependencies) {
    this.logger = deps.logger.child({ adapter: 'mercadolivre' });
    this.auth = new MeliAuth(deps);
    this.client = new MeliClient(deps, this.auth);
    this.questions = new QuestionsHydrator(deps, this.client);
    this.messages = new MessagesHydrator(deps, this.client);
    this.claims = new ClaimsHydrator(deps, this.client);
    this.orders = new OrdersHydrator(deps, this.client);
    this.outbound = new MeliOutbound(deps, this.client);
  }

  /* ------------------------------- Inbound -------------------------------- */

  /**
   * Mercado Livre has no cryptographic push signature. The payload is parsed
   * defensively and the seller (`user_id`) must resolve to a connected account;
   * otherwise the event is rejected as `UNKNOWN_SELLER`.
   */
  async verifyInbound(request: RawWebhookRequest): Promise<WebhookVerification> {
    const payload = parseJsonBody(request.rawBody);
    const baseLookup: AccountLookup = { marketplace: 'MERCADO_LIVRE' };

    if (!payload) {
      this.logger.warn('meli.webhook.invalid_payload', { remoteIp: request.remoteIp });
      return {
        valid: false,
        reason: 'INVALID_PAYLOAD',
        accountLookup: baseLookup,
        payload: {},
      };
    }

    const externalSellerId = asString(payload.user_id) ?? asString(payload.userId);
    const eventId = asString(payload._id) ?? asString(payload.id);
    const topic = asString(payload.topic);
    const resource = asString(payload.resource);

    if (!externalSellerId) {
      return {
        valid: false,
        reason: 'UNKNOWN_SELLER',
        eventId,
        topic,
        resource,
        accountLookup: baseLookup,
        payload,
      };
    }

    const account = await this.deps.repos.accounts.findByExternalSeller(
      'MERCADO_LIVRE',
      externalSellerId,
    );
    if (!account) {
      this.logger.warn('meli.webhook.unknown_seller', { externalSellerId, eventId, topic });
      return {
        valid: false,
        reason: 'UNKNOWN_SELLER',
        eventId,
        topic,
        resource,
        accountLookup: { marketplace: 'MERCADO_LIVRE', externalSellerId },
        payload,
      };
    }

    return {
      valid: true,
      reason: 'MELI_NO_SIGNATURE',
      eventId,
      topic,
      resource,
      accountLookup: {
        marketplace: 'MERCADO_LIVRE',
        accountId: account.id,
        externalSellerId,
        marketplaceSiteId: account.marketplaceSiteId,
      },
      payload,
    };
  }

  async hydrate(envelope: InboundEnvelope): Promise<HydratedInboundMessage[]> {
    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const topic = (asString(envelope.topic) ?? asString(payload.topic) ?? '')
      .toLowerCase()
      .replace(/-/g, '_');
    const resource = asString(envelope.resource) ?? asString(payload.resource);
    const account = await loadMeliAccount(this.deps, envelope.accountId);

    try {
      switch (topic) {
        case 'questions': {
          const questionId =
            extractResourceSegment(resource, 'questions') ??
            asString(payload.question_id) ??
            asString(payload.resource_id);
          if (!questionId) {
            this.logger.warn('meli.inbound.unmapped_resource', {
              accountId: account.id,
              topic,
              resource,
              warning: `UNMAPPED_RESOURCE:${topic}`,
            });
            return [];
          }
          return await this.questions.hydrate(account, questionId);
        }
        case 'messages':
          return await this.messages.hydrate(account, resource, payload);
        case 'claims':
        case 'post_purchase':
        case 'postpurchase': {
          const claimId =
            extractResourceSegment(resource, 'claims') ??
            asString(payload.claim_id) ??
            asString(payload.resource_id);
          if (!claimId) {
            this.logger.warn('meli.inbound.unmapped_resource', {
              accountId: account.id,
              topic,
              resource,
              warning: `UNMAPPED_RESOURCE:${topic}`,
            });
            return [];
          }
          return await this.claims.hydrate(account, claimId);
        }
        case 'orders':
          await this.orders.hydrateOrders(account, resource, payload);
          return [];
        case 'shipments':
          return await this.orders.hydrateShipments(account, resource, payload);
        default:
          this.logger.warn('meli.inbound.unmapped_topic', {
            accountId: account.id,
            topic,
            resource,
            warning: `UNMAPPED_TOPIC:${topic}`,
          });
          return [];
      }
    } catch (error) {
      this.logger.error('meli.inbound.hydrate_failed', {
        accountId: account.id,
        topic,
        resource,
        error: redactPiiForLogs(errorMessage(error)),
      });
      throw error;
    }
  }

  async enrichOrder(input: {
    accountId: string;
    externalOrderId: string;
    ticketId: string;
  }): Promise<{ order: NormalizedOrderSnapshot } | null> {
    const account = await loadMeliAccount(this.deps, input.accountId);
    const fetched = await fetchOrderWithShipment(
      this.client,
      account.id,
      input.externalOrderId,
    );
    if (!fetched) {
      this.logger.error('meli.enrich_order.failed', {
        accountId: account.id,
        externalOrderId: input.externalOrderId,
        ticketId: input.ticketId,
      });
      return null;
    }

    let snapshot = fetched.snapshot;
    const ticket = await this.deps.repos.tickets.findActiveByExternalOrderId(
      'MERCADO_LIVRE',
      input.externalOrderId,
    );
    const claimId =
      ticket?.claimId ??
      asString(ticket?.channelMetadata.claim_id) ??
      asString(ticket?.channelMetadata.claimId);

    const allowedActions: Record<string, unknown> = { ...snapshot.allowedActions };
    if (claimId) {
      try {
        const claim = await this.client.get<MeliClaim>(
          account.id,
          `/post-purchase/v1/claims/${claimId}`,
        );
        allowedActions.claim = {
          claim_id: claimId,
          status: asString(claim.status),
          stage: asString(claim.stage),
          due_date: asString(claim.due_date),
          available_actions: extractRespondentActions(claim),
        };
      } catch (error) {
        this.logger.warn('meli.enrich_order.claim_unavailable', {
          accountId: account.id,
          claimId,
          error: errorMessage(error),
        });
      }
    }

    snapshot = { ...snapshot, allowedActions };
    await upsertOrderCache(this.deps, this.logger, account.id, snapshot);
    return { order: snapshot };
  }

  /* ------------------------------- Outbound ------------------------------- */

  async send(draft: OutboundDraft): Promise<OutboundResult> {
    return this.outbound.send(draft);
  }

  async executeAction(request: ChannelActionRequest): Promise<ChannelActionResult> {
    return this.outbound.executeAction(request);
  }

  validateOutbound(input: OutboundValidationInput): PolicyEvaluation {
    return this.outbound.validateOutbound(input);
  }

  resolveRoute(input: OutboundValidationInput): RouteDecision {
    return this.outbound.resolveRoute(input);
  }

  /* ------------------------------ Maintenance ------------------------------ */

  /** Refreshes Meli tokens that expire within 30 minutes (serialized per account). */
  async runMaintenance(): Promise<{ task: string; ok: boolean; detail: string }[]> {
    const now = this.deps.clock.now();
    const accounts = await this.deps.repos.accounts.list({
      marketplace: 'MERCADO_LIVRE',
      status: 'ACTIVE',
    });

    if (accounts.length === 0) {
      return [
        {
          task: 'meli.token.refresh',
          ok: true,
          detail: 'Nenhuma conta Mercado Livre ativa para renovar',
        },
      ];
    }

    const results: { task: string; ok: boolean; detail: string }[] = [];
    for (const account of accounts) {
      const expiresAt = account.tokenExpiresAt;
      const due = expiresAt === null || expiresAt.getTime() - now.getTime() <= THIRTY_MINUTES_MS;
      if (!due) {
        results.push({
          task: 'meli.token.refresh',
          ok: true,
          detail: `Conta ${account.id}: token válido até ${expiresAt?.toISOString() ?? 'desconhecido'}`,
        });
        continue;
      }
      try {
        await this.auth.refreshAccessToken(account.id, { force: true, reason: 'maintenance' });
        results.push({
          task: 'meli.token.refresh',
          ok: true,
          detail: `Conta ${account.id}: token renovado`,
        });
      } catch (error) {
        results.push({
          task: 'meli.token.refresh',
          ok: false,
          detail: `Conta ${account.id}: falha ao renovar token — ${redactPiiForLogs(
            errorMessage(error),
          )}`,
        });
      }
    }
    return results;
  }
}
