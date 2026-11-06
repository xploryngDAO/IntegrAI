import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it } from 'vitest';

import type {
  ICache,
  ILogger,
  IRealtimePublisher,
  ITicketRepository,
} from '@sac/shared';

import { AgentService } from '../AgentService';
import { signAccessToken } from '../auth/access-token';
import {
  ACCESS_TOKEN_DENY_FALLBACK_TTL_SECONDS,
  accessTokenDenyKey,
  denyAccessToken,
  isAccessTokenDenied,
  resolveAccessTokenDenyTtlSeconds,
} from '../auth/access-token-revocation';
import { FrozenClock } from './accountFakes';
import { StubAgentRepository } from './platformFakes';

/**
 * P0 - access-token revocation by `jti`.
 *
 * Covers the three moving parts independently: the claim minted by
 * `signAccessToken`, the denylist write done on logout (TTL sized from `exp`)
 * and the read performed by `AgentService.verifyToken` (including the explicit
 * fail-open policy on a cache outage and the legacy token without `jti`).
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');
const PASSWORD = 'CorrectHorse123!';
const JWT_SECRET = 'unit-test-secret-with-32-characters!!';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface LogEntry {
  level: 'warn' | 'info';
  message: string;
  meta?: Record<string, unknown>;
}

function collectingLogger(entries: LogEntry[]): ILogger {
  const logger: ILogger = {
    child(): ILogger {
      return logger;
    },
    trace(): void {},
    debug(): void {},
    info(message, meta): void {
      entries.push({ level: 'info', message, meta });
    },
    warn(message, meta): void {
      entries.push({ level: 'warn', message, meta });
    },
    error(): void {},
  };
  return logger;
}

/** In-memory cache that records value + TTL of every write. */
class RecordingCache implements ICache {
  readonly entries = new Map<string, unknown>();
  readonly ttls = new Map<string, number>();
  failExists = false;
  failSet = false;

  async get<T>(key: string): Promise<T | null> {
    return (this.entries.get(key) as T | undefined) ?? null;
  }
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (this.failSet) throw new Error('redis unavailable');
    this.entries.set(key, value);
    this.ttls.set(key, ttlSeconds);
  }
  async setNx(key: string, value: string): Promise<boolean> {
    if (this.entries.has(key)) return false;
    this.entries.set(key, value);
    return true;
  }
  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }
  async exists(key: string): Promise<boolean> {
    if (this.failExists) throw new Error('redis unavailable');
    return this.entries.has(key);
  }
  async ttl(key: string): Promise<number> {
    return this.ttls.get(key) ?? -2;
  }
  async incr(): Promise<number> {
    return 1;
  }
  async hset(): Promise<void> {}
  async hgetall<T extends Record<string, string>>(): Promise<T | null> {
    return null;
  }
  async sadd(): Promise<void> {}
  async srem(): Promise<void> {}
  async smembers(): Promise<string[]> {
    return [];
  }
}

const silentRealtime: IRealtimePublisher = {
  ticketUpdated(): void {},
  messageCreated(): void {},
  queueChanged(): void {},
  channelHealth(): void {},
  agentPresence(): void {},
};

const tickets = {
  countActiveByAgent: async (): Promise<number> => 0,
} as unknown as ITicketRepository;

let passwordHash = '';

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

function createHarness() {
  const clock = new FrozenClock(NOW);
  const agents = new StubAgentRepository();
  const cache = new RecordingCache();
  const logs: LogEntry[] = [];

  const service = new AgentService({
    logger: collectingLogger(logs),
    clock,
    cache,
    realtime: silentRealtime,
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '1h',
    presenceTtlSeconds: 120,
    repos: { agents, tickets },
  });

  const agent = agents.seed({
    email: 'admin@acme.test',
    passwordHash,
    tenantId: 'tenant-1',
    role: 'ADMIN',
  });

  return { clock, agents, cache, logs, service, agent };
}

function decode(token: string): jwt.JwtPayload {
  return jwt.verify(token, JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: 'sac-hub',
    audience: 'sac-web',
  }) as jwt.JwtPayload;
}

async function loginToken(h: ReturnType<typeof createHarness>): Promise<string> {
  const result = await h.service.login('admin@acme.test', PASSWORD);
  if ('twoFactorRequired' in result) throw new Error('Expected a session, got 2FA challenge');
  return result.token;
}

/* ==========================================================================
 * 1. signAccessToken mints a unique jti
 * ========================================================================== */

describe('signAccessToken: jti claim', () => {
  const subject = {
    id: 'agent-1',
    email: 'ana@acme.test',
    name: 'Ana',
    role: 'ADMIN',
    tenantId: 'tenant-1',
    isPlatformAdmin: false,
  };

  it('adds a UUID v4 jti to every access token', () => {
    const claims = decode(
      signAccessToken({ subject, secret: JWT_SECRET, expiresIn: '15m' }),
    );

    expect(typeof claims.jti).toBe('string');
    expect(claims.jti).toMatch(UUID_V4);
    expect(claims.sub).toBe('agent-1');
    expect(typeof claims.exp).toBe('number');
  });

  it('uses a different jti for every token (same operator, same second)', () => {
    const first = decode(
      signAccessToken({ subject, secret: JWT_SECRET, expiresIn: '15m' }),
    );
    const second = decode(
      signAccessToken({ subject, secret: JWT_SECRET, expiresIn: '15m' }),
    );

    expect(first.jti).not.toBe(second.jti);
  });

  it('mints jti on login, so the controller can revoke what it just issued', async () => {
    const h = createHarness();
    const token = await loginToken(h);

    expect(decode(token).jti).toMatch(UUID_V4);
  });
});

/* ==========================================================================
 * 2. verifyToken rejects a denylisted jti
 * ========================================================================== */

describe('AgentService.verifyToken: denylist', () => {
  it('rejects a valid, unexpired token whose jti was denied (401)', async () => {
    const h = createHarness();
    const token = await loginToken(h);
    const claims = decode(token);

    await denyAccessToken({
      jti: String(claims.jti),
      expiresAt: claims.exp,
      now: NOW,
      cache: h.cache,
      logger: collectingLogger(h.logs),
    });
    expect(h.cache.entries.get(accessTokenDenyKey(String(claims.jti)))).toBe('1');

    await expect(h.service.verifyToken(token)).rejects.toMatchObject({
      code: 'AUTHENTICATION_ERROR',
      httpStatus: 401,
    });
    expect(h.logs.some((entry) => entry.message === 'agent.session.access_token_revoked')).toBe(
      true,
    );
  });

  it('keeps accepting the same token when only ANOTHER jti is denied', async () => {
    const h = createHarness();
    const token = await loginToken(h);

    await denyAccessToken({
      jti: '11111111-2222-4333-8444-555555555555',
      expiresAt: Math.floor(NOW.getTime() / 1000) + 3600,
      now: NOW,
      cache: h.cache,
    });

    await expect(h.service.verifyToken(token)).resolves.toMatchObject({
      agentId: h.agent.id,
      tenantId: 'tenant-1',
    });
  });

  it('accepts a legacy token without jti (minted before this feature)', async () => {
    const h = createHarness();
    const legacy = jwt.sign(
      {
        email: 'admin@acme.test',
        name: 'Ana Admin',
        role: 'ADMIN',
        tenantId: 'tenant-1',
        isPlatformAdmin: false,
      },
      JWT_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: '1h',
        issuer: 'sac-hub',
        audience: 'sac-web',
        subject: h.agent.id,
      },
    );

    const claims = await h.service.verifyToken(legacy);

    expect(claims).toMatchObject({ agentId: h.agent.id, tenantId: 'tenant-1' });
    // Nothing to revoke, so the optional claims stay absent.
    expect(claims.jti).toBeUndefined();
    expect(h.cache.entries.size).toBe(0);
  });

  it('FAILS OPEN on a cache outage: warns and accepts the token', async () => {
    const h = createHarness();
    const token = await loginToken(h);
    h.cache.failExists = true;

    await expect(h.service.verifyToken(token)).resolves.toMatchObject({
      agentId: h.agent.id,
    });

    const warning = h.logs.find(
      (entry) => entry.message === 'auth.access_token.denylist_unavailable',
    );
    expect(warning?.level).toBe('warn');
    expect(warning?.meta).toMatchObject({ reason: 'cache_read_failed' });
  });
});

/* ==========================================================================
 * 3. TTL sizing + best-effort write
 * ========================================================================== */

describe('access-token denylist TTL', () => {
  it('uses the remaining lifetime of the token (ceil, never negative)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const nowSeconds = Math.floor(now.getTime() / 1000);

    expect(resolveAccessTokenDenyTtlSeconds(nowSeconds + 900, now)).toBe(900);
    expect(resolveAccessTokenDenyTtlSeconds(nowSeconds + 1, now)).toBe(1);
    expect(resolveAccessTokenDenyTtlSeconds(nowSeconds - 1, now)).toBe(0);
    expect(resolveAccessTokenDenyTtlSeconds(nowSeconds, now)).toBe(0);
  });

  it('falls back to JWT_EXPIRES_IN default when the token has no exp', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    expect(resolveAccessTokenDenyTtlSeconds(undefined, now)).toBe(
      ACCESS_TOKEN_DENY_FALLBACK_TTL_SECONDS,
    );
    expect(resolveAccessTokenDenyTtlSeconds(Number.NaN, now, 900)).toBe(900);
  });

  it('writes value "1" with the remaining TTL', async () => {
    const cache = new RecordingCache();
    const now = new Date('2026-01-01T00:00:00.000Z');
    const nowSeconds = Math.floor(now.getTime() / 1000);

    const written = await denyAccessToken({
      jti: 'jti-1',
      expiresAt: nowSeconds + 900,
      now,
      cache,
    });

    expect(written).toBe(true);
    expect(cache.entries.get('sac:auth:deny:jti-1')).toBe('1');
    expect(cache.ttls.get('sac:auth:deny:jti-1')).toBe(900);
  });

  it('does nothing for an already expired token', async () => {
    const cache = new RecordingCache();
    const now = new Date('2026-01-01T00:00:00.000Z');

    const written = await denyAccessToken({
      jti: 'jti-expired',
      expiresAt: Math.floor(now.getTime() / 1000) - 10,
      now,
      cache,
    });

    expect(written).toBe(false);
    expect(cache.entries.size).toBe(0);
  });

  it('is best effort: a cache failure resolves false and never throws', async () => {
    const cache = new RecordingCache();
    cache.failSet = true;
    const logs: LogEntry[] = [];

    await expect(
      denyAccessToken({
        jti: 'jti-1',
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        cache,
        logger: collectingLogger(logs),
      }),
    ).resolves.toBe(false);

    expect(logs.some((entry) => entry.message === 'auth.access_token.revoke_failed')).toBe(true);
  });

  it('is a no-op without jti (legacy token)', async () => {
    const cache = new RecordingCache();

    await expect(denyAccessToken({ jti: undefined, cache })).resolves.toBe(false);
    expect(cache.entries.size).toBe(0);
  });
});

/* ==========================================================================
 * 4. isAccessTokenDenied
 * ========================================================================== */

describe('isAccessTokenDenied', () => {
  it('reads the namespaced key', async () => {
    const cache = new RecordingCache();
    await cache.set('sac:auth:deny:jti-1', '1', 60);

    await expect(isAccessTokenDenied({ jti: 'jti-1', cache })).resolves.toBe(true);
    await expect(isAccessTokenDenied({ jti: 'jti-2', cache })).resolves.toBe(false);
    await expect(isAccessTokenDenied({ jti: undefined, cache })).resolves.toBe(false);
  });

  it('returns false (allow) when the cache read throws', async () => {
    const cache = new RecordingCache();
    cache.failExists = true;
    const logs: LogEntry[] = [];

    await expect(
      isAccessTokenDenied({ jti: 'jti-1', cache, logger: collectingLogger(logs) }),
    ).resolves.toBe(false);
    expect(logs.some((entry) => entry.message === 'auth.access_token.denylist_unavailable')).toBe(
      true,
    );
  });
});
