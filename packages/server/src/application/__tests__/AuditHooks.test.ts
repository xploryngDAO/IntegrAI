import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import type {
  IEmailService,
  IEmailVerificationRepository,
  ILogger,
  IRealtimePublisher,
  ITenantRepository,
  ITicketRepository,
} from '@sac/shared';

import { AgentService } from '../AgentService';
import { AuthService } from '../AuthService';
import { hashToken } from '../auth/access-token';
import { InMemoryCache } from './accountFakes';
import { InMemoryPasswordResetRepository, InMemorySessionRepository } from './authFakes';
import { RecordingAuditService } from './adminFakes';
import { StubAgentRepository } from './platformFakes';

/**
 * Audit hooks of the auth slice (contract minimum):
 *   auth.login.success / auth.login.failure / auth.profile.updated /
 *   auth.password.reset_completed.
 *
 * The recorder is the in-memory `RecordingAuditService`; persistence and
 * scrubbing are covered by `AuditService.test.ts`.
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

const silentRealtime: IRealtimePublisher = {
  ticketUpdated(): void {},
  messageCreated(): void {},
  queueChanged(): void {},
  channelHealth(): void {},
  agentPresence(): void {},
};

const T0 = new Date('2026-11-06T12:00:00.000Z');
const PASSWORD = 'CorrectHorse123!';

const tickets = {
  countActiveByAgent: async (): Promise<number> => 0,
} as unknown as ITicketRepository;

async function buildAgentService() {
  const clock = { now: () => new Date(T0.getTime()) };
  const cache = new InMemoryCache();
  const audit = new RecordingAuditService();
  const agents = new StubAgentRepository();
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  agents.seed({
    id: 'agent-1',
    tenantId: 'tenant-1',
    email: 'admin@acme.test',
    role: 'ADMIN',
    passwordHash,
    isActive: true,
    emailVerifiedAt: new Date(T0.getTime()),
  });
  const service = new AgentService({
    logger: silentLogger,
    clock,
    cache,
    realtime: silentRealtime,
    jwtSecret: 'unit-test-secret-with-32-characters!!',
    jwtExpiresIn: '1h',
    presenceTtlSeconds: 120,
    audit,
    repos: { agents, tickets },
  });
  return { audit, agents, service };
}

describe('AgentService audit', () => {
  it('records auth.login.success with the request provenance', async () => {
    const { audit, service } = await buildAgentService();

    await service.login('admin@acme.test', PASSWORD, {
      ip: '203.0.113.7',
      userAgent: 'Chrome',
    });

    expect(audit.actions()).toEqual(['auth.login.success']);
    expect(audit.recorded[0]).toMatchObject({
      tenantId: 'tenant-1',
      actorId: 'agent-1',
      actorEmail: 'admin@acme.test',
      ip: '203.0.113.7',
      userAgent: 'Chrome',
      metadata: { role: 'ADMIN', twoFactor: false },
    });
  });

  it('records auth.login.failure without the password and keeps the 401', async () => {
    const { audit, service } = await buildAgentService();

    await expect(
      service.login('admin@acme.test', 'wrong-password', { ip: '203.0.113.9' }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR', httpStatus: 401 });

    expect(audit.actions()).toEqual(['auth.login.failure']);
    expect(audit.recorded[0]).toMatchObject({
      tenantId: 'tenant-1',
      actorId: 'agent-1',
      actorEmail: 'admin@acme.test',
      ip: '203.0.113.9',
      metadata: { reason: 'invalid_password' },
    });
    expect(JSON.stringify(audit.recorded[0])).not.toContain('wrong-password');
  });

  it('records auth.profile.updated on PATCH /auth/me', async () => {
    const { audit, service } = await buildAgentService();

    const summary = await service.updateProfile(
      'agent-1',
      { name: 'Ana Updated' },
      { ip: '203.0.113.11', userAgent: 'Chrome' },
    );

    expect(summary.name).toBe('Ana Updated');
    expect(audit.actions()).toEqual(['auth.profile.updated']);
    expect(audit.recorded[0]).toMatchObject({
      actorId: 'agent-1',
      actorEmail: 'admin@acme.test',
      resourceType: 'user',
      resourceId: 'agent-1',
      ip: '203.0.113.11',
      userAgent: 'Chrome',
    });
  });
});

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
  async findById(): Promise<null> {
    return null;
  },
} as unknown as ITenantRepository;

const unusedEmailVerifications = {
  async findByTokenHash(): Promise<null> {
    return null;
  },
} as unknown as IEmailVerificationRepository;

describe('AuthService audit', () => {
  it('records auth.password.reset_completed after a successful reset', async () => {
    const clock = { now: () => new Date(T0.getTime()) };
    const cache = new InMemoryCache();
    const audit = new RecordingAuditService();
    const agents = new StubAgentRepository();
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    agents.seed({
      id: 'agent-1',
      tenantId: 'tenant-1',
      email: 'admin@acme.test',
      role: 'ADMIN',
      passwordHash,
      isActive: true,
      emailVerifiedAt: new Date(T0.getTime()),
    });

    const passwordResets = new InMemoryPasswordResetRepository(clock);
    const sessions = new InMemorySessionRepository(clock);
    const rawToken = 'a'.repeat(64);
    await passwordResets.create({
      userId: 'agent-1',
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(T0.getTime() + 30 * 60 * 1000),
    });
    await sessions.create({
      userId: 'agent-1',
      tenantId: 'tenant-1',
      refreshTokenHash: 'hash-1',
      expiresAt: new Date(T0.getTime() + 86_400_000),
    });

    const service = new AuthService({
      logger: silentLogger,
      clock,
      cache,
      email: fakeEmail,
      audit,
      config: {
        webOrigin: 'https://app.example.test',
        appBaseUrl: 'https://api.example.test',
      },
      repos: {
        agents,
        tenants: unusedTenants,
        emailVerifications: unusedEmailVerifications,
        passwordResets,
        sessions,
      },
    });

    await service.resetPassword(rawToken, 'New-password-1234');

    expect(audit.actions()).toEqual(['auth.password.reset_completed']);
    expect(audit.recorded[0]).toMatchObject({
      tenantId: 'tenant-1',
      actorId: 'agent-1',
      actorEmail: 'admin@acme.test',
      resourceType: 'user',
      metadata: { revokedSessions: 1, watermarkSet: true },
    });
    expect(sessions.rows[0]?.revokedAt).not.toBeNull();
  });
});
