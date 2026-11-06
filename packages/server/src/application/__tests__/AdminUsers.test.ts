import { describe, expect, it } from 'vitest';
import type { AgentRecord, ILogger } from '@sac/shared';
import { ADMIN_USERS_EXPORT_MAX_ROWS } from '@sac/shared';

import { userRevocationWatermarkKey } from '../auth/access-token-revocation';
import { AdminUserService } from '../AdminUserService';
import { InMemoryCache } from './accountFakes';
import { InMemorySessionRepository } from './authFakes';
import { InMemoryAdminUserRepository, RecordingAuditService } from './adminFakes';

/**
 * Workspace user administration guards:
 *  - tenant isolation (a foreign id is a 404);
 *  - self-change and self-revocation are refused (409);
 *  - the last ACTIVE ADMIN can neither be demoted nor deactivated (409);
 *  - every effective mutation is audited with the right action code;
 *  - bulk revocation closes the refresh sessions AND stamps the JWT watermark.
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

function build() {
  const clock = { now: () => new Date(T0.getTime()) };
  const cache = new InMemoryCache();
  const audit = new RecordingAuditService();
  const sessions = new InMemorySessionRepository(clock);
  const repo = new InMemoryAdminUserRepository(clock);
  const service = new AdminUserService({
    logger: silentLogger,
    clock,
    cache,
    audit,
    repos: { adminUsers: repo, sessions },
  });
  return { clock, cache, audit, sessions, repo, service };
}

const ACTOR = { id: 'admin-1', email: 'admin@acme.test', tenantId: 'tenant-1', ip: '203.0.113.7' };

function seedAgent(
  repo: InMemoryAdminUserRepository,
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
  return repo.seed({
    tenantId: 'tenant-1',
    role: 'AGENT',
    name: 'Agent',
    email: `agent-${Math.random().toString(36).slice(2, 8)}@acme.test`,
    ...overrides,
  });
}

describe('AdminUserService.list', () => {
  it('is tenant-scoped, ordered by createdAt and carries the counters', async () => {
    const { repo, service } = build();
    const first = seedAgent(repo, {
      id: 'agent-1',
      role: 'ADMIN',
      createdAt: new Date(T0.getTime()),
    });
    const second = seedAgent(repo, {
      id: 'agent-2',
      createdAt: new Date(T0.getTime() + 60_000),
    });
    seedAgent(repo, { id: 'foreign', tenantId: 'tenant-2' });

    repo.sessionsCount.set(first.id, 3);
    repo.lastLoginAt.set(first.id, new Date('2026-11-05T10:00:00.000Z'));

    const result = await service.list('tenant-1');

    expect(result.total).toBe(2);
    expect(result.items.map((entry) => entry.id)).toEqual(['agent-1', 'agent-2']);
    expect(result.items[0]).toEqual({
      id: 'agent-1',
      name: first.name,
      email: first.email,
      role: 'ADMIN',
      isActive: true,
      lastLoginAt: '2026-11-05T10:00:00.000Z',
      createdAt: T0.toISOString(),
      sessionsCount: 3,
    });
    expect(result.items[1]).toMatchObject({ id: 'agent-2', lastLoginAt: null, sessionsCount: 0 });
    expect(second.id).toBe('agent-2');
  });

  it('defaults to page 1 / perPage 25 and clamps out-of-range pagination', async () => {
    const { repo, service } = build();
    seedAgent(repo, { id: 'agent-1', createdAt: new Date(T0.getTime()) });

    const defaults = await service.list('tenant-1');
    expect(defaults).toMatchObject({ page: 1, perPage: 25, total: 1 });

    const clampedPage = await service.list('tenant-1', { page: 0 });
    expect(clampedPage.page).toBe(1);

    const clampedPerPage = await service.list('tenant-1', { perPage: 1_000 });
    expect(clampedPerPage.perPage).toBe(100);
  });

  it('searches name OR email case-insensitively after trimming the term', async () => {
    const { repo, service } = build();
    seedAgent(repo, {
      id: 'agent-1',
      name: 'Ana Admin',
      email: 'ana@acme.test',
    });
    seedAgent(repo, {
      id: 'agent-2',
      name: 'Bob',
      email: 'ana.silva@acme.test',
    });
    seedAgent(repo, { id: 'foreign', tenantId: 'tenant-2', name: 'Ana Foreign' });

    const byName = await service.list('tenant-1', { search: '  ANA  ' });
    expect(byName.total).toBe(2);
    expect(byName.items.map((entry) => entry.id)).toEqual(['agent-1', 'agent-2']);

    const byEmail = await service.list('tenant-1', { search: 'ANA.SILVA@' });
    expect(byEmail.total).toBe(1);
    expect(byEmail.items[0]?.id).toBe('agent-2');

    const blank = await service.list('tenant-1', { search: '   ' });
    expect(blank.total).toBe(2);
  });

  it('combines role + status filters with pagination and reports the filtered total', async () => {
    const { repo, service } = build();
    seedAgent(repo, {
      id: 'agent-1',
      name: 'Ana Admin',
      role: 'ADMIN',
      createdAt: new Date(T0.getTime()),
    });
    seedAgent(repo, {
      id: 'agent-2',
      name: 'Ana Admin',
      role: 'ADMIN',
      isActive: false,
      createdAt: new Date(T0.getTime() + 1_000),
    });
    seedAgent(repo, {
      id: 'agent-3',
      name: 'Bob Agent',
      role: 'AGENT',
      createdAt: new Date(T0.getTime() + 2_000),
    });
    seedAgent(repo, {
      id: 'agent-4',
      name: 'Carol Agent',
      role: 'AGENT',
      createdAt: new Date(T0.getTime() + 3_000),
    });
    seedAgent(repo, {
      id: 'agent-5',
      name: 'Sara Supervisor',
      role: 'SUPERVISOR',
      createdAt: new Date(T0.getTime() + 4_000),
    });
    seedAgent(repo, { id: 'foreign', tenantId: 'tenant-2', role: 'AGENT' });

    const secondPage = await service.list('tenant-1', {
      role: 'AGENT',
      status: 'ACTIVE',
      page: 2,
      perPage: 1,
    });

    expect(secondPage.total).toBe(2); // FILTERED set, not the 5-row team
    expect(secondPage.page).toBe(2);
    expect(secondPage.perPage).toBe(1);
    expect(secondPage.items.map((entry) => entry.id)).toEqual(['agent-4']);

    const inactive = await service.list('tenant-1', { status: 'INACTIVE' });
    expect(inactive.total).toBe(1);
    expect(inactive.items.map((entry) => entry.id)).toEqual(['agent-2']);

    const combined = await service.list('tenant-1', {
      search: 'admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    expect(combined.total).toBe(1);
    expect(combined.items.map((entry) => entry.id)).toEqual(['agent-1']);
  });

  it('breaks createdAt ties by id so pagination is deterministic', async () => {
    const { repo, service } = build();
    seedAgent(repo, { id: 'agent-b', createdAt: new Date(T0.getTime()) });
    seedAgent(repo, { id: 'agent-a', createdAt: new Date(T0.getTime()) });

    const result = await service.list('tenant-1');

    expect(result.items.map((entry) => entry.id)).toEqual(['agent-a', 'agent-b']);
  });
});

describe('AdminUserService.exportRows', () => {
  it('returns the filtered rows without pagination and keeps the tenant scope', async () => {
    const { repo, service } = build();
    seedAgent(repo, { id: 'agent-1', role: 'AGENT', createdAt: new Date(T0.getTime()) });
    seedAgent(repo, {
      id: 'agent-2',
      role: 'AGENT',
      createdAt: new Date(T0.getTime() + 1_000),
    });
    seedAgent(repo, {
      id: 'agent-3',
      role: 'ADMIN',
      createdAt: new Date(T0.getTime() + 2_000),
    });
    seedAgent(repo, { id: 'foreign', tenantId: 'tenant-2', role: 'AGENT' });

    const rows = await service.exportRows('tenant-1', { role: 'AGENT' });

    expect(rows.map((row) => row.id)).toEqual(['agent-1', 'agent-2']);
    expect(repo.lastFilter).toMatchObject({
      tenantId: 'tenant-1',
      role: 'AGENT',
      offset: 0,
      limit: ADMIN_USERS_EXPORT_MAX_ROWS,
    });

    const capped = await service.exportRows('tenant-1', {}, 2);
    expect(capped.map((row) => row.id)).toEqual(['agent-1', 'agent-2']);
    expect(repo.lastFilter?.limit).toBe(2);
  });

  it('hard-caps the limit at 10k even when a caller asks for more', async () => {
    const { repo, service } = build();
    seedAgent(repo, { id: 'agent-1' });

    await service.exportRows('tenant-1', {}, 50_000);

    expect(repo.lastFilter?.limit).toBe(ADMIN_USERS_EXPORT_MAX_ROWS);
    expect(ADMIN_USERS_EXPORT_MAX_ROWS).toBe(10_000);
  });
});

describe('AdminUserService.update', () => {
  it('changes the role and audits admin.user.role_changed', async () => {
    const { repo, audit, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    seedAgent(repo, { id: 'agent-2', role: 'AGENT' });
    seedAgent(repo, { id: 'admin-3', role: 'ADMIN' });

    const result = await service.update('tenant-1', ACTOR, 'agent-2', { role: 'ADMIN' });

    expect(result.role).toBe('ADMIN');
    expect(audit.actions()).toEqual(['admin.user.role_changed']);
    expect(audit.recorded[0]).toMatchObject({
      tenantId: 'tenant-1',
      actorId: 'admin-1',
      actorEmail: 'admin@acme.test',
      resourceType: 'user',
      resourceId: 'agent-2',
      metadata: { from: 'AGENT', to: 'ADMIN' },
    });
  });

  it('refuses to change its own role or active flag with 409', async () => {
    const { repo, audit, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });

    await expect(
      service.update('tenant-1', ACTOR, 'admin-1', { role: 'AGENT' }),
    ).rejects.toMatchObject({ code: 'CANNOT_MODIFY_SELF', httpStatus: 409 });
    await expect(
      service.update('tenant-1', ACTOR, 'admin-1', { isActive: false }),
    ).rejects.toMatchObject({ code: 'CANNOT_MODIFY_SELF', httpStatus: 409 });

    expect(audit.recorded).toHaveLength(0);
  });

  it('refuses to demote or deactivate the last active ADMIN with 409', async () => {
    const { repo, audit, service } = build();
    // The target is the ONLY active ADMIN of the workspace (the actor is not
    // required to be a row for the guard; its id simply differs).
    const target = seedAgent(repo, { id: 'admin-2', role: 'ADMIN' });

    expect(target.role).toBe('ADMIN');
    await expect(
      service.update('tenant-1', ACTOR, 'admin-2', { role: 'AGENT' }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN_PROTECTED', httpStatus: 409 });
    await expect(
      service.update('tenant-1', ACTOR, 'admin-2', { isActive: false }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN_PROTECTED', httpStatus: 409 });

    expect(audit.recorded).toHaveLength(0);
  });

  it('allows demoting/deactivating an ADMIN when another active ADMIN remains', async () => {
    const { repo, audit, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    seedAgent(repo, { id: 'admin-2', role: 'ADMIN' });

    const demoted = await service.update('tenant-1', ACTOR, 'admin-2', { role: 'AGENT' });
    expect(demoted.role).toBe('AGENT');

    const deactivated = await service.update('tenant-1', ACTOR, 'admin-2', { isActive: false });
    expect(deactivated.isActive).toBe(false);

    expect(audit.actions()).toEqual([
      'admin.user.role_changed',
      'admin.user.deactivated',
    ]);
  });

  it('audits activation with admin.user.activated', async () => {
    const { repo, audit, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    seedAgent(repo, { id: 'agent-2', isActive: false });

    const result = await service.update('tenant-1', ACTOR, 'agent-2', { isActive: true });

    expect(result.isActive).toBe(true);
    expect(audit.actions()).toEqual(['admin.user.activated']);
    expect(audit.recorded[0]?.metadata).toEqual({
      isActive: true,
      previousIsActive: false,
    });
  });

  it('answers 404 for an operator of another tenant', async () => {
    const { repo, audit, service } = build();
    seedAgent(repo, { id: 'foreign', tenantId: 'tenant-2' });

    await expect(
      service.update('tenant-1', ACTOR, 'foreign', { role: 'AGENT' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    expect(audit.recorded).toHaveLength(0);
  });

  it('treats a no-op PATCH as a read (no audit row)', async () => {
    const { repo, audit, service } = build();
    seedAgent(repo, { id: 'agent-1', role: 'AGENT' });

    const result = await service.update('tenant-1', ACTOR, 'agent-1', { role: 'AGENT' });

    expect(result.role).toBe('AGENT');
    expect(audit.recorded).toHaveLength(0);
  });
});

describe('AdminUserService.revokeSessions', () => {
  it('revokes every refresh session, stamps the watermark and audits', async () => {
    const { repo, sessions, cache, audit, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    const target = seedAgent(repo, { id: 'agent-2' });

    for (const hash of ['hash-1', 'hash-2']) {
      await sessions.create({
        userId: target.id,
        tenantId: 'tenant-1',
        refreshTokenHash: hash,
        expiresAt: new Date(T0.getTime() + 86_400_000),
      });
    }

    const result = await service.revokeSessions('tenant-1', ACTOR, target.id);

    expect(result).toEqual({ revoked: 2 });
    expect(sessions.rows.every((row) => row.revokedAt !== null)).toBe(true);
    expect(cache.entries.get(userRevocationWatermarkKey(target.id))).toBe(
      Math.floor(T0.getTime() / 1000),
    );
    expect(audit.actions()).toEqual(['admin.user.sessions_revoked']);
    expect(audit.recorded[0]?.metadata).toEqual({ revoked: 2 });
  });

  it('refuses to revoke its own sessions with 409', async () => {
    const { repo, sessions, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    await sessions.create({
      userId: 'admin-1',
      tenantId: 'tenant-1',
      refreshTokenHash: 'hash-own',
      expiresAt: new Date(T0.getTime() + 86_400_000),
    });

    await expect(
      service.revokeSessions('tenant-1', ACTOR, 'admin-1'),
    ).rejects.toMatchObject({ code: 'CANNOT_REVOKE_OWN_SESSIONS', httpStatus: 409 });
    expect(sessions.rows[0]?.revokedAt).toBeNull();
  });

  it('answers 404 for a target of another tenant', async () => {
    const { repo, service } = build();
    seedAgent(repo, { id: 'foreign', tenantId: 'tenant-2' });

    await expect(
      service.revokeSessions('tenant-1', ACTOR, 'foreign'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });
});
