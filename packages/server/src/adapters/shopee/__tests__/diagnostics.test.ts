import { afterEach, describe, expect, it } from 'vitest';
import type {
  AdapterDependencies,
  ChannelRuntimeConfig,
  HttpRequestOptions,
  HttpResponse,
  ICache,
  IClock,
  IHttpClient,
  ILogger,
  MarketplaceAccountRecord,
} from '@sac/shared';
import { ShopeeAuth } from '../client/ShopeeAuth';
import { ShopeeClient } from '../client/ShopeeClient';
import { computeSign } from '../client/sign';
import { ShopeeChannelAdapter } from '../ShopeeChannelAdapter';
import {
  ShopeeDiagnostics,
  extractHost,
  isHealthyShopStatus,
  isProductionHost,
  isSandboxHost,
  validateApiBase,
} from '../ShopeeDiagnostics';

/**
 * `diagnose` must be a REAL probe, but its mapping is pure: the HTTP transport is
 * stubbed here so we can assert the exact signed request, the check ids/statuses
 * and the remediation for each failure mode - without any network.
 */

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-01-01T00:00:00.000Z');
const PARTNER_ID = 123_123;
const PARTNER_KEY = 'partner-key';
const SHOP_ID = '987654';
const CACHED_ACCESS_TOKEN = 'cached-access-token';

const LOST_PUSH_ENV = 'SHOPEE_DIAGNOSE_LOST_PUSH';

interface StubOptions {
  apiBase?: string;
  dateHeader?: string | null;
  shopInfoBody?: Record<string, unknown>;
  lostPushBody?: Record<string, unknown>;
}

interface Stub {
  diagnostics: ShopeeDiagnostics;
  calls: HttpRequestOptions[];
}

function successEnvelope(response: Record<string, unknown>, requestId: string): Record<string, unknown> {
  return { request_id: requestId, error: '', message: '', response };
}

function createAccount(): MarketplaceAccountRecord {
  return {
    id: ACCOUNT_ID,
    marketplace: 'SHOPEE',
    displayName: 'Loja Teste',
    externalSellerId: SHOP_ID,
    marketplaceSiteId: 'BR',
    accessTokenEnc: 'enc:persisted-token',
    refreshTokenEnc: 'enc:refresh-token',
    tokenExpiresAt: new Date(NOW.getTime() + 3 * 3600 * 1000),
    authExpiresAt: null,
    channelConfig: { shop_id: SHOP_ID },
    status: 'ACTIVE',
    lastTokenRefreshAt: new Date(NOW.getTime() - 3600 * 1000),
    lastErrorAt: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function createConfig(apiBase: string): ChannelRuntimeConfig {
  return {
    appBaseUrl: 'http://localhost:4000',
    amazon: {
      lwaClientId: '',
      lwaClientSecret: '',
      spApiEndpoint: '',
      lwaTokenUrl: '',
      rdtEndpoint: '',
      region: '',
      sesInboundSharedSecret: '',
      emailDomainAllowlist: [],
    },
    meli: {
      clientId: '',
      clientSecret: '',
      redirectUri: '',
      apiBase: 'https://api.mercadolivre.com',
      refreshIntervalSeconds: 21_600,
      webhookTopics: [],
    },
    shopee: {
      partnerId: PARTNER_ID,
      partnerKey: PARTNER_KEY,
      redirectUri: 'https://sac.example.com/api/v1/accounts/oauth/shopee/callback',
      apiBase,
      refreshIntervalSeconds: 12_600,
      lostPushCron: '*/5 * * * *',
      lostPushLookbackMinutes: 60,
      webhookToleranceSeconds: 300,
    },
    smtp: { host: 'localhost', port: 1025, secure: false },
    s3: { bucket: 'sac', attachmentsBucket: 'sac-attachments' },
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

function createDeps(options: StubOptions, calls: HttpRequestOptions[]): AdapterDependencies {
  const account = createAccount();
  const logger: ILogger = {
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const clock: IClock = { now: () => new Date(NOW) };
  const cache: ICache = {
    get: async <T>(key: string): Promise<T | null> =>
      key.includes(':access:') ? (CACHED_ACCESS_TOKEN as unknown as T) : null,
    set: async () => undefined,
    setNx: async () => true,
    del: async () => undefined,
    exists: async () => false,
    ttl: async () => -1,
    incr: async () => 1,
    hset: async () => undefined,
    hgetall: async <T>() => null as T | null,
    sadd: async () => undefined,
    srem: async () => undefined,
    smembers: async () => [],
  };

  const shopInfoBody =
    options.shopInfoBody ??
    successEnvelope({ shop_name: 'Loja Teste', status: 'NORMAL', region: 'BR' }, 'req-shop-1');
  const lostPushBody =
    options.lostPushBody ??
    successEnvelope(
      { push_message_list: [{ code: 10 }], has_next_page: false, last_message_id: 99 },
      'req-lost-1',
    );

  const headers: Record<string, string> = {};
  if (options.dateHeader !== null) {
    headers['date'] = options.dateHeader ?? NOW.toUTCString();
  }

  const http: IHttpClient = {
    request: async <T>(request: HttpRequestOptions): Promise<HttpResponse<T>> => {
      calls.push(request);
      const isShopInfo = request.url.endsWith('/api/v2/shop/get_shop_info');
      const isLostPush = request.url.endsWith('/api/v2/push/get_lost_push_message');
      const body = isShopInfo ? shopInfoBody : isLostPush ? lostPushBody : null;
      if (!body) throw new Error(`unexpected HTTP call: ${request.url}`);
      return {
        status: 200,
        ok: true,
        headers,
        body: body as unknown as T,
        durationMs: 5,
        requestId: String(body['request_id'] ?? ''),
      };
    },
    requestBinary: async () => {
      throw new Error('requestBinary is not used by diagnose');
    },
  };

  const deps = {
    logger,
    clock,
    config: createConfig(options.apiBase ?? 'https://partner.shopeemobile.com'),
    repos: {
      accounts: {
        findById: async () => account,
        findByExternalSeller: async () => account,
        list: async () => [account],
        updateTokens: async () => account,
        setStatus: async () => account,
      },
      tickets: {},
      messages: {},
      orders: {},
      attachments: {},
      webhookEvents: {},
      piiVault: {},
      ticketEvents: {},
    },
    cache,
    lock: {
      withLock: async <T>(_resources: string[], _ttl: number, fn: () => Promise<T>) => fn(),
      tryWithLock: async <T>(_resources: string[], _ttl: number, fn: () => Promise<T>) => ({
        acquired: true,
        value: await fn(),
      }),
    },
    rateLimiter: {
      consume: async () => true,
      acquire: async () => undefined,
      reset: async () => undefined,
    },
    storage: {},
    cipher: {
      encrypt: (plaintext: string) => `enc:${plaintext}`,
      decrypt: (ciphertext: string) => {
        if (!ciphertext.startsWith('enc:')) throw new Error('unexpected ciphertext');
        return ciphertext.slice(4);
      },
      hash: (value: string) => value,
      keyId: 'test',
    },
    realtime: {
      ticketUpdated: () => undefined,
      messageCreated: () => undefined,
      queueChanged: () => undefined,
      channelHealth: () => undefined,
      agentPresence: () => undefined,
    },
    http,
    queue: {
      publish: async () => 'job-id',
      publishToDlq: async () => undefined,
    },
  };

  return deps as unknown as AdapterDependencies;
}

function createStub(options: StubOptions = {}): Stub {
  const calls: HttpRequestOptions[] = [];
  const deps = createDeps(options, calls);
  const client = new ShopeeClient(deps);
  const auth = new ShopeeAuth(deps, client);
  client.attachTokenProvider({
    getCredentials: (accountId: string) => auth.getCredentials(accountId),
    forceRefresh: (accountId: string) => auth.forceRefreshCredentials(accountId),
  });
  return { diagnostics: new ShopeeDiagnostics(deps, client, auth), calls };
}

function checksById(checks: Array<{ id: string }>): string[] {
  return checks.map((check) => check.id);
}

afterEach(() => {
  delete process.env[LOST_PUSH_ENV];
});

describe('ShopeeDiagnostics.diagnose (stubbed transport)', () => {
  it('returns the full check matrix and signs the real get_shop_info call', async () => {
    const { diagnostics, calls } = createStub();

    const checks = await diagnostics.diagnose({ accountId: ACCOUNT_ID });

    expect(checksById(checks)).toEqual([
      'shopee.config',
      'shopee.clock',
      'shopee.token',
      'shopee.sign',
      'shopee.shop_info',
      'shopee.lost_push',
      'shopee.sandbox',
    ]);
    expect(checks.find((check) => check.id === 'shopee.config')?.status).toBe('ok');
    expect(checks.find((check) => check.id === 'shopee.clock')?.status).toBe('ok');
    expect(checks.find((check) => check.id === 'shopee.token')?.status).toBe('ok');
    expect(checks.find((check) => check.id === 'shopee.sign')?.status).toBe('ok');
    expect(checks.find((check) => check.id === 'shopee.shop_info')?.status).toBe('ok');
    expect(checks.find((check) => check.id === 'shopee.lost_push')?.status).toBe('skipped');
    expect(checks.find((check) => check.id === 'shopee.sandbox')?.status).toBe('ok');
    expect(checks.find((check) => check.id === 'shopee.shop_info')?.detail).toContain('Loja Teste');

    expect(calls).toHaveLength(1);
    const call = calls[0] as HttpRequestOptions;
    expect(call.method).toBe('GET');
    expect(call.url).toBe('https://partner.shopeemobile.com/api/v2/shop/get_shop_info');

    const query = (call.query ?? {}) as Record<string, string | number>;
    expect(query['partner_id']).toBe(String(PARTNER_ID));
    expect(query['access_token']).toBe(CACHED_ACCESS_TOKEN);
    expect(query['shop_id']).toBe(SHOP_ID);
    expect(typeof query['timestamp']).toBe('number');
    expect(query['sign']).toBe(
      computeSign({
        partnerId: String(PARTNER_ID),
        apiPath: '/api/v2/shop/get_shop_info',
        timestamp: Number(query['timestamp']),
        accessToken: CACHED_ACCESS_TOKEN,
        shopId: SHOP_ID,
        partnerKey: PARTNER_KEY,
      }),
    );
    expect(call.body).toBeUndefined();
  });

  it('warns when SHOPEE_API_BASE points at the sandbox', async () => {
    const { diagnostics } = createStub({ apiBase: 'https://partner.test-stable.shopeemobile.com' });

    const checks = await diagnostics.diagnose({ accountId: ACCOUNT_ID });
    const sandbox = checks.find((check) => check.id === 'shopee.sandbox');
    expect(sandbox?.status).toBe('warn');
    expect(sandbox?.detail).toContain('partner.test-stable.shopeemobile.com');
    expect(sandbox?.remediation).toContain('SHOPEE_API_BASE');
  });

  it('fails shop_info and skips the clock check on a Shopee business error', async () => {
    const { diagnostics } = createStub({
      shopInfoBody: { request_id: 'req-err', error: 'error_sign', message: 'invalid signature' },
    });

    const checks = await diagnostics.diagnose({ accountId: ACCOUNT_ID });
    const shopInfo = checks.find((check) => check.id === 'shopee.shop_info');
    expect(shopInfo?.status).toBe('fail');
    expect(shopInfo?.detail).toContain('error_sign');
    expect(shopInfo?.detail).toContain('req-err');
    expect(shopInfo?.remediation).toContain('Assinatura');
    expect(checks.find((check) => check.id === 'shopee.clock')?.status).toBe('skipped');
  });

  it('fails the clock check when the server Date header is beyond 300s', async () => {
    const { diagnostics } = createStub({
      dateHeader: new Date(NOW.getTime() + 10 * 60 * 1000).toUTCString(),
    });

    const checks = await diagnostics.diagnose({ accountId: ACCOUNT_ID });
    const clock = checks.find((check) => check.id === 'shopee.clock');
    expect(clock?.status).toBe('fail');
    expect(clock?.remediation).toContain('NTP');
    expect(clock?.detail).toContain('600s');
  });

  it('queries lost pushes only when SHOPEE_DIAGNOSE_LOST_PUSH=true and never consumes them', async () => {
    process.env[LOST_PUSH_ENV] = 'true';
    const { diagnostics, calls } = createStub();

    const checks = await diagnostics.diagnose({ accountId: ACCOUNT_ID });

    const lostPush = checks.find((check) => check.id === 'shopee.lost_push');
    expect(lostPush?.status).toBe('ok');
    expect(lostPush?.detail).toContain('1 push(es)');
    expect(calls).toHaveLength(2);

    const lostCall = calls[1] as HttpRequestOptions;
    expect(lostCall.method).toBe('GET');
    expect(lostCall.url).toBe('https://partner.shopeemobile.com/api/v2/push/get_lost_push_message');
    expect(lostCall.body).toBeUndefined();
    const query = (lostCall.query ?? {}) as Record<string, string | number>;
    // Official v2: the lost-push endpoints are PUBLIC (partner_id/timestamp/sign
    // only) - no access_token and no shop_id.
    expect(query['access_token']).toBeUndefined();
    expect(query['shop_id']).toBeUndefined();
    expect(query['sign']).toBe(
      computeSign({
        partnerId: String(PARTNER_ID),
        apiPath: '/api/v2/push/get_lost_push_message',
        timestamp: Number(query['timestamp']),
        partnerKey: PARTNER_KEY,
      }),
    );
  });
});

describe('adapter composition', () => {
  it('exposes diagnose/runMaintenance through the Shopee channel adapter', () => {
    const deps = createDeps({}, []);
    const adapter = new ShopeeChannelAdapter(deps);

    expect(adapter.marketplace).toBe('SHOPEE');
    expect(typeof adapter.diagnose).toBe('function');
    expect(typeof adapter.runMaintenance).toBe('function');
    expect(typeof adapter.enrichOrder).toBe('function');
  });
});

describe('diagnostic helpers', () => {
  it('parses hosts and validates the API base', () => {
    expect(extractHost('https://partner.shopeemobile.com')).toBe('partner.shopeemobile.com');
    expect(extractHost('not-a-url')).toBe('');
    expect(validateApiBase('https://partner.shopeemobile.com')).toBeNull();
    expect(validateApiBase('http://partner.shopeemobile.com')).toContain('https');
    expect(validateApiBase('')).toContain('ausente');
    expect(isSandboxHost('partner.test-stable.shopeemobile.com')).toBe(true);
    expect(isSandboxHost('openplatform.sandbox.test-stable.shopee.sg')).toBe(true);
    expect(isSandboxHost('partner.shopeemobile.com')).toBe(false);
    expect(isProductionHost('partner.shopeemobile.com')).toBe(true);
    expect(isProductionHost('openplatform.shopee.com.br')).toBe(true);
    expect(isProductionHost('openplatform.shopee.cn')).toBe(true);
    expect(isProductionHost('partner.test-stable.shopeemobile.com')).toBe(false);
  });

  it('classifies shop statuses', () => {
    expect(isHealthyShopStatus('NORMAL')).toBe(true);
    expect(isHealthyShopStatus(' active ')).toBe(true);
    expect(isHealthyShopStatus('BANNED')).toBe(false);
  });
});
