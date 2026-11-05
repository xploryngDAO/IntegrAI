import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import type { ILogger } from '@sac/shared';

/**
 * ioredis connection factories.
 *
 * Two flavours exist on purpose:
 *  - `createRedisConnection` for caches, locks and rate limiters (bounded
 *    command retries: a stuck Redis must not stall an HTTP request forever);
 *  - `createBullMqConnection` for BullMQ, which REQUIRES
 *    `maxRetriesPerRequest: null` and blocking connections (see BullMQ docs).
 *
 * Never share a BullMQ connection with regular commands: blocking commands
 * would starve the rest of the application.
 */

export interface RedisConnectionSettings {
  logger?: ILogger;
  /** CLIENT SETNAME - shows up in `CLIENT LIST` for debugging. */
  connectionName?: string;
  /** Do not open the socket until the first command is issued. */
  lazyConnect?: boolean;
  /** Optional ioredis key prefix (do NOT use together with BullMQ). */
  keyPrefix?: string;
}

function retryStrategy(times: number): number {
  // 250ms, 500ms, 1s ... capped at 5s. Redis restarts recover quickly.
  return Math.min(times * 250, 5_000);
}

function baseOptions(settings: RedisConnectionSettings): RedisOptions {
  return {
    connectionName: settings.connectionName ?? 'sac-hub',
    lazyConnect: settings.lazyConnect ?? false,
    keyPrefix: settings.keyPrefix,
    retryStrategy,
    enableOfflineQueue: true,
    connectTimeout: 10_000,
  };
}

function attachDiagnostics(client: Redis, settings: RedisConnectionSettings, label: string): void {
  client.on('error', (error: Error) => {
    settings.logger?.error(`redis.${label}.error`, { message: error.message });
  });
  client.on('end', () => {
    settings.logger?.warn(`redis.${label}.closed`);
  });
  client.on('reconnecting', (delayMs: number) => {
    settings.logger?.warn(`redis.${label}.reconnecting`, { delayMs });
  });
}

/** General-purpose connection: cache, Redlock, token buckets, presence. */
export function createRedisConnection(url: string, settings: RedisConnectionSettings = {}): Redis {
  const client = new Redis(url, {
    ...baseOptions(settings),
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
  attachDiagnostics(client, settings, 'client');
  return client;
}

/**
 * BullMQ-safe connection. BullMQ requires `maxRetriesPerRequest: null`; it
 * duplicates this connection internally for its blocking commands.
 */
export function createBullMqConnection(url: string, settings: RedisConnectionSettings = {}): Redis {
  const client = new Redis(url, {
    ...baseOptions(settings),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  attachDiagnostics(client, settings, 'bullmq');
  return client;
}

/** Graceful close: QUIT first, hard-disconnect if the server is unreachable. */
export async function closeRedisConnection(client: Redis | null | undefined): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('NOSCRIPT');
}

/**
 * Thin cache for Redis Lua scripts: EVALSHA with automatic EVAL fallback after
 * a Redis restart or `SCRIPT FLUSH`. The SHA is computed client-side so the
 * first call is a single round-trip.
 */
export class RedisLuaScript {
  private sha: string | null = null;
  private readonly sourceSha: string;

  constructor(
    private readonly client: Redis,
    private readonly source: string,
  ) {
    this.sourceSha = createHash('sha1').update(source).digest('hex');
  }

  get sha1(): string {
    return this.sourceSha;
  }

  async run(keys: string[], args: Array<string | number>): Promise<unknown> {
    const argv = args.map((value) => (typeof value === 'number' ? String(value) : value));

    if (this.sha) {
      try {
        return await this.client.evalsha(this.sha, keys.length, ...keys, ...argv);
      } catch (error) {
        if (!isNoScriptError(error)) throw error;
        this.sha = null;
      }
    }

    const result = await this.client.eval(this.source, keys.length, ...keys, ...argv);
    this.sha = this.sourceSha;
    return result;
  }
}
