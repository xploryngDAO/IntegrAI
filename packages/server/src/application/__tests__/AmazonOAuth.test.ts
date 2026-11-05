import { describe, expect, it } from 'vitest';

import type { ChannelRuntimeConfig } from '@sac/shared';
import { AmazonOAuthNotConfiguredError, MarketplaceApiError, ValidationError } from '@sac/shared';

import { AccountService } from '../AccountService';
import {
  FakeCipher,
  FrozenClock,
  InMemoryAccountRepository,
  InMemoryCache,
  RecordingHttpClient,
  TEST_AMAZON_APP_ID,
  TEST_AMAZON_REDIRECT_URI,
  fakeAdapterRegistry,
  silentLogger,
  testChannelConfig,
} from './accountFakes';

const NOW = new Date('2026-11-05T12:00:00.000Z');

interface HarnessOptions {
  handler?: ConstructorParameters<typeof RecordingHttpClient>[0];
  amazon?: Partial<ChannelRuntimeConfig['amazon']>;
}

function createHarness(options: HarnessOptions = {}) {
  const clock = new FrozenClock(NOW);
  const cache = new InMemoryCache();
  const cipher = new FakeCipher();
  const accounts = new InMemoryAccountRepository(clock);
  const http = new RecordingHttpClient(
    options.handler ?? (() => ({ status: 200, body: {} })),
  );

  const service = new AccountService({
    logger: silentLogger,
    clock,
    cache,
    cipher,
    http,
    config: testChannelConfig({ amazon: options.amazon }),
    adapters: fakeAdapterRegistry,
    repos: { accounts },
  });

  return { clock, cache, cipher, accounts, http, service };
}

function decodeState(state: string): Record<string, unknown> {
  const [encoded] = state.split('.');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function formBody(request: { body?: unknown }): URLSearchParams {
  expect(typeof request.body).toBe('string');
  return new URLSearchParams(request.body as string);
}

describe('AccountService Amazon OAuth - start', () => {
  it('builds the Seller Central consent URL with a signed state carrying tenantId + displayName', async () => {
    const { service } = createHarness();

    const result = await service.startOAuth('AMAZON', '  Amazon BR - Matriz  ', 'tenant-1');

    const url = new URL(result.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://sellercentral.amazon.com/apps/authorize/consent',
    );
    expect(url.searchParams.get('application_id')).toBe(TEST_AMAZON_APP_ID);
    expect(url.searchParams.get('version')).toBe('beta');
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(result.marketplace).toBe('AMAZON');

    const payload = decodeState(result.state);
    expect(payload.marketplace).toBe('AMAZON');
    expect(payload.tenantId).toBe('tenant-1');
    expect(payload.displayName).toBe('Amazon BR - Matriz');
    expect(typeof payload.nonce).toBe('string');
    expect(payload.issuedAt).toBe(NOW.getTime());
  });

  it('honours a regional consent URL from AMAZON_OAUTH_AUTHORIZE_URL', async () => {
    const { service } = createHarness({
      amazon: { oauthAuthorizeUrl: 'https://sellercentral.amazon.co.uk/apps/authorize/consent' },
    });

    const result = await service.startOAuth('AMAZON', 'Amazon UK', 'tenant-1');

    expect(result.authorizeUrl.startsWith('https://sellercentral.amazon.co.uk/apps/authorize/consent?')).toBe(
      true,
    );
  });

  it('rejects an empty displayName before touching the cache', async () => {
    const { service, cache } = createHarness();

    await expect(service.startOAuth('AMAZON', '   ', 'tenant-1')).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(cache.entries.size).toBe(0);
  });

  it('answers AMAZON_OAUTH_NOT_CONFIGURED (409 + remediation) when AMAZON_APP_ID is missing', async () => {
    const { service, cache } = createHarness({ amazon: { appId: undefined } });

    const failure = await service.startOAuth('AMAZON', 'Amazon BR', 'tenant-1').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AmazonOAuthNotConfiguredError);
    expect(failure).toMatchObject({
      code: 'AMAZON_OAUTH_NOT_CONFIGURED',
      httpStatus: 409,
      details: {
        provider: 'AMAZON',
        missing: ['AMAZON_APP_ID'],
      },
    });
    expect((failure as AmazonOAuthNotConfiguredError).details?.remediation).toContain(
      'AMAZON_APP_ID',
    );
    // No half-written state when the app is not configured.
    expect(cache.entries.size).toBe(0);
  });
});

describe('AccountService Amazon OAuth - callback', () => {
  it('exchanges spapi_oauth_code at the LWA endpoint and upserts the AMAZON account for the state tenant', async () => {
    const harness = createHarness({
      handler: () => ({
        status: 200,
        body: {
          access_token: 'Atza|access',
          refresh_token: 'Atzr|refresh',
          expires_in: 3_600,
          token_type: 'bearer',
        },
      }),
    });

    const start = await harness.service.startOAuth('AMAZON', 'Amazon BR', 'tenant-1');
    const result = await harness.service.completeOAuth('AMAZON', {
      code: 'spapi-code-123',
      state: start.state,
      sellingPartnerId: 'A2Q3Y263D00KWC',
      rawQuery: {
        spapi_oauth_code: 'spapi-code-123',
        selling_partner_id: 'A2Q3Y263D00KWC',
        state: start.state,
      },
    });

    // --- LWA token exchange ------------------------------------------------
    expect(harness.http.requests).toHaveLength(1);
    const exchange = harness.http.requests[0];
    expect(exchange?.method).toBe('POST');
    expect(exchange?.url).toBe('https://api.amazon.com/auth/o2/token');
    expect(exchange?.headers?.['content-type']).toBe('application/x-www-form-urlencoded');

    const form = formBody(exchange ?? {});
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('spapi-code-123');
    expect(form.get('client_id')).toBe('amzn1.application-oa2-client.test');
    expect(form.get('client_secret')).toBe('amzn1.oa2-cs.v1.test');
    expect(form.get('redirect_uri')).toBe(TEST_AMAZON_REDIRECT_URI);

    // --- Account persisted with tenant + encrypted tokens -------------------
    expect(result).toEqual({ accountId: 'account-1', displayName: 'Amazon BR' });
    expect(harness.accounts.rows).toHaveLength(1);
    const row = harness.accounts.rows[0]!;
    expect(row).toMatchObject({
      id: 'account-1',
      tenantId: 'tenant-1',
      marketplace: 'AMAZON',
      displayName: 'Amazon BR',
      externalSellerId: 'A2Q3Y263D00KWC',
      marketplaceSiteId: 'A2Q3Y263D00KWC',
      status: 'ACTIVE',
      accessTokenEnc: harness.cipher.encrypt('Atza|access'),
      refreshTokenEnc: harness.cipher.encrypt('Atzr|refresh'),
    });
    expect(row.channelConfig).toMatchObject({
      selling_partner_id: 'A2Q3Y263D00KWC',
      seller_id: 'A2Q3Y263D00KWC',
      region: 'na',
      seller_central_region: 'na',
      auth_flow: 'oauth2',
    });
    expect(row.tokenExpiresAt?.toISOString()).toBe('2026-11-05T13:00:00.000Z');

    // The state is single use.
    await expect(
      harness.service.completeOAuth('AMAZON', {
        code: 'spapi-code-123',
        state: start.state,
        sellingPartnerId: 'A2Q3Y263D00KWC',
        rawQuery: {},
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('falls back to the raw query for selling_partner_id', async () => {
    const harness = createHarness({
      handler: () => ({ status: 200, body: { refresh_token: 'Atzr|refresh', expires_in: 3_600 } }),
    });
    const start = await harness.service.startOAuth('AMAZON', 'Amazon BR', 'tenant-1');

    await harness.service.completeOAuth('AMAZON', {
      code: 'spapi-code',
      state: start.state,
      rawQuery: { selling_partner_id: 'A1SELLER' },
    });

    expect(harness.accounts.rows[0]?.externalSellerId).toBe('A1SELLER');
  });

  it('rejects a callback without selling_partner_id', async () => {
    const harness = createHarness();
    const start = await harness.service.startOAuth('AMAZON', 'Amazon BR', 'tenant-1');

    await expect(
      harness.service.completeOAuth('AMAZON', {
        code: 'spapi-code',
        state: start.state,
        rawQuery: {},
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('selling_partner_id') });
  });

  it('surfaces an LWA exchange error as MARKETPLACE_API_ERROR and creates no account', async () => {
    const harness = createHarness({
      handler: () => ({
        status: 400,
        body: { error: 'invalid_grant', error_description: 'authorization code expired' },
      }),
    });
    const start = await harness.service.startOAuth('AMAZON', 'Amazon BR', 'tenant-1');

    const failure = await harness.service
      .completeOAuth('AMAZON', {
        code: 'expired-code',
        state: start.state,
        sellingPartnerId: 'A2Q3Y263D00KWC',
        rawQuery: {},
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketplaceApiError);
    expect(failure).toMatchObject({ code: 'MARKETPLACE_API_ERROR', httpStatus: 502 });
    expect((failure as Error).message).toContain('authorization code expired');
    expect(harness.accounts.rows).toHaveLength(0);
  });

  it('refuses to steal an account that already belongs to another tenant', async () => {
    const harness = createHarness({
      handler: () => ({ status: 200, body: { refresh_token: 'Atzr|refresh', expires_in: 3_600 } }),
    });
    harness.accounts.seed({
      tenantId: 'tenant-b',
      marketplace: 'AMAZON',
      externalSellerId: 'A2Q3Y263D00KWC',
      marketplaceSiteId: 'A2Q3Y263D00KWC',
      refreshTokenEnc: harness.cipher.encrypt('old-refresh'),
    });

    const start = await harness.service.startOAuth('AMAZON', 'Tenant A store', 'tenant-a');

    await expect(
      harness.service.completeOAuth('AMAZON', {
        code: 'spapi-code',
        state: start.state,
        sellingPartnerId: 'A2Q3Y263D00KWC',
        rawQuery: {},
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'Account already belongs to another tenant' });

    expect(harness.accounts.rows[0]).toMatchObject({
      tenantId: 'tenant-b',
      refreshTokenEnc: harness.cipher.encrypt('old-refresh'),
    });
  });

  it('attaches the tenant to a legacy tenantless account on reconnect', async () => {
    const harness = createHarness({
      handler: () => ({ status: 200, body: { refresh_token: 'Atzr|new', expires_in: 3_600 } }),
    });
    harness.accounts.seed({
      tenantId: null,
      marketplace: 'AMAZON',
      externalSellerId: 'A2Q3Y263D00KWC',
      marketplaceSiteId: 'A2Q3Y263D00KWC',
    });

    const start = await harness.service.startOAuth('AMAZON', 'Amazon BR', 'tenant-1');
    await harness.service.completeOAuth('AMAZON', {
      code: 'spapi-code',
      state: start.state,
      sellingPartnerId: 'A2Q3Y263D00KWC',
      rawQuery: {},
    });

    expect(harness.accounts.rows).toHaveLength(1);
    expect(harness.accounts.rows[0]).toMatchObject({
      tenantId: 'tenant-1',
      refreshTokenEnc: harness.cipher.encrypt('Atzr|new'),
    });
  });
});

describe('AccountService tenant scoping', () => {
  it('lists only the caller tenant accounts', async () => {
    const harness = createHarness();
    harness.accounts.seed({
      tenantId: 'tenant-a',
      marketplace: 'AMAZON',
      externalSellerId: 'seller-a',
    });
    harness.accounts.seed({
      tenantId: 'tenant-b',
      marketplace: 'AMAZON',
      externalSellerId: 'seller-b',
    });

    const listed = await harness.service.listAccounts('tenant-a');

    expect(listed.map((account) => account.externalSellerId)).toEqual(['seller-a']);
    expect(await harness.service.listAccounts(null)).toEqual([]);
    expect(await harness.service.listAccounts()).toHaveLength(2);
  });
});

describe('AccountService connector descriptor (UI capability probe)', () => {
  it('advertises the Amazon consent template only when AMAZON_APP_ID is configured', () => {
    const configured = createHarness().service.describeConnectors();
    const amazon = configured.find((entry) => entry.marketplace === 'AMAZON');

    expect(amazon?.authMode).toBe('HYBRID');
    expect(amazon?.authorizeUrlTemplate).toBe(
      `https://sellercentral.amazon.com/apps/authorize/consent?application_id=${TEST_AMAZON_APP_ID}&state=<state>&version=beta`,
    );

    const unconfigured = createHarness({ amazon: { appId: undefined } }).service.describeConnectors();
    expect(
      unconfigured.find((entry) => entry.marketplace === 'AMAZON')?.authorizeUrlTemplate,
    ).toBeNull();
  });
});
