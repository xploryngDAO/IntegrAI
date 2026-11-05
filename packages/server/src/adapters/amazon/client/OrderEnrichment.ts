import { CACHE_KEYS, MarketplaceApiError, redactPiiForLogs } from '@sac/shared';
import type {
  AdapterDependencies,
  BuyerPiiSnapshot,
  ILogger,
  MarketplaceAccountRecord,
  NormalizedOrderSnapshot,
} from '@sac/shared';
import { parseChannelSettings, toBuyerPii, toOrderSnapshot, toUpsertOrderInput } from '../mappers';
import type { AmazonOrderBundle } from '../types';
import type { SpApiClient } from './SpApiClient';

/**
 * Amazon order enrichment: non-restricted order business data with the LWA
 * token, restricted buyer PII with an RDT, and PII persistence into the vault
 * (never into `support_tickets`).
 *
 * Degradation contract: order reads are fatal (worker retries), while missing
 * items / messaging actions / PII (403) produce warnings so the inbound message
 * is still persisted.
 */
export class OrderEnrichmentService {
  private readonly deps: AdapterDependencies;
  private readonly spApi: SpApiClient;
  private readonly logger: ILogger;

  constructor(deps: AdapterDependencies, spApi: SpApiClient) {
    this.deps = deps;
    this.spApi = spApi;
    this.logger = deps.logger.child({ component: 'amazon.enrichment' });
  }

  async fetchOrderBundle(
    account: MarketplaceAccountRecord,
    orderId: string,
    buyerAnonymizedEmail: string | null,
  ): Promise<AmazonOrderBundle> {
    const warnings: string[] = [];

    const rawOrder = await this.spApi.getOrder(account.id, orderId);

    let items: Awaited<ReturnType<SpApiClient['getOrderItems']>> = [];
    try {
      items = await this.spApi.getOrderItems(account.id, orderId);
    } catch (error) {
      warnings.push('AMAZON_ORDER_ITEMS_UNAVAILABLE');
      this.logWarn('getOrderItems', error, account.id, orderId);
    }

    const allowedActions = await this.loadAllowedActions(account, orderId, { warnings });

    let restricted: Awaited<ReturnType<SpApiClient['getOrderWithRestrictedData']>> | null = null;
    try {
      restricted = await this.spApi.getOrderWithRestrictedData(account.id, orderId);
    } catch (error) {
      if (error instanceof MarketplaceApiError && error.retryable) {
        // 429/5xx: let the worker retry instead of silently degrading.
        throw error;
      }
      if (error instanceof MarketplaceApiError) {
        // 403 (not authorized for restricted data) or another non-retryable
        // restriction failure: keep the order, flag the missing PII.
        warnings.push('AMAZON_PII_NOT_AVAILABLE');
        this.logWarn('getOrderWithRestrictedData', error, account.id, orderId);
      } else {
        throw error;
      }
    }

    const order = toOrderSnapshot(
      rawOrder,
      items,
      allowedActions,
      buyerAnonymizedEmail,
      restricted,
      orderId,
    );
    const buyerPii = toBuyerPii(restricted, buyerAnonymizedEmail);

    return { order, buyerPii, allowedActions, warnings, rawOrder };
  }

  /**
   * Allowed proactive actions for the order. A successful (even empty) SP-API
   * answer is authoritative; the cached `allowed_actions_cache` is only a
   * fallback when the API call fails.
   */
  async loadAllowedActions(
    account: MarketplaceAccountRecord,
    orderId: string,
    options?: { strict?: boolean; warnings?: string[] },
  ): Promise<string[]> {
    try {
      return await this.spApi.getMessagingActions(account.id, orderId);
    } catch (error) {
      if (options?.strict && error instanceof MarketplaceApiError && error.retryable) {
        throw error;
      }
      options?.warnings?.push('AMAZON_MESSAGING_ACTIONS_UNAVAILABLE');
      this.logWarn('getMessagingActionsForOrder', error, account.id, orderId);
    }

    const cached = parseChannelSettings(account.channelConfig).allowedActionsCache;
    if (cached.length === 0) options?.warnings?.push('AMAZON_ALLOWED_ACTIONS_CACHE_EMPTY');
    return cached;
  }

  /** Upserts `buyer_pii_vault` + short-lived Redis mirror (900 s). */
  async persistPii(ticketId: string, buyerPii: BuyerPiiSnapshot): Promise<void> {
    const now = this.deps.clock.now();
    const retentionDays = Math.max(1, this.deps.config.piiRetentionDays);
    const expiresAt = new Date(now.getTime() + retentionDays * 86_400_000);
    await this.deps.repos.piiVault.upsert({
      ticketId,
      marketplace: 'AMAZON',
      buyerName: buyerPii.name ?? null,
      buyerEmail: buyerPii.email ?? null,
      buyerDocument: buyerPii.document ?? null,
      buyerPhone: buyerPii.phone ?? null,
      shippingAddress: buyerPii.shippingAddress ?? {},
      sourceEndpoints: buyerPii.sourceEndpoints ?? [],
      expiresAt,
    });
    await this.deps.cache.set(CACHE_KEYS.piiTicket(ticketId), buyerPii, 900);
  }

  async upsertOrder(accountId: string, order: NormalizedOrderSnapshot): Promise<void> {
    await this.deps.repos.orders.upsert(toUpsertOrderInput(accountId, order));
  }

  private logWarn(
    operation: string,
    error: unknown,
    accountId: string,
    orderId: string | null,
  ): void {
    const message = error instanceof Error ? redactPiiForLogs(error.message) : 'erro desconhecido';
    this.logger.warn('amazon.enrichment.degraded', {
      operation,
      accountId,
      orderId,
      error: message,
    });
  }
}
