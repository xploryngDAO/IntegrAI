import { createHash, randomUUID } from 'node:crypto';

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it } from 'vitest';

import type {
  AgentPresenceStatus,
  AgentRecord,
  AgentRole,
  CreateAgentInput,
  CreateInvitationResult,
  IAgentRepository,
  IClock,
  IEmailService,
  IInvitationRepository,
  ILogger,
  ITenantRepository,
  InvitationRecord,
  TenantRecord,
  UpsertInvitationInput,
} from '@sac/shared';

import { redactPiiForLogs } from '@sac/shared';

import { AuthSessionService } from '../AuthSessionService';
import { INVITATION_TTL_MS, InvitationService } from '../InvitationService';
import { InMemorySessionRepository } from './authFakes';
import { RecordingAuditService } from './adminFakes';

/* ==========================================================================
 * Test doubles
 * ========================================================================== */

const WEB_ORIGIN = 'https://app.test, http://localhost:5173';
const APP_BASE_URL = 'https://api.test';
const JWT_SECRET = 'unit-test-secret-with-32-characters!!';
const NEW_PASSWORD = 'a-whole-new-password';
const DAY_MS = 24 * 60 * 60 * 1000;

const logger: ILogger = {
  child(): ILogger {
    return this;
  },
  trace(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

class FakeClock implements IClock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

interface SentInvitationEmail {
  to: string;
  link: string;
  inviterName?: string;
}

class FakeEmailService implements IEmailService {
  readonly invitations: SentInvitationEmail[] = [];
  failInvitations = false;

  async sendVerificationEmail(): Promise<void> {}

  async sendPasswordResetEmail(): Promise<void> {}

  async sendInvitationEmail(to: string, link: string, inviterName?: string): Promise<void> {
    if (this.failInvitations) {
      this.failInvitations = false;
      throw new Error('smtp unavailable');
    }
    this.invitations.push({ to, link, inviterName });
  }
}

class InMemoryTenantRepository implements ITenantRepository {
  readonly rows: TenantRecord[] = [];
  private sequence = 0;

  constructor(private readonly clock: IClock) {}

  seed(input: { slug: string; name?: string; status?: string }): TenantRecord {
    const at = this.clock.now();
    const row: TenantRecord = {
      id: `tenant-${(this.sequence += 1)}`,
      slug: input.slug,
      name: input.name ?? input.slug,
      status: input.status ?? 'ACTIVE',
      plan: 'FREE',
      maxAccounts: 1,
      maxAgents: 3,
      billingStatus: 'TRIALING',
      trialEndsAt: null,
      billingEmail: null,
      onboardingCompletedAt: null,
      deletedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    this.rows.push(row);
    return row;
  }

  async create(input: { slug: string; name: string; status?: string }): Promise<TenantRecord> {
    return this.seed(input);
  }

  async findBySlug(slug: string): Promise<TenantRecord | null> {
    return this.rows.find((row) => row.slug === slug) ?? null;
  }

  async findById(id: string): Promise<TenantRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async update(
    id: string,
    input: { name?: string; onboardingCompletedAt?: Date | null },
  ): Promise<TenantRecord> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`Tenant not found: ${id}`);
    if (input.name !== undefined) row.name = input.name;
    if (input.onboardingCompletedAt !== undefined) {
      row.onboardingCompletedAt = input.onboardingCompletedAt;
    }
    row.updatedAt = this.clock.now();
    return row;
  }

  async delete(id: string): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

class InMemoryAgentRepository implements IAgentRepository {
  readonly rows: AgentRecord[] = [];
  private sequence = 0;

  constructor(private readonly clock: IClock) {}

  seed(input: {
    email: string;
    name?: string;
    passwordHash: string;
    tenantId?: string | null;
    role?: AgentRole;
    emailVerifiedAt?: Date | null;
    isActive?: boolean;
  }): AgentRecord {
    const at = this.clock.now();
    const row: AgentRecord = {
      id: `agent-${(this.sequence += 1)}`,
      tenantId: input.tenantId ?? null,
      email: input.email.trim().toLowerCase(),
      name: input.name ?? 'Operador',
      passwordHash: input.passwordHash,
      role: input.role ?? 'ADMIN',
      presence: 'OFFLINE',
      avatarColor: '#2563eb',
      maxConcurrent: 20,
      isActive: input.isActive ?? true,
      lastSeenAt: null,
      emailVerifiedAt: input.emailVerifiedAt ?? null,
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

  async create(input: CreateAgentInput): Promise<AgentRecord> {
    if (this.rows.some((row) => row.email === input.email)) {
      const conflict = new Error('Unique constraint failed on the fields: (`email`)');
      (conflict as Error & { code?: string }).code = 'P2002';
      throw conflict;
    }
    const at = this.clock.now();
    const row: AgentRecord = {
      id: `agent-${(this.sequence += 1)}`,
      tenantId: input.tenantId ?? null,
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      role: input.role ?? 'AGENT',
      presence: 'OFFLINE',
      avatarColor: input.avatarColor ?? '#2563eb',
      maxConcurrent: input.maxConcurrent ?? 20,
      isActive: true,
      lastSeenAt: null,
      emailVerifiedAt: input.emailVerifiedAt ?? null,
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

  async findByEmail(email: string): Promise<AgentRecord | null> {
    return this.rows.find((row) => row.email === email.trim().toLowerCase()) ?? null;
  }

  async findById(id: string): Promise<AgentRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async list(): Promise<AgentRecord[]> {
    return [...this.rows];
  }

  async updatePresence(
    id: string,
    presence: AgentPresenceStatus,
    at: Date,
  ): Promise<AgentRecord> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`agent not found: ${id}`);
    row.presence = presence;
    row.lastSeenAt = at;
    return row;
  }

  async updateName(id: string, name: string): Promise<AgentRecord> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`agent not found: ${id}`);
    row.name = name;
    return row;
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`agent not found: ${id}`);
    row.passwordHash = passwordHash;
  }

  async markEmailVerified(id: string, at: Date): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`agent not found: ${id}`);
    row.emailVerifiedAt = at;
  }
}

/** Mirrors the Prisma repository: unique (tenant, email), conditional accept. */
class InMemoryInvitationRepository implements IInvitationRepository {
  readonly rows: InvitationRecord[] = [];

  constructor(private readonly clock: IClock) {}

  async upsert(input: UpsertInvitationInput): Promise<InvitationRecord> {
    const existing = this.rows.find(
      (row) => row.tenantId === input.tenantId && row.email === input.email,
    );
    if (existing !== undefined) {
      existing.role = input.role;
      existing.tokenHash = input.tokenHash;
      existing.invitedBy = input.invitedBy ?? null;
      existing.expiresAt = input.expiresAt;
      existing.acceptedAt = null;
      return existing;
    }

    const row: InvitationRecord = {
      id: randomUUID(),
      tenantId: input.tenantId,
      email: input.email,
      role: input.role,
      tokenHash: input.tokenHash,
      invitedBy: input.invitedBy ?? null,
      expiresAt: input.expiresAt,
      acceptedAt: null,
      createdAt: this.clock.now(),
    };
    this.rows.push(row);
    return row;
  }

  async findByTokenHash(tokenHash: string): Promise<InvitationRecord | null> {
    return this.rows.find((row) => row.tokenHash === tokenHash) ?? null;
  }

  async findById(id: string): Promise<InvitationRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async listByTenant(tenantId: string): Promise<InvitationRecord[]> {
    return this.rows
      .filter((row) => row.tenantId === tenantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async accept(id: string, at: Date): Promise<InvitationRecord | null> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined || row.acceptedAt !== null) return null;
    row.acceptedAt = at;
    return row;
  }

  async revoke(id: string, tenantId: string, at: Date): Promise<boolean> {
    const row = this.rows.find((entry) => entry.id === id);
    if (
      row === undefined ||
      row.tenantId !== tenantId ||
      row.acceptedAt !== null ||
      row.expiresAt.getTime() <= at.getTime()
    ) {
      return false;
    }
    row.expiresAt = at;
    return true;
  }

  async deletePending(id: string, tenantId: string, at: Date): Promise<boolean> {
    const index = this.rows.findIndex(
      (entry) =>
        entry.id === id &&
        entry.tenantId === tenantId &&
        entry.acceptedAt === null &&
        entry.expiresAt.getTime() > at.getTime(),
    );
    if (index < 0) return false;
    this.rows.splice(index, 1);
    return true;
  }

  async reissue(
    id: string,
    tenantId: string,
    input: { tokenHash: string; expiresAt: Date },
  ): Promise<boolean> {
    const row = this.rows.find(
      (entry) => entry.id === id && entry.tenantId === tenantId && entry.acceptedAt === null,
    );
    if (row === undefined) return false;
    row.tokenHash = input.tokenHash;
    row.expiresAt = input.expiresAt;
    return true;
  }
}

/* ==========================================================================
 * Harness
 * ========================================================================== */

let adminPasswordHash = '';
let operatorPasswordHash = '';

beforeAll(async () => {
  adminPasswordHash = await bcrypt.hash('admin-password-123', 4);
  operatorPasswordHash = await bcrypt.hash('operator-password-123', 4);
});

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function extractToken(link: string): string {
  const token = new URL(link).searchParams.get('token');
  if (token === null) throw new Error(`No token in link: ${link}`);
  return token;
}

function buildHarness(overrides?: { webOrigin?: string; appBaseUrl?: string }) {
  const clock = new FakeClock(new Date('2026-04-01T09:00:00.000Z'));
  const tenants = new InMemoryTenantRepository(clock);
  const agents = new InMemoryAgentRepository(clock);
  const invitations = new InMemoryInvitationRepository(clock);
  const email = new FakeEmailService();
  const sessions = new InMemorySessionRepository(clock);
  const audit = new RecordingAuditService();

  const acme = tenants.seed({ slug: 'acme', name: 'Acme' });
  const other = tenants.seed({ slug: 'other', name: 'Other' });

  const admin = agents.seed({
    email: 'admin@acme.test',
    name: 'Ana Admin',
    passwordHash: adminPasswordHash,
    tenantId: acme.id,
    role: 'ADMIN',
    emailVerifiedAt: clock.now(),
  });

  const authSessions = new AuthSessionService({
    logger,
    clock,
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '15m',
    repos: { agents, sessions },
  });

  const service = new InvitationService({
    logger,
    clock,
    email,
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '15m',
    config: {
      webOrigin: overrides?.webOrigin ?? WEB_ORIGIN,
      appBaseUrl: overrides?.appBaseUrl ?? APP_BASE_URL,
    },
    sessions: authSessions,
    audit,
    repos: { invitations, agents, tenants },
  });

  return {
    clock,
    tenants,
    agents,
    invitations,
    email,
    sessions,
    authSessions,
    audit,
    service,
    acme,
    other,
    admin,
  };
}

type Harness = ReturnType<typeof buildHarness>;

async function invite(
  h: Harness,
  email = 'op@acme.test',
  role: AgentRole = 'AGENT',
): Promise<CreateInvitationResult> {
  return h.service.create({ email, role, actor: { id: h.admin.id, name: h.admin.name, tenantId: h.acme.id } });
}

/* ==========================================================================
 * create / resend
 * ========================================================================== */

describe('InvitationService.create', () => {
  it('stores only the SHA-256 hash with a 7 day TTL and mails the first WEB_ORIGIN link', async () => {
    const h = buildHarness();

    const result = await invite(h, '  Op@Acme.Test ', 'SUPERVISOR');

    expect(result).toMatchObject({
      invitationId: expect.any(String) as string,
      email: 'op@acme.test',
      role: 'SUPERVISOR',
    });

    expect(h.invitations.rows).toHaveLength(1);
    const record = h.invitations.rows[0];
    const token = extractToken(h.email.invitations[0].link);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(record).toMatchObject({
      id: result.invitationId,
      tenantId: h.acme.id,
      email: 'op@acme.test',
      role: 'SUPERVISOR',
      invitedBy: h.admin.id,
      acceptedAt: null,
    });
    expect(record.tokenHash).toBe(sha256(token));
    expect(record.tokenHash).not.toBe(token);
    expect(record.expiresAt.getTime() - h.clock.now().getTime()).toBe(INVITATION_TTL_MS);
    expect(INVITATION_TTL_MS).toBe(7 * DAY_MS);

    expect(h.email.invitations).toHaveLength(1);
    expect(h.email.invitations[0]).toMatchObject({
      to: 'op@acme.test',
      inviterName: 'Ana Admin',
      link: `https://app.test/invite?token=${encodeURIComponent(token)}`,
    });
  });

  it('falls back to APP_BASE_URL when WEB_ORIGIN is empty', async () => {
    const h = buildHarness({ webOrigin: '' });

    await invite(h);

    expect(h.email.invitations[0].link).toMatch(/^https:\/\/api\.test\/invite\?token=/);
  });

  it('rejects an e-mail that already belongs to an operator (global, 409)', async () => {
    const h = buildHarness();
    h.agents.seed({
      email: 'taken@other.test',
      passwordHash: operatorPasswordHash,
      tenantId: h.other.id,
      role: 'AGENT',
      emailVerifiedAt: h.clock.now(),
    });

    await expect(invite(h, 'TAKEN@other.test')).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
    });

    expect(h.invitations.rows).toHaveLength(0);
    expect(h.email.invitations).toHaveLength(0);
  });

  it('rejects an e-mail that already belongs to an operator of the same tenant (409)', async () => {
    const h = buildHarness();
    h.agents.seed({
      email: 'agent@acme.test',
      passwordHash: operatorPasswordHash,
      tenantId: h.acme.id,
      role: 'AGENT',
      emailVerifiedAt: h.clock.now(),
    });

    await expect(invite(h, 'agent@acme.test')).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
    });
    expect(h.invitations.rows).toHaveLength(0);
  });

  it('rejects an invalid e-mail and an unsupported role with 422', async () => {
    const h = buildHarness();

    await expect(invite(h, 'not-an-email')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      httpStatus: 422,
    });
    await expect(
      h.service.create({
        email: 'op@acme.test',
        role: 'OWNER' as AgentRole,
        actor: { id: h.admin.id, name: h.admin.name, tenantId: h.acme.id },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });

    expect(h.invitations.rows).toHaveLength(0);
  });

  it('regenerates the token and extends the TTL on resend instead of duplicating', async () => {
    const h = buildHarness();
    const first = await invite(h, 'op@acme.test', 'AGENT');
    const firstToken = extractToken(h.email.invitations[0].link);

    h.clock.advance(2 * DAY_MS);
    const second = await invite(h, 'op@acme.test', 'SUPERVISOR');
    const secondToken = extractToken(h.email.invitations[1].link);

    expect(second.invitationId).toBe(first.invitationId);
    expect(secondToken).not.toBe(firstToken);
    expect(h.invitations.rows).toHaveLength(1);

    const row = h.invitations.rows[0];
    expect(row.role).toBe('SUPERVISOR');
    expect(row.tokenHash).toBe(sha256(secondToken));
    expect(row.expiresAt.getTime() - h.clock.now().getTime()).toBe(INVITATION_TTL_MS);
    expect(row.acceptedAt).toBeNull();

    // The superseded link is dead before the original TTL would have expired.
    await expect(
      h.service.accept({ token: firstToken, name: 'Op', password: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION_TOKEN', httpStatus: 400 });
  });

  it('still resolves when the SMTP relay fails (the ADMIN can resend)', async () => {
    const h = buildHarness();
    h.email.failInvitations = true;

    const result = await invite(h);

    expect(result.email).toBe('op@acme.test');
    expect(h.invitations.rows).toHaveLength(1);
    expect(h.email.invitations).toHaveLength(0);
  });
});

/* ==========================================================================
 * list
 * ========================================================================== */

describe('InvitationService.list', () => {
  it('derives pending/accepted/expired and only returns the caller tenant', async () => {
    const h = buildHarness();

    await invite(h, 'expired@acme.test');
    h.clock.advance(INVITATION_TTL_MS + 1000);

    await invite(h, 'pending@acme.test');
    await invite(h, 'accepted@acme.test');
    const acceptedToken = extractToken(
      h.email.invitations.find((entry) => entry.to === 'accepted@acme.test')?.link ?? '',
    );
    await h.service.accept({ token: acceptedToken, name: 'Accepted', password: NEW_PASSWORD });

    await h.service.create({
      email: 'outsider@other.test',
      role: 'AGENT',
      actor: { id: h.admin.id, name: h.admin.name, tenantId: h.other.id },
    });

    const list = await h.service.list(h.acme.id);
    const byEmail = new Map(list.map((entry) => [entry.email, entry]));

    expect(byEmail.get('pending@acme.test')?.status).toBe('pending');
    expect(byEmail.get('accepted@acme.test')?.status).toBe('accepted');
    expect(byEmail.get('accepted@acme.test')?.acceptedAt).not.toBeNull();
    expect(byEmail.get('expired@acme.test')?.status).toBe('expired');
    expect(byEmail.has('outsider@other.test')).toBe(false);
    expect(list).toHaveLength(3);
  });
});

/* ==========================================================================
 * revoke
 * ========================================================================== */

describe('InvitationService.revoke', () => {
  it('expires a pending invitation and burns its link', async () => {
    const h = buildHarness();
    const created = await invite(h);
    const token = extractToken(h.email.invitations[0].link);

    await h.service.revoke(created.invitationId, h.acme.id);

    expect(h.invitations.rows[0].expiresAt).toEqual(h.clock.now());
    expect((await h.service.list(h.acme.id))[0].status).toBe('expired');
    await expect(
      h.service.accept({ token, name: 'Op', password: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION_TOKEN', httpStatus: 400 });
  });

  it('answers 404 for an unknown id, a malformed id or another tenant', async () => {
    const h = buildHarness();
    const created = await invite(h);

    await expect(h.service.revoke('00000000-0000-4000-8000-000000000000', h.acme.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
    await expect(h.service.revoke('not-a-uuid', h.acme.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
    await expect(h.service.revoke(created.invitationId, h.other.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });

    expect(h.invitations.rows[0].acceptedAt).toBeNull();
    expect(h.invitations.rows[0].expiresAt.getTime()).toBeGreaterThan(h.clock.now().getTime());
  });

  it('refuses to revoke an accepted invitation (409)', async () => {
    const h = buildHarness();
    const created = await invite(h);
    const token = extractToken(h.email.invitations[0].link);
    await h.service.accept({ token, name: 'Op', password: NEW_PASSWORD });

    await expect(h.service.revoke(created.invitationId, h.acme.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
    });
  });

  it('is idempotent for an already expired invitation', async () => {
    const h = buildHarness();
    const created = await invite(h);
    h.clock.advance(INVITATION_TTL_MS + 1000);

    await expect(h.service.revoke(created.invitationId, h.acme.id)).resolves.toBeUndefined();
  });
});

/* ==========================================================================
 * admin console (list + hard-delete revoke)
 * ========================================================================== */

/** Request provenance of the ADMIN calling the console endpoints. */
function adminActor(h: Harness) {
  return {
    id: h.admin.id,
    // The resend e-mail template renders the ADMIN display name.
    name: h.admin.name,
    email: h.admin.email,
    tenantId: h.acme.id,
    ip: '203.0.113.9',
    userAgent: 'Vitest/1.0',
  };
}

describe('InvitationService.listForAdmin', () => {
  it('derives the uppercase status, newest first, tenant-scoped with ISO instants', async () => {
    const h = buildHarness();

    await invite(h, 'expired@acme.test');
    h.clock.advance(INVITATION_TTL_MS + 1000);
    await invite(h, 'pending@acme.test');
    h.clock.advance(1000);
    await invite(h, 'accepted@acme.test');

    const acceptedToken = extractToken(
      h.email.invitations.find((entry) => entry.to === 'accepted@acme.test')?.link ?? '',
    );
    await h.service.accept({ token: acceptedToken, name: 'Accepted', password: NEW_PASSWORD });

    // A pending invite of another workspace must never leak into the listing.
    await h.service.create({
      email: 'outsider@other.test',
      role: 'AGENT',
      actor: { id: h.admin.id, name: h.admin.name, tenantId: h.other.id },
    });

    const result = await h.service.listForAdmin(h.acme.id);
    const byEmail = new Map(result.items.map((entry) => [entry.email, entry]));

    expect(result.total).toBe(3);
    expect(result.items.map((entry) => entry.email)).toEqual([
      'accepted@acme.test',
      'pending@acme.test',
      'expired@acme.test',
    ]);
    expect(byEmail.get('pending@acme.test')).toMatchObject({
      status: 'PENDING',
      acceptedAt: null,
      role: 'AGENT',
    });
    expect(byEmail.get('accepted@acme.test')).toMatchObject({ status: 'ACCEPTED' });
    expect(byEmail.get('expired@acme.test')).toMatchObject({ status: 'EXPIRED' });
    expect(byEmail.get('accepted@acme.test')?.acceptedAt).toBe(
      h.clock.now().toISOString(),
    );
    expect(byEmail.get('pending@acme.test')?.createdAt).toBe(
      new Date(h.clock.now().getTime() - 1000).toISOString(),
    );
    expect(byEmail.has('outsider@other.test')).toBe(false);
  });
});

describe('InvitationService.revokeForAdmin', () => {
  it('hard-deletes a pending invitation and audits invitation.revoked', async () => {
    const h = buildHarness();
    const created = await invite(h, 'revoke-me@acme.test', 'SUPERVISOR');
    const token = extractToken(h.email.invitations[0].link);
    // The create itself is audited; this test asserts only the revoke event.
    h.audit.recorded.length = 0;

    await h.service.revokeForAdmin(h.acme.id, adminActor(h), created.invitationId);

    // Row deleted (not merely expired): the link is burned with it.
    expect(h.invitations.rows).toHaveLength(0);
    await expect(
      h.service.accept({ token, name: 'Op', password: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION_TOKEN', httpStatus: 400 });

    expect(h.audit.actions()).toEqual(['invitation.revoked']);
    expect(h.audit.recorded[0]).toMatchObject({
      action: 'invitation.revoked',
      tenantId: h.acme.id,
      actorId: h.admin.id,
      // Full actor e-mail on its own column; the invitee e-mail is redacted.
      actorEmail: h.admin.email,
      resourceType: 'invitation',
      resourceId: created.invitationId,
      ip: '203.0.113.9',
      userAgent: 'Vitest/1.0',
      metadata: {
        email: redactPiiForLogs('revoke-me@acme.test'),
        role: 'SUPERVISOR',
      },
    });
  });

  it('refuses an accepted invitation with 409 INVITATION_ALREADY_ACCEPTED and keeps the row', async () => {
    const h = buildHarness();
    const created = await invite(h);
    const token = extractToken(h.email.invitations[0].link);
    await h.service.accept({ token, name: 'Op', password: NEW_PASSWORD });
    h.audit.recorded.length = 0;

    await expect(
      h.service.revokeForAdmin(h.acme.id, adminActor(h), created.invitationId),
    ).rejects.toMatchObject({
      code: 'INVITATION_ALREADY_ACCEPTED',
      httpStatus: 409,
    });

    expect(h.invitations.rows).toHaveLength(1);
    expect(h.invitations.rows[0]?.acceptedAt).not.toBeNull();
    expect(h.audit.recorded).toHaveLength(0);
  });

  it('answers 404 for a foreign, unknown or malformed id without auditing', async () => {
    const h = buildHarness();
    const created = await invite(h);
    h.audit.recorded.length = 0;

    await expect(
      h.service.revokeForAdmin(h.other.id, adminActor(h), created.invitationId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    await expect(
      h.service.revokeForAdmin(
        h.acme.id,
        adminActor(h),
        '00000000-0000-4000-8000-000000000000',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    await expect(
      h.service.revokeForAdmin(h.acme.id, adminActor(h), 'not-a-uuid'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

    expect(h.invitations.rows).toHaveLength(1);
    expect(h.audit.recorded).toHaveLength(0);
  });

  it('is an idempotent no-op for an already expired invitation', async () => {
    const h = buildHarness();
    const created = await invite(h);
    h.clock.advance(INVITATION_TTL_MS + 1000);
    h.audit.recorded.length = 0;

    await expect(
      h.service.revokeForAdmin(h.acme.id, adminActor(h), created.invitationId),
    ).resolves.toBeUndefined();

    // Only PENDING rows are revoked: the expired row stays visible as history.
    expect(h.invitations.rows).toHaveLength(1);
    expect(h.audit.recorded).toHaveLength(0);
  });

  it('answers 409 when a concurrent acceptance wins the delete race', async () => {
    const h = buildHarness();
    const created = await invite(h);
    h.audit.recorded.length = 0;
    h.invitations.deletePending = async () => false;

    await expect(
      h.service.revokeForAdmin(h.acme.id, adminActor(h), created.invitationId),
    ).rejects.toMatchObject({
      code: 'INVITATION_ALREADY_ACCEPTED',
      httpStatus: 409,
    });
    expect(h.audit.recorded).toHaveLength(0);
  });
});

/* ==========================================================================
 * admin console (resend)
 * ========================================================================== */

describe('InvitationService.resendForAdmin', () => {
  it('re-issues a PENDING invitation with a NEW token/hash, fresh TTL and audits invitation.resent', async () => {
    const h = buildHarness();
    const created = await invite(h, 'resent@acme.test', 'SUPERVISOR');
    const firstToken = extractToken(h.email.invitations[0].link);
    const firstHash = h.invitations.rows[0].tokenHash;
    h.audit.recorded.length = 0;

    h.clock.advance(2 * DAY_MS);
    const result = await h.service.resendForAdmin(
      h.acme.id,
      adminActor(h),
      created.invitationId,
    );

    expect(result).toMatchObject({
      id: created.invitationId,
      email: 'resent@acme.test',
      role: 'SUPERVISOR',
      status: 'PENDING',
    });
    expect(result.expiresAt.getTime()).toBe(h.clock.now().getTime() + INVITATION_TTL_MS);

    // Same template/service as `create`, once more, addressed to the invitee.
    expect(h.email.invitations).toHaveLength(2);
    const secondToken = extractToken(h.email.invitations[1].link);
    expect(h.email.invitations[1]).toMatchObject({
      to: 'resent@acme.test',
      inviterName: 'Ana Admin',
      link: `https://app.test/invite?token=${encodeURIComponent(secondToken)}`,
    });
    expect(secondToken).not.toBe(firstToken);

    // The row keeps its id/role and receives the new hash + expiry.
    expect(h.invitations.rows).toHaveLength(1);
    const row = h.invitations.rows[0];
    expect(row.tokenHash).not.toBe(firstHash);
    expect(row.tokenHash).toBe(sha256(secondToken));
    expect(row.expiresAt).toEqual(result.expiresAt);
    expect(row.acceptedAt).toBeNull();

    // The superseded link is dead as soon as the resend lands.
    await expect(
      h.service.accept({ token: firstToken, name: 'Op', password: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION_TOKEN', httpStatus: 400 });

    expect(h.audit.actions()).toEqual(['invitation.resent']);
    expect(h.audit.recorded[0]).toMatchObject({
      action: 'invitation.resent',
      tenantId: h.acme.id,
      actorId: h.admin.id,
      actorEmail: h.admin.email,
      resourceType: 'invitation',
      resourceId: created.invitationId,
      ip: '203.0.113.9',
      userAgent: 'Vitest/1.0',
      metadata: {
        email: redactPiiForLogs('resent@acme.test'),
        role: 'SUPERVISOR',
      },
    });
  });

  it('re-issues an EXPIRED invitation, reviving its acceptance', async () => {
    const h = buildHarness();
    const created = await invite(h, 'expired@acme.test', 'AGENT');
    h.clock.advance(INVITATION_TTL_MS + 1000);
    expect((await h.service.list(h.acme.id))[0].status).toBe('expired');

    const result = await h.service.resendForAdmin(
      h.acme.id,
      adminActor(h),
      created.invitationId,
    );

    expect(result.status).toBe('PENDING');
    expect(h.invitations.rows[0].expiresAt.getTime()).toBe(
      h.clock.now().getTime() + INVITATION_TTL_MS,
    );
    expect((await h.service.list(h.acme.id))[0].status).toBe('pending');

    // The freshly mailed link is the only one that can be consumed.
    const freshToken = extractToken(h.email.invitations[1].link);
    const accepted = await h.service.accept({
      token: freshToken,
      name: 'Expired Revived',
      password: NEW_PASSWORD,
    });
    expect(accepted.agent.email).toBe('expired@acme.test');
    expect(h.invitations.rows[0].acceptedAt).toEqual(h.clock.now());
  });

  it('answers 409 INVITATION_ALREADY_ACCEPTED for an accepted invitation without mailing', async () => {
    const h = buildHarness();
    const created = await invite(h, 'accepted@acme.test');
    const token = extractToken(h.email.invitations[0].link);
    await h.service.accept({ token, name: 'Op', password: NEW_PASSWORD });
    h.audit.recorded.length = 0;
    const emailsBefore = h.email.invitations.length;

    await expect(
      h.service.resendForAdmin(h.acme.id, adminActor(h), created.invitationId),
    ).rejects.toMatchObject({
      code: 'INVITATION_ALREADY_ACCEPTED',
      httpStatus: 409,
    });

    expect(h.email.invitations).toHaveLength(emailsBefore);
    expect(h.audit.recorded).toHaveLength(0);
  });

  it('answers 404 for a foreign, unknown or malformed id without mailing or auditing', async () => {
    const h = buildHarness();
    const created = await invite(h);
    h.audit.recorded.length = 0;
    const emailsBefore = h.email.invitations.length;

    await expect(
      h.service.resendForAdmin(h.other.id, adminActor(h), created.invitationId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    await expect(
      h.service.resendForAdmin(
        h.acme.id,
        adminActor(h),
        '00000000-0000-4000-8000-000000000000',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    await expect(
      h.service.resendForAdmin(h.acme.id, adminActor(h), 'not-a-uuid'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

    expect(h.invitations.rows).toHaveLength(1);
    expect(h.email.invitations).toHaveLength(emailsBefore);
    expect(h.audit.recorded).toHaveLength(0);
  });

  it('answers 502 EMAIL_SEND_FAILED and leaves the stored token/expiry untouched', async () => {
    const h = buildHarness();
    const created = await invite(h, 'bounce@acme.test');
    const firstToken = extractToken(h.email.invitations[0].link);
    const before = {
      tokenHash: h.invitations.rows[0].tokenHash,
      expiresAt: h.invitations.rows[0].expiresAt,
    };
    h.audit.recorded.length = 0;
    h.email.failInvitations = true;

    await expect(
      h.service.resendForAdmin(h.acme.id, adminActor(h), created.invitationId),
    ).rejects.toMatchObject({ code: 'EMAIL_SEND_FAILED', httpStatus: 502 });

    // Nothing was written and nothing was audited.
    expect(h.invitations.rows[0].tokenHash).toBe(before.tokenHash);
    expect(h.invitations.rows[0].expiresAt).toEqual(before.expiresAt);
    expect(h.audit.recorded).toHaveLength(0);

    // The original link still works because it was never overwritten.
    const accepted = await h.service.accept({
      token: firstToken,
      name: 'Still Valid',
      password: NEW_PASSWORD,
    });
    expect(accepted.agent.email).toBe('bounce@acme.test');
  });

  it('answers 409 when a concurrent acceptance wins the reissue race', async () => {
    const h = buildHarness();
    const created = await invite(h);
    h.audit.recorded.length = 0;
    // The e-mail leaves, but the conditional UPDATE finds the row accepted.
    h.invitations.reissue = async () => false;

    await expect(
      h.service.resendForAdmin(h.acme.id, adminActor(h), created.invitationId),
    ).rejects.toMatchObject({
      code: 'INVITATION_ALREADY_ACCEPTED',
      httpStatus: 409,
    });
    expect(h.audit.recorded).toHaveLength(0);
  });
});

/* ==========================================================================
 * accept
 * ========================================================================== */

describe('InvitationService.accept', () => {
  it('creates the verified operator in the invitation tenant with the invited role and a session', async () => {
    const h = buildHarness();
    await invite(h, 'new-agent@acme.test', 'SUPERVISOR');
    const token = extractToken(h.email.invitations[0].link);

    const result = await h.service.accept(
      { token, name: '  Novo Agente ', password: NEW_PASSWORD },
      { userAgent: 'Mozilla/5.0 (test)', ip: '203.0.113.20' },
    );

    expect(h.agents.rows).toHaveLength(2);
    const created = h.agents.rows[1];
    expect(created).toMatchObject({
      email: 'new-agent@acme.test',
      name: 'Novo Agente',
      tenantId: h.acme.id,
      role: 'SUPERVISOR',
      emailVerifiedAt: h.clock.now(),
      isActive: true,
    });
    // bcrypt cost 12, never the plaintext.
    expect(created.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(created.passwordHash).not.toContain(NEW_PASSWORD);
    await expect(bcrypt.compare(NEW_PASSWORD, created.passwordHash)).resolves.toBe(true);

    expect(h.invitations.rows[0].acceptedAt).toEqual(h.clock.now());

    // Access token: real HS256 JWT carrying the tenant/role of the invitation.
    const claims = jwt.verify(result.token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'sac-hub',
      audience: 'sac-web',
    }) as jwt.JwtPayload;
    expect(claims.sub).toBe(created.id);
    expect(claims.tenantId).toBe(h.acme.id);
    expect(claims.role).toBe('SUPERVISOR');
    expect(claims.email).toBe('new-agent@acme.test');

    // Rotating refresh token: raw in the response, SHA-256 in `sessions`.
    expect(result.refreshToken).toMatch(/^[0-9a-f]{96}$/);
    expect(h.sessions.rows).toHaveLength(1);
    expect(h.sessions.rows[0]).toMatchObject({
      userId: created.id,
      tenantId: h.acme.id,
      userAgent: 'Mozilla/5.0 (test)',
      ip: '203.0.113.20',
      revokedAt: null,
    });
    expect(h.sessions.rows[0].refreshTokenHash).toBe(sha256(result.refreshToken ?? ''));

    expect(result.agent).toEqual({
      id: created.id,
      name: 'Novo Agente',
      email: 'new-agent@acme.test',
      role: 'SUPERVISOR',
      presence: 'OFFLINE',
      tenantId: h.acme.id,
    });
  });

  it('rejects a password shorter than 12 characters with 422 and keeps the invite pending', async () => {
    const h = buildHarness();
    await invite(h);
    const token = extractToken(h.email.invitations[0].link);

    await expect(
      h.service.accept({ token, name: 'Op', password: 'short-pass' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });

    expect(h.agents.rows).toHaveLength(1);
    expect(h.invitations.rows[0].acceptedAt).toBeNull();
  });

  it('rejects an unknown token with 400 INVALID_INVITATION_TOKEN', async () => {
    const h = buildHarness();

    await expect(
      h.service.accept({ token: 'f'.repeat(64), name: 'Op', password: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION_TOKEN', httpStatus: 400 });
    expect(h.agents.rows).toHaveLength(1);
  });

  it('rejects a token after the 7 day TTL', async () => {
    const h = buildHarness();
    await invite(h);
    const token = extractToken(h.email.invitations[0].link);

    h.clock.advance(INVITATION_TTL_MS + 1000);

    await expect(
      h.service.accept({ token, name: 'Op', password: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION_TOKEN', httpStatus: 400 });
    expect(h.agents.rows).toHaveLength(1);
    expect(h.invitations.rows[0].acceptedAt).toBeNull();
  });

  it('rejects a replayed (already used) token', async () => {
    const h = buildHarness();
    await invite(h);
    const token = extractToken(h.email.invitations[0].link);
    await h.service.accept({ token, name: 'Op', password: NEW_PASSWORD });

    await expect(
      h.service.accept({ token, name: 'Outro', password: 'another-password-123' }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION_TOKEN', httpStatus: 400 });
    // The first operator is untouched and no second account was created.
    expect(h.agents.rows).toHaveLength(2);
    expect(h.agents.rows[1].name).toBe('Op');
    expect(h.sessions.rows).toHaveLength(1);
  });

  it('rejects an invitation whose e-mail already has an account (409)', async () => {
    const h = buildHarness();
    await invite(h, 'late@acme.test');
    const token = extractToken(h.email.invitations[0].link);

    // The address gets an account between the invite and the acceptance.
    h.agents.seed({
      email: 'late@acme.test',
      passwordHash: operatorPasswordHash,
      tenantId: h.other.id,
      role: 'AGENT',
      emailVerifiedAt: h.clock.now(),
    });

    await expect(
      h.service.accept({ token, name: 'Late', password: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 });
    expect(h.invitations.rows[0].acceptedAt).toBeNull();
  });

  it('rejects an invitation whose workspace is not active (409)', async () => {
    const h = buildHarness();
    await invite(h);
    const token = extractToken(h.email.invitations[0].link);
    h.acme.status = 'SUSPENDED';

    await expect(
      h.service.accept({ token, name: 'Op', password: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 });
    expect(h.agents.rows).toHaveLength(1);
  });

  it('omits the refresh token when the session store is unavailable', async () => {
    const h = buildHarness();
    await invite(h);
    const token = extractToken(h.email.invitations[0].link);

    const withoutSessions = new InvitationService({
      logger,
      clock: h.clock,
      email: h.email,
      jwtSecret: JWT_SECRET,
      jwtExpiresIn: '15m',
      config: { webOrigin: WEB_ORIGIN, appBaseUrl: APP_BASE_URL },
      repos: { invitations: h.invitations, agents: h.agents, tenants: h.tenants },
    });

    const result = await withoutSessions.accept({ token, name: 'Op', password: NEW_PASSWORD });

    expect(result.refreshToken).toBeUndefined();
    expect(result.token.length).toBeGreaterThan(0);
    expect(h.sessions.rows).toHaveLength(0);
  });
});
