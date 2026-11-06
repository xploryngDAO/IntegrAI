import type { ICache, IClock } from '@sac/shared';

/**
 * TTL-aware `ICache` fake for the rate-limit tests.
 *
 * It mirrors `RedisCache` for the two primitives the limiter relies on:
 *  - `incr(key, ttl)`: increments and sets the TTL only on the first hit;
 *  - `ttl(key)`: remaining seconds of the current window.
 *
 * `failIncr` simulates a Redis outage so the in-process fallback can be
 * exercised without a real connection.
 */
export class CountingCache implements ICache {
  private readonly counters = new Map<string, { used: number; expiresAt: number }>();
  private readonly values = new Map<string, { value: unknown; expiresAt: number }>();
  failIncr = false;
  failAll = false;

  constructor(private readonly clock: IClock) {}

  private now(): number {
    return this.clock.now().getTime();
  }

  private alive(expiresAt: number): boolean {
    return expiresAt > this.now();
  }

  async get<T>(key: string): Promise<T | null> {
    this.guard();
    const entry = this.values.get(key);
    if (entry === undefined) return null;
    if (!this.alive(entry.expiresAt)) {
      this.values.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.guard();
    this.values.set(key, { value, expiresAt: this.now() + Math.max(1, ttlSeconds) * 1_000 });
  }

  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    this.guard();
    if ((await this.get(key)) !== null) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async del(key: string): Promise<void> {
    this.guard();
    this.counters.delete(key);
    this.values.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    this.guard();
    if (this.values.has(key)) return (await this.get(key)) !== null;
    const counter = this.counters.get(key);
    return counter !== undefined && this.alive(counter.expiresAt);
  }

  async ttl(key: string): Promise<number> {
    this.guard();
    const expiresAt =
      this.counters.get(key)?.expiresAt ??
      this.values.get(key)?.expiresAt ??
      null;
    if (expiresAt === null) return -2;
    const remainingMs = expiresAt - this.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1_000) : -2;
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    if (this.failIncr || this.failAll) throw new Error('redis unavailable');
    const now = this.now();
    const current = this.counters.get(key);
    if (current === undefined || !this.alive(current.expiresAt)) {
      this.counters.set(key, {
        used: 1,
        expiresAt: now + Math.max(1, ttlSeconds) * 1_000,
      });
      return 1;
    }
    current.used += 1;
    return current.used;
  }

  async hset(): Promise<void> {
    this.guard();
  }

  async hgetall<T extends Record<string, string>>(): Promise<T | null> {
    this.guard();
    return null;
  }

  async sadd(): Promise<void> {
    this.guard();
  }

  async srem(): Promise<void> {
    this.guard();
  }

  async smembers(): Promise<string[]> {
    this.guard();
    return [];
  }

  /** Force every operation to fail (full Redis outage). */
  private guard(): void {
    if (this.failAll) throw new Error('redis unavailable');
  }
}
