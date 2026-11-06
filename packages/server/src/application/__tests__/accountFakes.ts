import { createHash } from 'node:crypto';

import type {
  AccountStatus,
  AccountTokenPatch,
  ChannelRuntimeConfig,
  CreateAccountInput,
  IAccountRepository,
  IAdapterRegistry,
  ICache,
  IClock,
  IHttpClient,
  ILogger,
  ISecretCipher,
  HttpRequestOptions,
  Marketplace,
  MarketplaceAccountRecord,
} from '@sac/shared';

/**
 * In-memory stubs shared by the AccountService unit tests.
 *
 * They mirror the production semantics closely enough to assert persistence:
 * tokens are stored through the (fake) cipher, the tenant id is preserved, the
 * account is keyed by `(marketplace, externalSellerId, marketplaceSiteId)` and a
 * state read is single-use because the cache entry is deleted.
 */

export const silentLogger: ILogger = {
  child(): ILogger {
    return this;
  },
  trace(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

export class FrozenClock implements IClock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(date: Date): void {
    this.current = date;
  }
}

export class InMemoryCache implements ICache {
  readonly entries = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return (this.entries.get(key) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, value);
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
    return this.entries.has(key);
  }

  async ttl(): Promise<number> {
    return -1;
  }

  async incr(key: string): Promise<number> {
    const next = Number(this.entries.get(key) ?? 0) + 1;
    this.entries.set(key, next);
    return next;
  }

  async hset(key: string, values: Record<string, string>): Promise<void> {
    const current = (this.entries.get(key) as Record<string, string> | undefined) ?? {};
    this.entries.set(key, { ...current, ...values });
  }

  async hgetall<T extends Record<string, string>>(key: string): Promise<T | null> {
    return (this.entries.get(key) as T | undefined) ?? null;
  }

  async sadd(): Promise<void> {}

  async srem(): Promise<void> {}

  async smembers(): Promise<string[]> {
    return [];
  }
}

/** Deterministic HMAC-like hash + reversible marker so tests can assert crypto. */
export class FakeCipher implements ISecretCipher {
  readonly keyId = 'test-key';

  encrypt(plaintext: string): string {
    return `enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
  }

  decrypt(ciphertext: string): string {
    return Buffer.from(ciphertext.replace(/^enc:/, ''), 'base64').toString('utf8');
  }

  hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}

export interface StubbedHttpReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export class RecordingHttpClient implements IHttpClient {
  readonly requests: HttpRequestOptions[] = [];

  constructor(private readonly handler: (options: HttpRequestOptions) => StubbedHttpReply) {}

  async request<T>(options: HttpRequestOptions): Promise<{
    status: number;
    ok: boolean;
    headers: Record<string, string>;
    body: T;
    durationMs: number;
  }> {
    this.requests.push(options);
    const reply = this.handler(options);
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      headers: reply.headers ?? {},
      body: (reply.body ?? {}) as T,
      durationMs: 1,
    };
  }

  async requestBinary(): Promise<never> {
    throw new Error('requestBinary is not used by the OAuth flow');
  }
}

export class InMemoryAccountRepository implements IAccountRepository {
  readonly rows: MarketplaceAccountRecord[] = [];
  private sequence = 0;

  constructor(private readonly clock: IClock) {}

  seed(input: Partial<MarketplaceAccountRecord> & { marketplace: Marketplace; externalSellerId: string }): MarketplaceAccountRecord {
    const at = this.clock.now();
    const row: MarketplaceAccountRecord = {
      id: input.id ?? `account-${(this.sequence += 1)}`,
      tenantId: input.tenantId ?? null,
      marketplace: input.marketplace,
      displayName: input.displayName ?? 'Seeded account',
      externalSellerId: input.externalSellerId,
      marketplaceSiteId: input.marketplaceSiteId ?? input.externalSellerId,
      accessTokenEnc: input.accessTokenEnc ?? null,
      refreshTokenEnc: input.refreshTokenEnc ?? null,
      tokenExpiresAt: input.tokenExpiresAt ?? null,
      authExpiresAt: input.authExpiresAt ?? null,
      channelConfig: input.channelConfig ?? {},
      status: input.status ?? 'ACTIVE',
      lastTokenRefreshAt: input.lastTokenRefreshAt ?? null,
      lastErrorAt: input.lastErrorAt ?? null,
      lastError: input.lastError ?? null,
      createdAt: input.createdAt ?? at,
      updatedAt: input.updatedAt ?? at,
    };
    this.rows.push(row);
    return row;
  }

  private byKey(
    marketplace: Marketplace,
    externalSellerId: string,
    marketplaceSiteId?: string,
  ): MarketplaceAccountRecord | undefined {
    return this.rows.find(
      (row) =>
        row.marketplace === marketplace &&
        row.externalSellerId === externalSellerId &&
        (marketplaceSiteId === undefined || row.marketplaceSiteId === marketplaceSiteId),
    );
  }

  async create(input: CreateAccountInput): Promise<MarketplaceAccountRecord> {
    return this.seed({
      tenantId: input.tenantId ?? null,
      marketplace: input.marketplace,
      displayName: input.displayName,
      externalSellerId: input.externalSellerId,
      marketplaceSiteId: input.marketplaceSiteId,
      accessTokenEnc: input.accessTokenEnc ?? null,
      refreshTokenEnc: input.refreshTokenEnc ?? null,
      tokenExpiresAt: input.tokenExpiresAt ?? null,
      authExpiresAt: input.authExpiresAt ?? null,
      channelConfig: input.channelConfig ?? {},
      status: input.status ?? 'ACTIVE',
    });
  }

  async findById(id: string): Promise<MarketplaceAccountRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async findByExternalSeller(
    marketplace: Marketplace,
    externalSellerId: string,
    marketplaceSiteId?: string,
  ): Promise<MarketplaceAccountRecord | null> {
    return this.byKey(marketplace, externalSellerId, marketplaceSiteId) ?? null;
  }

  async findFirstByMarketplace(marketplace: Marketplace): Promise<MarketplaceAccountRecord | null> {
    return this.rows.find((row) => row.marketplace === marketplace) ?? null;
  }

  async list(filter?: {
    marketplace?: Marketplace;
    status?: AccountStatus;
    tenantId?: string | null;
  }): Promise<MarketplaceAccountRecord[]> {
    return this.rows.filter(
      (row) =>
        (filter?.marketplace === undefined || row.marketplace === filter.marketplace) &&
        (filter?.status === undefined || row.status === filter.status) &&
        (filter?.tenantId === undefined || row.tenantId === filter.tenantId),
    );
  }

  async updateTokens(id: string, patch: AccountTokenPatch): Promise<MarketplaceAccountRecord> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`Account not found: ${id}`);
    if (patch.accessTokenEnc !== undefined) row.accessTokenEnc = patch.accessTokenEnc;
    if (patch.refreshTokenEnc !== undefined) row.refreshTokenEnc = patch.refreshTokenEnc;
    if (patch.tokenExpiresAt !== undefined) row.tokenExpiresAt = patch.tokenExpiresAt;
    if (patch.authExpiresAt !== undefined) row.authExpiresAt = patch.authExpiresAt;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.lastTokenRefreshAt !== undefined) row.lastTokenRefreshAt = patch.lastTokenRefreshAt;
    if (patch.lastError !== undefined) row.lastError = patch.lastError;
    if (patch.lastErrorAt !== undefined) row.lastErrorAt = patch.lastErrorAt;
    if (patch.tenantId !== undefined) row.tenantId = patch.tenantId;
    row.updatedAt = this.clock.now();
    return row;
  }

  async updateChannelConfig(
    id: string,
    config: Record<string, unknown>,
  ): Promise<MarketplaceAccountRecord> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`Account not found: ${id}`);
    row.channelConfig = config;
    row.updatedAt = this.clock.now();
    return row;
  }

  async setStatus(
    id: string,
    status: AccountStatus,
    error?: string | null,
  ): Promise<MarketplaceAccountRecord> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`Account not found: ${id}`);
    row.status = status;
    if (error !== undefined) {
      row.lastError = error;
      row.lastErrorAt = error === null ? null : this.clock.now();
    }
    row.updatedAt = this.clock.now();
    return row;
  }

  async delete(id: string): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

export const fakeAdapterRegistry: IAdapterRegistry = {
  get(): never {
    throw new Error('No adapter is required by the OAuth flow');
  },
};

export const TEST_AMAZON_APP_ID = 'amzn1.application-oa2-client.test';
export const TEST_AMAZON_REDIRECT_URI =
  'https://api.integrai.test/api/v1/accounts/oauth/amazon/callback';

export function testChannelConfig(
  overrides: { amazon?: Partial<ChannelRuntimeConfig['amazon']> } = {},
): ChannelRuntimeConfig {
  return {
    appBaseUrl: 'https://api.integrai.test',
    amazon: {
      lwaClientId: 'amzn1.application-oa2-client.test',
      lwaClientSecret: 'amzn1.oa2-cs.v1.test',
      spApiEndpoint: 'https://sellingpartnerapi-na.amazon.com',
      lwaTokenUrl: 'https://api.amazon.com/auth/o2/token',
      rdtEndpoint: 'https://sellingpartnerapi-na.amazon.com/tokens/2021-03-01/restrictedDataToken',
      region: 'na',
      sesInboundSharedSecret: 'ses-secret',
      emailDomainAllowlist: ['amazon.com', 'amazon.com.br'],
      appId: TEST_AMAZON_APP_ID,
      appRedirectUri: TEST_AMAZON_REDIRECT_URI,
      oauthAuthorizeUrl: 'https://sellercentral.amazon.com/apps/authorize/consent',
      ...overrides.amazon,
    },
    meli: {
      clientId: 'meli-client',
      clientSecret: 'meli-secret',
      redirectUri: 'https://api.integrai.test/api/v1/accounts/oauth/mercadolivre/callback',
      apiBase: 'https://api.mercadolibre.com',
      refreshIntervalSeconds: 20_700,
      webhookTopics: ['questions'],
      webhookSecret: 'meli-webhook-secret',
    },
    shopee: {
      partnerId: 1_000_000,
      partnerKey: 'shopee-key',
      redirectUri: 'https://api.integrai.test/api/v1/accounts/oauth/shopee/callback',
      apiBase: 'https://partner.shopeemobile.com',
      refreshIntervalSeconds: 12_600,
      lostPushCron: '*/5 * * * *',
      lostPushLookbackMinutes: 60,
      webhookToleranceSeconds: 300,
    },
    smtp: { host: 'localhost', port: 1025, secure: false },
    s3: { bucket: 'sac-hub-raw', attachmentsBucket: 'sac-hub-attachments' },
    piiRetentionDays: 30,
    rateLimits: {
      amazonMessagingPerSecond: 1,
      amazonOrdersPerSecond: 0.5,
      amazonOrdersBurst: 10,
      amazonRdtPerSecond: 1,
      meliPerSecond: 10,
      shopeePerSecond: 5,
    },
  };
}
