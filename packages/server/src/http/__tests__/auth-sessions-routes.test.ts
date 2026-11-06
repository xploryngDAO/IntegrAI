import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AuthenticationError, CACHE_KEYS, NotFoundError } from '@sac/shared';
import type { IAgentSummary, UserSessionView } from '@sac/shared';

import { InMemoryCache } from '../../application/__tests__/accountFakes';
import { buildTestApp } from './http-test-harness';

/**
 * HTTP contract of the self-service session/profile endpoints:
 *
 *   GET    /api/v1/auth/sessions              -> { items: UserSessionView[] }
 *   DELETE /api/v1/auth/sessions/:id         -> 204 (current deletion = logout)
 *   POST   /api/v1/auth/sessions/revoke-others -> { revoked }
 *   PATCH  /api/v1/auth/me                   -> IAgentSummary
 *
 * 401 without a JWT, 404 for a foreign/unknown session, 422 for a malformed
 * body/id. The session service is a mock; its own rules are unit-tested in
 * `application/__tests__/UserSessions.test.ts`.
 */

const TOKEN = 'token-agent';
const JTI = 'jti-1';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-06T12:00:00.000Z');

const SUMMARY: IAgentSummary = {
  id: 'agent-1',
  tenantId: 'tenant-1',
  name: 'Ana',
  email: 'ana@acme.test',
  role: 'ADMIN',
  presence: 'ONLINE',
  avatarColor: '#2563eb',
  activeTickets: 2,
};

const SESSION: UserSessionView = {
  id: SESSION_ID,
  createdAt: '2026-11-06T10:00:00.000Z',
  lastUsedAt: null,
  userAgent: 'Chrome',
  ip: '203.0.113.7',
  current: true,
};

describe('self-service session/profile HTTP routes', () => {
  let app: FastifyInstance;
  let cache: InMemoryCache;

  const verifyToken = vi.fn(async (token: string) => {
    if (token !== TOKEN) throw new AuthenticationError('Invalid token');
    return {
      agentId: 'agent-1',
      email: 'ana@acme.test',
      name: 'Ana',
      role: 'ADMIN',
      tenantId: 'tenant-1',
      isPlatformAdmin: false,
      jti: JTI,
      sessionId: SESSION_ID,
      tokenExpiresAt: Math.floor(NOW.getTime() / 1000) + 3_600,
    };
  });
  const listForUser = vi.fn(async () => [SESSION]);
  const revokeById = vi.fn(async () => ({ revoked: true, current: true }));
  const revokeOthers = vi.fn(async () => 4);
  const updateProfile = vi.fn(async () => SUMMARY);
  const auditRecord = vi.fn();

  beforeAll(async () => {
    cache = new InMemoryCache();
    app = await buildTestApp({
      services: {
        agents: { verifyToken, updateProfile },
        sessions: { listForUser, revokeById, revokeOthers },
        audit: { record: auditRecord, list: async () => ({ items: [], page: 1, perPage: 25, total: 0 }), flush: async (): Promise<void> => undefined },
        cache,
        clock: { now: () => new Date(NOW.getTime()) },
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    cache.entries.clear();
    verifyToken.mockClear();
    listForUser.mockClear();
    revokeById.mockClear();
    revokeOthers.mockClear();
    updateProfile.mockClear();
    auditRecord.mockClear();
    revokeById.mockImplementation(async () => ({ revoked: true, current: true }));
    revokeOthers.mockImplementation(async () => 4);
  });

  const auth = { authorization: `Bearer ${TOKEN}` };

  it('answers 401 without a JWT on the self-service routes', async () => {
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/auth/sessions' }),
      app.inject({ method: 'DELETE', url: `/api/v1/auth/sessions/${SESSION_ID}` }),
      app.inject({ method: 'POST', url: '/api/v1/auth/sessions/revoke-others' }),
      app.inject({
        method: 'PATCH',
        url: '/api/v1/auth/me',
        headers: { 'content-type': 'application/json' },
        payload: { name: 'New name' },
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
    }
  });

  it('GET /auth/sessions returns the items envelope and the current SID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { items: [SESSION] } });
    expect(listForUser).toHaveBeenCalledWith('agent-1', SESSION_ID);
  });

  it('DELETE /auth/sessions/:id answers 204 and denylists the current access token', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${SESSION_ID}`,
      headers: auth,
    });

    expect(response.statusCode).toBe(204);
    expect(revokeById).toHaveBeenCalledWith(SESSION_ID, 'agent-1', SESSION_ID);
    // Revoking the session that issued the token also kills the JWT now.
    expect(cache.entries.has(CACHE_KEYS.authAccessTokenDeny(JTI))).toBe(true);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.logout', resourceType: 'session' }),
    );
  });

  it('DELETE /auth/sessions/:id does not denylist the JWT when another device was revoked', async () => {
    revokeById.mockResolvedValueOnce({ revoked: true, current: false });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${SESSION_ID}`,
      headers: auth,
    });

    expect(response.statusCode).toBe(204);
    expect(cache.entries.has(CACHE_KEYS.authAccessTokenDeny(JTI))).toBe(false);
  });

  it('DELETE /auth/sessions/:id answers 404 for a foreign/unknown session and 422 for a bad id', async () => {
    revokeById.mockRejectedValueOnce(new NotFoundError('Session', SESSION_ID));
    const notFound = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${SESSION_ID}`,
      headers: auth,
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const invalid = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/sessions/not-a-uuid',
      headers: auth,
    });
    expect(invalid.statusCode).toBe(422);
  });

  it('POST /auth/sessions/revoke-others returns the revoked count', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke-others',
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { revoked: 4 } });
    expect(revokeOthers).toHaveBeenCalledWith('agent-1', SESSION_ID);
  });

  it('PATCH /auth/me updates the profile and returns the agent summary', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/me',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { name: 'Ana Updated' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: SUMMARY });
    expect(updateProfile).toHaveBeenCalledTimes(1);
    const [agentId, body, device] = updateProfile.mock.calls[0] as unknown as [
      string,
      { name: string },
      { ip: string | null; userAgent: string | null },
    ];
    expect(agentId).toBe('agent-1');
    expect(body).toEqual({ name: 'Ana Updated' });
    // Audit provenance from the request (`inject` defaults to lightMyRequest).
    expect(device.userAgent).toBe('lightMyRequest');
    expect(typeof device.ip).toBe('string');
  });

  it('PATCH /auth/me answers 422 for an empty/oversized name', async () => {
    for (const payload of [{}, { name: '' }, { name: 'x'.repeat(121) }]) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/auth/me',
        headers: { ...auth, 'content-type': 'application/json' },
        payload,
      });
      expect(response.statusCode).toBe(422);
    }
    expect(updateProfile).not.toHaveBeenCalled();
  });
});
