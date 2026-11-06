/**
 * Shared fake `AdapterDependencies` for the Mercado Livre unit tests.
 *
 * The marketplace HTTP boundary (`deps.http`) is the only stubbed transport: no
 * test performs a network call, and every collaborator is in-memory.
 */
import type {
  AdapterDependencies,
  HttpResponse,
  MarketplaceAccountRecord,
  SupportTicketRecord,
} from '@sac/shared';

export interface FakeHttpRequest {
  method: string;
  url: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  formData?: FormData;
}

export type FakeHttpHandler = (
  request: FakeHttpRequest,
) => Promise<HttpResponse<unknown>> | HttpResponse<unknown>;

export interface FakeDepsOptions {
  accountOverrides?: Partial<MarketplaceAccountRecord>;
  accounts?: MarketplaceAccountRecord[];
  httpHandler?: FakeHttpHandler;
  now?: Date;
}

export interface FakeDeps {
  deps: AdapterDependencies;
  account: MarketplaceAccountRecord;
  cacheStore: Map<string, unknown>;
  queueCalls: Array<{ queue: string; payload: Record<string, unknown>; options?: unknown }>;
  httpCalls: FakeHttpRequest[];
}

const DEFAULT_NOW = new Date();

export function jsonResponse(body: unknown, status = 200): HttpResponse<unknown> {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {},
    body,
    durationMs: 1,
  };
}

export function createFakeDeps(options: FakeDepsOptions = {}): FakeDeps {
  const now = options.now ?? DEFAULT_NOW;
  const account: MarketplaceAccountRecord = {
    id: 'acc-1',
    marketplace: 'MERCADO_LIVRE',
    displayName: 'Loja Teste',
    externalSellerId: '42',
    marketplaceSiteId: 'MLB',
    accessTokenEnc: null,
    refreshTokenEnc: 'enc:RT1',
    tokenExpiresAt: null,
    authExpiresAt: null,
    channelConfig: {},
    status: 'ACTIVE',
    lastTokenRefreshAt: null,
    lastErrorAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...options.accountOverrides,
  };
  const accounts = options.accounts ?? [account];

  const cacheStore = new Map<string, unknown>();
  const queueCalls: FakeDeps['queueCalls'] = [];
  const httpCalls: FakeHttpRequest[] = [];
  let tokenCalls = 0;

  const defaultHandler: FakeHttpHandler = (request) => {
    if (request.url.endsWith('/oauth/token')) {
      tokenCalls += 1;
      return jsonResponse({
        access_token: `AT-${tokenCalls}`,
        refresh_token: 'RT2',
        expires_in: 21_600,
        token_type: 'Bearer',
      });
    }
    if (request.url.endsWith('/users/me')) {
      return jsonResponse({ id: 42, nickname: 'LOJA TESTE', site_id: 'MLB' });
    }
    if (request.url.endsWith('/users/42')) {
      return jsonResponse({
        id: 42,
        nickname: 'LOJA TESTE',
        site_id: 'MLB',
        status: { site_status: 'active' },
      });
    }
    if (request.url.includes('/items/search')) {
      return jsonResponse({ paging: { total: 0 }, results: [] });
    }
    if (request.url.endsWith('/missed_feeds')) {
      return jsonResponse([]);
    }
    throw new Error(`fake http: unexpected ${request.method} ${request.url}`);
  };

  const handler = options.httpHandler ?? defaultHandler;

  const http = {
    request: async (request: {
      method: string;
      url: string;
      query?: FakeHttpRequest['query'];
      body?: unknown;
      formData?: FormData;
    }): Promise<HttpResponse<unknown>> => {
      const call: FakeHttpRequest = {
        method: request.method,
        url: request.url,
        query: request.query,
        body: request.body,
        formData: request.formData,
      };
      httpCalls.push(call);
      return handler(call);
    },
    requestBinary: async () => {
      throw new Error('requestBinary not stubbed');
    },
  };

  const cache = {
    get: async <T>(key: string): Promise<T | null> =>
      cacheStore.has(key) ? (cacheStore.get(key) as T) : null,
    set: async <T>(key: string, value: T): Promise<void> => {
      cacheStore.set(key, value);
    },
    setNx: async (): Promise<boolean> => true,
    del: async (key: string): Promise<void> => {
      cacheStore.delete(key);
    },
    exists: async (key: string): Promise<boolean> => cacheStore.has(key),
    ttl: async (): Promise<number> => 100,
    incr: async (): Promise<number> => 1,
    hset: async (): Promise<void> => undefined,
    hgetall: async <T extends Record<string, string>>(): Promise<T | null> => null,
    sadd: async (): Promise<void> => undefined,
    srem: async (): Promise<void> => undefined,
    smembers: async (): Promise<string[]> => [],
  };

  const tickets: SupportTicketRecord[] = [];
  const repos = {
    accounts: {
      findById: async (id: string): Promise<MarketplaceAccountRecord | null> =>
        accounts.find((candidate) => candidate.id === id) ?? null,
      findByExternalSeller: async (
        _marketplace: string,
        externalSellerId: string,
      ): Promise<MarketplaceAccountRecord | null> =>
        accounts.find((candidate) => candidate.externalSellerId === externalSellerId) ?? null,
      findFirstByMarketplace: async (): Promise<MarketplaceAccountRecord | null> =>
        accounts[0] ?? null,
      list: async (): Promise<MarketplaceAccountRecord[]> => accounts,
      updateTokens: async (
        id: string,
        patch: Partial<MarketplaceAccountRecord>,
      ): Promise<MarketplaceAccountRecord> => {
        const target = accounts.find((candidate) => candidate.id === id) ?? account;
        Object.assign(target, patch);
        return target;
      },
      setStatus: async (
        id: string,
        status: MarketplaceAccountRecord['status'],
        error?: string | null,
      ): Promise<MarketplaceAccountRecord> => {
        const target = accounts.find((candidate) => candidate.id === id) ?? account;
        target.status = status;
        target.lastError = error ?? null;
        return target;
      },
      updateChannelConfig: async (): Promise<MarketplaceAccountRecord> => account,
      create: async (): Promise<MarketplaceAccountRecord> => account,
      delete: async (): Promise<void> => undefined,
    },
    tickets: {
      findActiveByExternalOrderId: async (): Promise<SupportTicketRecord | null> =>
        tickets[0] ?? null,
      findByExternalReference: async (): Promise<SupportTicketRecord | null> => null,
      findById: async (): Promise<SupportTicketRecord | null> => tickets[0] ?? null,
    },
    messages: {
      findByExternalMessageId: async (): Promise<null> => null,
      createIdempotent: async () => {
        throw new Error('messages.createIdempotent not stubbed');
      },
    },
    orders: {
      findByPackId: async (): Promise<null> => null,
      findByExternalOrderId: async (): Promise<null> => null,
      upsert: async (input: { externalOrderId: string }) => ({
        id: 'oc-1',
        externalOrderId: input.externalOrderId,
      }),
    },
    attachments: {},
    webhookEvents: {},
    piiVault: {},
    ticketEvents: {},
  };

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
    clock: { now: () => now },
    config: {
      appBaseUrl: 'http://localhost:4000',
      amazon: {},
      meli: {
        clientId: 'app-1234',
        clientSecret: 'secret',
        redirectUri: 'http://localhost:4000/callback',
        apiBase: 'https://api.mercadolibre.com',
        refreshIntervalSeconds: 20_700,
        webhookTopics: ['questions', 'messages', 'post_purchase'],
        webhookSecret: 'test-webhook-secret',
      },
      shopee: {},
      smtp: {},
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
    },
    repos,
    cache,
    lock: {
      withLock: async <T>(_resources: string[], _ttl: number, fn: () => Promise<T>) => fn(),
      tryWithLock: async <T>(_resources: string[], _ttl: number, fn: () => Promise<T>) => ({
        acquired: true,
        value: await fn(),
      }),
    },
    rateLimiter: {
      acquire: async (): Promise<void> => undefined,
      consume: async (): Promise<boolean> => true,
      reset: async (): Promise<void> => undefined,
    },
    storage: {
      getObject: async (): Promise<Buffer> => Buffer.from('evidence-bytes'),
      buildUri: (key: string) => `s3://bucket/${key}`,
      putObject: async () => {
        throw new Error('storage.putObject not stubbed');
      },
      putToPresignedUrl: async (): Promise<void> => undefined,
      presignGet: async (): Promise<string> => '',
    },
    cipher: {
      encrypt: (value: string) => `enc:${value}`,
      decrypt: (value: string) => value.replace(/^enc:/, ''),
      hash: (value: string) => `hash:${value}`,
      keyId: 'test',
    },
    realtime: {
      channelHealth: () => undefined,
      ticketUpdated: () => undefined,
      messageCreated: () => undefined,
      queueChanged: () => undefined,
      agentPresence: () => undefined,
    },
    http,
    queue: {
      publish: async (
        queue: string,
        payload: Record<string, unknown>,
        queueOptions?: unknown,
      ): Promise<string> => {
        queueCalls.push({ queue, payload, options: queueOptions });
        return `job-${queueCalls.length}`;
      },
      publishToDlq: async (): Promise<void> => undefined,
    },
  } as unknown as AdapterDependencies;

  return { deps, account, cacheStore, queueCalls, httpCalls };
}
