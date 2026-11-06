import { describe, expect, it } from 'vitest';

import type { IAccountRepository, MarketplaceAccountRecord } from '@sac/shared';

import { StatusService, isHealthyAccount, overallStatus } from '../StatusService';
import { FrozenClock, InMemoryAccountRepository, silentLogger } from './accountFakes';

/**
 * Public status page (`GET /status`) unit tests.
 *
 * Contract under test:
 *  - only infra probes decide `api/database/redis/storage`;
 *  - channels are AGGREGATED per marketplace (counts only, no PII);
 *  - level mapping: database/redis down => down, storage down or a partially
 *    unhealthy channel => degraded, everything fine => operational;
 *  - the service never throws for a failing probe.
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');
const MINUTE_MS = 60 * 1_000;

type Probe = () => Promise<void>;

interface HarnessOptions {
  database?: Probe;
  redis?: Probe;
  storage?: Probe;
  accounts?: IAccountRepository;
  timeoutMs?: number;
}

function createHarness(options: HarnessOptions = {}) {
  const clock = new FrozenClock(NOW);
  const accounts = options.accounts ?? new InMemoryAccountRepository(clock);
  const calls: string[] = [];
  const probe = (name: string, override?: Probe): Probe => {
    if (override !== undefined) return override;
    return async () => {
      calls.push(name);
    };
  };

  const service = new StatusService({
    logger: silentLogger,
    clock,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    probes: {
      database: probe('database', options.database),
      redis: probe('redis', options.redis),
      storage: probe('storage', options.storage),
    },
    repos: { accounts },
  });

  /** Seeds the in-memory repository (only valid when no custom port was given). */
  const seed = (
    overrides: Partial<MarketplaceAccountRecord> & {
      marketplace: MarketplaceAccountRecord['marketplace'];
      externalSellerId: string;
    },
  ): MarketplaceAccountRecord => {
    if (!(accounts instanceof InMemoryAccountRepository)) {
      throw new Error('seed() requires the default in-memory account repository');
    }
    return accounts.seed(overrides);
  };

  return { clock, accounts, service, calls, seed };
}

function seedHealthy(
  seed: ReturnType<typeof createHarness>['seed'],
  overrides: Partial<MarketplaceAccountRecord> & {
    marketplace: MarketplaceAccountRecord['marketplace'];
    externalSellerId: string;
  },
): MarketplaceAccountRecord {
  return seed({
    accessTokenEnc: 'enc:access',
    status: 'ACTIVE',
    ...overrides,
  });
}

describe('StatusService.snapshot', () => {
  it('is operational when every probe and channel is healthy', async () => {
    const h = createHarness();
    seedHealthy(h.seed, {
      marketplace: 'MERCADO_LIVRE',
      externalSellerId: 'meli-1',
      displayName: 'Meli Store',
    });

    const snapshot = await h.service.snapshot();

    expect(snapshot.status).toBe('operational');
    expect(snapshot.checkedAt).toBe(NOW.toISOString());
    expect(snapshot.services.map((service) => service.name)).toEqual([
      'api',
      'database',
      'redis',
      'storage',
    ]);
    expect(snapshot.services.map((service) => service.status)).toEqual([
      'operational',
      'operational',
      'operational',
      'operational',
    ]);
    for (const service of snapshot.services) {
      expect(service.latencyMs === null || service.latencyMs >= 0).toBe(true);
    }
    expect(new Set(h.calls)).toEqual(new Set(['database', 'redis', 'storage']));
    expect(snapshot.channels).toEqual([
      { marketplace: 'MERCADO_LIVRE', accounts: 1, healthy: 1, lastErrorAt: null },
    ]);
  });

  it('is degraded (not down) when object storage fails', async () => {
    const h = createHarness({
      storage: async () => {
        throw new Error('S3 unreachable');
      },
    });

    const snapshot = await h.service.snapshot();

    expect(snapshot.status).toBe('degraded');
    expect(snapshot.services.find((service) => service.name === 'storage')).toMatchObject({
      status: 'down',
    });
    // The failure detail (which may carry a bucket/endpoint) is never exposed.
    expect(JSON.stringify(snapshot)).not.toContain('S3 unreachable');
  });

  it('is down when the database probe fails', async () => {
    const h = createHarness({
      database: async () => {
        throw new Error('postgres down');
      },
    });

    const snapshot = await h.service.snapshot();

    expect(snapshot.status).toBe('down');
    expect(snapshot.services.find((service) => service.name === 'database')).toMatchObject({
      status: 'down',
    });
  });

  it('is down when Redis fails, even if the database is healthy', async () => {
    const h = createHarness({
      redis: async () => {
        throw new Error('redis down');
      },
    });

    const snapshot = await h.service.snapshot();

    expect(snapshot.status).toBe('down');
    expect(snapshot.services.find((service) => service.name === 'redis')).toMatchObject({
      status: 'down',
    });
  });

  it('aggregates channels per marketplace without PII', async () => {
    const h = createHarness();
    seedHealthy(h.seed, {
      id: 'account-amazon',
      marketplace: 'AMAZON',
      externalSellerId: 'amz-1',
      displayName: 'Segredo do Vendedor',
    });
    seedHealthy(h.seed, {
      id: 'account-meli-1',
      marketplace: 'MERCADO_LIVRE',
      externalSellerId: 'meli-1',
      displayName: 'Loja Meli',
    });
    // Disconnected: unhealthy even though it has credentials.
    h.seed({
      id: 'account-meli-2',
      marketplace: 'MERCADO_LIVRE',
      externalSellerId: 'meli-2',
      displayName: 'Loja Antiga',
      accessTokenEnc: 'enc:access',
      status: 'DISCONNECTED',
      lastErrorAt: new Date(NOW.getTime() - 10 * MINUTE_MS),
    });
    // Recent error: still ACTIVE but unhealthy inside the 30-minute window.
    seedHealthy(h.seed, {
      id: 'account-shopee',
      marketplace: 'SHOPEE',
      externalSellerId: 'shop-1',
      displayName: 'Loja Shopee',
      lastErrorAt: new Date(NOW.getTime() - 5 * MINUTE_MS),
    });

    const snapshot = await h.service.snapshot();

    expect(snapshot.status).toBe('degraded');
    expect(snapshot.channels).toEqual([
      { marketplace: 'AMAZON', accounts: 1, healthy: 1, lastErrorAt: null },
      {
        marketplace: 'MERCADO_LIVRE',
        accounts: 2,
        healthy: 1,
        lastErrorAt: new Date(NOW.getTime() - 10 * MINUTE_MS).toISOString(),
      },
      {
        marketplace: 'SHOPEE',
        accounts: 1,
        healthy: 0,
        lastErrorAt: new Date(NOW.getTime() - 5 * MINUTE_MS).toISOString(),
      },
    ]);

    // No account id, display name, token or e-mail crosses the public payload.
    const serialized = JSON.stringify(snapshot.channels);
    for (const secret of ['account-amazon', 'account-meli-1', 'Segredo do Vendedor', 'enc:access']) {
      expect(serialized).not.toContain(secret);
    }
    expect(Object.keys(snapshot.channels[0]).sort()).toEqual([
      'accounts',
      'healthy',
      'lastErrorAt',
      'marketplace',
    ]);
  });

  it('keeps rendering when the account repository fails', async () => {
    const failingAccounts = {
      list: async () => {
        throw new Error('accounts query failed');
      },
    } as unknown as IAccountRepository;
    const h = createHarness({ accounts: failingAccounts });

    const snapshot = await h.service.snapshot();

    expect(snapshot.status).toBe('operational');
    expect(snapshot.channels).toEqual([]);
  });

  it('bounds a hung probe with the configured timeout', async () => {
    const h = createHarness({
      timeoutMs: 20,
      database: () => new Promise<void>(() => undefined),
    });

    const snapshot = await h.service.snapshot();

    expect(snapshot.status).toBe('down');
    const database = snapshot.services.find((service) => service.name === 'database');
    expect(database?.status).toBe('down');
    expect(database?.latencyMs).toBeGreaterThanOrEqual(20);
  });
});

describe('overallStatus', () => {
  const channel = (
    healthy: number,
    accounts: number,
  ): { marketplace: 'AMAZON'; accounts: number; healthy: number; lastErrorAt: null } => ({
    marketplace: 'AMAZON',
    accounts,
    healthy,
    lastErrorAt: null,
  });

  it('is operational only when every dependency and channel is healthy', () => {
    expect(
      overallStatus([], [channel(2, 2)]),
    ).toBe('operational');
    expect(overallStatus([], [channel(1, 2)])).toBe('degraded');
  });

  it('is down when database or Redis is down (priority over storage)', () => {
    const down = (name: 'database' | 'redis' | 'storage' | 'api') => ({
      name,
      status: 'down' as const,
      latencyMs: 1,
    });
    expect(overallStatus([down('database'), down('storage')], [channel(0, 1)])).toBe('down');
    expect(overallStatus([down('redis')], [channel(1, 1)])).toBe('down');
    expect(overallStatus([down('storage')], [channel(1, 1)])).toBe('degraded');
  });
});

describe('isHealthyAccount', () => {
  const base = (overrides: Partial<MarketplaceAccountRecord> = {}): MarketplaceAccountRecord => ({
    id: 'account-1',
    tenantId: 'tenant-1',
    marketplace: 'SHOPEE',
    displayName: 'Shop',
    externalSellerId: 'shop-1',
    marketplaceSiteId: 'shop-1',
    accessTokenEnc: 'enc:access',
    refreshTokenEnc: null,
    tokenExpiresAt: null,
    authExpiresAt: null,
    channelConfig: {},
    status: 'ACTIVE',
    lastTokenRefreshAt: null,
    lastErrorAt: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

  it('requires ACTIVE status and stored credentials', () => {
    expect(isHealthyAccount(base(), NOW)).toBe(true);
    expect(isHealthyAccount(base({ status: 'DISCONNECTED' }), NOW)).toBe(false);
    expect(
      isHealthyAccount(base({ accessTokenEnc: null, refreshTokenEnc: null }), NOW),
    ).toBe(false);
    expect(isHealthyAccount(base({ accessTokenEnc: null, refreshTokenEnc: 'enc:r' }), NOW)).toBe(
      true,
    );
  });

  it('treats an error inside the 30-minute window as unhealthy', () => {
    expect(
      isHealthyAccount(base({ lastErrorAt: new Date(NOW.getTime() - 10 * MINUTE_MS) }), NOW),
    ).toBe(false);
    expect(
      isHealthyAccount(base({ lastErrorAt: new Date(NOW.getTime() - 31 * MINUTE_MS) }), NOW),
    ).toBe(true);
  });
});
