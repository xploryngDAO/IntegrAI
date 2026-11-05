import { CACHE_KEYS, redactPiiForLogs } from '@sac/shared';
import type {
  IAccountRepository,
  IAdapterRegistry,
  ICache,
  IClock,
  ILogger,
  IQueuePublisher,
  IWebhookEventRepository,
  IWebhookIngressService,
  InboundJobPayload,
  Marketplace,
  MarketplaceAccountRecord,
  RawWebhookRequest,
  WebhookAck,
  WebhookVerification,
} from '@sac/shared';

import { enqueueInbound } from '../queues/producers';

/**
 * ============================================================================
 * WebhookIngressService
 * ============================================================================
 *
 * The fast path every marketplace webhook goes through. It must stay within the
 * channel budgets (Meli < 500ms, Shopee < 100ms, Amazon relay < 1s), so it only:
 *
 *   1. verifies the signature with the adapter (pure/in-process);
 *   2. resolves the owning account (Shopee refuses unknown shops);
 *   3. claims the Redis idempotency key (`SET NX EX 86400`);
 *   4. persists the `webhook_events` audit row;
 *   5. enqueues the raw payload for hydration and returns an ack.
 *
 * Nothing here calls a marketplace API or opens a DB transaction beyond the
 * single audit insert.
 */

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export interface WebhookIngressServiceDependencies {
  logger: ILogger;
  clock: IClock;
  cache: ICache;
  queue: IQueuePublisher;
  adapters: IAdapterRegistry;
  repos: {
    webhookEvents: IWebhookEventRepository;
    accounts: IAccountRepository;
  };
}

export class WebhookIngressService implements IWebhookIngressService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly cache: ICache;
  private readonly queue: IQueuePublisher;
  private readonly adapters: IAdapterRegistry;
  private readonly repos: WebhookIngressServiceDependencies['repos'];

  constructor(deps: WebhookIngressServiceDependencies) {
    this.logger = deps.logger.child({ component: 'WebhookIngressService' });
    this.clock = deps.clock;
    this.cache = deps.cache;
    this.queue = deps.queue;
    this.adapters = deps.adapters;
    this.repos = deps.repos;
  }

  async accept(marketplace: Marketplace, request: RawWebhookRequest): Promise<WebhookAck> {
    const started = Date.now();
    const now = this.clock.now();

    const adapter = this.adapters.get(marketplace);

    // 1. Signature verification -------------------------------------------
    let verification: WebhookVerification;
    try {
      verification = await adapter.verifyInbound(request);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.safeRecord({
        marketplace,
        status: 'FAILED',
        signatureValid: false,
        payload: {},
        error: `VERIFICATION_ERROR:${redactPiiForLogs(reason).slice(0, 300)}`,
      });
      this.logger.warn('webhook.verification_error', {
        marketplace,
        reason: redactPiiForLogs(reason).slice(0, 300),
      });
      return this.rejected(marketplace, started, { reason: 'VERIFICATION_ERROR' }, 401);
    }

    if (!verification.valid) {
      await this.safeRecord({
        marketplace,
        eventId: verification.eventId ?? null,
        topic: verification.topic ?? null,
        resource: verification.resource ?? null,
        status: 'FAILED',
        signatureValid: false,
        payload: verification.payload ?? {},
        error: `INVALID_SIGNATURE:${verification.reason}`,
      });
      this.logger.warn('webhook.invalid_signature', {
        marketplace,
        reason: verification.reason,
      });
      return this.rejected(marketplace, started, { reason: 'INVALID_SIGNATURE' }, 401);
    }

    // 2. Account resolution -----------------------------------------------
    const account = await this.resolveAccount(marketplace, verification);
    if (!account) {
      await this.safeRecord({
        marketplace,
        eventId: verification.eventId ?? null,
        topic: verification.topic ?? null,
        resource: verification.resource ?? null,
        status: 'FAILED',
        signatureValid: true,
        payload: verification.payload ?? {},
        error: 'UNKNOWN_ACCOUNT',
      });
      this.logger.warn('webhook.unknown_account', {
        marketplace,
        topic: verification.topic ?? null,
        // Never log seller identifiers alongside PII; seller id is not PII but
        // keep the log minimal anyway.
        hasEventId: Boolean(verification.eventId),
      });
      return this.rejected(marketplace, started, { reason: 'UNKNOWN_ACCOUNT' }, 401);
    }

    // 3. Idempotency -------------------------------------------------------
    const eventId = verification.eventId ?? null;
    const idempotencyKey = eventId ? CACHE_KEYS.webhookIdempotency(marketplace, eventId) : null;

    if (idempotencyKey) {
      let claimed = false;
      try {
        claimed = await this.cache.setNx(idempotencyKey, '1', IDEMPOTENCY_TTL_SECONDS);
      } catch (error) {
        // Fail open: a Redis hiccup must not drop a marketplace webhook.
        this.logger.error('webhook.idempotency_unavailable', {
          marketplace,
          error: redactPiiForLogs(errorMessage(error)),
        });
        claimed = true;
      }

      if (!claimed) {
        await this.safeRecord({
          marketplace,
          accountId: account.id,
          eventId,
          topic: verification.topic ?? null,
          resource: verification.resource ?? null,
          status: 'DUPLICATE',
          signatureValid: true,
          payload: verification.payload ?? {},
        });
        this.logger.debug('webhook.duplicate', { marketplace, eventId });
        return {
          accepted: true,
          duplicate: true,
          status: 'DUPLICATE',
          httpStatus: 200,
          body: { status: 'DUPLICATE' },
          eventId,
          durationMs: Date.now() - started,
        };
      }
    }

    // 4. Persist the audit row --------------------------------------------
    let webhookEventId: string | null = null;
    try {
      const record = await this.repos.webhookEvents.record({
        tenantId: account.tenantId ?? null,
        marketplace,
        accountId: account.id,
        eventId,
        topic: verification.topic ?? null,
        resource: verification.resource ?? null,
        status: 'RECEIVED',
        signatureValid: true,
        payload: verification.payload ?? {},
      });
      webhookEventId = record.id;
    } catch (error) {
      if (idempotencyKey) await this.releaseIdempotency(idempotencyKey);
      this.logger.error('webhook.persist_failed', {
        marketplace,
        error: redactPiiForLogs(errorMessage(error)),
      });
      return this.rejected(marketplace, started, { reason: 'PERSIST_FAILED' }, 503, eventId);
    }

    // 5. Enqueue for hydration -------------------------------------------
    const jobPayload: InboundJobPayload = {
      marketplace,
      accountId: account.id,
      topic: verification.topic ?? null,
      resource: verification.resource ?? null,
      eventId,
      payload: verification.payload ?? {},
      rawS3Uri: null,
      receivedAt: now.toISOString(),
      webhookEventId,
    };

    try {
      await enqueueInbound(this.queue, marketplace, jobPayload, {
        jobId: eventId
          ? `inbound:${marketplace}:${eventId}`
          : `inbound:${marketplace}:${account.id}:${now.getTime()}`,
      });
    } catch (error) {
      if (idempotencyKey) await this.releaseIdempotency(idempotencyKey);
      if (webhookEventId) {
        await this.safeMarkStatus(webhookEventId, 'FAILED', {
          error: `ENQUEUE_FAILED:${redactPiiForLogs(errorMessage(error)).slice(0, 300)}`,
        });
      }
      this.logger.error('webhook.enqueue_failed', {
        marketplace,
        error: redactPiiForLogs(errorMessage(error)),
      });
      return this.rejected(marketplace, started, { reason: 'ENQUEUE_FAILED' }, 503, eventId);
    }

    const durationMs = Date.now() - started;
    this.logger.debug('webhook.accepted', {
      marketplace,
      topic: verification.topic ?? null,
      eventId,
      accountId: account.id,
      durationMs,
    });

    return {
      accepted: true,
      duplicate: false,
      status: 'ACCEPTED',
      httpStatus: 200,
      body: { status: marketplace === 'SHOPEE' ? 'ACK' : 'OK' },
      eventId,
      durationMs,
    };
  }

  /* ==================================================================== */
  /* Helpers                                                              */
  /* ==================================================================== */

  private async resolveAccount(
    marketplace: Marketplace,
    verification: WebhookVerification,
  ): Promise<MarketplaceAccountRecord | null> {
    const lookup = verification.accountLookup;
    try {
      if (lookup?.accountId) {
        const byId = await this.repos.accounts.findById(lookup.accountId);
        if (byId) return byId;
      }
      if (lookup?.externalSellerId) {
        const bySeller = await this.repos.accounts.findByExternalSeller(
          marketplace,
          lookup.externalSellerId,
          lookup.marketplaceSiteId,
        );
        if (bySeller) return bySeller;
      }
      // Amazon relay can route by inbound e-mail address that only maps to one
      // connected seller in practice. Shopee/Meli must resolve explicitly:
      // accepting an unknown shop would create tickets on the wrong account.
      if (marketplace !== 'SHOPEE' && !lookup?.externalSellerId) {
        return await this.repos.accounts.findFirstByMarketplace(marketplace);
      }
    } catch (error) {
      this.logger.error('webhook.account_lookup_failed', {
        marketplace,
        error: redactPiiForLogs(errorMessage(error)),
      });
    }
    return null;
  }

  private rejected(
    marketplace: Marketplace,
    started: number,
    body: Record<string, unknown>,
    httpStatus: number,
    eventId?: string | null,
  ): WebhookAck {
    return {
      accepted: false,
      duplicate: false,
      status: 'REJECTED',
      httpStatus,
      body: { status: 'ERROR', marketplace, ...body },
      eventId: eventId ?? null,
      durationMs: Date.now() - started,
    };
  }

  private async safeRecord(input: Parameters<IWebhookEventRepository['record']>[0]): Promise<void> {
    try {
      await this.repos.webhookEvents.record(input);
    } catch (error) {
      this.logger.error('webhook.audit_write_failed', {
        marketplace: input.marketplace,
        status: input.status,
        error: redactPiiForLogs(errorMessage(error)),
      });
    }
  }

  private async safeMarkStatus(
    id: string,
    status: 'RECEIVED' | 'DUPLICATE' | 'PROCESSED' | 'FAILED' | 'DEAD_LETTER',
    detail?: { error?: string | null; processedAt?: Date },
  ): Promise<void> {
    try {
      await this.repos.webhookEvents.markStatus(id, status, detail);
    } catch (error) {
      this.logger.error('webhook.audit_status_failed', {
        webhookEventId: id,
        status,
        error: redactPiiForLogs(errorMessage(error)),
      });
    }
  }

  private async releaseIdempotency(key: string): Promise<void> {
    try {
      await this.cache.del(key);
    } catch (error) {
      this.logger.warn('webhook.idempotency_release_failed', {
        error: redactPiiForLogs(errorMessage(error)),
      });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
