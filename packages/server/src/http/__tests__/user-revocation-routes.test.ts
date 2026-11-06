import bcrypt from 'bcryptjs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  IAppServices,
  IAuthSessionService,
  IClock,
  IEmailService,
  IEmailVerificationRepository,
  ILogger,
  IRealtimePublisher,
  ITenantRepository,
  ITicketRepository,
} from '@sac/shared';

import { AgentService } from '../../application/AgentService';
import { AuthService } from '../../application/AuthService';
import { hashToken } from '../../application/auth/access-token';
import { InMemoryCache } from '../../application/__tests__/accountFakes';
import {
  InMemoryPasswordResetRepository,
  InMemorySessionRepository,
} from '../../application/__tests__/authFakes';
import { StubAgentRepository } from '../../application/__tests__/platformFakes';
import { buildHttpApp } from '../app';
import type { RealtimeHub } from '../realtime-hub';
import type { HttpServerOptions } from '../types';

/**
 * End-to-end (in-process) proof of the per-user access-token watermark:
 *
 *   login (device A + B) -> POST /auth/reset-password
 *        -> both old bearers answer 401 AUTHENTICATION_ERROR
 *        -> a fresh login (after the revocation second) answers 200
 *
 *   login (device A + B) -> POST /auth/logout WITHOUT refreshToken
 *        -> both old bearers answer 401, new login answers 200
 *
 * The REAL `buildHttpApp` route graph, the REAL JWT guard, the REAL
 * `AgentService` and the REAL `AuthService` are exercised (only repositories
 * and the cache are in-memory). No network, no database, no Redis.
 *
 * `Date` is faked so `iat`/watermark second boundaries are deterministic: the
 * watermark is `<=` (`iat <= watermark` is revoked), so the tests advance the
 * clock past the revocation second before minting the "new login" token.
 */

const JWT_SECRET = 'unit-test-secret-with-32-characters!!';
const PASSWORD = 'CorrectHorse123!';
const NEW_PASSWORD = 'AnotherCorrectHorse456!';
const RESET_TOKEN = 'a1'.repeat(32);
const T0 = new Date('2026-06-01T12:00:00.000Z');

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

const fakeEmail: IEmailService = {
  async sendVerificationEmail(): Promise<void> {},
  async sendPasswordResetEmail(): Promise<void> {},
  async sendInvitationEmail(): Promise<void> {},
  async sendNewSessionAlert(): Promise<void> {},
  async sendRoleChangedAlert(): Promise<void> {},
  async sendAccountDeactivatedAlert(): Promise<void> {},
  async sendAccountReactivatedAlert(): Promise<void> {},
};

const unusedTenants = {
  async create(): Promise<never> {
    throw new Error('tenant repository is not used by these flows');
  },
  async findBySlug(): Promise<null> {
    return null;
  },
  async findById(): Promise<null> {
    return null;
  },
  async delete(): Promise<void> {},
} as unknown as ITenantRepository;

const unusedEmailVerifications = {
  async create(): Promise<never> {
    throw new Error('verification repository is not used by these flows');
  },
  async findByTokenHash(): Promise<null> {
    return null;
  },
  async markUsed(): Promise<void> {},
  async invalidateUnused(): Promise<number> {
    return 0;
  },
} as unknown as IEmailVerificationRepository;

const fakeHub = {
  attach: (): void => undefined,
  close: async (): Promise<void> => undefined,
  publisher: { agentPresence: (): void => undefined },
} as unknown as RealtimeHub;

/** Ship only the ports these routes touch; everything else is an inert proxy. */
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

interface Harness {
  app: FastifyInstance;
  cache: InMemoryCache;
  agentId: string;
  passwordResets: InMemoryPasswordResetRepository;
  login: (password: string) => Promise<string>;
  me: (token: string) => Promise<{ statusCode: number; body: Record<string, unknown> }>;
}

async function buildHarness(withAuthService: boolean): Promise<Harness> {
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

  const sessionsStub = {
    revoke: vi.fn(async () => true),
    revokeAllForUser: vi.fn(async () => 1),
  } as unknown as IAuthSessionService;

  const passwordResets = new InMemoryPasswordResetRepository(clock);
  const auth = withAuthService
    ? new AuthService({
        logger: silentLogger,
        clock,
        cache,
        email: fakeEmail,
        config: { webOrigin: 'https://app.example.test', appBaseUrl: 'https://api.example.test' },
        repos: {
          agents: agentsRepo,
          tenants: unusedTenants,
          emailVerifications: unusedEmailVerifications,
          passwordResets,
          sessions: new InMemorySessionRepository(clock),
        },
      })
    : ({
        resetPassword: async (): Promise<void> => undefined,
      } as unknown as AuthService);

  const app = await buildHttpApp(
    serviceTree({ agents, auth, sessions: sessionsStub, cache, clock }),
    fakeHub,
    serverOptions(),
  );
  await app.ready();

  const login = async (password: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'admin@acme.test', password },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { data: { token: string } }).data.token;
  };

  const me = async (
    token: string,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
  };

  return { app, cache, agentId: agent.id, passwordResets, login, me };
}

async function withFakeDate<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(T0);
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

describe('per-user access-token revocation (HTTP)', () => {
  it('reset-password revokes every old access token; a new login still works', async () => {
    await withFakeDate(async () => {
      const h = await buildHarness(true);
      try {
        // Two devices, both with a valid access token for the SAME operator.
        const deviceA = await h.login(PASSWORD);
        const deviceB = await h.login(PASSWORD);
        expect((await h.me(deviceA)).statusCode).toBe(200);
        expect((await h.me(deviceB)).statusCode).toBe(200);

        // A reset link minted before the revocation instant (30 min TTL).
        await h.passwordResets.create({
          userId: h.agentId,
          tokenHash: hashToken(RESET_TOKEN),
          expiresAt: new Date(T0.getTime() + 30 * 60 * 1000),
        });

        // Move past the login second: the watermark must be strictly later.
        vi.setSystemTime(new Date(T0.getTime() + 2_000));

        const reset = await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/reset-password',
          headers: { 'content-type': 'application/json' },
          payload: { token: RESET_TOKEN, password: NEW_PASSWORD },
        });
        expect(reset.statusCode).toBe(200);

        for (const token of [deviceA, deviceB]) {
          const revoked = await h.me(token);
          expect(revoked.statusCode).toBe(401);
          expect(revoked.body).toMatchObject({ error: { code: 'AUTHENTICATION_ERROR' } });
        }

        // Past the watermark second: the post-reset login is accepted.
        vi.setSystemTime(new Date(T0.getTime() + 4_000));
        const fresh = await h.login(NEW_PASSWORD);
        expect((await h.me(fresh)).statusCode).toBe(200);
      } finally {
        await h.app.close();
      }
    });
  });

  it('logout everywhere (no refreshToken) revokes every old access token; a new login works', async () => {
    await withFakeDate(async () => {
      const h = await buildHarness(false);
      try {
        const deviceA = await h.login(PASSWORD);
        const deviceB = await h.login(PASSWORD);

        const logout = await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/logout',
          headers: { authorization: `Bearer ${deviceA}`, 'content-type': 'application/json' },
          payload: {},
        });
        expect(logout.statusCode).toBe(204);

        // Device A is covered by its `jti` denylist, device B only by the
        // per-user watermark - the actual proof of bulk revocation.
        for (const token of [deviceA, deviceB]) {
          const revoked = await h.me(token);
          expect(revoked.statusCode).toBe(401);
          expect(revoked.body).toMatchObject({ error: { code: 'AUTHENTICATION_ERROR' } });
        }

        vi.setSystemTime(new Date(T0.getTime() + 2_000));
        const fresh = await h.login(PASSWORD);
        expect((await h.me(fresh)).statusCode).toBe(200);
      } finally {
        await h.app.close();
      }
    });
  });
});
