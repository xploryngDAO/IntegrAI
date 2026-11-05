import { afterEach, describe, expect, it } from 'vitest';
import type {
  AdapterDependencies,
  ChannelRuntimeConfig,
  HttpRequestOptions,
  HttpResponse,
  MarketplaceAccountRecord,
} from '@sac/shared';
import { AMAZON_DIAGNOSE_ORDER_ID_ENV, runAmazonDiagnosis } from '../diagnose';

const config: ChannelRuntimeConfig = {
  appBaseUrl: 'http://localhost:3000',
  amazon: {
    lwaClientId: 'client-id',
    lwaClientSecret: 'client-secret',
    spApiEndpoint: 'https://sellingpartnerapi-na.amazon.com',
    lwaTokenUrl: 'https://api.amazon.com/auth/o2/token',
    rdtEndpoint:
      'https://sellingpartnerapi-na.amazon.com/tokens/2021-03-01/restrictedDataToken',
    region: 'NA',
    sesInboundSharedSecret: 'shared-secret',
    emailDomainAllowlist: [],
  },
  meli: {
    clientId: 'm',
    clientSecret: 'm',
    redirectUri: 'x',
    apiBase: 'https://api.mercadolivre.com',
    refreshIntervalSeconds: 1,
    webhookTopics: [],
  },
  shopee: {
    partnerId: 1,
    partnerKey: 'k',
    redirectUri: 'x',
    apiBase: 'https://partner.shopeemobile.com',
    refreshIntervalSeconds: 1,
    lostPushCron: '*/5 * * * *',
    lostPushLookbackMinutes: 60,
    webhookToleranceSeconds: 300,
  },
  smtp: { host: 'localhost', port: 1025, secure: false },
  s3: { bucket: 'sac', attachmentsBucket: 'sac' },
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

const account: MarketplaceAccountRecord = {
  id: 'acc-1',
  marketplace: 'AMAZON',
  displayName: 'Amazon BR',
  externalSellerId: 'SELLER',
  marketplaceSiteId: 'A2Q3Y263D00KWC',
  accessTokenEnc: null,
  refreshTokenEnc: 'v1:key:iv:tag:cipher',
  tokenExpiresAt: null,
  authExpiresAt: null,
  channelConfig: {},
  status: 'ACTIVE',
  lastTokenRefreshAt: null,
  lastErrorAt: null,
  lastError: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

interface HttpStub {
  deps: AdapterDependencies;
  calls: HttpRequestOptions[];
}

function response<T>(status: number, body: T): HttpResponse<T> {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {},
    body,
    durationMs: 1,
  };
}

function makeDeps(
  handler: (options: HttpRequestOptions) => HttpResponse<unknown>,
  overrides?: {
    account?: MarketplaceAccountRecord | null;
    decrypt?: (ciphertext: string) => string;
  },
): HttpStub {
  const calls: HttpRequestOptions[] = [];
  const logger = {
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const deps = {
    logger,
    clock: { now: () => new Date('2026-11-05T12:00:00Z') },
    config,
    repos: {
      accounts: {
        findById: async () => (overrides?.account === undefined ? account : overrides.account),
      },
    },
    cache: { get: async () => null, set: async () => undefined },
    lock: { withLock: async () => undefined },
    rateLimiter: { acquire: async () => undefined, consume: async () => true },
    storage: {
      putObject: async () => ({ key: 'k', uri: 's3://sac/k', size: 0, sha256: 'x' }),
      getObject: async () => Buffer.from(''),
      putToPresignedUrl: async () => undefined,
      presignGet: async () => 'x',
      buildUri: (key: string) => `s3://sac/${key}`,
    },
    cipher: {
      encrypt: (value: string) => value,
      decrypt: overrides?.decrypt ?? (() => 'refresh-token'),
      hash: (value: string) => `hash:${value}`,
      keyId: 'k',
    },
    realtime: {
      ticketUpdated: () => undefined,
      messageCreated: () => undefined,
      queueChanged: () => undefined,
      channelHealth: () => undefined,
      agentPresence: () => undefined,
    },
    http: {
      request: async <T,>(options: HttpRequestOptions): Promise<HttpResponse<T>> => {
        calls.push(options);
        return handler(options) as HttpResponse<T>;
      },
      requestBinary: async () => {
        throw new Error('requestBinary is not used by diagnose');
      },
    },
    queue: { publish: async () => 'job', publishToDlq: async () => undefined },
  };
  return { deps: deps as unknown as AdapterDependencies, calls };
}

function happyHandler(options: HttpRequestOptions): HttpResponse<unknown> {
  if (options.url.includes('/auth/o2/token')) {
    return response(200, {
      access_token: 'lwa-access-token-secret',
      expires_in: 3600,
      token_type: 'bearer',
    });
  }
  if (options.url.includes('/sellers/v1/marketplaceParticipations')) {
    return response(200, {
      payload: [
        {
          marketplace: { id: 'A2Q3Y263D00KWC', countryCode: 'BR', name: 'Amazon.com.br' },
          storeName: 'Minha Marca',
          participation: { isParticipating: true, hasSuspendedListings: false },
        },
      ],
    });
  }
  if (options.url.includes('/tokens/2021-03-01/restrictedDataToken')) {
    return response(200, { restrictedDataToken: 'rdt-token-secret', expiresIn: 3600 });
  }
  return response(404, { errors: [{ code: 'NotFound', message: 'unexpected url' }] });
}

function statusById(checks: Awaited<ReturnType<typeof runAmazonDiagnosis>>): Record<string, string> {
  return Object.fromEntries(checks.map((check) => [check.id, check.status]));
}

afterEach(() => {
  delete process.env[AMAZON_DIAGNOSE_ORDER_ID_ENV];
});

describe('Amazon diagnose (live-call mapping, stubbed http)', () => {
  it('performs LWA + Sellers calls and skips RDT without a sample order id', async () => {
    const { deps, calls } = makeDeps(happyHandler);
    const checks = await runAmazonDiagnosis(deps, 'acc-1');

    expect(checks.map((check) => check.id)).toEqual([
      'amazon.config',
      'amazon.lwa',
      'amazon.participations',
      'amazon.rdt',
    ]);
    expect(statusById(checks)).toEqual({
      'amazon.config': 'ok',
      'amazon.lwa': 'ok',
      'amazon.participations': 'ok',
      'amazon.rdt': 'skipped',
    });

    // Real calls were issued with the documented URLs/headers.
    const lwaCall = calls.find((call) => call.url.includes('/auth/o2/token'));
    expect(lwaCall?.method).toBe('POST');
    expect(String(lwaCall?.body)).toContain('grant_type=refresh_token');
    expect(String(lwaCall?.body)).toContain('refresh_token=refresh-token');

    const participationCall = calls.find((call) =>
      call.url.includes('/sellers/v1/marketplaceParticipations'),
    );
    expect(participationCall?.method).toBe('GET');
    expect(participationCall?.headers?.['x-amz-access-token']).toBe('lwa-access-token-secret');

    // RDT is not called without an order id, and no secret leaks into checks.
    expect(calls.some((call) => call.url.includes('/restrictedDataToken'))).toBe(false);
    const serialized = JSON.stringify(checks);
    expect(serialized).not.toContain('lwa-access-token-secret');
    expect(serialized).not.toContain('refresh-token');
    expect(checks[2]?.detail).toContain('A2Q3Y263D00KWC');
  });

  it('requests a real RDT when AMAZON_DIAGNOSE_ORDER_ID is configured', async () => {
    process.env[AMAZON_DIAGNOSE_ORDER_ID_ENV] = '123-4567890-1234567';
    const { deps, calls } = makeDeps(happyHandler);
    const checks = await runAmazonDiagnosis(deps, 'acc-1');

    expect(statusById(checks)['amazon.rdt']).toBe('ok');
    const rdtCall = calls.find((call) => call.url.includes('/restrictedDataToken'));
    expect(rdtCall?.method).toBe('POST');
    expect(rdtCall?.headers?.['x-amz-access-token']).toBe('lwa-access-token-secret');
    const body = rdtCall?.body as {
      restrictedResources?: Array<{ method?: string; path?: string; dataElements?: string[] }>;
    };
    expect(body.restrictedResources?.[0]?.path).toBe('/orders/v0/orders/123-4567890-1234567');
    expect(body.restrictedResources?.[0]?.dataElements).toEqual(['buyerInfo', 'shippingAddress']);
    const rdtCheck = checks.find((check) => check.id === 'amazon.rdt');
    expect(rdtCheck?.detail).not.toContain('rdt-token-secret');
    expect(rdtCheck?.detail).toContain('/orders/v0/orders/123-4567890-1234567');
  });

  it('fails the LWA check with actionable remediation on invalid_grant and skips downstream', async () => {
    const { deps } = makeDeps((options) => {
      if (options.url.includes('/auth/o2/token')) {
        return response(400, { error: 'invalid_grant', error_description: 'invalid refresh token' });
      }
      return response(500, {});
    });
    const checks = await runAmazonDiagnosis(deps, 'acc-1');
    expect(statusById(checks)).toEqual({
      'amazon.config': 'ok',
      'amazon.lwa': 'fail',
      'amazon.participations': 'skipped',
      'amazon.rdt': 'skipped',
    });
    expect(checks[1]?.detail).toContain('invalid_grant');
    expect(checks[1]?.remediation).toContain('Seller Central');
  });

  it('fails config when the account has no refresh token and does not call the network', async () => {
    const { deps, calls } = makeDeps(happyHandler, {
      account: { ...account, refreshTokenEnc: null },
    });
    const checks = await runAmazonDiagnosis(deps, 'acc-1');
    expect(statusById(checks)['amazon.config']).toBe('fail');
    expect(statusById(checks)['amazon.lwa']).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('warns when the LWA call fails at transport level and maps RDT 403 to a PII-approval remediation', async () => {
    process.env[AMAZON_DIAGNOSE_ORDER_ID_ENV] = '123-4567890-1234567';
    const transportDeps = makeDeps(() => {
      throw new Error('socket hang up');
    });
    const transportChecks = await runAmazonDiagnosis(transportDeps.deps, 'acc-1');
    expect(statusById(transportChecks)['amazon.lwa']).toBe('warn');
    expect(transportChecks[1]?.detail).toContain('socket hang up');

    const rdt403Deps = makeDeps((options) => {
      if (options.url.includes('/restrictedDataToken')) {
        return response(403, { errors: [{ code: 'Unauthorized', message: 'not authorized' }] });
      }
      return happyHandler(options);
    });
    const rdtChecks = await runAmazonDiagnosis(rdt403Deps.deps, 'acc-1');
    const rdtCheck = rdtChecks.find((check) => check.id === 'amazon.rdt');
    expect(rdtCheck?.status).toBe('fail');
    expect(rdtCheck?.remediation?.toLowerCase()).toContain('dados restritos');
  });

  it('warns when Sellers returns no marketplace participations', async () => {
    const { deps } = makeDeps((options) => {
      if (options.url.includes('/sellers/v1/marketplaceParticipations')) {
        return response(200, { payload: [] });
      }
      return happyHandler(options);
    });
    const checks = await runAmazonDiagnosis(deps, 'acc-1');
    expect(statusById(checks)['amazon.participations']).toBe('warn');
  });
});
