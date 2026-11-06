import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type {
  HttpRequestOptions,
  HttpResponse,
  IClock,
  IHttpClient,
  ILogger,
  ITenantSsoConnectionRepository,
  SsoConnectionTestResult,
  SsoDomainMatch,
  TenantSsoConnectionRecord,
  UpsertTenantSsoConnectionInput,
} from '@sac/shared';

import type { HttpRouteContext } from '../types';
import { tenantRoutes } from '../routes/tenants.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { TenantSsoService } from '../../application/TenantSsoService';
import { OidcClient } from '../../application/sso/OidcClient';
import { SSO_TEST_TIMEOUT_MS } from '../../application/sso/connectionTest';
import { CountingCache } from '../../application/__tests__/rateLimitFakes';

/**
 * ============================================================================
 * ADMIN "test connection" - HTTP end to end (no network, no database)
 * ============================================================================
 *
 * Unlike `sso-routes.test.ts` (stub service), this suite wires the REAL
 * `TenantSsoService` + `OidcClient` and stubs only the transport (`IHttpClient`
 * serves a real discovery document and a real RSA JWKS). The whole path is
 * therefore covered: RBAC, throttle, 404, per-check report and envelope.
 */

const NOW = new Date('2026-11-06T12:00:00.000Z');
const ISSUER = 'https://idp.example.com';
const TENANT_ID = 'tenant-1';
const KID = 'signing-key-1';
const CLIENT_SECRET = 'super-secret-value';

const noopLogger: ILogger = {
  child(): ILogger {
    return this;
  },
  trace(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

/* ======================================================================== */
/* Provider stub (real RSA key so the JWKS predicate runs for real)          */
/* ======================================================================== */

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
const RSA_JWK = {
  ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
  kid: KID,
  use: 'sig',
  alg: 'RS256',
};

class StubOidcHttp implements IHttpClient {
  readonly calls: HttpRequestOptions[] = [];
  discoveryStatus = 200;
  discoveryIssuer = ISSUER;
  jwks: Record<string, unknown> = { keys: [RSA_JWK] };
  jwksStatus = 200;
  jwksCalls = 0;

  async request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    this.calls.push(options);
    const url = String(options.url);

    const respond = (status: number, body: unknown): HttpResponse<T> => ({
      status,
      ok: status >= 200 && status < 300,
      headers: { 'content-type': 'application/json' },
      body: body as T,
      durationMs: 1,
    });

    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      if (this.discoveryStatus !== 200) {
        return respond(this.discoveryStatus, { error: 'server_error' });
      }
      return respond(200, {
        issuer: this.discoveryIssuer,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    if (url === `${ISSUER}/jwks`) {
      this.jwksCalls += 1;
      return respond(this.jwksStatus, this.jwks);
    }
    return respond(404, { error: 'not_found' });
  }

  async requestBinary(): Promise<HttpResponse<Buffer>> {
    return { status: 500, ok: false, headers: {}, body: Buffer.alloc(0), durationMs: 1 };
  }
}

/* ======================================================================== */
/* In-memory connection repository                                          */
/* ======================================================================== */

class FakeSsoConnectionRepository implements ITenantSsoConnectionRepository {
  readonly rows: TenantSsoConnectionRecord[] = [];

  async findByTenantId(tenantId: string): Promise<TenantSsoConnectionRecord | null> {
    return this.rows.find((row) => row.tenantId === tenantId) ?? null;
  }

  async findById(id: string): Promise<TenantSsoConnectionRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async upsert(input: UpsertTenantSsoConnectionInput): Promise<TenantSsoConnectionRecord> {
    const existing = await this.findByTenantId(input.tenantId);
    if (existing !== null) {
      Object.assign(existing, input, { updatedAt: NOW });
      return existing;
    }
    const row: TenantSsoConnectionRecord = {
      id: `sso-${this.rows.length + 1}`,
      ...input,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.rows.push(row);
    return row;
  }

  async deleteByTenantId(tenantId: string): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.tenantId === tenantId);
    if (index < 0) return false;
    this.rows.splice(index, 1);
    return true;
  }

  async findEnabledByDomain(): Promise<SsoDomainMatch | null> {
    return null;
  }

  seed(overrides: Partial<TenantSsoConnectionRecord> = {}): TenantSsoConnectionRecord {
    const row: TenantSsoConnectionRecord = {
      id: `sso-${this.rows.length + 1}`,
      tenantId: TENANT_ID,
      provider: 'MICROSOFT',
      issuerUrl: ISSUER,
      clientId: 'client-id',
      clientSecretEnc: `v1:test:${CLIENT_SECRET}`,
      redirectUri: 'https://api.example.com/api/v1/auth/sso/callback',
      scopes: 'openid profile email',
      allowedDomains: ['acme.test'],
      groupRoleMap: {},
      autoProvision: true,
      defaultRole: 'AGENT',
      enforceSso: false,
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }
}

/* ======================================================================== */
/* Harness                                                                  */
/* ======================================================================== */

interface Harness {
  app: FastifyInstance;
  http: StubOidcHttp;
  repo: FakeSsoConnectionRepository;
}

async function buildHarness(): Promise<Harness> {
  const clock: IClock = { now: () => NOW };
  const cache = new CountingCache(clock);
  const http = new StubOidcHttp();
  const repo = new FakeSsoConnectionRepository();

  const tenantSso = new TenantSsoService({
    logger: noopLogger,
    clock,
    cache,
    cipher: {
      encrypt: (plaintext: string) => `v1:test:${Buffer.from(plaintext).toString('base64')}`,
      decrypt: () => CLIENT_SECRET,
      hash: (value: string) => `hash:${value}`,
      keyId: 'test',
    },
    repo,
    appBaseUrl: 'https://api.example.com',
    nodeEnv: 'test',
    oidc: new OidcClient({ logger: noopLogger, clock, cache, http, nodeEnv: 'test' }),
  });

  const ctx = {
    services: { tenantSso },
    hub: {},
    options: {},
  } as unknown as HttpRouteContext;

  const app = Fastify();
  registerErrorHandler(app, { logger: noopLogger, exposeDetails: true });
  // Stand-in for the global JWT guard: headers choose the principal.
  app.addHook('preHandler', async (request) => {
    const tenantId = request.headers['x-test-tenant'];
    if (typeof tenantId === 'string' && tenantId.length > 0) {
      request.agent = {
        id: 'agent-1',
        email: 'admin@acme.test',
        name: 'Ana',
        role: String(request.headers['x-test-role'] ?? 'ADMIN'),
        tenantId,
        isPlatformAdmin: false,
      };
    }
  });
  await app.register(tenantRoutes, { prefix: '/api/v1/tenants', ...ctx });
  await app.ready();

  return { app, http, repo };
}

function testRequest(options: { role?: string; tenantId?: string } = {}) {
  return {
    method: 'POST' as const,
    url: '/api/v1/tenants/me/sso/test',
    headers: {
      'x-test-tenant': options.tenantId ?? TENANT_ID,
      'x-test-role': options.role ?? 'ADMIN',
    },
  };
}

function reportOf(response: { json: () => unknown }): SsoConnectionTestResult {
  return (response.json() as { data: SsoConnectionTestResult }).data;
}

/* ======================================================================== */
/* Tests                                                                    */
/* ======================================================================== */

describe('POST /tenants/me/sso/test (ADMIN connection test)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('answers 200 ok=true with every check when the provider is healthy', async () => {
    harness.repo.seed();

    const response = await harness.app.inject(testRequest());
    const report = reportOf(response);

    expect(response.statusCode).toBe(200);
    expect(report.ok).toBe(true);
    expect(report.issuer).toBe(ISSUER);
    expect(report.authorizationEndpoint).toBe(`${ISSUER}/authorize`);
    expect(report.tokenEndpoint).toBe(`${ISSUER}/token`);
    expect(report.jwksKeys).toEqual([KID]);
    expect(report.enabled).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual([
      'discovery',
      'issuer',
      'authorization_endpoint',
      'token_endpoint',
      'jwks_uri',
      'response_types',
      'code_challenge_methods',
      'id_token_signing_alg',
      'jwks',
      'allowed_domains',
    ]);
    expect(report.checks.every((check) => check.ok)).toBe(true);

    // The probe is READ-ONLY: discovery + JWKS, 5 s each, never the token endpoint.
    expect(harness.http.calls).toHaveLength(2);
    expect(harness.http.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(harness.http.calls.every((call) => call.timeoutMs === SSO_TEST_TIMEOUT_MS)).toBe(true);
    expect(SSO_TEST_TIMEOUT_MS).toBe(5_000);

    // Defensive: the stored secret never crosses the API boundary.
    expect(response.body).not.toContain(CLIENT_SECRET);
    expect(response.body).not.toContain('clientSecret');
  });

  it('reports ok=false with the discovery check false when discovery answers 500', async () => {
    harness.repo.seed();
    harness.http.discoveryStatus = 500;

    const response = await harness.app.inject(testRequest());
    const report = reportOf(response);

    expect(response.statusCode).toBe(200);
    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ name: 'discovery', ok: false });
    expect(report.checks[0]?.detail).toContain('HTTP 500');
    // Without the document the JWKS is not probed (nothing to blame).
    expect(harness.http.jwksCalls).toBe(0);
  });

  it('reports a divergent issuer without failing the whole provider read', async () => {
    harness.repo.seed();
    harness.http.discoveryIssuer = 'https://other-idp.example.com';

    const response = await harness.app.inject(testRequest());
    const report = reportOf(response);

    expect(response.statusCode).toBe(200);
    expect(report.ok).toBe(false);
    expect(report.issuer).toBe('https://other-idp.example.com');
    const issuerCheck = report.checks.find((check) => check.name === 'issuer');
    expect(issuerCheck).toMatchObject({ ok: false });
    expect(issuerCheck?.detail).toContain(ISSUER);
    expect(issuerCheck?.detail).toContain('https://other-idp.example.com');
    // The remaining checks still ran and the JWKS is valid.
    expect(report.checks.find((check) => check.name === 'jwks')).toMatchObject({ ok: true });
  });

  it('reports ok=false when the JWKS has no RSA signing key', async () => {
    harness.repo.seed();
    harness.http.jwks = { keys: [] };

    const response = await harness.app.inject(testRequest());
    const report = reportOf(response);

    expect(response.statusCode).toBe(200);
    expect(report.ok).toBe(false);
    expect(report.jwksKeys).toEqual([]);
    expect(report.checks.find((check) => check.name === 'jwks')).toMatchObject({ ok: false });
  });

  it('rejects an RSA key without kid (the login flow selects by kid)', async () => {
    harness.repo.seed();
    const { kid: _kid, ...keyWithoutKid } = RSA_JWK;
    harness.http.jwks = { keys: [keyWithoutKid] };

    const response = await harness.app.inject(testRequest());
    const report = reportOf(response);

    expect(response.statusCode).toBe(200);
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'jwks')).toMatchObject({ ok: false });
  });

  it('reports a failed check when the allowlist is empty', async () => {
    harness.repo.seed({ allowedDomains: [] });

    const response = await harness.app.inject(testRequest());
    const report = reportOf(response);

    expect(response.statusCode).toBe(200);
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'allowed_domains')).toMatchObject({
      ok: false,
    });
  });

  it('tests a DISABLED connection and reports enabled=false (ok stays true)', async () => {
    harness.repo.seed({ enabled: false });

    const response = await harness.app.inject(testRequest());
    const report = reportOf(response);

    expect(response.statusCode).toBe(200);
    expect(report.ok).toBe(true);
    expect(report.enabled).toBe(false);
  });

  it('answers 404 SSO_NOT_CONFIGURED when the workspace has no connection', async () => {
    const response = await harness.app.inject(testRequest());

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'SSO_NOT_CONFIGURED' } });
    expect(harness.http.calls).toHaveLength(0);
  });

  it('answers 403 for AGENT and SUPERVISOR without touching the provider', async () => {
    harness.repo.seed();

    for (const role of ['AGENT', 'SUPERVISOR']) {
      const response = await harness.app.inject(testRequest({ role }));

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_ERROR' } });
    }
    expect(harness.http.calls).toHaveLength(0);
  });

  it('answers 429 RATE_LIMITED after 10 probes (per tenant + IP)', async () => {
    harness.repo.seed();

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await harness.app.inject(testRequest());
      expect(response.statusCode).toBe(200);
    }

    const blocked = await harness.app.inject(testRequest());
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });
});
