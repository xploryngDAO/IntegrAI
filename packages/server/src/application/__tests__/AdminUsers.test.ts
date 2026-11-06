import { describe, expect, it, vi } from 'vitest';
import type {
  AccountStatusAlertEmail,
  AgentRecord,
  IEmailService,
  ILogger,
  ITenantRepository,
  RoleChangedAlertEmail,
} from '@sac/shared';
import { ADMIN_USERS_EXPORT_MAX_ROWS, redactPiiForLogs } from '@sac/shared';

import { userRevocationWatermarkKey } from '../auth/access-token-revocation';
import { AdminUserService } from '../AdminUserService';
import { InMemoryCache } from './accountFakes';
import { InMemorySessionRepository } from './authFakes';
import {
  InMemoryAdminUserRepository,
  InMemoryTwoFactorRepository,
  RecordingAuditService,
} from './adminFakes';

/**
 * Workspace user administration guards:
 *  - tenant isolation (a foreign id is a 404);
 *  - self-change and self-revocation are refused (409);
 *  - the last ACTIVE ADMIN can neither be demoted nor deactivated (409);
 *  - every effective mutation is audited with the right action code;
 *  - bulk revocation closes the refresh sessions AND stamps the JWT watermark;
 *  - an effective role/active change e-mails the AFFECTED operator (never the
 *    actor) without ever blocking the response.
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

const TENANT_NAME = 'Acme Ltda';

/** Records the account-management alerts, in delivery order. */
class RecordingAccountEmailService implements IEmailService {
  readonly roleChanges: RoleChangedAlertEmail[] = [];
  readonly deactivated: AccountStatusAlertEmail[] = [];
  readonly activated: AccountStatusAlertEmail[] = [];
  /** Every attempt, including the ones that throw (failure-path assertions). */
  attempts = 0;
  failNextAlert = false;

  async sendVerificationEmail(): Promise<void> {}

  async sendPasswordResetEmail(): Promise<void> {}

  async sendInvitationEmail(): Promise<void> {}

  async sendNewSessionAlert(): Promise<void> {
    // New-device alerts are covered by AuthService.test.ts.
  }

  async sendRoleChangedAlert(input: RoleChangedAlertEmail): Promise<void> {
    this.attempts += 1;
    this.failIfRequested();
    this.roleChanges.push(input);
  }

  async sendAccountDeactivatedAlert(input: AccountStatusAlertEmail): Promise<void> {
    this.attempts += 1;
    this.failIfRequested();
    this.deactivated.push(input);
  }

  async sendAccountReactivatedAlert(input: AccountStatusAlertEmail): Promise<void> {
    this.attempts += 1;
    this.failIfRequested();
    this.activated.push(input);
  }

  /** Delivered messages (any kind), for "nothing was sent" assertions. */
  delivered(): number {
    return this.roleChanges.length + this.deactivated.length + this.activated.length;
  }

  private failIfRequested(): void {
    if (!this.failNextAlert) return;
    this.failNextAlert = false;
    throw new Error('smtp unavailable');
  }
}

/**
 * Only `findById` is exercised (the alert body needs the workspace name); the
 * remaining `ITenantRepository` methods are intentionally absent and the double
 * is cast at the seam, like the other narrow fakes in this suite.
 */
class FakeTenantDirectory {
  readonly names = new Map<string, string>();
  failLookup = false;

  async findById(id: string): Promise<{ name: string } | null> {
    if (this.failLookup) throw new Error('tenant store unavailable');
    const name = this.names.get(id);
    return name === undefined ? null : { name };
  }
}

function build(options: { withEmail?: boolean } = {}) {
  const clock = { now: () => new Date(T0.getTime()) };
  const cache = new InMemoryCache();
  const audit = new RecordingAuditService();
  const sessions = new InMemorySessionRepository(clock);
  const repo = new InMemoryAdminUserRepository(clock);
  const twoFactor = new InMemoryTwoFactorRepository(repo);
  const email = new RecordingAccountEmailService();
  const tenants = new FakeTenantDirectory();
  tenants.names.set('tenant-1', TENANT_NAME);

  const service = new AdminUserService({
    logger: silentLogger,
    clock,
    cache,
    audit,
    ...(options.withEmail === false ? {} : { email }),
    tenants: tenants as unknown as ITenantRepository,
    repos: { adminUsers: repo, sessions, twoFactor },
  });
  return { clock, cache, audit, sessions, repo, twoFactor, service, email, tenants };
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
      twoFactorEnabled: false,
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

describe('AdminUserService.update + account alert e-mails', () => {
  /**
   * Lets every fire-and-forget continuation run before a "nothing was sent"
   * assertion. The alert chain awaits only in-memory doubles, so one macrotask
   * is enough.
   */
  async function flushAlerts(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('e-mails the target about an effective role change with the full payload', async () => {
    const { repo, email, audit, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    seedAgent(repo, { id: 'agent-2', role: 'AGENT', name: 'Ana', email: 'ana@acme.test' });

    const result = await service.update('tenant-1', ACTOR, 'agent-2', {
      role: 'SUPERVISOR',
    });
    expect(result.role).toBe('SUPERVISOR');

    await vi.waitFor(() => expect(email.roleChanges).toHaveLength(1));
    expect(email.roleChanges[0]).toEqual({
      to: 'ana@acme.test',
      name: 'Ana',
      previousRole: 'AGENT',
      newRole: 'SUPERVISOR',
      changedBy: 'admin@acme.test',
      tenantName: TENANT_NAME,
    });
    expect(email.deactivated).toHaveLength(0);
    expect(email.activated).toHaveLength(0);
    // The existing audit is untouched and never duplicated by the alert path.
    expect(audit.actions()).toEqual(['admin.user.role_changed']);
  });

  it('e-mails the target when the account is deactivated', async () => {
    const { repo, email, audit, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    seedAgent(repo, {
      id: 'agent-2',
      role: 'AGENT',
      name: 'Bruno',
      email: 'bruno@acme.test',
    });

    const result = await service.update('tenant-1', ACTOR, 'agent-2', { isActive: false });
    expect(result.isActive).toBe(false);

    await vi.waitFor(() => expect(email.deactivated).toHaveLength(1));
    expect(email.deactivated[0]).toEqual({
      to: 'bruno@acme.test',
      name: 'Bruno',
      changedBy: 'admin@acme.test',
      tenantName: TENANT_NAME,
    });
    expect(email.roleChanges).toHaveLength(0);
    expect(email.activated).toHaveLength(0);
    expect(audit.actions()).toEqual(['admin.user.deactivated']);
  });

  it('e-mails the target when the account is reactivated', async () => {
    const { repo, email, audit, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    seedAgent(repo, {
      id: 'agent-2',
      role: 'AGENT',
      name: 'Carla',
      email: 'carla@acme.test',
      isActive: false,
    });

    const result = await service.update('tenant-1', ACTOR, 'agent-2', { isActive: true });
    expect(result.isActive).toBe(true);

    await vi.waitFor(() => expect(email.activated).toHaveLength(1));
    expect(email.activated[0]).toEqual({
      to: 'carla@acme.test',
      name: 'Carla',
      changedBy: 'admin@acme.test',
      tenantName: TENANT_NAME,
    });
    expect(email.roleChanges).toHaveLength(0);
    expect(email.deactivated).toHaveLength(0);
    expect(audit.actions()).toEqual(['admin.user.activated']);
  });

  it('sends one alert per changed dimension when role AND active flag change together', async () => {
    const { repo, email, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    seedAgent(repo, {
      id: 'agent-2',
      role: 'AGENT',
      name: 'Diego',
      email: 'diego@acme.test',
    });

    await service.update('tenant-1', ACTOR, 'agent-2', {
      role: 'SUPERVISOR',
      isActive: false,
    });

    await vi.waitFor(() => expect(email.delivered()).toBe(2));
    expect(email.roleChanges).toHaveLength(1);
    expect(email.deactivated).toHaveLength(1);
    expect(email.activated).toHaveLength(0);
    expect(email.roleChanges[0]).toMatchObject({
      previousRole: 'AGENT',
      newRole: 'SUPERVISOR',
    });
    expect(email.deactivated[0]).toMatchObject({ to: 'diego@acme.test' });
  });

  it('does NOT e-mail when nothing effectively changed (same role / same status)', async () => {
    const { repo, email, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    seedAgent(repo, { id: 'agent-2', role: 'AGENT', isActive: true });

    await service.update('tenant-1', ACTOR, 'agent-2', { role: 'AGENT' });
    await service.update('tenant-1', ACTOR, 'agent-2', { isActive: true });
    await service.update('tenant-1', ACTOR, 'agent-2', {});

    await flushAlerts();
    expect(email.attempts).toBe(0);
    expect(email.delivered()).toBe(0);
  });

  it('never e-mails when an administrator tries to change its own account', async () => {
    const { repo, email, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN', email: 'admin@acme.test' });

    await expect(
      service.update('tenant-1', ACTOR, 'admin-1', { role: 'AGENT' }),
    ).rejects.toMatchObject({ code: 'CANNOT_MODIFY_SELF', httpStatus: 409 });

    await flushAlerts();
    expect(email.attempts).toBe(0);
  });

  it('keeps the update successful when the alert e-mail fails', async () => {
    const { repo, email, audit, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    seedAgent(repo, { id: 'agent-2', role: 'AGENT', email: 'ana@acme.test' });
    email.failNextAlert = true;

    const result = await service.update('tenant-1', ACTOR, 'agent-2', {
      role: 'SUPERVISOR',
    });

    expect(result.role).toBe('SUPERVISOR');
    expect(audit.actions()).toEqual(['admin.user.role_changed']);
    await vi.waitFor(() => expect(email.attempts).toBe(1));
    expect(email.roleChanges).toHaveLength(0);
  });

  it('still sends the alert (without workspace name) when the tenant lookup fails', async () => {
    const { repo, email, tenants, service } = build();
    tenants.failLookup = true;
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    seedAgent(repo, { id: 'agent-2', role: 'AGENT', email: 'ana@acme.test' });

    await service.update('tenant-1', ACTOR, 'agent-2', { isActive: false });

    await vi.waitFor(() => expect(email.deactivated).toHaveLength(1));
    expect(email.deactivated[0]).toMatchObject({
      to: 'ana@acme.test',
      changedBy: 'admin@acme.test',
      tenantName: null,
    });
  });

  it('works when the e-mail dependency is not wired (legacy harness)', async () => {
    const { repo, service } = build({ withEmail: false });
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    seedAgent(repo, { id: 'agent-2', role: 'AGENT' });

    const result = await service.update('tenant-1', ACTOR, 'agent-2', { role: 'SUPERVISOR' });

    expect(result.role).toBe('SUPERVISOR');
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

describe('AdminUserService.resetTwoFactor', () => {
  it('wipes TOTP + recovery codes, revokes the target sessions and audits (masked e-mail)', async () => {
    const { repo, twoFactor, sessions, cache, audit, service } = build();
    // The actor has its own factor and device: neither may be touched.
    const actor = seedAgent(repo, {
      id: 'admin-1',
      role: 'ADMIN',
      email: 'admin@acme.test',
    });
    twoFactor.seedEnabled(actor.id, { secretEnc: 'enc:actor', recoveryCodes: 4 });

    const target = seedAgent(repo, {
      id: 'agent-2',
      name: 'Bob',
      email: 'bob.silva@acme.test',
      role: 'SUPERVISOR',
      isActive: true,
    });
    twoFactor.seedEnabled(target.id, { secretEnc: 'enc:target', recoveryCodes: 8 });

    for (const [userId, hash] of [
      ['admin-1', 'hash-actor'],
      [target.id, 'hash-target-1'],
      [target.id, 'hash-target-2'],
    ] as const) {
      await sessions.create({
        userId,
        tenantId: 'tenant-1',
        refreshTokenHash: hash,
        expiresAt: new Date(T0.getTime() + 86_400_000),
      });
    }

    const result = await service.resetTwoFactor('tenant-1', ACTOR, target.id);

    expect(result).toEqual({ id: target.id, twoFactorEnabled: false });

    // Factor wiped: flag off, secret null and no break-glass code left.
    expect(target.twoFactorEnabled).toBe(false);
    expect(target.twoFactorSecretEnc).toBeNull();
    expect(twoFactor.recoveryCodeHashes(target.id)).toEqual([]);

    // Role/active flag are out of scope for the reset.
    expect(target.role).toBe('SUPERVISOR');
    expect(target.isActive).toBe(true);

    // Every refresh session of the target is revoked; the actor keeps its own.
    const targetSessions = sessions.rows.filter((row) => row.userId === target.id);
    expect(targetSessions).toHaveLength(2);
    expect(targetSessions.every((row) => row.revokedAt !== null)).toBe(true);
    expect(sessions.rows.find((row) => row.userId === 'admin-1')?.revokedAt).toBeNull();

    // The watermark is stamped for the target only (JWT dies before `exp`).
    expect(cache.entries.get(userRevocationWatermarkKey(target.id))).toBe(
      Math.floor(T0.getTime() / 1000),
    );
    expect(cache.entries.has(userRevocationWatermarkKey('admin-1'))).toBe(false);

    // The actor's factor is untouched.
    expect(actor.twoFactorEnabled).toBe(true);
    expect(actor.twoFactorSecretEnc).toBe('enc:actor');
    expect(twoFactor.recoveryCodeHashes('admin-1')).toHaveLength(4);

    // One audit row with the masked e-mail and the agent id — no secret/codes.
    expect(audit.actions()).toEqual(['admin.user.2fa_reset']);
    const row = audit.recorded[0];
    expect(row).toMatchObject({
      tenantId: 'tenant-1',
      actorId: 'admin-1',
      actorEmail: 'admin@acme.test',
      resourceType: 'user',
      resourceId: target.id,
    });
    const metadata = row?.metadata as Record<string, unknown>;
    expect(metadata.targetEmail).toBe(redactPiiForLogs('bob.silva@acme.test'));
    expect(metadata.targetEmail).not.toBe('bob.silva@acme.test');
    expect(metadata.targetAgentId).toBe(target.id);
    expect(JSON.stringify(metadata)).not.toContain('enc:target');
    expect(JSON.stringify(metadata)).not.toContain('recovery-hash');
  });

  it('refuses to reset the caller own factor with 409 CANNOT_RESET_OWN_2FA', async () => {
    const { repo, twoFactor, sessions, audit, service } = build();
    const actor = seedAgent(repo, {
      id: 'admin-1',
      role: 'ADMIN',
    });
    twoFactor.seedEnabled(actor.id, { secretEnc: 'enc:actor', recoveryCodes: 8 });
    await sessions.create({
      userId: actor.id,
      tenantId: 'tenant-1',
      refreshTokenHash: 'hash-own',
      expiresAt: new Date(T0.getTime() + 86_400_000),
    });

    await expect(
      service.resetTwoFactor('tenant-1', ACTOR, actor.id),
    ).rejects.toMatchObject({ code: 'CANNOT_RESET_OWN_2FA', httpStatus: 409 });

    expect(actor.twoFactorEnabled).toBe(true);
    expect(twoFactor.recoveryCodeHashes(actor.id)).toHaveLength(8);
    expect(sessions.rows[0]?.revokedAt).toBeNull();
    expect(audit.recorded).toHaveLength(0);
  });

  it('answers 409 TWO_FACTOR_NOT_ENABLED when the target has no active factor', async () => {
    const { repo, twoFactor, cache, audit, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    const target = seedAgent(repo, { id: 'agent-2' });

    await expect(
      service.resetTwoFactor('tenant-1', ACTOR, target.id),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_NOT_ENABLED', httpStatus: 409 });

    expect(target.twoFactorEnabled).toBe(false);
    expect(twoFactor.recoveryCodeHashes(target.id)).toEqual([]);
    expect(cache.entries.has(userRevocationWatermarkKey(target.id))).toBe(false);
    expect(audit.recorded).toHaveLength(0);
  });

  it('answers 404 for a foreign or unknown target and never writes', async () => {
    const { repo, twoFactor, cache, audit, service } = build();
    seedAgent(repo, { id: 'admin-1', role: 'ADMIN' });
    const foreign = seedAgent(repo, { id: 'foreign', tenantId: 'tenant-2' });
    twoFactor.seedEnabled(foreign.id);

    await expect(
      service.resetTwoFactor('tenant-1', ACTOR, foreign.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    await expect(
      service.resetTwoFactor('tenant-1', ACTOR, 'missing'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

    expect(foreign.twoFactorEnabled).toBe(true);
    expect(twoFactor.recoveryCodeHashes(foreign.id)).toHaveLength(8);
    expect(cache.entries.has(userRevocationWatermarkKey(foreign.id))).toBe(false);
    expect(audit.recorded).toHaveLength(0);
  });
});
