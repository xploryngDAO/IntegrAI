import bcrypt from 'bcryptjs';
import { beforeAll, describe, expect, it } from 'vitest';

import type { IRealtimePublisher, ITicketRepository } from '@sac/shared';

import { AgentService } from '../AgentService';
import { FrozenClock, InMemoryCache, silentLogger } from './accountFakes';
import {
  InMemoryTenantRepository,
  StubAgentRepository,
  makeTenant,
} from './platformFakes';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const PASSWORD = 'CorrectHorse123!';
const JWT_SECRET = 'unit-test-secret-with-32-characters!!';

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

let passwordHash = '';

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

function createHarness() {
  const clock = new FrozenClock(NOW);
  const tenants = new InMemoryTenantRepository(() => clock.now());
  const agents = new StubAgentRepository();
  const cache = new InMemoryCache();

  const service = new AgentService({
    logger: silentLogger,
    clock,
    cache,
    realtime: silentRealtime,
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '1h',
    presenceTtlSeconds: 120,
    tenants,
    repos: { agents, tickets },
  });

  return { clock, tenants, agents, cache, service };
}

function seedAgent(
  agents: StubAgentRepository,
  overrides: Parameters<StubAgentRepository['seed']>[0] = {},
) {
  return agents.seed({
    email: 'admin@acme.test',
    passwordHash,
    tenantId: 'tenant-1',
    role: 'ADMIN',
    ...overrides,
  });
}

describe('AgentService tenant lifecycle gate', () => {
  it('logs in and verifies a token for an ACTIVE workspace', async () => {
    const h = createHarness();
    h.tenants.seed(makeTenant({ id: 'tenant-1', slug: 'acme' }));
    const agent = seedAgent(h.agents);

    const result = await h.service.login('admin@acme.test', PASSWORD);

    expect('twoFactorRequired' in result).toBe(false);
    if ('twoFactorRequired' in result) return;

    const claims = await h.service.verifyToken(result.token);
    expect(claims).toMatchObject({
      agentId: agent.id,
      email: 'admin@acme.test',
      name: 'Ana Admin',
      role: 'ADMIN',
      tenantId: 'tenant-1',
      isPlatformAdmin: false,
    });
    // P0: every access token carries a revocation handle and its expiry.
    expect(claims.jti).toEqual(expect.any(String));
    expect(claims.tokenExpiresAt).toEqual(expect.any(Number));
  });

  it('propagates the platform admin flag in the access token', async () => {
    const h = createHarness();
    h.tenants.seed(makeTenant({ id: 'tenant-1', slug: 'acme' }));
    seedAgent(h.agents, { isPlatformAdmin: true });

    const result = await h.service.login('admin@acme.test', PASSWORD);
    if ('twoFactorRequired' in result) throw new Error('Expected a session');

    await expect(h.service.verifyToken(result.token)).resolves.toMatchObject({
      isPlatformAdmin: true,
    });
  });

  it('blocks login when the workspace was soft-deleted (403 TENANT_INACTIVE)', async () => {
    const h = createHarness();
    h.tenants.seed(
      makeTenant({
        id: 'tenant-1',
        slug: 'acme',
        status: 'DELETED',
        deletedAt: new Date('2026-11-04T12:00:00.000Z'),
      }),
    );
    seedAgent(h.agents);

    const failure = await h.service
      .login('admin@acme.test', PASSWORD)
      .then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({ code: 'TENANT_INACTIVE', httpStatus: 403 });
    expect(failure).toMatchObject({ details: { status: 'DELETED', tenantId: 'tenant-1' } });
  });

  it('blocks login when the workspace is suspended', async () => {
    const h = createHarness();
    h.tenants.seed(makeTenant({ id: 'tenant-1', slug: 'acme', status: 'SUSPENDED' }));
    seedAgent(h.agents);

    await expect(h.service.login('admin@acme.test', PASSWORD)).rejects.toMatchObject({
      code: 'TENANT_INACTIVE',
      httpStatus: 403,
    });
  });

  it('blocks login when the token workspace no longer exists', async () => {
    const h = createHarness();
    seedAgent(h.agents, { tenantId: 'ghost-tenant' });

    await expect(h.service.login('admin@acme.test', PASSWORD)).rejects.toMatchObject({
      code: 'TENANT_INACTIVE',
      httpStatus: 403,
    });
  });

  it('keeps answering 401 for a wrong password on a deleted workspace (no status leak)', async () => {
    const h = createHarness();
    h.tenants.seed(
      makeTenant({ id: 'tenant-1', slug: 'acme', status: 'DELETED', deletedAt: NOW }),
    );
    seedAgent(h.agents);

    await expect(h.service.login('admin@acme.test', 'WrongPassword1!')).rejects.toMatchObject({
      code: 'AUTHENTICATION_ERROR',
      httpStatus: 401,
    });
  });

  it('rejects a previously issued token once the workspace is deleted (403)', async () => {
    const h = createHarness();
    const tenant = h.tenants.seed(makeTenant({ id: 'tenant-1', slug: 'acme' }));
    seedAgent(h.agents);

    const result = await h.service.login('admin@acme.test', PASSWORD);
    if ('twoFactorRequired' in result) throw new Error('Expected a session');
    await expect(h.service.verifyToken(result.token)).resolves.toMatchObject({
      tenantId: 'tenant-1',
    });

    // LGPD soft delete lands while the access token is still valid.
    tenant.status = 'DELETED';
    tenant.deletedAt = NOW;

    await expect(h.service.verifyToken(result.token)).rejects.toMatchObject({
      code: 'TENANT_INACTIVE',
      httpStatus: 403,
    });
  });

  it('still accepts a legacy operator without a tenant', async () => {
    const h = createHarness();
    seedAgent(h.agents, { tenantId: null });

    const result = await h.service.login('admin@acme.test', PASSWORD);
    if ('twoFactorRequired' in result) throw new Error('Expected a session');

    await expect(h.service.verifyToken(result.token)).resolves.toMatchObject({
      tenantId: null,
    });
  });

  it('rejects malformed tokens with 401', async () => {
    const h = createHarness();

    await expect(h.service.verifyToken('not-a-jwt')).rejects.toMatchObject({
      code: 'AUTHENTICATION_ERROR',
      httpStatus: 401,
    });
  });
});
