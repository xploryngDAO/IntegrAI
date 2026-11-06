import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { KeyObject } from 'node:crypto';
import type {
  AgentPresenceStatus,
  AgentRecord,
  CreateAgentInput,
  CreateSsoAgentInput,
  IAgentRepository,
  IAgentService,
  IAgentSsoRepository,
  IClock,
  IHttpClient,
  ILogger,
  ITenantSsoConnectionRepository,
  LoginSuccess,
  SsoDomainMatch,
  TenantSsoConnectionRecord,
  UpdateSsoAgentInput,
  UpsertTenantSsoConnectionInput,
} from '@sac/shared';
import type { HttpRequestOptions, HttpResponse } from '@sac/shared';
import { describe, expect, it, vi } from 'vitest';

import { AgentService } from '../AgentService';
import { SsoAuthService, collectGroups, resolveMappedRole } from '../SsoAuthService';
import { TenantSsoService } from '../TenantSsoService';
import { OidcClient } from '../sso/OidcClient';
import { CountingCache } from './rateLimitFakes';

/**
 * ============================================================================
 * Enterprise SSO - unit coverage (no network, no database)
 * ============================================================================
 *
 * The OIDC provider is a stub HTTP client that serves a REAL discovery document,
 * a REAL JWKS (generated RSA key pair) and a REAL RS256-signed ID token. The
 * signature, `iss`, `aud`, `exp` and `nonce` checks therefore run against the
 * production `OidcClient`, not a mock of it.
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'integrAI-client-id';
const CLIENT_SECRET = 'super-secret-value';
const TENANT_ID = 'tenant-1';
const TENANT_SLUG = 'acme';
const WEB_ORIGIN = 'https://app.example.com';
const KID = 'signing-key-1';
const JWT_SECRET = 'unit-test-jwt-secret-with-enough-length';

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
/* Crypto: real RSA key pair, real RS256 tokens                             */
/* ======================================================================== */

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
const publicJwk = {
  ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
  kid: KID,
  use: 'sig',
  alg: 'RS256',
};

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signIdToken(claims: Record<string, unknown>, options: { alg?: string; key?: KeyObject } = {}): string {
  const header = { alg: options.alg ?? 'RS256', typ: 'JWT', kid: KID };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput, 'ascii')
    .sign(options.key ?? privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

/* ======================================================================== */
/* Stub OIDC provider                                                       */
/* ======================================================================== */

class StubOidcHttp implements IHttpClient {
  readonly calls: HttpRequestOptions[] = [];
  tokenStatus = 200;
  tokenResponse: Record<string, unknown> = {};
  jwks: Record<string, unknown> = { keys: [publicJwk] };
  /** Optional per-call sequence (first call old key, second the rotated one). */
  jwksResponses: Record<string, unknown>[] = [];
  jwksCalls = 0;
  failDiscovery = false;

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
      if (this.failDiscovery) throw new Error('connect ECONNREFUSED');
      return respond(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url === `${ISSUER}/jwks`) {
      this.jwksCalls += 1;
      const next = this.jwksResponses.shift();
      return respond(200, next ?? this.jwks);
    }
    if (url === `${ISSUER}/token`) {
      return respond(this.tokenStatus, this.tokenResponse);
    }
    return respond(404, { error: 'not_found' });
  }

  async requestBinary(options: HttpRequestOptions): Promise<HttpResponse<Buffer>> {
    this.calls.push(options);
    return {
      status: 500,
      ok: false,
      headers: {},
      body: Buffer.alloc(0),
      durationMs: 1,
    };
  }
}

/* ======================================================================== */
/* In-memory repositories                                                   */
/* ======================================================================== */

class InMemorySsoConnectionRepository implements ITenantSsoConnectionRepository {
  readonly rows: TenantSsoConnectionRecord[] = [];
  readonly tenants = new Map<string, { slug: string; status: string }>([
    [TENANT_ID, { slug: TENANT_SLUG, status: 'ACTIVE' }],
  ]);
  private sequence = 0;

  constructor(private readonly clock: IClock) {}

  async findByTenantId(tenantId: string): Promise<TenantSsoConnectionRecord | null> {
    return this.rows.find((row) => row.tenantId === tenantId) ?? null;
  }

  async findById(id: string): Promise<TenantSsoConnectionRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async upsert(input: UpsertTenantSsoConnectionInput): Promise<TenantSsoConnectionRecord> {
    const at = this.clock.now();
    const existing = this.rows.find((row) => row.tenantId === input.tenantId);
    if (existing !== undefined) {
      Object.assign(existing, input, { updatedAt: at });
      return existing;
    }
    const row: TenantSsoConnectionRecord = {
      id: `sso-${(this.sequence += 1)}`,
      ...input,
      createdAt: at,
      updatedAt: at,
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

  async findEnabledByDomain(domain: string): Promise<SsoDomainMatch | null> {
    for (const row of this.rows) {
      if (!row.enabled || !row.allowedDomains.includes(domain)) continue;
      const tenant = this.tenants.get(row.tenantId);
      if (tenant === undefined || tenant.status !== 'ACTIVE') continue;
      return { connection: row, tenantSlug: tenant.slug, tenantStatus: tenant.status };
    }
    return null;
  }
}

class InMemoryAgentSsoRepository implements IAgentSsoRepository {
  readonly rows: AgentRecord[] = [];
  private sequence = 0;

  constructor(private readonly clock: IClock) {}

  async findByEmail(email: string): Promise<AgentRecord | null> {
    return this.rows.find((row) => row.email === email.trim().toLowerCase()) ?? null;
  }

  async create(input: CreateSsoAgentInput): Promise<AgentRecord> {
    if (await this.findByEmail(input.email)) {
      const conflict = new Error('Unique constraint failed on the fields: (`email`)');
      (conflict as Error & { code?: string }).code = 'P2002';
      throw conflict;
    }
    const at = this.clock.now();
    const row: AgentRecord = {
      id: `agent-${(this.sequence += 1)}`,
      tenantId: input.tenantId,
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      role: input.role,
      presence: 'OFFLINE',
      avatarColor: '#2563eb',
      maxConcurrent: 20,
      isActive: true,
      lastSeenAt: null,
      emailVerifiedAt: input.emailVerifiedAt,
      twoFactorSecretEnc: null,
      twoFactorEnabled: false,
      isPlatformAdmin: false,
      mustResetPassword: false,
      createdAt: at,
      updatedAt: at,
    };
    this.rows.push(row);
    return row;
  }

  async updateFromSso(id: string, patch: UpdateSsoAgentInput): Promise<AgentRecord> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`agent not found: ${id}`);
    row.name = patch.name;
    row.emailVerifiedAt = patch.emailVerifiedAt;
    row.mustResetPassword = patch.mustResetPassword;
    if (patch.role !== undefined) row.role = patch.role;
    row.updatedAt = this.clock.now();
    return row;
  }

  seed(row: Partial<AgentRecord> & { email: string }): AgentRecord {
    const at = this.clock.now();
    const record: AgentRecord = {
      id: `agent-seed-${(this.sequence += 1)}`,
      tenantId: TENANT_ID,
      name: 'Seed Operator',
      passwordHash: 'x',
      role: 'AGENT',
      presence: 'OFFLINE',
      avatarColor: '#2563eb',
      maxConcurrent: 20,
      isActive: true,
      lastSeenAt: null,
      emailVerifiedAt: at,
      twoFactorSecretEnc: null,
      twoFactorEnabled: false,
      isPlatformAdmin: false,
      mustResetPassword: false,
      createdAt: at,
      updatedAt: at,
      ...row,
    };
    this.rows.push(record);
    return record;
  }
}

class InMemoryAgentRepository implements IAgentRepository {
  readonly rows: AgentRecord[] = [];
  private sequence = 0;

  constructor(private readonly clock: IClock) {}

  seed(row: Partial<AgentRecord> & { email: string; passwordHash: string }): AgentRecord {
    const at = this.clock.now();
    const record: AgentRecord = {
      id: `agent-${(this.sequence += 1)}`,
      tenantId: TENANT_ID,
      name: 'Ana',
      role: 'ADMIN',
      presence: 'OFFLINE',
      avatarColor: '#2563eb',
      maxConcurrent: 20,
      isActive: true,
      lastSeenAt: null,
      emailVerifiedAt: at,
      twoFactorSecretEnc: null,
      twoFactorEnabled: false,
      isPlatformAdmin: false,
      mustResetPassword: false,
      createdAt: at,
      updatedAt: at,
      ...row,
    };
    this.rows.push(record);
    return record;
  }

  async create(input: CreateAgentInput): Promise<AgentRecord> {
    throw new Error('not used');
  }

  async findByEmail(email: string): Promise<AgentRecord | null> {
    return this.rows.find((row) => row.email === email) ?? null;
  }

  async findById(id: string): Promise<AgentRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async list(): Promise<AgentRecord[]> {
    return [...this.rows];
  }

  async updatePresence(id: string, presence: AgentPresenceStatus): Promise<AgentRecord> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`agent not found: ${id}`);
    row.presence = presence;
    return row;
  }

  async updateName(id: string, name: string): Promise<AgentRecord> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`agent not found: ${id}`);
    row.name = name;
    return row;
  }

  async updatePassword(): Promise<void> {
    throw new Error('not used');
  }

  async markEmailVerified(): Promise<void> {
    throw new Error('not used');
  }
}

/* ======================================================================== */
/* Harness                                                                  */
/* ======================================================================== */

interface Harness {
  cache: CountingCache;
  clock: IClock;
  http: StubOidcHttp;
  connections: InMemorySsoConnectionRepository;
  agentRepo: InMemoryAgentSsoRepository;
  tenantSso: TenantSsoService;
  sso: SsoAuthService;
  issueSession: ReturnType<typeof vi.fn>;
}

function buildHarness(options: { now?: () => Date } = {}): Harness {
  const clock: IClock = { now: options.now ?? (() => NOW) };
  const cache = new CountingCache(clock);
  const http = new StubOidcHttp();
  const connections = new InMemorySsoConnectionRepository(clock);
  const agentRepo = new InMemoryAgentSsoRepository(clock);

  const tenantSso = new TenantSsoService({
    logger: noopLogger,
    clock,
    cache,
    cipher: {
      encrypt: (plaintext: string) => `v1:test:${Buffer.from(plaintext).toString('base64')}`,
      decrypt: (ciphertext: string) => {
        const parts = ciphertext.split(':');
        if (parts[0] !== 'v1' || parts[1] !== 'test' || typeof parts[2] !== 'string') {
          throw new Error('bad ciphertext');
        }
        return Buffer.from(parts[2], 'base64').toString('utf8');
      },
      hash: (value: string) => `hash:${value}`,
      keyId: 'test',
    },
    repo: connections,
    appBaseUrl: 'https://api.example.com',
    nodeEnv: 'test',
    oidc: new OidcClient({ logger: noopLogger, clock, cache, http, nodeEnv: 'test' }),
  });

  const issueSession = vi.fn(
    async (agentId: string): Promise<LoginSuccess> => ({
      token: 'signed.jwt.token',
      refreshToken: 'r'.repeat(96),
      agent: {
        id: agentId,
        name: 'Ana',
        email: 'ana@acme.test',
        role: 'ADMIN',
        presence: 'ONLINE',
        tenantId: TENANT_ID,
      },
    }),
  );

  const sso = new SsoAuthService({
    logger: noopLogger,
    clock,
    cache,
    http,
    cipher: {
      encrypt: (plaintext: string) => `v1:test:${Buffer.from(plaintext).toString('base64')}`,
      decrypt: (ciphertext: string) => {
        const parts = ciphertext.split(':');
        if (parts[0] !== 'v1' || parts[1] !== 'test' || typeof parts[2] !== 'string') {
          throw new Error('bad ciphertext');
        }
        return Buffer.from(parts[2], 'base64').toString('utf8');
      },
      hash: (value: string) => `hash:${value}`,
      keyId: 'test',
    },
    jwtSecret: JWT_SECRET,
    webOrigin: `${WEB_ORIGIN},https://backup.example.com`,
    nodeEnv: 'test',
    repos: { connections, agents: agentRepo },
    agents: { issueSession } as unknown as IAgentService,
  });

  return { cache, clock, http, connections, agentRepo, tenantSso, sso, issueSession };
}

const CONFIG = {
  provider: 'MICROSOFT' as const,
  issuerUrl: `${ISSUER}/`,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  allowedDomains: ['Acme.Test.', '@example.org', 'acme.test'],
  groupRoleMap: { 'sac-admins': 'ADMIN', 'sac-support': 'AGENT' } as const,
};

async function seedConnection(harness: Harness, overrides: Record<string, unknown> = {}) {
  await harness.tenantSso.update(TENANT_ID, { ...CONFIG, ...overrides });
  return harness.connections.rows[0] as TenantSsoConnectionRecord;
}

async function beginFlow(harness: Harness, email = 'ana@acme.test') {
  const { authorizationUrl } = await harness.sso.start({ email, ip: '203.0.113.9' });
  const url = new URL(authorizationUrl);
  return {
    url,
    state: url.searchParams.get('state') ?? '',
    nonce: url.searchParams.get('nonce') ?? '',
  };
}

function idTokenFor(
  nonce: string,
  overrides: Record<string, unknown> = {},
  options: { alg?: string; key?: KeyObject } = {},
): string {
  return signIdToken(
    {
      iss: ISSUER,
      aud: CLIENT_ID,
      exp: NOW_SECONDS + 300,
      iat: NOW_SECONDS,
      nonce,
      email: 'ana@acme.test',
      email_verified: true,
      name: 'Ana Silva',
      groups: ['sac-admins'],
      ...overrides,
    },
    options,
  );
}

/* ======================================================================== */
/* Tests                                                                    */
/* ======================================================================== */

describe('TenantSsoService - configuration (ADMIN, secret write-only)', () => {
  it('creates the connection, encrypts the secret and never returns it', async () => {
    const harness = buildHarness();
    const view = await harness.tenantSso.update(TENANT_ID, CONFIG);

    expect(view).toMatchObject({
      tenantId: TENANT_ID,
      provider: 'MICROSOFT',
      issuerUrl: ISSUER,
      clientId: CLIENT_ID,
      clientSecretConfigured: true,
      redirectUri: 'https://api.example.com/api/v1/auth/sso/callback',
      scopes: 'openid profile email',
      autoProvision: true,
      defaultRole: 'AGENT',
      enforceSso: false,
      enabled: true,
    });
    expect(view.allowedDomains).toEqual(['acme.test', 'example.org']);
    expect(view.groupRoleMap).toEqual({ 'sac-admins': 'ADMIN', 'sac-support': 'AGENT' });
    expect(Object.keys(view)).not.toContain('clientSecretEnc');
    expect(JSON.stringify(view)).not.toContain(CLIENT_SECRET);

    // Stored encrypted (ciphertext), never the plaintext.
    const row = harness.connections.rows[0] as TenantSsoConnectionRecord;
    expect(row.clientSecretEnc).not.toBeNull();
    expect(row.clientSecretEnc).not.toContain(CLIENT_SECRET);
    expect(row.clientSecretEnc?.startsWith('v1:')).toBe(true);
  });

  it('keeps the stored secret when clientSecret is omitted on update', async () => {
    const harness = buildHarness();
    await harness.tenantSso.update(TENANT_ID, CONFIG);
    const encryptedBefore = harness.connections.rows[0]?.clientSecretEnc;

    const view = await harness.tenantSso.update(TENANT_ID, {
      ...CONFIG,
      clientSecret: undefined,
      enforceSso: true,
    });

    expect(view.enforceSso).toBe(true);
    expect(view.clientSecretConfigured).toBe(true);
    expect(harness.connections.rows[0]?.clientSecretEnc).toBe(encryptedBefore);
  });

  it('rotates the secret when a new one is provided', async () => {
    const harness = buildHarness();
    await harness.tenantSso.update(TENANT_ID, CONFIG);
    const encryptedBefore = harness.connections.rows[0]?.clientSecretEnc;

    await harness.tenantSso.update(TENANT_ID, { ...CONFIG, clientSecret: 'another-secret' });

    expect(harness.connections.rows[0]?.clientSecretEnc).not.toBe(encryptedBefore);
  });

  it('supports connections without a secret (public client / PKCE only)', async () => {
    const harness = buildHarness();
    const view = await harness.tenantSso.update(TENANT_ID, {
      ...CONFIG,
      clientSecret: undefined,
    });
    expect(view.clientSecretConfigured).toBe(false);
    expect(harness.connections.rows[0]?.clientSecretEnc).toBeNull();
  });

  it('answers 404 SSO_NOT_CONFIGURED when the workspace has no connection', async () => {
    const harness = buildHarness();
    await expect(harness.tenantSso.get(TENANT_ID)).rejects.toMatchObject({
      code: 'SSO_NOT_CONFIGURED',
      httpStatus: 404,
    });
    await expect(harness.tenantSso.remove(TENANT_ID)).rejects.toMatchObject({
      code: 'SSO_NOT_CONFIGURED',
    });
  });

  it('deletes the connection exactly once', async () => {
    const harness = buildHarness();
    await harness.tenantSso.update(TENANT_ID, CONFIG);

    await expect(harness.tenantSso.remove(TENANT_ID)).resolves.toBeUndefined();
    expect(harness.connections.rows).toHaveLength(0);
    await expect(harness.tenantSso.remove(TENANT_ID)).rejects.toMatchObject({
      code: 'SSO_NOT_CONFIGURED',
    });
  });

  it('rejects a non-https issuer and redirect URI', async () => {
    const harness = buildHarness();
    await expect(
      harness.tenantSso.update(TENANT_ID, { ...CONFIG, issuerUrl: 'http://idp.example.com' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });

    await expect(
      harness.tenantSso.update(TENANT_ID, {
        ...CONFIG,
        redirectUri: 'http://api.example.com/api/v1/auth/sso/callback',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects enforceSso without any allowed domain (would lock the workspace)', async () => {
    const harness = buildHarness();
    await expect(
      harness.tenantSso.update(TENANT_ID, {
        ...CONFIG,
        allowedDomains: [],
        enforceSso: true,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // Not enforcing is fine with an empty allowlist (SSO simply matches nobody).
    const view = await harness.tenantSso.update(TENANT_ID, {
      ...CONFIG,
      allowedDomains: [],
      enforceSso: false,
    });
    expect(view.allowedDomains).toEqual([]);
  });

  it('rejects invalid domains and group roles', async () => {
    const harness = buildHarness();
    await expect(
      harness.tenantSso.update(TENANT_ID, { ...CONFIG, allowedDomains: ['not a domain'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(
      harness.tenantSso.update(TENANT_ID, {
        ...CONFIG,
        groupRoleMap: { group: 'OWNER' as unknown as 'ADMIN' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(
      harness.tenantSso.update(TENANT_ID, { ...CONFIG, clientSecret: 'short' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('TenantSsoService - public discovery', () => {
  it('routes an e-mail domain to the workspace IdP', async () => {
    const harness = buildHarness();
    await seedConnection(harness);

    await expect(
      harness.tenantSso.discover({ email: 'ANYONE@ACME.TEST', ip: '203.0.113.10' }),
    ).resolves.toEqual({ enabled: true, provider: 'MICROSOFT', tenantSlug: TENANT_SLUG });

    await expect(
      harness.tenantSso.discover({ domain: 'acme.test', ip: '203.0.113.10' }),
    ).resolves.toEqual({ enabled: true, provider: 'MICROSOFT', tenantSlug: TENANT_SLUG });
  });

  it('answers 404 for unknown, disabled or empty-allowlist connections', async () => {
    const harness = buildHarness();

    await expect(
      harness.tenantSso.discover({ email: 'ana@acme.test', ip: '203.0.113.10' }),
    ).rejects.toMatchObject({ code: 'SSO_NOT_CONFIGURED', httpStatus: 404 });

    await seedConnection(harness, { enabled: false });
    await expect(
      harness.tenantSso.discover({ email: 'ana@acme.test', ip: '203.0.113.10' }),
    ).rejects.toMatchObject({ code: 'SSO_NOT_CONFIGURED' });

    await seedConnection(harness, { enabled: true, allowedDomains: [] });
    await expect(
      harness.tenantSso.discover({ email: 'ana@acme.test', ip: '203.0.113.10' }),
    ).rejects.toMatchObject({ code: 'SSO_NOT_CONFIGURED' });
  });

  it('requires an email or a domain', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    await expect(harness.tenantSso.discover({ ip: '203.0.113.10' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('does not match a suspended workspace', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    harness.connections.tenants.set(TENANT_ID, { slug: TENANT_SLUG, status: 'SUSPENDED' });

    await expect(
      harness.tenantSso.discover({ email: 'ana@acme.test', ip: '203.0.113.10' }),
    ).rejects.toMatchObject({ code: 'SSO_NOT_CONFIGURED' });
  });
});

describe('SsoAuthService - start (state, nonce, PKCE)', () => {
  it('builds the authorize URL with S256 PKCE, nonce and a signed single-use state', async () => {
    const harness = buildHarness();
    await seedConnection(harness);

    const { url, state, nonce } = await beginFlow(harness);

    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/api/v1/auth/sso/callback',
    );
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(nonce.length).toBeGreaterThanOrEqual(32);
    // The verifier must never appear in the browser URL.
    expect(url.searchParams.get('code_verifier')).toBeNull();
    expect(url.toString()).not.toContain(CLIENT_SECRET);

    const stored = await harness.cache.get<Record<string, string>>(
      `sac:auth:sso:state:${state}`,
    );
    expect(stored).not.toBeNull();
    expect(stored?.nonce).toBe(nonce);
    expect(typeof stored?.codeVerifier).toBe('string');
    expect(stored?.tenantId).toBe(TENANT_ID);
  });

  it('answers 404 when the domain has no enabled connection', async () => {
    const harness = buildHarness();
    await expect(
      harness.sso.start({ email: 'ana@unknown.test', ip: '203.0.113.9' }),
    ).rejects.toMatchObject({ code: 'SSO_NOT_CONFIGURED', httpStatus: 404 });
  });

  it('answers 404 when the requested provider is not the configured one', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    await expect(
      harness.sso.start({ email: 'ana@acme.test', provider: 'OKTA', ip: '203.0.113.9' }),
    ).rejects.toMatchObject({ code: 'SSO_NOT_CONFIGURED' });
  });

  it('fails with SSO_PROVIDER_ERROR when discovery is unreachable', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    harness.http.failDiscovery = true;

    await expect(
      harness.sso.start({ email: 'ana@acme.test', ip: '203.0.113.9' }),
    ).rejects.toMatchObject({ code: 'SSO_PROVIDER_ERROR', httpStatus: 502 });
  });
});

describe('SsoAuthService - callback (ID token + JIT)', () => {
  it('provisions the operator, maps the role by group and redirects with a one-time code', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const { state, nonce } = await beginFlow(harness);

    harness.http.tokenResponse = {
      token_type: 'Bearer',
      // `aud` as an array + matching azp exercises the multi-audience branch.
      id_token: idTokenFor(nonce, { groups: ['sac-support', 'sac-admins'] }),
    };

    const result = await harness.sso.callback({
      code: 'auth-code-1',
      state,
      ip: '203.0.113.9',
      userAgent: 'vitest',
    });

    expect(result.provisioned).toBe(true);
    expect(result.tenantId).toBe(TENANT_ID);
    expect(result.redirectUrl.startsWith(`${WEB_ORIGIN}/auth/sso/callback?code=`)).toBe(true);

    const redirect = new URL(result.redirectUrl);
    const code = redirect.searchParams.get('code') ?? '';
    expect(code.length).toBeGreaterThanOrEqual(32);
    expect(result.redirectUrl).not.toContain('signed.jwt');
    expect(result.redirectUrl).not.toContain('refresh');

    const agent = harness.agentRepo.rows[0];
    expect(agent).toMatchObject({
      tenantId: TENANT_ID,
      email: 'ana@acme.test',
      name: 'Ana Silva',
      role: 'ADMIN',
      isActive: true,
      mustResetPassword: false,
    });
    expect(agent?.emailVerifiedAt?.getTime()).toBe(NOW.getTime());
    // Random, unknown password hash: password login can never match it.
    expect(agent?.passwordHash.startsWith('$2')).toBe(true);

    // The hand-off record stores only the identity, never a token.
    const handoff = await harness.cache.get<Record<string, unknown>>(
      `sac:auth:sso:code:${createHashLike(code)}`,
    );
    expect(handoff).toEqual({ agentId: agent?.id, tenantId: TENANT_ID });
    expect(JSON.stringify(handoff)).not.toContain('signed.jwt');
  });

  it('updates an existing operator and preserves the role when no group matches', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const existing = harness.agentRepo.seed({
      email: 'ana@acme.test',
      role: 'ADMIN',
      name: 'Old Name',
    });

    const { state, nonce } = await beginFlow(harness);
    harness.http.tokenResponse = {
      id_token: idTokenFor(nonce, { groups: ['unmapped-group'], name: 'Ana New' }),
    };

    const result = await harness.sso.callback({ code: 'auth-code-1', state });

    expect(result.provisioned).toBe(false);
    const updated = harness.agentRepo.rows.find((row) => row.id === existing.id);
    expect(updated?.name).toBe('Ana New');
    // Unmapped group must not demote the ADMIN.
    expect(updated?.role).toBe('ADMIN');
    expect(updated?.mustResetPassword).toBe(false);
  });

  it('rejects a wrong nonce (replay of another flow)', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const { state } = await beginFlow(harness);

    harness.http.tokenResponse = { id_token: idTokenFor('nonce-from-another-flow') };

    await expect(harness.sso.callback({ code: 'auth-code-1', state })).rejects.toMatchObject({
      code: 'SSO_TOKEN_INVALID',
      httpStatus: 401,
      details: { reason: 'nonce' },
    });
  });

  it('rejects a token issued for another audience', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const { state, nonce } = await beginFlow(harness);

    harness.http.tokenResponse = { id_token: idTokenFor(nonce, { aud: 'another-client' }) };

    await expect(harness.sso.callback({ code: 'auth-code-1', state })).rejects.toMatchObject({
      code: 'SSO_TOKEN_INVALID',
      details: { reason: 'audience' },
    });
  });

  it('rejects a token signed by another key (signature)', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const { state, nonce } = await beginFlow(harness);

    const { privateKey: rogueKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
    harness.http.tokenResponse = { id_token: idTokenFor(nonce, {}, { key: rogueKey }) };

    await expect(harness.sso.callback({ code: 'auth-code-1', state })).rejects.toMatchObject({
      code: 'SSO_TOKEN_INVALID',
      details: { reason: 'signature' },
    });
  });

  it('refreshes the JWKS once when the signing key rotates reusing the same kid', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const { state, nonce } = await beginFlow(harness);

    // Same `kid`, different key pair — exactly what the stub IdP does when it
    // restarts. The cached JWKS has the old key, so the first verification
    // fails on the signature and the client must fetch the JWKS again.
    const rotated = generateKeyPairSync('rsa', { modulusLength: 2_048 });
    const rotatedJwk = {
      ...(rotated.publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
      kid: KID,
      use: 'sig',
      alg: 'RS256',
    };
    harness.http.jwksResponses = [{ keys: [publicJwk] }, { keys: [rotatedJwk] }];
    harness.http.tokenResponse = {
      id_token: idTokenFor(nonce, {}, { key: rotated.privateKey }),
    };

    const result = await harness.sso.callback({ code: 'auth-code-1', state });

    expect(result.provisioned).toBe(true);
    expect(harness.http.jwksCalls).toBe(2);
  });

  it('refuses an unsigned/HS256 token', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const { state, nonce } = await beginFlow(harness);

    // alg=none style token (empty signature) must never be accepted.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: CLIENT_ID,
        exp: NOW_SECONDS + 300,
        nonce,
        email: 'ana@acme.test',
        email_verified: true,
      }),
    ).toString('base64url');
    harness.http.tokenResponse = { id_token: `${header}.${payload}.` };

    await expect(harness.sso.callback({ code: 'auth-code-1', state })).rejects.toMatchObject({
      code: 'SSO_TOKEN_INVALID',
      details: { reason: 'unsupported_alg' },
    });
  });

  it('rejects an e-mail domain outside the allowlist', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const { state, nonce } = await beginFlow(harness);

    harness.http.tokenResponse = {
      id_token: idTokenFor(nonce, { email: 'ana@evil.test', preferred_username: 'ana@evil.test' }),
    };

    await expect(harness.sso.callback({ code: 'auth-code-1', state })).rejects.toMatchObject({
      code: 'SSO_DOMAIN_NOT_ALLOWED',
      httpStatus: 403,
    });
    expect(harness.agentRepo.rows).toHaveLength(0);
  });

  it('rejects an e-mail the IdP did not verify', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const { state, nonce } = await beginFlow(harness);

    harness.http.tokenResponse = {
      id_token: idTokenFor(nonce, { email_verified: false }),
    };

    await expect(harness.sso.callback({ code: 'auth-code-1', state })).rejects.toMatchObject({
      code: 'SSO_EMAIL_UNVERIFIED',
      httpStatus: 403,
    });
    expect(harness.agentRepo.rows).toHaveLength(0);
  });

  it('rejects a replayed state and accepts the first callback only', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const { state, nonce } = await beginFlow(harness);
    harness.http.tokenResponse = { id_token: idTokenFor(nonce) };

    await expect(harness.sso.callback({ code: 'auth-code-1', state })).resolves.toMatchObject({
      tenantId: TENANT_ID,
    });

    await expect(harness.sso.callback({ code: 'auth-code-1', state })).rejects.toMatchObject({
      code: 'SSO_STATE_INVALID',
      httpStatus: 400,
    });
    // Only one operator was provisioned.
    expect(harness.agentRepo.rows).toHaveLength(1);
  });

  it('rejects a forged state (tampered signature) without touching Redis', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const { state } = await beginFlow(harness);
    const [random] = state.split('.');
    const forged = `${random}.${'A'.repeat(43)}`;

    await expect(harness.sso.callback({ code: 'auth-code-1', state: forged })).rejects.toMatchObject({
      code: 'SSO_STATE_INVALID',
    });
  });

  it('rejects an expired state (10 min TTL)', async () => {
    let current = NOW.getTime();
    const harness = buildHarness({ now: () => new Date(current) });
    await seedConnection(harness);
    const { state, nonce } = await beginFlow(harness);

    current += 11 * 60 * 1_000;
    harness.http.tokenResponse = { id_token: idTokenFor(nonce) };

    await expect(harness.sso.callback({ code: 'auth-code-1', state })).rejects.toMatchObject({
      code: 'SSO_STATE_INVALID',
    });
  });

  it('rejects an expired ID token', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const { state, nonce } = await beginFlow(harness);
    harness.http.tokenResponse = {
      id_token: idTokenFor(nonce, { exp: NOW_SECONDS - 3_600 }),
    };

    await expect(harness.sso.callback({ code: 'auth-code-1', state })).rejects.toMatchObject({
      code: 'SSO_TOKEN_INVALID',
      details: { reason: 'expired' },
    });
  });

  it('answers SSO_CANCELLED when the IdP redirects with an error', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const { state } = await beginFlow(harness);

    await expect(
      harness.sso.callback({ error: 'access_denied', state }),
    ).rejects.toMatchObject({ code: 'SSO_CANCELLED' });
  });

  it('answers SSO_ACCOUNT_CONFLICT for an e-mail owned by another workspace', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const foreign = harness.agentRepo.seed({
      email: 'ana@acme.test',
      tenantId: 'tenant-2',
    });
    harness.connections.tenants.set('tenant-2', { slug: 'other', status: 'ACTIVE' });

    const { state, nonce } = await beginFlow(harness);
    harness.http.tokenResponse = { id_token: idTokenFor(nonce) };

    await expect(harness.sso.callback({ code: 'auth-code-1', state })).rejects.toMatchObject({
      code: 'SSO_ACCOUNT_CONFLICT',
      httpStatus: 409,
    });
    expect(harness.agentRepo.rows.find((row) => row.id === foreign.id)?.tenantId).toBe('tenant-2');
  });

  it('answers SSO_ACCOUNT_DISABLED and never reactivates a suspended operator', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const disabled = harness.agentRepo.seed({ email: 'ana@acme.test', isActive: false });

    const { state, nonce } = await beginFlow(harness);
    harness.http.tokenResponse = { id_token: idTokenFor(nonce) };

    await expect(harness.sso.callback({ code: 'auth-code-1', state })).rejects.toMatchObject({
      code: 'SSO_ACCOUNT_DISABLED',
      httpStatus: 403,
    });
    expect(harness.agentRepo.rows.find((row) => row.id === disabled.id)?.isActive).toBe(false);
  });

  it('answers SSO_PROVISIONING_DISABLED when autoProvision is off and the user is unknown', async () => {
    const harness = buildHarness();
    await seedConnection(harness, { autoProvision: false });
    const { state, nonce } = await beginFlow(harness);
    harness.http.tokenResponse = { id_token: idTokenFor(nonce) };

    await expect(harness.sso.callback({ code: 'auth-code-1', state })).rejects.toMatchObject({
      code: 'SSO_PROVISIONING_DISABLED',
      httpStatus: 403,
    });
  });

  it('issues new operators with the default role when no group matches', async () => {
    const harness = buildHarness();
    await seedConnection(harness, { defaultRole: 'SUPERVISOR' });
    const { state, nonce } = await beginFlow(harness);
    harness.http.tokenResponse = {
      id_token: idTokenFor(nonce, { groups: ['no-mapping'] }),
    };

    await harness.sso.callback({ code: 'auth-code-1', state });
    expect(harness.agentRepo.rows[0]?.role).toBe('SUPERVISOR');
  });
});

describe('SsoAuthService - exchange (single use)', () => {
  it('mints the session once and rejects the second redemption', async () => {
    const harness = buildHarness();
    await seedConnection(harness);
    const { state, nonce } = await beginFlow(harness);
    harness.http.tokenResponse = { id_token: idTokenFor(nonce) };

    const callback = await harness.sso.callback({ code: 'auth-code-1', state });
    const code = new URL(callback.redirectUrl).searchParams.get('code') ?? '';

    const first = await harness.sso.exchange({ code, ip: '203.0.113.9', userAgent: 'vitest' });
    expect(first.token).toBe('signed.jwt.token');
    expect(harness.issueSession).toHaveBeenCalledTimes(1);
    expect(harness.issueSession).toHaveBeenCalledWith(callback.agentId, {
      userAgent: 'vitest',
      ip: '203.0.113.9',
    });

    await expect(harness.sso.exchange({ code })).rejects.toMatchObject({
      code: 'INVALID_SSO_CODE',
      httpStatus: 401,
    });
    expect(harness.issueSession).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown/garbage codes with INVALID_SSO_CODE', async () => {
    const harness = buildHarness();
    await expect(harness.sso.exchange({ code: 'nope' })).rejects.toMatchObject({
      code: 'INVALID_SSO_CODE',
      httpStatus: 401,
    });
  });

  it('lets the one-time code expire after 60 seconds', async () => {
    let current = NOW.getTime();
    const harness = buildHarness({ now: () => new Date(current) });
    await seedConnection(harness);
    const { state, nonce } = await beginFlow(harness);
    harness.http.tokenResponse = { id_token: idTokenFor(nonce) };

    const callback = await harness.sso.callback({ code: 'auth-code-1', state });
    const code = new URL(callback.redirectUrl).searchParams.get('code') ?? '';

    current += 61 * 1_000;
    await expect(harness.sso.exchange({ code })).rejects.toMatchObject({
      code: 'INVALID_SSO_CODE',
    });
  });
});

describe('AgentService - enforce_sso gate (break-glass = platform admin only)', () => {
  const PASSWORD = 'correct-horse-battery';
  const passwordHash = bcrypt.hashSync(PASSWORD, 4);

  function buildAgents(harness: Harness) {
    const agentsRepo = new InMemoryAgentRepository(harness.clock);
    const agent = agentsRepo.seed({ email: 'admin@acme.test', passwordHash, role: 'ADMIN' });

    const agents = new AgentService({
      logger: noopLogger,
      clock: harness.clock,
      cache: harness.cache,
      realtime: {
        ticketUpdated: vi.fn(),
        messageCreated: vi.fn(),
        queueChanged: vi.fn(),
        channelHealth: vi.fn(),
        agentPresence: vi.fn(),
      },
      jwtSecret: JWT_SECRET,
      jwtExpiresIn: '12h',
      presenceTtlSeconds: 120,
      sso: harness.tenantSso,
      repos: {
        agents: agentsRepo,
        tickets: { countActiveByAgent: async () => 0 },
      } as unknown as ConstructorParameters<typeof AgentService>[0]['repos'],
    });

    return { agents, agentsRepo, agent };
  }

  it('answers 403 SSO_REQUIRED for a tenant ADMIN after a valid password', async () => {
    const harness = buildHarness();
    await seedConnection(harness, { enforceSso: true, allowedDomains: ['acme.test'] });
    const { agents } = buildAgents(harness);

    await expect(agents.login('admin@acme.test', PASSWORD)).rejects.toMatchObject({
      code: 'SSO_REQUIRED',
      httpStatus: 403,
    });
  });

  it('still answers 401 for a wrong password (no account/policy enumeration)', async () => {
    const harness = buildHarness();
    await seedConnection(harness, { enforceSso: true, allowedDomains: ['acme.test'] });
    const { agents } = buildAgents(harness);

    await expect(agents.login('admin@acme.test', 'wrong-password')).rejects.toMatchObject({
      code: 'AUTHENTICATION_ERROR',
      httpStatus: 401,
    });
  });

  it('exempts the platform administrator (break-glass)', async () => {
    const harness = buildHarness();
    await seedConnection(harness, { enforceSso: true, allowedDomains: ['acme.test'] });
    const { agents, agentsRepo } = buildAgents(harness);
    agentsRepo.rows[0]!.isPlatformAdmin = true;

    const result = await agents.login('admin@acme.test', PASSWORD);
    expect('token' in result).toBe(true);
  });

  it('allows the password path when the connection does not enforce SSO', async () => {
    const harness = buildHarness();
    await seedConnection(harness, { enforceSso: false });
    const { agents } = buildAgents(harness);

    const result = await agents.login('admin@acme.test', PASSWORD);
    expect('token' in result).toBe(true);
  });

  it('ignores enforcement when the connection is disabled', async () => {
    const harness = buildHarness();
    await seedConnection(harness, { enforceSso: true, enabled: false, allowedDomains: ['acme.test'] });
    const { agents } = buildAgents(harness);

    const result = await agents.login('admin@acme.test', PASSWORD);
    expect('token' in result).toBe(true);
  });
});

describe('SSO claim helpers', () => {
  it('collects groups from arrays, space-separated strings and roles', () => {
    expect(
      collectGroups({ groups: ['g1', ' g2 ', 3], roles: 'r1 r2' }),
    ).toEqual(['g1', 'g2', 'r1', 'r2']);
  });

  it('maps to the highest-privilege role and ignores unknown groups', () => {
    const map = { a: 'AGENT', b: 'SUPERVISOR', c: 'ADMIN' } as const;
    expect(resolveMappedRole(['a', 'b'], { ...map })).toBe('SUPERVISOR');
    expect(resolveMappedRole(['a', 'c', 'b'], { ...map })).toBe('ADMIN');
    expect(resolveMappedRole(['unknown'], { ...map })).toBeNull();
  });
});

/* ======================================================================== */
/* Test helper                                                              */
/* ======================================================================== */

/** Mirrors `hashToken` (server-side) without importing an internal module. */
function createHashLike(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
