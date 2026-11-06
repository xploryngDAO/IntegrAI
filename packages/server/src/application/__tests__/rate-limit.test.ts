import { describe, expect, it } from 'vitest';

import type { AuthRateLimitPolicy } from '../auth/rate-limit';
import { AUTH_RATE_LIMITS, AuthRateLimiter } from '../auth/rate-limit';
import { FrozenClock, silentLogger } from './accountFakes';
import { CountingCache } from './rateLimitFakes';

/**
 * The limiter is the single gate behind login / 2FA challenge / reset links, so
 * these tests pin the semantics that matter:
 *
 *  - the limit itself is ALLOWED (N/in-window), N+1 is blocked;
 *  - the window expires (fixed window keyed by the first hit);
 *  - a Redis outage degrades to an in-process window that still enforces the
 *    limit, and recovers the distributed counter when Redis comes back;
 *  - `consumeAll` charges every bucket and throws for the constrained one.
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');
const POLICY: AuthRateLimitPolicy = { bucket: 'test.bucket', limit: 3, windowSeconds: 900 };

function createHarness() {
  const clock = new FrozenClock(NOW);
  const cache = new CountingCache(clock);
  const limiter = new AuthRateLimiter({ cache, clock, logger: silentLogger });
  return { clock, cache, limiter };
}

describe('AuthRateLimiter.consume', () => {
  it('allows exactly `limit` attempts inside the window and blocks the next one', async () => {
    const h = createHarness();

    const first = await h.limiter.consume(POLICY, 'k');
    const second = await h.limiter.consume(POLICY, 'k');
    const third = await h.limiter.consume(POLICY, 'k');
    const fourth = await h.limiter.consume(POLICY, 'k');

    expect([first.allowed, second.allowed, third.allowed]).toEqual([true, true, true]);
    expect(third.remaining).toBe(0);
    expect(third.used).toBe(3);

    expect(fourth.allowed).toBe(false);
    expect(fourth.used).toBe(4);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfterMs).toBe(15 * 60 * 1_000);
    expect(fourth.degraded).toBe(false);
  });

  it('reports the remaining window from the Redis TTL when blocked', async () => {
    const h = createHarness();
    for (let index = 0; index < 3; index += 1) await h.limiter.consume(POLICY, 'k');

    h.clock.set(new Date(NOW.getTime() + 10 * 60 * 1_000));
    const blocked = await h.limiter.consume(POLICY, 'k');

    expect(blocked.allowed).toBe(false);
    // 15 min window, 10 min elapsed -> ~5 min left.
    expect(blocked.retryAfterMs).toBe(5 * 60 * 1_000);
  });

  it('resets after the window expires', async () => {
    const h = createHarness();
    for (let index = 0; index < 4; index += 1) await h.limiter.consume(POLICY, 'k');

    h.clock.set(new Date(NOW.getTime() + POLICY.windowSeconds * 1_000 + 1));
    const afterWindow = await h.limiter.consume(POLICY, 'k');

    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.used).toBe(1);
  });

  it('keeps independent windows per key', async () => {
    const h = createHarness();
    for (let index = 0; index < 4; index += 1) await h.limiter.consume(POLICY, 'a');

    const other = await h.limiter.consume(POLICY, 'b');

    expect(other.allowed).toBe(true);
    expect(other.used).toBe(1);
  });

  it('assertAllowed throws 429 RATE_LIMITED with the bucket in the details', async () => {
    const h = createHarness();
    for (let index = 0; index < 3; index += 1) await h.limiter.assertAllowed(POLICY, 'k');

    await expect(h.limiter.assertAllowed(POLICY, 'k')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      details: { bucket: 'test.bucket' },
    });
  });
});

describe('AuthRateLimiter fallback (Redis unavailable)', () => {
  it('still enforces the limit with the in-process window', async () => {
    const h = createHarness();
    h.cache.failIncr = true;

    const results = [];
    for (let index = 0; index < 4; index += 1) {
      results.push(await h.limiter.consume(POLICY, 'k'));
    }

    expect(results.map((entry) => entry.allowed)).toEqual([true, true, true, false]);
    expect(results.at(-1)?.degraded).toBe(true);
    expect(results.at(-1)?.used).toBe(4);
  });

  it('expires the fallback window with the clock', async () => {
    const h = createHarness();
    h.cache.failIncr = true;
    for (let index = 0; index < 4; index += 1) await h.limiter.consume(POLICY, 'k');

    h.clock.set(new Date(NOW.getTime() + POLICY.windowSeconds * 1_000 + 1));
    const afterWindow = await h.limiter.consume(POLICY, 'k');

    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.degraded).toBe(true);
  });

  it('goes back to the shared counter once Redis recovers', async () => {
    const h = createHarness();
    h.cache.failIncr = true;
    await h.limiter.consume(POLICY, 'k');

    h.cache.failIncr = false;
    const recovered = await h.limiter.consume(POLICY, 'k');

    // The Redis counter starts fresh: the fallback map is not authoritative.
    expect(recovered.allowed).toBe(true);
    expect(recovered.degraded).toBe(false);
    expect(recovered.used).toBe(1);
  });

  it('does not turn a blocked attempt into an exception other than 429', async () => {
    const h = createHarness();
    h.cache.failIncr = true;
    for (let index = 0; index < 3; index += 1) await h.limiter.assertAllowed(POLICY, 'k');

    await expect(h.limiter.assertAllowed(POLICY, 'k')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
    });
  });
});

describe('AuthRateLimiter.consumeAll', () => {
  it('charges every bucket and throws for the constrained one', async () => {
    const h = createHarness();
    const perJti: AuthRateLimitPolicy = { bucket: 'a', limit: 5, windowSeconds: 900 };
    const perIp: AuthRateLimitPolicy = { bucket: 'b', limit: 2, windowSeconds: 900 };

    const first = await h.limiter.consumeAll([
      { policy: perJti, key: 'jti' },
      { policy: perIp, key: 'ip' },
    ]);
    expect(first.map((entry) => entry.allowed)).toEqual([true, true]);

    await h.limiter.consumeAll([
      { policy: perJti, key: 'jti' },
      { policy: perIp, key: 'ip' },
    ]);

    await expect(
      h.limiter.consumeAll([
        { policy: perJti, key: 'jti' },
        { policy: perIp, key: 'ip' },
      ]),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', details: { bucket: 'b' } });

    // The jti bucket was charged even though the IP bucket blocked the attempt.
    const jtiDecision = await h.limiter.consume(perJti, 'jti');
    expect(jtiDecision.used).toBe(4);
  });
});

describe('AUTH_RATE_LIMITS', () => {
  it('matches the documented policy (login 10, 2FA 5, reset links 3 / 15 min)', () => {
    expect(AUTH_RATE_LIMITS.login).toEqual({
      bucket: 'auth.login',
      limit: 10,
      windowSeconds: 900,
    });
    expect(AUTH_RATE_LIMITS.twoFactorChallenge.limit).toBe(5);
    expect(AUTH_RATE_LIMITS.twoFactorChallengeIp.limit).toBe(5);
    expect(AUTH_RATE_LIMITS.forgotPassword.limit).toBe(3);
    expect(AUTH_RATE_LIMITS.resendVerification.limit).toBe(3);
    for (const policy of Object.values(AUTH_RATE_LIMITS)) {
      expect(policy.windowSeconds).toBe(900);
    }
  });
});
