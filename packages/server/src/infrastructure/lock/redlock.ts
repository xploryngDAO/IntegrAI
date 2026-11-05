import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { IDistributedLock, ILogger } from '@sac/shared';
import { RedisLuaScript } from '../redis/connection';

/**
 * Redlock (https://redis.io/docs/manual/patterns/distributed-locks/#the-redlock-algorithm)
 * implemented over N independent Redis clients.
 *
 * Guarantees relied upon by the adapters:
 *  - a lock is only considered held when the SET NX succeeded on a quorum of
 *    clients (floor(N/2) + 1) AND the remaining TTL (after subtracting the
 *    elapsed time and the clock-drift allowance) is positive;
 *  - release always uses a token compare-and-delete Lua script, so a lease
 *    that expired and was re-acquired by somebody else is never deleted.
 *
 * Shopee refresh tokens are single-use: two concurrent refreshes destroy the
 * account, which is exactly why this is a real quorum implementation and not a
 * single-key SET NX.
 */

const RELEASE_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

const DEFAULT_RETRY_DELAY_MS = 200;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_DRIFT_FACTOR = 0.01;

export class LockAcquisitionError extends Error {
  public readonly resources: string[];
  public readonly attempts: number;

  constructor(message: string, resources: string[], attempts: number) {
    super(message);
    this.name = 'LockAcquisitionError';
    this.resources = resources;
    this.attempts = attempts;
    Object.setPrototypeOf(this, LockAcquisitionError.prototype);
  }
}

export interface RedlockSettings {
  /** Base delay between attempts (jittered). Default 200ms. */
  retryDelayMs?: number;
  /** Default number of acquisition attempts. Default 10. */
  maxAttempts?: number;
  /** Fraction of the TTL reserved for clock drift. Default 0.01. */
  driftFactor?: number;
  logger?: ILogger;
}

export interface LockAcquireOptions {
  retryDelayMs?: number;
  maxAttempts?: number;
}

interface LockHandle {
  keys: string[];
  token: string;
  /** Remaining validity (TTL minus elapsed minus drift) at acquisition time. */
  validityMs: number;
  quorum: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function jitteredRetryDelay(baseMs: number): number {
  return Math.max(1, Math.floor(baseMs * (0.5 + Math.random() * 0.5)));
}

export class Redlock implements IDistributedLock {
  private readonly clients: Redis[];
  private readonly releaseScripts: RedisLuaScript[];
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly driftFactor: number;
  private readonly logger?: ILogger;

  constructor(clients: Redis[], settings: RedlockSettings = {}) {
    if (clients.length === 0) {
      throw new Error('Redlock: at least one Redis client is required');
    }
    this.clients = clients;
    this.releaseScripts = clients.map((client) => new RedisLuaScript(client, RELEASE_LUA));
    this.retryDelayMs = Math.max(1, settings.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.maxAttempts = Math.max(1, settings.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.driftFactor = Math.min(0.5, Math.max(0, settings.driftFactor ?? DEFAULT_DRIFT_FACTOR));
    this.logger = settings.logger;
  }

  async withLock<T>(
    resources: string[],
    ttlMs: number,
    fn: () => Promise<T>,
    options?: LockAcquireOptions,
  ): Promise<T> {
    const handle = await this.acquire(resources, ttlMs, options);
    try {
      return await fn();
    } finally {
      await this.release(handle);
    }
  }

  async tryWithLock<T>(
    resources: string[],
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<{ acquired: boolean; value?: T }> {
    let handle: LockHandle;
    try {
      handle = await this.acquire(resources, ttlMs, { maxAttempts: 1 });
    } catch (error) {
      if (error instanceof LockAcquisitionError) return { acquired: false };
      throw error;
    }

    try {
      const value = await fn();
      return { acquired: true, value };
    } finally {
      await this.release(handle);
    }
  }

  /** Explicit acquisition (used when the caller cannot use the callback API). */
  async acquire(
    resources: string[],
    ttlMs: number,
    options?: LockAcquireOptions,
  ): Promise<LockHandle> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`Redlock: ttlMs must be a positive number, got ${ttlMs}`);
    }

    const keys = [...new Set(resources)].filter((resource) => resource.trim().length > 0);
    if (keys.length === 0) {
      throw new Error('Redlock: at least one non-empty resource key is required');
    }

    const quorum = Math.floor(this.clients.length / 2) + 1;
    const driftMs = Math.floor(ttlMs * this.driftFactor) + 2;
    const maxAttempts = Math.max(1, Math.floor(options?.maxAttempts ?? this.maxAttempts));
    const retryDelayMs = Math.max(1, Math.floor(options?.retryDelayMs ?? this.retryDelayMs));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const token = randomBytes(16).toString('hex');
      const startedAt = Date.now();
      let lockedClients = 0;

      await Promise.all(
        this.clients.map(async (client) => {
          let clientLocked = true;
          for (const key of keys) {
            try {
              const result = await client.set(key, token, 'PX', ttlMs, 'NX');
              if (result !== 'OK') clientLocked = false;
            } catch (error) {
              clientLocked = false;
              this.logger?.warn('redlock.set_failed', {
                key,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
          if (clientLocked) lockedClients += 1;
        }),
      );

      const elapsedMs = Date.now() - startedAt;
      const validityMs = ttlMs - elapsedMs - driftMs;

      if (lockedClients >= quorum && validityMs > 0) {
        return { keys, token, validityMs, quorum };
      }

      // Partial acquisition or expired before we could use it: roll back.
      await this.releaseKeys(keys, token);

      if (attempt < maxAttempts) {
        await sleep(jitteredRetryDelay(retryDelayMs));
      }
    }

    throw new LockAcquisitionError(
      `Could not acquire distributed lock on [${keys.join(', ')}] after ${maxAttempts} attempt(s)`,
      keys,
      maxAttempts,
    );
  }

  /** Releases a handle previously returned by `acquire`. Never throws. */
  async release(handle: LockHandle): Promise<void> {
    await this.releaseKeys(handle.keys, handle.token);
  }

  private async releaseKeys(keys: string[], token: string): Promise<void> {
    await Promise.all(
      this.releaseScripts.map(async (script) => {
        for (const key of keys) {
          try {
            await script.run([key], [token]);
          } catch (error) {
            this.logger?.warn('redlock.release_failed', {
              key,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }),
    );
  }
}
