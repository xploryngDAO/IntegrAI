import type { Redis } from 'ioredis';
import { CACHE_KEYS, RateLimitError } from '@sac/shared';
import type { ChannelRateLimits, IRateLimiter, RateLimitOptions } from '@sac/shared';
import { RedisLuaScript } from '../redis/connection';

/**
 * Distributed token bucket in Redis.
 *
 * Hash fields: `tokens` (float) and `lastRefillMs` (epoch ms). The script is
 * idempotent w.r.t. time: the refill is computed lazily on each call, so idle
 * buckets do not need a background process. Lua guarantees the read-modify-
 * write happens atomically, which is what makes per-order Amazon limits safe
 * across the API process and every worker.
 *
 * Bucket names are hierarchical; the effective limit is derived from the
 * longest matching prefix (see `resolveBucketConfig`).
 */

export interface TokenBucketConfig {
  capacity: number;
  refillPerSecond: number;
}

const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttlMs = tonumber(ARGV[5])

local bucket = redis.call('HMGET', key, 'tokens', 'lastRefillMs')
local tokens = tonumber(bucket[1])
local lastRefillMs = tonumber(bucket[2])

if tokens == nil or lastRefillMs == nil then
  tokens = capacity
  lastRefillMs = nowMs
end

if nowMs > lastRefillMs then
  tokens = math.min(capacity, tokens + (nowMs - lastRefillMs) * refillPerMs)
  lastRefillMs = nowMs
end

local allowed = 0
local waitMs = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  waitMs = math.ceil((cost - tokens) / refillPerMs)
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'lastRefillMs', tostring(lastRefillMs))
redis.call('PEXPIRE', key, ttlMs)

return { allowed, math.floor(tokens), waitMs }
`;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CAPACITY = 5;
const DEFAULT_REFILL_PER_SECOND = 5;

/** Minimum refill rate used to avoid division by zero in the Lua wait calc. */
const MIN_REFILL_PER_SECOND = 0.0001;

/**
 * Derives capacity/refill for a bucket name. Prefix rules, in order:
 *  - `amazon:messaging`  -> 1 req/s, burst 2 (proactive messaging per order)
 *  - `amazon:orders`     -> RL_AMAZON_ORDERS_PER_SECOND refill, burst = RL_AMAZON_ORDERS_BURST
 *  - `amazon:rdt`        -> 1 req/s (restricted data tokens)
 *  - `meli`              -> RL_MELI_PER_SECOND, burst 10
 *  - `shopee`            -> RL_SHOPEE_PER_SECOND, burst 5
 *  - anything else       -> 5 req/s, burst 5
 */
export function resolveBucketConfig(bucket: string, limits: ChannelRateLimits): TokenBucketConfig {
  if (bucket.startsWith('amazon:messaging')) {
    return {
      capacity: 2,
      refillPerSecond: Math.max(MIN_REFILL_PER_SECOND, limits.amazonMessagingPerSecond),
    };
  }
  if (bucket.startsWith('amazon:orders')) {
    return {
      capacity: Math.max(1, Math.floor(limits.amazonOrdersBurst)),
      refillPerSecond: Math.max(MIN_REFILL_PER_SECOND, limits.amazonOrdersPerSecond),
    };
  }
  if (bucket.startsWith('amazon:rdt')) {
    return {
      capacity: 1,
      refillPerSecond: Math.max(MIN_REFILL_PER_SECOND, limits.amazonRdtPerSecond),
    };
  }
  if (bucket.startsWith('meli')) {
    return {
      capacity: 10,
      refillPerSecond: Math.max(MIN_REFILL_PER_SECOND, limits.meliPerSecond),
    };
  }
  if (bucket.startsWith('shopee')) {
    return {
      capacity: 5,
      refillPerSecond: Math.max(MIN_REFILL_PER_SECOND, limits.shopeePerSecond),
    };
  }
  return {
    capacity: DEFAULT_CAPACITY,
    refillPerSecond: DEFAULT_REFILL_PER_SECOND,
  };
}

export interface TokenBucketOptions {
  /** Default wait budget for `acquire` when the caller omits `timeoutMs`. */
  defaultTimeoutMs?: number;
}

interface TakeResult {
  allowed: boolean;
  tokens: number;
  waitMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeCost(cost: number | undefined): number {
  if (cost === undefined || !Number.isFinite(cost) || cost <= 0) return 1;
  return cost;
}

function computeTtlMs(config: TokenBucketConfig): number {
  const fullRefillMs = (config.capacity / config.refillPerSecond) * 1_000;
  return Math.max(30_000, Math.ceil(fullRefillMs) * 2);
}

function parseScriptResult(raw: unknown): TakeResult {
  if (!Array.isArray(raw) || raw.length < 3) {
    throw new Error(`Token bucket Lua script returned an unexpected value: ${JSON.stringify(raw)}`);
  }
  const allowed = Number(raw[0]) === 1;
  const tokens = Number(raw[1]);
  const waitMs = Number(raw[2]);
  return {
    allowed,
    tokens: Number.isFinite(tokens) ? tokens : 0,
    waitMs: Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 0,
  };
}

export class TokenBucketRateLimiter implements IRateLimiter {
  private readonly script: RedisLuaScript;
  private readonly defaultTimeoutMs: number;

  constructor(
    private readonly redis: Redis,
    private readonly limits: ChannelRateLimits,
    options: TokenBucketOptions = {},
  ) {
    this.script = new RedisLuaScript(redis, TOKEN_BUCKET_LUA);
    this.defaultTimeoutMs = Math.max(0, options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  /** Non-blocking: consumes a token when available, otherwise returns false. */
  async consume(bucket: string, options: RateLimitOptions = {}): Promise<boolean> {
    const result = await this.take(bucket, normalizeCost(options.cost));
    return result.allowed;
  }

  /** Blocks (with small sleeps) until a token is available; throws on timeout. */
  async acquire(bucket: string, options: RateLimitOptions = {}): Promise<void> {
    const cost = normalizeCost(options.cost);
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    if (timeoutMs <= 0) {
      const result = await this.take(bucket, cost);
      if (!result.allowed) throw new RateLimitError(bucket, result.waitMs);
      return;
    }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await this.take(bucket, cost);
      if (result.allowed) return;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new RateLimitError(bucket, result.waitMs);

      const sleepMs = Math.min(Math.max(Math.min(result.waitMs, 250), 10), remainingMs);
      await sleep(sleepMs);
    }
  }

  /** Drops the bucket state (next call starts full). */
  async reset(bucket: string): Promise<void> {
    await this.redis.del(CACHE_KEYS.rateBucket(bucket));
  }

  private async take(bucket: string, cost: number): Promise<TakeResult> {
    const config = resolveBucketConfig(bucket, this.limits);
    const raw = await this.script.run(
      [CACHE_KEYS.rateBucket(bucket)],
      [
        config.capacity,
        config.refillPerSecond / 1_000,
        Date.now(),
        cost,
        computeTtlMs(config),
      ],
    );
    return parseScriptResult(raw);
  }
}
