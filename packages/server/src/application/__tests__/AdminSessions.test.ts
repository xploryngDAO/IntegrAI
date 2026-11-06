import { describe, expect, it } from 'vitest';
import type { AgentRecord, ILogger } from '@sac/shared';

import { AdminUserService } from '../AdminUserService';
import { InMemoryCache } from './accountFakes';
import { InMemorySessionRepository } from './authFakes';
import { InMemoryAdminUserRepository, InMemoryTwoFactorRepository, RecordingAuditService } from './adminFakes';

/**
 * Workspace session administration (`GET/DELETE /admin/sessions`):
 *  - only LIVE sessions of the caller's tenant are listed (revoked/expired and
 *    cross-tenant rows are invisible);
 *  - the order is `lastUsedAt DESC NULLS LAST`, then `createdAt DESC`;
 *  - `current` comes from the access-token `sid` claim;
 *  - DELETE revokes one device, audits `admin.session.revoked` with the masked
 *    operator e-mail and refuses the caller's own current session with 409;
 *  - unknown/foreign/already-revoked ids are the same 404 (no existence leak).
 */

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

const T0 = new Date('2026-11-06T12:00:00.000Z');
const ACTOR = {
  id: 'admin-1',
  email: 'admin@acme.test',
  tenantId: 'tenant-1',
  ip: '203.0.113.7',
  userAgent: 'Chrome',
};

function build() {
  const clock = { now: () => new Date(T0.getTime()) };
  const cache = new InMemoryCache();
  const audit = new RecordingAuditService();
  const sessions = new InMemorySessionRepository(clock);
  const repo = new InMemoryAdminUserRepository(clock);
  const twoFactor = new InMemoryTwoFactorRepository(repo);
  const service = new AdminUserService({
    logger: silentLogger,
    clock,
    cache,
    audit,
    repos: { adminUsers: repo, sessions, twoFactor },
  });
  return { clock, audit, sessions, repo, twoFactor, service };
}

function seedAgent(
  repo: InMemoryAdminUserRepository,
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
  return repo.seed({
    tenantId: 'tenant-1',
    role: 'AGENT',
    name: 'Agent',
    email: 'agent@acme.test',
    ...overrides,
  });
}

describe('AdminUserService.listSessions', () => {
  it('lists only LIVE sessions of the caller tenant, joined with the operator', async () => {
    const { repo, service } = build();
    const ana = seedAgent(repo, { id: 'agent-1', name: 'Ana', email: 'ana@acme.test' });
    const bob = seedAgent(repo, { id: 'agent-2', name: 'Bob', email: 'bob@acme.test' });
    seedAgent(repo, { id: 'foreign', tenantId: 'tenant-2' });

    const live = repo.seedSession(ana.id, {
      id: 'session-live',
      userAgent: 'Chrome',
      ip: '203.0.113.7',
      createdAt: new Date(T0.getTime() - 60_000),
      lastUsedAt: new Date(T0.getTime() - 30_000),
    });
    repo.seedSession(ana.id, {
      id: 'session-revoked',
      revokedAt: new Date(T0.getTime() - 10_000),
    });
    repo.seedSession(ana.id, {
      id: 'session-expired',
      expiresAt: new Date(T0.getTime() - 1),
    });
    repo.seedSession('foreign', { id: 'session-foreign' });
    // Stale tenant on the session row: the agent tenant still wins.
    repo.seedSession(bob.id, { id: 'session-stale-tenant', tenantId: 'tenant-2' });
    repo.seedSession(bob.id, {
      id: 'session-bob',
      createdAt: new Date(T0.getTime() - 120_000),
      lastUsedAt: null,
    });

    const result = await service.listSessions('tenant-1');

    expect(result.total).toBe(2);
    expect(result.items.map((entry) => entry.id)).toEqual(['session-live', 'session-bob']);
    expect(result.items[0]).toEqual({
      id: 'session-live',
      agentId: ana.id,
      name: 'Ana',
      email: 'ana@acme.test',
      role: 'AGENT',
      ip: '203.0.113.7',
      userAgent: 'Chrome',
      createdAt: new Date(T0.getTime() - 60_000).toISOString(),
      lastUsedAt: new Date(T0.getTime() - 30_000).toISOString(),
      current: false,
    });
    expect(result.items[1]).toMatchObject({ id: 'session-bob', lastUsedAt: null });
    expect(live.revokedAt).toBeNull();
  });

  it('orders by lastUsedAt DESC NULLS LAST and then createdAt DESC', async () => {
    const { repo, service } = build();
    const ana = seedAgent(repo, { id: 'agent-1' });

    repo.seedSession(ana.id, {
      id: 'older-use',
      lastUsedAt: new Date(T0.getTime() - 60_000),
      createdAt: new Date(T0.getTime() - 300_000),
    });
    repo.seedSession(ana.id, {
      id: 'tie-older-created',
      lastUsedAt: new Date(T0.getTime() - 10_000),
      createdAt: new Date(T0.getTime() - 200_000),
    });
    repo.seedSession(ana.id, {
      id: 'tie-newer-created',
      lastUsedAt: new Date(T0.getTime() - 10_000),
      createdAt: new Date(T0.getTime() - 100_000),
    });
    repo.seedSession(ana.id, {
      id: 'never-used',
      lastUsedAt: null,
      createdAt: new Date(T0.getTime() - 1_000),
    });

    const result = await service.listSessions('tenant-1');

    expect(result.items.map((entry) => entry.id)).toEqual([
      'tie-newer-created',
      'tie-older-created',
      'older-use',
      'never-used',
    ]);
  });

  it('flags only the sid-matching row as current (legacy tokens flag none)', async () => {
    const { repo, service } = build();
    const ana = seedAgent(repo, { id: 'agent-1' });
    repo.seedSession(ana.id, { id: 'session-1', createdAt: new Date(T0.getTime() - 2_000) });
    repo.seedSession(ana.id, { id: 'session-2', createdAt: new Date(T0.getTime() - 1_000) });

    const withSid = await service.listSessions('tenant-1', {}, 'session-1');
    expect(withSid.items.map((entry) => [entry.id, entry.current])).toEqual([
      ['session-2', false],
      ['session-1', true],
    ]);

    const legacy = await service.listSessions('tenant-1');
    expect(legacy.items.every((entry) => entry.current === false)).toBe(true);
  });

  it('defaults to page 1 / perPage 50 and clamps out-of-range pagination', async () => {
    const { repo, service } = build();
    const ana = seedAgent(repo, { id: 'agent-1' });
    repo.seedSession(ana.id, { id: 'session-1' });

    await service.listSessions('tenant-1');
    expect(repo.lastSessionFilter).toEqual({ tenantId: 'tenant-1', offset: 0, limit: 50 });

    await service.listSessions('tenant-1', { page: 0, perPage: 1_000 });
    expect(repo.lastSessionFilter).toEqual({ tenantId: 'tenant-1', offset: 0, limit: 100 });

    await service.listSessions('tenant-1', { page: 3, perPage: 10 });
    expect(repo.lastSessionFilter).toEqual({ tenantId: 'tenant-1', offset: 20, limit: 10 });
  });
});

describe('AdminUserService.revokeSession', () => {
  it('revokes one session, stamps revokedAt and audits admin.session.revoked', async () => {
    const { repo, audit, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    const bob = seedAgent(repo, {
      id: 'agent-2',
      name: 'Bob',
      email: 'bob@acme.test',
      role: 'SUPERVISOR',
    });
    const session = repo.seedSession(bob.id, { id: 'session-target' });

    await expect(
      service.revokeSession('tenant-1', ACTOR, session.id),
    ).resolves.toBeUndefined();

    expect(session.revokedAt).toEqual(T0);
    expect(audit.actions()).toEqual(['admin.session.revoked']);
    expect(audit.recorded[0]).toMatchObject({
      tenantId: 'tenant-1',
      actorId: 'admin-1',
      actorEmail: 'admin@acme.test',
      ip: '203.0.113.7',
      userAgent: 'Chrome',
      resourceType: 'session',
      resourceId: 'session-target',
      metadata: {
        // PII: the full address must never reach the audit row.
        agentEmail: 'bo***@acme.test',
        targetAgentId: 'agent-2',
      },
    });
  });

  it('allows revoking another session of the caller (only the CURRENT one is refused)', async () => {
    const { repo, audit, service } = build();
    const admin = seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    const previous = repo.seedSession(admin.id, { id: 'session-previous' });

    await service.revokeSession('tenant-1', ACTOR, previous.id, 'session-current');

    expect(previous.revokedAt).toEqual(T0);
    expect(audit.actions()).toEqual(['admin.session.revoked']);
  });

  it('refuses to revoke the current session with 409 and leaves it untouched', async () => {
    const { repo, audit, service } = build();
    const admin = seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    const current = repo.seedSession(admin.id, { id: 'session-current' });

    await expect(
      service.revokeSession('tenant-1', ACTOR, current.id, current.id),
    ).rejects.toMatchObject({ code: 'CANNOT_REVOKE_CURRENT_SESSION', httpStatus: 409 });

    expect(current.revokedAt).toBeNull();
    expect(audit.recorded).toHaveLength(0);
  });

  it('answers 404 for unknown, cross-tenant, already-revoked and expired sessions', async () => {
    const { repo, audit, service } = build();
    const ana = seedAgent(repo, { id: 'agent-1' });
    seedAgent(repo, { id: 'foreign', tenantId: 'tenant-2' });

    const revoked = repo.seedSession(ana.id, {
      id: 'session-revoked',
      revokedAt: new Date(T0.getTime() - 1_000),
    });
    const expired = repo.seedSession(ana.id, {
      id: 'session-expired',
      expiresAt: new Date(T0.getTime() - 1),
    });
    const foreign = repo.seedSession('foreign', { id: 'session-foreign' });

    for (const id of ['session-missing', revoked.id, expired.id, foreign.id]) {
      await expect(service.revokeSession('tenant-1', ACTOR, id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        httpStatus: 404,
      });
    }

    expect(foreign.revokedAt).toBeNull();
    expect(expired.revokedAt).toBeNull();
    expect(audit.recorded).toHaveLength(0);
  });
});
