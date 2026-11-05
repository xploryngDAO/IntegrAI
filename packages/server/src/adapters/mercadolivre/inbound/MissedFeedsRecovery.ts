import {
  redactPiiForLogs,
  type AdapterDependencies,
  type ILogger,
  type InboundJobPayload,
} from '@sac/shared';
import type { MeliClient } from '../client/MeliClient';
import { asNumber, asString, errorMessage, isRecord, truncateText } from '../mappers';
import type { MeliMissedFeed } from '../types';

/**
 * Cache key required by the missed-feed recovery contract (Meli keeps missed
 * notifications for 2 days only, per the official Notificações docs).
 */
const MISSED_CURSOR_KEY = 'sac:meli:missed:cursor';
const MISSED_CURSOR_TTL_SECONDS = 3 * 24 * 60 * 60;
const MAX_SEEN_IDS = 500;
const INBOUND_QUEUE = 'queue.inbound.meli';
const DETAIL_LIMIT = 240;

interface MissedCursor {
  cursor: string | null;
  seen: string[];
}

export interface MissedFeedRecoveryResult {
  ok: boolean;
  recovered: number;
  skipped: number;
  detail: string;
}

/**
 * Recovers `GET /missed_feeds?app_id={MELI_CLIENT_ID}` notifications that the
 * marketplace could not deliver after 8 attempts. Each recovered feed is
 * re-published to `queue.inbound.meli` with the standard `InboundJobPayload`
 * shape, deduplicated by `_id`/`id`/`resource+attempts`, and a cursor is kept in
 * Redis under `sac:meli:missed:cursor`.
 */
export class MissedFeedsRecovery {
  private readonly logger: ILogger;

  constructor(
    private readonly deps: AdapterDependencies,
    private readonly client: MeliClient,
  ) {
    this.logger = deps.logger.child({ adapter: 'mercadolivre', component: 'missed-feeds' });
  }

  async run(): Promise<MissedFeedRecoveryResult> {
    const appId = this.deps.config.meli.clientId;
    if (!appId) {
      return {
        ok: false,
        recovered: 0,
        skipped: 0,
        detail: 'MELI_CLIENT_ID ausente; impossível consultar missed_feeds.',
      };
    }

    const accounts = await this.deps.repos.accounts.list({
      marketplace: 'MERCADO_LIVRE',
      status: 'ACTIVE',
    });
    if (accounts.length === 0) {
      return {
        ok: true,
        recovered: 0,
        skipped: 0,
        detail: 'Nenhuma conta Mercado Livre ativa para recuperar notificações perdidas.',
      };
    }

    const cursor = await this.readCursor();
    let feeds: MeliMissedFeed[];
    try {
      feeds = await this.fetchMissedFeeds(accounts[0].id, appId);
    } catch (error) {
      return {
        ok: false,
        recovered: 0,
        skipped: 0,
        detail: `Falha ao consultar missed_feeds: ${redactPiiForLogs(
          truncateText(errorMessage(error), DETAIL_LIMIT),
        )}`,
      };
    }

    const cursorTime = cursor.cursor ? Date.parse(cursor.cursor) : Number.NaN;
    const seen = new Set(cursor.seen);
    const nextSeen = [...cursor.seen];
    let newest = cursor.cursor;
    let recovered = 0;
    let skipped = 0;

    for (const rawFeed of feeds) {
      if (!isRecord(rawFeed)) {
        skipped += 1;
        continue;
      }
      const feed = rawFeed as MeliMissedFeed;
      const feedKey =
        asString(feed._id) ??
        asString(feed.id) ??
        `${asString(feed.resource) ?? 'resource'}|${asNumber(feed.attempts) ?? 0}`;

      if (seen.has(feedKey)) {
        skipped += 1;
        continue;
      }

      const receivedIso = asString(feed.received) ?? asString(feed.sent);
      const receivedTime = receivedIso ? Date.parse(receivedIso) : Number.NaN;
      if (
        !Number.isNaN(cursorTime) &&
        !Number.isNaN(receivedTime) &&
        receivedTime <= cursorTime
      ) {
        skipped += 1;
        continue;
      }

      const externalSellerId = asString(feed.user_id);
      if (!externalSellerId) {
        skipped += 1;
        continue;
      }
      const account = await this.deps.repos.accounts.findByExternalSeller(
        'MERCADO_LIVRE',
        externalSellerId,
      );
      if (!account) {
        skipped += 1;
        continue;
      }

      const job: InboundJobPayload = {
        marketplace: 'MERCADO_LIVRE',
        accountId: account.id,
        topic: asString(feed.topic),
        resource: asString(feed.resource),
        eventId: feedKey,
        payload: { ...rawFeed },
        rawS3Uri: null,
        receivedAt: receivedIso ?? this.deps.clock.now().toISOString(),
        webhookEventId: null,
      };
      await this.deps.queue.publish(INBOUND_QUEUE, job, {
        dedupeKey: `meli:missed:${feedKey}`,
      });

      recovered += 1;
      seen.add(feedKey);
      nextSeen.push(feedKey);
      if (receivedIso && (!newest || Date.parse(receivedIso) > Date.parse(newest))) {
        newest = receivedIso;
      }
    }

    await this.deps.cache.set(
      MISSED_CURSOR_KEY,
      JSON.stringify({ cursor: newest, seen: nextSeen.slice(-MAX_SEEN_IDS) }),
      MISSED_CURSOR_TTL_SECONDS,
    );

    this.logger.info('meli.missed_feeds.recovered', {
      recovered,
      skipped,
      total: feeds.length,
    });

    return {
      ok: true,
      recovered,
      skipped,
      detail: `${recovered} notificação(ões) perdida(s) recuperada(s), ${skipped} ignorada(s) (janela ${
        newest ?? 'sem cursor'
      }).`,
    };
  }

  private async fetchMissedFeeds(accountId: string, appId: string): Promise<MeliMissedFeed[]> {
    const response = await this.client.get<unknown>(accountId, '/missed_feeds', {
      app_id: appId,
    });
    if (Array.isArray(response)) return response as MeliMissedFeed[];
    if (isRecord(response)) {
      const nested = response.missed_feeds ?? response.results ?? response.feeds;
      if (Array.isArray(nested)) return nested as MeliMissedFeed[];
    }
    return [];
  }

  private async readCursor(): Promise<MissedCursor> {
    const raw = await this.deps.cache.get<string>(MISSED_CURSOR_KEY);
    if (!raw) return { cursor: null, seen: [] };
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { cursor: null, seen: [] };
      }
    }
    if (!isRecord(parsed)) return { cursor: null, seen: [] };
    const cursor = asString(parsed.cursor);
    const seen = Array.isArray(parsed.seen)
      ? parsed.seen.filter((value): value is string => typeof value === 'string')
      : [];
    return { cursor, seen };
  }
}
