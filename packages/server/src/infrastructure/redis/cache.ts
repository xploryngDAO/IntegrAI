import type { Redis } from 'ioredis';
import type { ICache } from '@sac/shared';
import { RedisLuaScript } from './connection';

/**
 * Atomic `INCR` + first-increment `EXPIRE` (fixed-window counter).
 * KEYS[1] = counter key, ARGV[1] = ttl seconds.
 */
const INCR_WITH_TTL_LUA = `
local value = redis.call('INCR', KEYS[1])
if value == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return value
`;

const DEFAULT_SET_CACHE_TTL_SECONDS = 60;

/**
 * `ICache` over Redis.
 *
 * Values are JSON encoded so callers can cache plain objects without any
 * per-call serialization. Every mutating helper is atomic where the contract
 * demands it (`setNx`, `incr`).
 */
export class RedisCache implements ICache {
  private readonly incrScript: RedisLuaScript;

  constructor(private readonly redis: Redis) {
    this.incrScript = new RedisLuaScript(redis, INCR_WITH_TTL_LUA);
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Value was written outside this cache (legacy/plain string) - return it
      // as-is instead of losing the entry.
      return raw as unknown as T;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const serialized = JSON.stringify(value);
    const ttl = normalizeTtl(ttlSeconds);
    await this.redis.set(key, serialized, 'EX', ttl);
  }

  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const ttl = normalizeTtl(ttlSeconds);
    const result = await this.redis.set(key, value, 'EX', ttl, 'NX');
    return result === 'OK';
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async exists(key: string): Promise<boolean> {
    const count = await this.redis.exists(key);
    return count > 0;
  }

  async ttl(key: string): Promise<number> {
    return this.redis.ttl(key);
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const ttl = normalizeTtl(ttlSeconds);
    const result = await this.incrScript.run([key], [ttl]);
    return Number(result);
  }

  async hset(key: string, values: Record<string, string>): Promise<void> {
    if (Object.keys(values).length === 0) return;
    await this.redis.hset(key, values);
  }

  async hgetall<T extends Record<string, string>>(key: string): Promise<T | null> {
    const hash = await this.redis.hgetall(key);
    if (!hash || Object.keys(hash).length === 0) return null;
    return hash as T;
  }

  async sadd(key: string, members: string[]): Promise<void> {
    if (members.length === 0) return;
    await this.redis.sadd(key, ...members);
  }

  async srem(key: string, members: string[]): Promise<void> {
    if (members.length === 0) return;
    await this.redis.srem(key, ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return this.redis.smembers(key);
  }
}

function normalizeTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return DEFAULT_SET_CACHE_TTL_SECONDS;
  return Math.max(1, Math.floor(ttlSeconds));
}
