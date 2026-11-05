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

/**
 * Shopee periodic reconciliation:
 *  1. rotate single-use refresh tokens under the Redlock when the token is
 *     nearing expiry or older than the configured refresh interval;
 *  2. recover pushes lost while the webhook was down via
 *     `POST /api/v2/push/get_lost_push_message`, paginating by `offset` and
 *     enqueueing each recovered payload into `queue.inbound.shopee` deduped by
 *     event id, persisting the per-account cursor in Redis.
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
      results.push(await this.recoverLostPushes(account));
    }
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
    account: MarketplaceAccountRecord,
  ): Promise<ShopeeMaintenanceTask> {
    const task = `shopee.lost-push:${account.id}`;
    const cursorKey = CACHE_KEYS.lastLostPushCursor(account.id);
    const now = this.deps.clock.now();
    const nowSeconds = Math.floor(now.getTime() / 1000);

    let cursorOffset = 0;
    try {
      const stored = await this.deps.cache.get<ShopeeLostPushCursor | Record<string, unknown>>(
        cursorKey,
      );
      cursorOffset = pickNumber(asRecord(stored) ?? null, ['offset']) ?? 0;
    } catch (error) {
      this.logger.warn('Shopee lost-push cursor unreadable; starting from offset 0', {
        accountId: account.id,
        error: this.describeError(error),
      });
    }

    let offset = cursorOffset;
    let recovered = 0;
    let published = 0;
    let pages = 0;
    let hasMore = true;
    const skipped: string[] = [];

    try {
      while (hasMore && pages < LOST_PUSH_MAX_PAGES) {
        const result = await this.client.request<Record<string, unknown>>({
          accountId: account.id,
          apiPath: SHOPEE_API_PATHS.getLostPushMessage,
          // Partner-scoped endpoint: signed with partner id + access token but no shop_id.
          includeShopId: false,
          body: {
            partner_id: toShopeeId(this.client.defaultPartnerId),
            timestamp: nowSeconds,
            offset,
          },
        });

        const data = asRecord(result.data) ?? {};
        const items = pickArray(data, ['data', 'lost_push_message_list', 'list'])
          .map(asRecord)
          .filter((item): item is Record<string, unknown> => item !== null);
        if (items.length === 0) break;

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
            `lost:${push.code}:${push.timestamp ?? offset}:${recovered}`;
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
              receivedAt: now.toISOString(),
              rawS3Uri: null,
            },
            {
              dedupeKey: `shopee:lostpush:${eventId}`,
              jobId: `shopee-lostpush-${eventId}`,
            },
          );
          published += 1;
        }

        hasMore = data['has_more'] === true;
        const nextOffset = pickNumber(data, ['next_offset', 'offset']);
        // Never loop on a non-advancing cursor.
        if (nextOffset !== null && nextOffset > offset) {
          offset = nextOffset;
        } else {
          offset += items.length;
        }
        pages += 1;
      }

      const nextCursor: ShopeeLostPushCursor = {
        offset,
        updatedAt: this.deps.clock.now().toISOString(),
      };
      await this.deps.cache.set(cursorKey, nextCursor, LOST_PUSH_CURSOR_TTL_SECONDS);

      const detail =
        `lost pushes recuperados: ${recovered}, enfileirados: ${published}, offset ${offset}` +
        (skipped.length > 0 ? `, ignorados: ${skipped.slice(0, 5).join('|')}` : '');
      this.logger.info('Shopee lost-push recovery finished', {
        accountId: account.id,
        recovered,
        published,
        offset,
      });
      return { task, ok: true, detail };
    } catch (error) {
      this.logger.error('Shopee lost-push recovery failed', {
        accountId: account.id,
        error: this.describeError(error),
      });
      return { task, ok: false, detail: this.describeError(error) };
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
