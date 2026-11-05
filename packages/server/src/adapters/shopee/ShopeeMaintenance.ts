import {
  CACHE_KEYS,
  MARKETPLACE_INBOUND_QUEUE,
  SHOPEE_REFRESH_INTERVAL_SECONDS,
  redactPiiForLogs,
  type AdapterDependencies,
  type ILogger,
  type MarketplaceAccountRecord,
} from '@sac/shared';
import { ShopeeClient } from './client/ShopeeClient';
import type { ShopeeAuth } from './client/ShopeeAuth';
import { SHOPEE_API_PATHS, type ShopeeLostPushCursor } from './types';
import {
  asRecord,
  normalizeEventId,
  normalizePushRecord,
  pickArray,
  pickNumber,
  toShopeeId,
} from './mappers';

export interface ShopeeMaintenanceTask {
  task: string;
  ok: boolean;
  detail: string;
}

const LOST_PUSH_MAX_PAGES = 10;
const LOST_PUSH_CURSOR_TTL_SECONDS = 7 * 24 * 3600;
const TOKEN_EXPIRY_BUFFER_MS = 30 * 60 * 1000;

interface LostPushRecoverySummary {
  recovered: number;
  published: number;
  confirmedBatches: number;
  skipped: string[];
  pages: number;
  lastMessageId: number | null;
}

/**
 * Shopee periodic reconciliation:
 *  1. rotate single-use refresh tokens under the Redlock when the token is
 *     nearing expiry or older than the configured refresh interval;
 *  2. recover pushes lost while the webhook was down.
 *
 * Lost pushes follow the official v2 contract:
 *  - `GET /api/v2/push/get_lost_push_message` (no request parameters) returns
 *    the earliest lost pushes of the last 3 days plus `has_next_page` and
 *    `last_message_id`;
 *  - every consumed batch is acknowledged with
 *    `POST /api/v2/push/confirm_consumed_lost_push_message { last_message_id }`
 *    so the same payloads are not recovered twice;
 *  - each payload is published into `queue.inbound.shopee` deduped by event id
 *    and the cursor is persisted in Redis for observability.
 *
 * Consumers: `queue.token.refresh` (every 3h30m) and
 * `queue.shopee.lost-push`.
 */
export class ShopeeMaintenance {
  private readonly deps: AdapterDependencies;
  private readonly client: ShopeeClient;
  private readonly auth: ShopeeAuth;
  private readonly logger: ILogger;

  constructor(deps: AdapterDependencies, client: ShopeeClient, auth: ShopeeAuth) {
    this.deps = deps;
    this.client = client;
    this.auth = auth;
    this.logger = deps.logger.child({ component: 'shopee.maintenance' });
  }

  async run(): Promise<ShopeeMaintenanceTask[]> {
    const accounts = await this.deps.repos.accounts.list({
      marketplace: 'SHOPEE',
      status: 'ACTIVE',
    });
    if (accounts.length === 0) {
      return [{ task: 'shopee.maintenance', ok: true, detail: 'nenhuma conta Shopee ativa' }];
    }

    const results: ShopeeMaintenanceTask[] = [];
    for (const account of accounts) {
      results.push(await this.refreshTokenIfDue(account));
    }
    // The lost-push endpoint is partner-scoped: recover once with the first
    // account that can authenticate instead of replaying/confirming per shop.
    results.push(await this.recoverLostPushes(accounts));
    return results;
  }

  private async refreshTokenIfDue(
    account: MarketplaceAccountRecord,
  ): Promise<ShopeeMaintenanceTask> {
    const task = `shopee.token.refresh:${account.id}`;
    try {
      if (!(await this.isTokenRefreshDue(account))) {
        return { task, ok: true, detail: 'token válido; refresh ignorado' };
      }
      const credentials = await this.auth.refreshAccessToken(account);
      return {
        task,
        ok: true,
        detail: `token renovado para a loja ${credentials.shopId}`,
      };
    } catch (error) {
      return { task, ok: false, detail: this.describeError(error) };
    }
  }

  private async isTokenRefreshDue(account: MarketplaceAccountRecord): Promise<boolean> {
    const nowMs = this.deps.clock.now().getTime();
    const expiresAtMs = account.tokenExpiresAt ? account.tokenExpiresAt.getTime() : null;
    const lastRefreshMs = account.lastTokenRefreshAt ? account.lastTokenRefreshAt.getTime() : null;
    const intervalMs = this.refreshIntervalSeconds() * 1000;

    const nearingExpiry = expiresAtMs === null || expiresAtMs - nowMs <= TOKEN_EXPIRY_BUFFER_MS;
    const staleRefresh = lastRefreshMs === null || nowMs - lastRefreshMs >= intervalMs;
    if (!nearingExpiry && !staleRefresh) return false;

    const gateOpen = !(await this.deps.cache.exists(CACHE_KEYS.shopeeRefreshGate(account.id)));
    return gateOpen;
  }

  private refreshIntervalSeconds(): number {
    const configured = this.deps.config.shopee.refreshIntervalSeconds;
    return configured > 0 ? configured : SHOPEE_REFRESH_INTERVAL_SECONDS;
  }

  private async recoverLostPushes(
    accounts: MarketplaceAccountRecord[],
  ): Promise<ShopeeMaintenanceTask> {
    let lastError: string | null = null;

    for (const account of accounts) {
      try {
        const summary = await this.recoverWithAccount(account);
        return {
          task: `shopee.lost-push:${account.id}`,
          ok: true,
          detail:
            `lost pushes recuperados: ${summary.recovered}, enfileirados: ${summary.published}, ` +
            `lotes confirmados: ${summary.confirmedBatches}, páginas: ${summary.pages}, ` +
            `last_message_id: ${summary.lastMessageId ?? 'n/a'}` +
            (summary.skipped.length > 0
              ? `, ignorados: ${summary.skipped.slice(0, 5).join('|')}`
              : ''),
        };
      } catch (error) {
        lastError = this.describeError(error);
        this.logger.warn('Shopee lost-push recovery failed for account; trying the next one', {
          accountId: account.id,
          error: lastError,
        });
      }
    }

    return {
      task: 'shopee.lost-push',
      ok: false,
      detail: lastError ?? 'nenhuma conta Shopee pôde autenticar para recuperar lost pushes',
    };
  }

  private async recoverWithAccount(
    account: MarketplaceAccountRecord,
  ): Promise<LostPushRecoverySummary> {
    const cursorKey = CACHE_KEYS.lastLostPushCursor(account.id);
    const nowIso = this.deps.clock.now().toISOString();

    let recovered = 0;
    let published = 0;
    let confirmedBatches = 0;
    let pages = 0;
    let hasNextPage = true;
    let lastMessageId = await this.readCursor(cursorKey);
    const skipped: string[] = [];

    while (hasNextPage && pages < LOST_PUSH_MAX_PAGES) {
      const result = await this.client.publicRequest<Record<string, unknown>>({
        // Official v2: GET, PUBLIC (partner_id/timestamp/sign only; no access
        // token and no shop_id), no request parameters.
        apiPath: SHOPEE_API_PATHS.getLostPushMessage,
        method: 'GET',
      });

      const data = asRecord(result.data) ?? {};
      const items = pickArray(data, ['push_message_list', 'data', 'lost_push_message_list'])
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => item !== null);
      const batchLastMessageId = pickNumber(data, ['last_message_id']);
      hasNextPage = data['has_next_page'] === true;

      for (const item of items) {
        const push = normalizePushRecord(item);
        if (!push) {
          skipped.push('payload_unparseable');
          continue;
        }
        recovered += 1;

        const targetAccountId = await this.resolveAccountIdForShop(push.shop_id, account.id);
        if (!targetAccountId) {
          skipped.push(`unknown_shop:${String(push.shop_id)}`);
          continue;
        }

        const eventId =
          normalizeEventId(push.code, push.data) ??
          `lost:${push.code}:${push.timestamp ?? batchLastMessageId ?? pages}:${recovered}`;
        const payload = {
          code: push.code,
          shop_id: push.shop_id,
          timestamp: push.timestamp,
          data: push.data,
        };

        await this.deps.queue.publish(
          MARKETPLACE_INBOUND_QUEUE.SHOPEE,
          {
            marketplace: 'SHOPEE',
            accountId: targetAccountId,
            topic: String(push.code),
            resource: null,
            eventId,
            payload,
            receivedAt: nowIso,
            rawS3Uri: null,
          },
          {
            dedupeKey: `shopee:lostpush:${eventId}`,
            jobId: `shopee-lostpush-${eventId}`,
          },
        );
        published += 1;
      }

      // Acknowledge the batch so Shopee stops returning it during the 3-day window.
      if (batchLastMessageId !== null) {
        if (items.length > 0) {
          await this.confirmConsumed(account, batchLastMessageId);
          confirmedBatches += 1;
        }
        lastMessageId = batchLastMessageId;
      }

      pages += 1;
      if (items.length === 0) break;
    }

    const nextCursor: ShopeeLostPushCursor = { lastMessageId, updatedAt: nowIso };
    await this.deps.cache.set(cursorKey, nextCursor, LOST_PUSH_CURSOR_TTL_SECONDS);

    this.logger.info('Shopee lost-push recovery finished', {
      accountId: account.id,
      recovered,
      published,
      confirmedBatches,
      pages,
      lastMessageId,
    });

    return { recovered, published, confirmedBatches, skipped, pages, lastMessageId };
  }

  private async confirmConsumed(
    account: MarketplaceAccountRecord,
    lastMessageId: number,
  ): Promise<void> {
    // Official v2: PUBLIC signed POST (partner_id/timestamp/sign only).
    await this.client.publicRequest<Record<string, unknown>>({
      apiPath: SHOPEE_API_PATHS.confirmConsumedLostPushMessage,
      method: 'POST',
      body: { last_message_id: lastMessageId },
    });
    this.logger.debug('Shopee lost-push batch confirmed as consumed', {
      accountId: account.id,
      lastMessageId,
    });
  }

  private async readCursor(cursorKey: string): Promise<number | null> {
    try {
      const stored = await this.deps.cache.get<ShopeeLostPushCursor | Record<string, unknown>>(
        cursorKey,
      );
      const record = asRecord(stored);
      return pickNumber(record, ['lastMessageId', 'last_message_id', 'offset']);
    } catch (error) {
      this.logger.debug('Shopee lost-push cursor unreadable; starting from scratch', {
        error: this.describeError(error),
      });
      return null;
    }
  }

  private async resolveAccountIdForShop(
    shopId: number | string | null,
    fallbackAccountId: string,
  ): Promise<string | null> {
    if (shopId === null) return fallbackAccountId;
    const account = await this.deps.repos.accounts.findByExternalSeller('SHOPEE', String(shopId));
    return account?.id ?? null;
  }

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return redactPiiForLogs(message).slice(0, 300);
  }
}
