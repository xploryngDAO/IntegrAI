import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  IAppServices,
  IClock,
  ILogger,
  IRealtimePublisher,
  ITicketRepository,
} from '@sac/shared';

import { AgentService } from '../../application/AgentService';
import { InMemoryCache } from '../../application/__tests__/accountFakes';
import { StubAgentRepository } from '../../application/__tests__/platformFakes';
import { buildHttpApp } from '../app';
import type { RealtimeHub } from '../realtime-hub';
import type { HttpServerOptions } from '../types';

/**
 * End-to-end (in-process) proof of the P0 access-token revocation.
 *
 * The REAL `buildHttpApp` route graph, the REAL JWT guard and the REAL
 * `AgentService` (only the repositories/cache are in-memory) are exercised:
 *
 *   login -> GET /auth/me (200) -> POST /auth/logout (204)
 *         -> GET /auth/me with the SAME bearer -> 401 AUTHENTICATION_ERROR
 *
 * No network, no database, no Redis: `app.inject` only.
 */

const JWT_SECRET = 'unit-test-secret-with-32-characters!!';
const PASSWORD = 'CorrectHorse123!';

const silentLogger: ILogger = {
  child(): ILogger {
    return this;
  },
  trace(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

const silentRealtime: IRealtimePublisher = {
  ticketUpdated(): void {},
  messageCreated(): void {},
  queueChanged(): void {},
  channelHealth(): void {},
  agentPresence(): void {},
};

const tickets = {
  countActiveByAgent: async (): Promise<number> => 0,
} as unknown as ITicketRepository;

const fakeHub = {
  attach: (): void => undefined,
  close: async (): Promise<void> => undefined,
  publisher: { agentPresence: (): void => undefined },
} as unknown as RealtimeHub;

/**
 * Deep service double: the auth suite exercises `agents`/`sessions`/`cache`/
 * `clock` explicitly; every other port resolves to an inert proxy so the real
 * route registration keeps working without a 60-method mock.
 */
function serviceTree(overrides: Record<string, unknown> = {}): IAppServices {
  const makeNode = (bag: Record<string, unknown>): unknown => {
    let node: unknown;
    const handler: ProxyHandler<(...args: unknown[]) => void> = {
      get(_target, property) {
        if (property === 'then') return undefined;
        if (typeof property === 'string' && Object.prototype.hasOwnProperty.call(bag, property)) {
          return bag[property];
        }
        return node;
      },
      apply() {
        return node;
      },
    };
    node = new Proxy(function noop(): void {}, handler);
    return node;
  };

  return makeNode({ logger: silentLogger, ...overrides }) as IAppServices;
}

function serverOptions(): HttpServerOptions {
  return {
    jwtSecret: JWT_SECRET,
    webOrigin: 'https://app.example.test',
    appBaseUrl: 'https://api.example.test',
    logger: silentLogger,
  };
}

let passwordHash = '';

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

function decode(token: string): jwt.JwtPayload {
  return jwt.verify(token, JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: 'sac-hub',
    audience: 'sac-web',
  }) as jwt.JwtPayload;
}

interface Harness {
  app: FastifyInstance;
  cache: InMemoryCache;
  agentId: string;
  sessions: { revoke: ReturnType<typeof vi.fn>; revokeAllForUser: ReturnType<typeof vi.fn> };
  login: () => Promise<string>;
}

async function buildHarness(): Promise<Harness> {
  const cache = new InMemoryCache();
  const agentsRepo = new StubAgentRepository();
  const clock: IClock = { now: () => new Date() };

  const agent = agentsRepo.seed({
    email: 'admin@acme.test',
    passwordHash,
    tenantId: 'tenant-1',
    role: 'ADMIN',
  });

  const agents = new AgentService({
    logger: silentLogger,
    clock,
    cache,
    realtime: silentRealtime,
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '1h',
    presenceTtlSeconds: 120,
    repos: { agents: agentsRepo, tickets },
  });

  const sessions = {
    revoke: vi.fn(async () => true),
    revokeAllForUser: vi.fn(async () => 1),
  };

  const app = await buildHttpApp(
    serviceTree({ agents, sessions, cache, clock }),
    fakeHub,
    serverOptions(),
  );
  await app.ready();

  const login = async (): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'admin@acme.test', password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { data: { token: string } }).data.token;
  };

  return { app, cache, agentId: agent.id, sessions, login };
}

describe('access-token revocation (HTTP)', () => {
  it('login -> logout -> /auth/me with the same token answers 401', async () => {
    const h = await buildHarness();
    try {
      const token = await h.login();
      const claims = decode(token);
      const jti = String(claims.jti);
      const denyKey = `sac:auth:deny:${jti}`;

      // The token works before logout.
      const before = await h.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toMatchObject({ data: { email: 'admin@acme.test' } });
      expect(h.cache.entries.has(denyKey)).toBe(false);

      // Logout: no refreshToken in the body => "logout everywhere" + jti deny.
      const logout = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: {},
      });
      expect(logout.statusCode).toBe(204);
      expect(h.sessions.revokeAllForUser).toHaveBeenCalledWith(h.agentId);
      expect(h.cache.entries.get(denyKey)).toBe('1');

      // The SAME bearer is now rejected by the global guard (401).
      const after = await h.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(after.statusCode).toBe(401);
      expect(after.json()).toMatchObject({ error: { code: 'AUTHENTICATION_ERROR' } });
    } finally {
      await h.app.close();
    }
  });

  it('logout WITH a refreshToken does not revoke the access token of another session', async () => {
    const h = await buildHarness();
    try {
      const first = await h.login();
      const second = await h.login();

      // Distinct tokens => distinct jti, so only the presented one is denied.
      expect(decode(first).jti).not.toBe(decode(second).jti);

      const logout = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { authorization: `Bearer ${first}`, 'content-type': 'application/json' },
        // Single-device logout: no user watermark, only this session + this jti.
        payload: { refreshToken: 'a'.repeat(96) },
      });
      expect(logout.statusCode).toBe(204);
      expect(h.sessions.revoke).toHaveBeenCalledWith('a'.repeat(96), h.agentId);
      expect(h.sessions.revokeAllForUser).not.toHaveBeenCalled();

      const revoked = await h.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${first}` },
      });
      expect(revoked.statusCode).toBe(401);

      const stillValid = await h.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${second}` },
      });
      expect(stillValid.statusCode).toBe(200);
    } finally {
      await h.app.close();
    }
  });
});
