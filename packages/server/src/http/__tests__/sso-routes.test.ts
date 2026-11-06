import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@sac/shared';
import type {
  ILogger,
  ISsoAuthService,
  ITenantSsoService,
  LoginSuccess,
  SsoConnectionTestResult,
  SsoConnectionView,
} from '@sac/shared';

import type { HttpRouteContext } from '../types';
import { authRoutes } from '../routes/auth.routes';
import { tenantRoutes } from '../routes/tenants.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { isPublicRoute } from '../middleware/auth';

/**
 * ============================================================================
 * Enterprise SSO HTTP surface
 * ============================================================================
 *
 * Checks the wire contract only (routes, RBAC, envelopes, redirects, status
 * codes): the services are stubs, the business rules are covered by
 * `application/__tests__/Sso.test.ts`.
 */

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

const VIEW: SsoConnectionView = {
  tenantId: 'tenant-1',
  provider: 'MICROSOFT',
  issuerUrl: 'https://login.microsoftonline.com/tenant/v2.0',
  clientId: 'client-id',
  clientSecretConfigured: true,
  redirectUri: 'https://api.example.com/api/v1/auth/sso/callback',
  scopes: 'openid profile email',
  allowedDomains: ['acme.test'],
  groupRoleMap: { 'sac-admins': 'ADMIN' },
  autoProvision: true,
  defaultRole: 'AGENT',
  enforceSso: false,
  enabled: true,
  createdAt: new Date('2026-11-05T12:00:00.000Z'),
  updatedAt: new Date('2026-11-05T12:00:00.000Z'),
};

const LOGIN_SUCCESS: LoginSuccess = {
  token: 'signed.jwt.token',
  refreshToken: 'r'.repeat(96),
  agent: {
    id: 'agent-1',
    name: 'Ana',
    email: 'ana@acme.test',
    role: 'ADMIN',
    presence: 'ONLINE',
    tenantId: 'tenant-1',
  },
};

const TEST_RESULT: SsoConnectionTestResult = {
  ok: true,
  checks: [
    { name: 'discovery', ok: true, detail: 'HTTP 200' },
    { name: 'issuer', ok: true, detail: VIEW.issuerUrl },
    { name: 'allowed_domains', ok: true, detail: '1 domain(s) allowed' },
  ],
  issuer: VIEW.issuerUrl,
  authorizationEndpoint: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
  jwksKeys: ['signing-key-1'],
  enabled: true,
};

describe('enterprise SSO routes', () => {
  let app: FastifyInstance;

  const tenantSsoGet = vi.fn(async () => VIEW);
  const tenantSsoUpdate = vi.fn(async () => VIEW);
  const tenantSsoRemove = vi.fn(async () => undefined);
  const tenantSsoTest = vi.fn(async () => TEST_RESULT);
  const tenantSsoDiscover = vi.fn(async () => ({
    enabled: true as const,
    provider: 'MICROSOFT' as const,
    tenantSlug: 'acme',
  }));
  const assertPasswordLoginAllowed = vi.fn(async () => undefined);

  const ssoStart = vi.fn(async () => ({
    authorizationUrl:
      'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?client_id=client-id&state=signed.state',
  }));
  const ssoCallback = vi.fn(async () => ({
    redirectUrl: 'https://app.example.com/auth/sso/callback?code=one-time-code',
    agentId: 'agent-1',
    tenantId: 'tenant-1',
    provisioned: true,
  }));
  const ssoExchange = vi.fn(async () => LOGIN_SUCCESS);
  const failureRedirect = vi.fn(
    (code: string) => `https://app.example.com/auth/sso/callback?error=${code}`,
  );

  beforeAll(async () => {
    const ctx = {
      services: {
        tenantSso: {
          get: tenantSsoGet,
          update: tenantSsoUpdate,
          remove: tenantSsoRemove,
          test: tenantSsoTest,
          discover: tenantSsoDiscover,
          assertPasswordLoginAllowed,
        } as unknown as ITenantSsoService,
        sso: {
          start: ssoStart,
          callback: ssoCallback,
          exchange: ssoExchange,
          failureRedirect,
        } as unknown as ISsoAuthService,
      },
      hub: {},
      options: {},
    } as unknown as HttpRouteContext;

    app = Fastify();
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
    await app.register(authRoutes, { prefix: '/api/v1/auth', ...ctx });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    tenantSsoGet.mockClear();
    tenantSsoUpdate.mockClear();
    tenantSsoRemove.mockClear();
    tenantSsoTest.mockClear();
    tenantSsoDiscover.mockClear();
    ssoStart.mockClear();
    ssoCallback.mockClear();
    ssoExchange.mockClear();
    failureRedirect.mockClear();
  });

  /* -------------------------------------------------------------------- */
  /* Public allowlist                                                      */
  /* -------------------------------------------------------------------- */

  it('keeps exactly the four SSO flow paths public', () => {
    expect(isPublicRoute('GET', '/api/v1/auth/sso/discover?email=ana@acme.test')).toBe(true);
    expect(isPublicRoute('GET', '/api/v1/auth/sso/start?email=ana@acme.test')).toBe(true);
    expect(isPublicRoute('GET', '/api/v1/auth/sso/callback?code=x&state=y')).toBe(true);
    expect(isPublicRoute('POST', '/api/v1/auth/sso/exchange')).toBe(true);
    // No prefix wildcard: an unknown sibling stays authenticated.
    expect(isPublicRoute('GET', '/api/v1/auth/sso/anything-else')).toBe(false);
  });

  it('protects the tenant SSO configuration with a JWT', () => {
    expect(isPublicRoute('GET', '/api/v1/tenants/me/sso')).toBe(false);
    expect(isPublicRoute('PUT', '/api/v1/tenants/me/sso')).toBe(false);
    expect(isPublicRoute('POST', '/api/v1/tenants/me/sso/test')).toBe(false);
    expect(isPublicRoute('DELETE', '/api/v1/tenants/me/sso')).toBe(false);
  });

  /* -------------------------------------------------------------------- */
  /* Tenant configuration (ADMIN + JWT tenant)                             */
  /* -------------------------------------------------------------------- */

  it('GET /tenants/me/sso answers 401 without a principal', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/tenants/me/sso' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'AUTHENTICATION_ERROR' } });
    expect(tenantSsoGet).not.toHaveBeenCalled();
  });

  it('GET /tenants/me/sso answers 403 for AGENT and SUPERVISOR', async () => {
    for (const role of ['AGENT', 'SUPERVISOR']) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/tenants/me/sso',
        headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': role },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_ERROR' } });
    }
    expect(tenantSsoGet).not.toHaveBeenCalled();
  });

  it('GET /tenants/me/sso returns the config without the secret (ADMIN)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/me/sso',
      headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      provider: 'MICROSOFT',
      clientId: 'client-id',
      clientSecretConfigured: true,
      allowedDomains: ['acme.test'],
    });
    expect(body.data).not.toHaveProperty('clientSecretEnc');
    expect(response.body).not.toContain('client-secret');
    expect(tenantSsoGet).toHaveBeenCalledWith('tenant-1');
  });

  it('PUT /tenants/me/sso uses the JWT tenant and forwards the body (ADMIN)', async () => {
    const payload = {
      provider: 'MICROSOFT',
      issuerUrl: 'https://login.microsoftonline.com/tenant/v2.0',
      clientId: 'client-id',
      clientSecret: 'a-new-secret',
      allowedDomains: ['acme.test'],
      enforceSso: false,
    };

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/tenants/me/sso',
      headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(tenantSsoUpdate).toHaveBeenCalledWith('tenant-1', payload);
  });

  it('PUT /tenants/me/sso accepts the lowercase provider slug used by the SPA', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/tenants/me/sso',
      headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
      payload: {
        provider: 'microsoft',
        issuerUrl: 'https://login.microsoftonline.com/tenant/v2.0',
        clientId: 'client-id',
      },
    });

    expect(response.statusCode).toBe(200);
    // Normalized to the persisted enum before reaching the service.
    expect(tenantSsoUpdate).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ provider: 'MICROSOFT' }),
    );
  });

  it('PUT /tenants/me/sso accepts redirectUri=null (deployment default)', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/tenants/me/sso',
      headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
      payload: {
        provider: 'MICROSOFT',
        issuerUrl: 'https://login.microsoftonline.com/tenant/v2.0',
        clientId: 'client-id',
        redirectUri: null,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(tenantSsoUpdate).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ redirectUri: undefined }),
    );
  });

  it('PUT /tenants/me/sso rejects a tenantId smuggled into the body (422)', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/tenants/me/sso',
      headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
      payload: {
        tenantId: 'tenant-2',
        provider: 'MICROSOFT',
        issuerUrl: 'https://login.microsoftonline.com/tenant/v2.0',
        clientId: 'client-id',
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(tenantSsoUpdate).not.toHaveBeenCalled();
  });

  it('PUT /tenants/me/sso rejects an unknown provider (422)', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/tenants/me/sso',
      headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
      payload: {
        provider: 'AUTH0',
        issuerUrl: 'https://login.example.com',
        clientId: 'client-id',
      },
    });

    expect(response.statusCode).toBe(422);
    expect(tenantSsoUpdate).not.toHaveBeenCalled();
  });

  it('DELETE /tenants/me/sso answers 204 (ADMIN)', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/tenants/me/sso',
      headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
    });

    expect(response.statusCode).toBe(204);
    expect(tenantSsoRemove).toHaveBeenCalledWith('tenant-1');
  });

  it('DELETE /tenants/me/sso answers 403 for a non-admin', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/tenants/me/sso',
      headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'SUPERVISOR' },
    });

    expect(response.statusCode).toBe(403);
    expect(tenantSsoRemove).not.toHaveBeenCalled();
  });

  /* -------------------------------------------------------------------- */
  /* Connection test (ADMIN, saved config)                                 */
  /* -------------------------------------------------------------------- */

  it('POST /tenants/me/sso/test answers 401 without a principal', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/tenants/me/sso/test' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'AUTHENTICATION_ERROR' } });
    expect(tenantSsoTest).not.toHaveBeenCalled();
  });

  it('POST /tenants/me/sso/test answers 403 for AGENT and SUPERVISOR', async () => {
    for (const role of ['AGENT', 'SUPERVISOR']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/me/sso/test',
        headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': role },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_ERROR' } });
    }
    expect(tenantSsoTest).not.toHaveBeenCalled();
  });

  it('POST /tenants/me/sso/test returns the report scoped by the JWT tenant (ADMIN)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants/me/sso/test',
      headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: TEST_RESULT });
    expect(tenantSsoTest).toHaveBeenCalledWith('tenant-1', { ip: expect.any(String) });
    expect(response.body).not.toContain('clientSecret');
  });

  it('POST /tenants/me/sso/test propagates 404 SSO_NOT_CONFIGURED', async () => {
    tenantSsoTest.mockRejectedValueOnce(
      new AppError('SSO_NOT_CONFIGURED', 'This workspace has no SSO connection', 404),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants/me/sso/test',
      headers: { 'x-test-tenant': 'tenant-1', 'x-test-role': 'ADMIN' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'SSO_NOT_CONFIGURED' } });
  });

  /* -------------------------------------------------------------------- */
  /* Public flow                                                           */
  /* -------------------------------------------------------------------- */

  it('GET /auth/sso/discover answers 200 with the routing data', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sso/discover?email=ana@acme.test',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { enabled: true, provider: 'MICROSOFT', tenantSlug: 'acme' },
    });
    expect(tenantSsoDiscover).toHaveBeenCalledWith({
      email: 'ana@acme.test',
      ip: expect.any(String),
    });
  });

  it('GET /auth/sso/discover answers 422 without email or domain', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/sso/discover' });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('GET /auth/sso/discover propagates 404 SSO_NOT_CONFIGURED', async () => {
    tenantSsoDiscover.mockRejectedValueOnce(
      new AppError('SSO_NOT_CONFIGURED', 'No workspace has SSO enabled', 404),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sso/discover?email=ana@unknown.test',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'SSO_NOT_CONFIGURED' } });
  });

  it('GET /auth/sso/start redirects 302 to the IdP authorization endpoint', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sso/start?email=ana@acme.test&provider=MICROSOFT',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?client_id=client-id&state=signed.state',
    );
    expect(ssoStart).toHaveBeenCalledWith({
      email: 'ana@acme.test',
      provider: 'MICROSOFT',
      ip: expect.any(String),
    });
  });

  it('GET /auth/sso/callback redirects 302 to the SPA with the one-time code', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sso/callback?code=idp-code&state=signed.state',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      'https://app.example.com/auth/sso/callback?code=one-time-code',
    );
  });

  it('GET /auth/sso/callback redirects post-state failures with a stable error code', async () => {
    ssoCallback.mockRejectedValueOnce(
      new AppError('SSO_DOMAIN_NOT_ALLOWED', 'Domain not allowed', 403),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sso/callback?code=idp-code&state=signed.state',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      'https://app.example.com/auth/sso/callback?error=SSO_DOMAIN_NOT_ALLOWED',
    );
    expect(failureRedirect).toHaveBeenCalledWith('SSO_DOMAIN_NOT_ALLOWED');
  });

  it('GET /auth/sso/callback keeps SSO_STATE_INVALID as a 400 JSON error (no redirect)', async () => {
    ssoCallback.mockRejectedValueOnce(
      new AppError('SSO_STATE_INVALID', 'Invalid state', 400),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sso/callback?code=idp-code&state=forged.state',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'SSO_STATE_INVALID' } });
    expect(failureRedirect).not.toHaveBeenCalled();
  });

  it('POST /auth/sso/exchange answers 200 with the AuthResponse', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sso/exchange',
      payload: { code: 'one-time-code' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        token: 'signed.jwt.token',
        refreshToken: 'r'.repeat(96),
        agent: {
          id: 'agent-1',
          name: 'Ana',
          email: 'ana@acme.test',
          role: 'ADMIN',
          presence: 'ONLINE',
          tenantId: 'tenant-1',
        },
      },
    });
  });

  it('POST /auth/sso/exchange answers 401 INVALID_SSO_CODE on a replayed code', async () => {
    ssoExchange.mockRejectedValueOnce(
      new AppError('INVALID_SSO_CODE', 'Code already used', 401),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sso/exchange',
      payload: { code: 'already-used' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_SSO_CODE' } });
  });

  it('POST /auth/sso/exchange rejects a body without code (422)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sso/exchange',
      payload: {},
    });

    expect(response.statusCode).toBe(422);
    expect(ssoExchange).not.toHaveBeenCalled();
  });
});
