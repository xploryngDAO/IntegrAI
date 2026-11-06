import { createHash } from 'node:crypto';

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it } from 'vitest';

import type {
  AgentPresenceStatus,
  AgentRecord,
  CreateAgentInput,
  IAgentRepository,
  ICache,
  IClock,
  IEmailService,
  IEmailVerificationRepository,
  ILogger,
  ITenantRepository,
} from '@sac/shared';

import { AuthService } from '../AuthService';
import { AuthSessionService, REFRESH_TOKEN_TTL_MS } from '../AuthSessionService';
import {
  InMemoryPasswordResetRepository,
  InMemorySessionRepository,
} from './authFakes';

/* ==========================================================================
 * Test doubles
 * ========================================================================== */

const TEST_PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'a-whole-new-password';
const JWT_SECRET = 'unit-test-secret-with-32-characters!!';
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * MINUTE_MS;

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

class FakeEmailService implements IEmailService {
  readonly verifications: Array<{ to: string; link: string }> = [];
  readonly resets: Array<{ to: string; link: string; name?: string }> = [];
  failResets = false;

  async sendVerificationEmail(to: string, link: string): Promise<void> {
    this.verifications.push({ to, link });
  }

  async sendPasswordResetEmail(to: string, link: string, name?: string): Promise<void> {
    if (this.failResets) {
      this.failResets = false;
      throw new Error('smtp unavailable');
    }
    this.resets.push({ to, link, name });
  }

  async sendInvitationEmail(): Promise<void> {
    // Invitations are covered by Invitations.test.ts.
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
    isActive?: boolean;
  }): AgentRecord {
    const at = this.clock.now();
    const row: AgentRecord = {
      id: `agent-${(this.sequence += 1)}`,
      tenantId: input.tenantId ?? null,
      email: input.email.trim().toLowerCase(),
      name: input.name ?? 'Operador',
      passwordHash: input.passwordHash,
      role: 'ADMIN',
      presence: 'OFFLINE',
      avatarColor: '#2563eb',
      maxConcurrent: 20,
      isActive: input.isActive ?? true,
      lastSeenAt: null,
      emailVerifiedAt: at,
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
    const at = this.clock.now();
    const row: AgentRecord = {
      id: `agent-${(this.sequence += 1)}`,
      tenantId: input.tenantId ?? null,
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      role: input.role ?? 'AGENT',
      presence: 'OFFLINE',
      avatarColor: '#2563eb',
      maxConcurrent: 20,
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

/* ==========================================================================
 * Harness helpers
 * ========================================================================== */

let passwordHash = '';

beforeAll(async () => {
  passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
});

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** `forgotPassword`/`resetPassword` never touch the cache or the tenant repo. */
class NoopCache implements ICache {
  async get<T>(): Promise<T | null> {
    return null;
  }
  async set(): Promise<void> {}
  async setNx(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {}
  async exists(): Promise<boolean> {
    return false;
  }
  async ttl(): Promise<number> {
    return -2;
  }
  async incr(): Promise<number> {
    return 1;
  }
  async hset(): Promise<void> {}
  async hgetall<T extends Record<string, string>>(): Promise<T | null> {
    return null;
  }
  async sadd(): Promise<void> {}
  async srem(): Promise<void> {}
  async smembers(): Promise<string[]> {
    return [];
  }
}

const unusedTenants = {
  async create(): Promise<never> {
    throw new Error('tenant repository is not used by the password reset flow');
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
    throw new Error('verification repository is not used by the password reset flow');
  },
  async findByTokenHash(): Promise<null> {
    return null;
  },
  async markUsed(): Promise<void> {},
  async invalidateUnused(): Promise<number> {
    return 0;
  },
} as unknown as IEmailVerificationRepository;

function extractToken(link: string): string {
  const token = new URL(link).searchParams.get('token');
  if (token === null) throw new Error(`No token in link: ${link}`);
  return token;
}

function buildHarness() {
  const clock = new FakeClock(new Date('2026-03-01T09:00:00.000Z'));
  const agents = new InMemoryAgentRepository(clock);
  const passwordResets = new InMemoryPasswordResetRepository(clock);
  const sessions = new InMemorySessionRepository(clock);
  const email = new FakeEmailService();

  const auth = new AuthService({
    logger,
    clock,
    cache: new NoopCache(),
    email,
    config: { webOrigin: 'https://app.test, http://localhost:5173', appBaseUrl: 'https://api.test' },
    repos: {
      agents,
      tenants: unusedTenants,
      emailVerifications: unusedEmailVerifications,
      passwordResets,
      sessions,
    },
  });

  const authSessions = new AuthSessionService({
    logger,
    clock,
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '15m',
    repos: { agents, sessions },
  });

  const agent = agents.seed({
    email: 'ana@acme.test',
    name: 'Ana',
    passwordHash,
    tenantId: 'tenant-1',
  });

  return { clock, agents, passwordResets, sessions, email, auth, authSessions, agent };
}

/* ==========================================================================
 * forgot-password
 * ========================================================================== */

describe('AuthService.forgotPassword', () => {
  it('always resolves for an unknown e-mail and sends nothing', async () => {
    const h = buildHarness();

    await expect(h.auth.forgotPassword('nobody@example.com')).resolves.toBeUndefined();

    expect(h.email.resets).toHaveLength(0);
    expect(h.passwordResets.rows).toHaveLength(0);
  });

  it('stores only the SHA-256 hash with a 30 min TTL and mails the WEB_ORIGIN link', async () => {
    const h = buildHarness();

    await h.auth.forgotPassword('ANA@acme.test');

    expect(h.passwordResets.rows).toHaveLength(1);
    const record = h.passwordResets.rows[0];
    const token = extractToken(h.email.resets[0].link);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(record.userId).toBe(h.agent.id);
    expect(record.tokenHash).toBe(sha256(token));
    expect(record.tokenHash).not.toBe(token);
    expect(record.usedAt).toBeNull();
    expect(record.expiresAt.getTime() - h.clock.now().getTime()).toBe(RESET_TTL_MS);

    expect(h.email.resets).toHaveLength(1);
    expect(h.email.resets[0].to).toBe('ana@acme.test');
    expect(h.email.resets[0].name).toBe('Ana');
    expect(h.email.resets[0].link).toBe(
      `https://app.test/reset-password?token=${encodeURIComponent(token)}`,
    );
  });

  it('invalidates the previous reset token when a new one is requested', async () => {
    const h = buildHarness();

    await h.auth.forgotPassword('ana@acme.test');
    const first = extractToken(h.email.resets[0].link);

    h.clock.advance(1000);
    await h.auth.forgotPassword('ana@acme.test');
    const second = extractToken(h.email.resets[1].link);

    expect(second).not.toBe(first);
    expect(h.passwordResets.rows).toHaveLength(2);

    await expect(h.auth.resetPassword(first, NEW_PASSWORD)).rejects.toMatchObject({
      code: 'INVALID_RESET_TOKEN',
      httpStatus: 400,
    });

    await expect(h.auth.resetPassword(second, NEW_PASSWORD)).resolves.toBeUndefined();
  });

  it('ignores an inactive operator', async () => {
    const h = buildHarness();
    h.agent.isActive = false;

    await expect(h.auth.forgotPassword('ana@acme.test')).resolves.toBeUndefined();

    expect(h.email.resets).toHaveLength(0);
    expect(h.passwordResets.rows).toHaveLength(0);
  });

  it('still resolves when the SMTP relay fails', async () => {
    const h = buildHarness();
    h.email.failResets = true;

    await expect(h.auth.forgotPassword('ana@acme.test')).resolves.toBeUndefined();

    // The token exists, so the operator can retry once the relay recovers.
    expect(h.passwordResets.rows).toHaveLength(1);
    expect(h.email.resets).toHaveLength(0);
  });
});

/* ==========================================================================
 * reset-password
 * ========================================================================== */

describe('AuthService.resetPassword', () => {
  async function requestedReset(h: ReturnType<typeof buildHarness>): Promise<string> {
    await h.auth.forgotPassword('ana@acme.test');
    return extractToken(h.email.resets[0].link);
  }

  it('re-hashes the password with bcrypt cost 12, burns the token and revokes sessions', async () => {
    const h = buildHarness();
    const first = await h.authSessions.issue(h.agent.id, { userAgent: 'device-a', ip: '10.0.0.1' });
    const second = await h.authSessions.issue(h.agent.id, { userAgent: 'device-b', ip: '10.0.0.2' });
    expect(first.refreshToken).not.toBe(second.refreshToken);

    const token = await requestedReset(h);
    await h.auth.resetPassword(token, NEW_PASSWORD);

    const stored = h.agents.rows[0];
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(stored.passwordHash).not.toContain(NEW_PASSWORD);
    await expect(bcrypt.compare(NEW_PASSWORD, stored.passwordHash)).resolves.toBe(true);
    await expect(bcrypt.compare(TEST_PASSWORD, stored.passwordHash)).resolves.toBe(false);

    const record = h.passwordResets.rows[0];
    expect(record.usedAt).toEqual(h.clock.now());

    expect(h.sessions.rows).toHaveLength(2);
    for (const session of h.sessions.rows) {
      expect(session.revokedAt).toEqual(h.clock.now());
    }
  });

  it('rejects an unknown token with 400 INVALID_RESET_TOKEN', async () => {
    const h = buildHarness();

    await expect(h.auth.resetPassword('f'.repeat(64), NEW_PASSWORD)).rejects.toMatchObject({
      code: 'INVALID_RESET_TOKEN',
      httpStatus: 400,
    });
    expect(await bcrypt.compare(TEST_PASSWORD, h.agents.rows[0].passwordHash)).toBe(true);
  });

  it('rejects a token after the 30 min TTL', async () => {
    const h = buildHarness();
    const token = await requestedReset(h);

    h.clock.advance(RESET_TTL_MS + 1000);

    await expect(h.auth.resetPassword(token, NEW_PASSWORD)).rejects.toMatchObject({
      code: 'INVALID_RESET_TOKEN',
      httpStatus: 400,
    });
    expect(await bcrypt.compare(TEST_PASSWORD, h.agents.rows[0].passwordHash)).toBe(true);
    expect(h.sessions.rows).toHaveLength(0);
  });

  it('rejects a replayed (already used) token', async () => {
    const h = buildHarness();
    const token = await requestedReset(h);

    await h.auth.resetPassword(token, NEW_PASSWORD);

    await expect(h.auth.resetPassword(token, 'another-password-123')).rejects.toMatchObject({
      code: 'INVALID_RESET_TOKEN',
      httpStatus: 400,
    });
    // The second attempt must not overwrite the password chosen first.
    await expect(bcrypt.compare(NEW_PASSWORD, h.agents.rows[0].passwordHash)).resolves.toBe(true);
  });

  it('requires at least 12 characters and keeps the token usable', async () => {
    const h = buildHarness();
    const token = await requestedReset(h);

    await expect(h.auth.resetPassword(token, 'short-pass')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      httpStatus: 422,
    });
    expect(h.passwordResets.rows[0].usedAt).toBeNull();
    expect(await bcrypt.compare(TEST_PASSWORD, h.agents.rows[0].passwordHash)).toBe(true);
  });

  it('rejects a token whose operator is no longer active', async () => {
    const h = buildHarness();
    const token = await requestedReset(h);
    h.agent.isActive = false;

    await expect(h.auth.resetPassword(token, NEW_PASSWORD)).rejects.toMatchObject({
      code: 'INVALID_RESET_TOKEN',
      httpStatus: 400,
    });
  });
});

/* ==========================================================================
 * refresh (rotation)
 * ========================================================================== */

describe('AuthSessionService.rotate', () => {
  it('rotates the session: revokes the old token and returns a new pair', async () => {
    const h = buildHarness();
    const issued = await h.authSessions.issue(h.agent.id, {
      userAgent: 'Mozilla/5.0 (test)',
      ip: '203.0.113.10',
    });

    h.clock.advance(60_000);
    const rotated = await h.authSessions.rotate(issued.refreshToken);

    expect(rotated.refreshToken).toMatch(/^[0-9a-f]{96}$/);
    expect(rotated.refreshToken).not.toBe(issued.refreshToken);
    expect(rotated.agent).toMatchObject({
      id: h.agent.id,
      email: 'ana@acme.test',
      role: 'ADMIN',
      tenantId: 'tenant-1',
    });

    // Access token is a real HS256 JWT signed for this principal.
    const claims = jwt.verify(rotated.token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'sac-hub',
      audience: 'sac-web',
    }) as jwt.JwtPayload;
    expect(claims.sub).toBe(h.agent.id);
    expect(claims.tenantId).toBe('tenant-1');

    expect(h.sessions.rows).toHaveLength(2);
    const [oldSession, newSession] = h.sessions.rows;
    expect(oldSession.revokedAt).toEqual(h.clock.now());
    expect(newSession.revokedAt).toBeNull();
    expect(newSession.refreshTokenHash).toBe(sha256(rotated.refreshToken));
    expect(newSession.userAgent).toBe('Mozilla/5.0 (test)');
    expect(newSession.ip).toBe('203.0.113.10');
    expect(newSession.expiresAt.getTime() - h.clock.now().getTime()).toBe(REFRESH_TOKEN_TTL_MS);
  });

  it('rejects an unknown refresh token with 401', async () => {
    const h = buildHarness();
    await expect(h.authSessions.rotate('a'.repeat(96))).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
      httpStatus: 401,
    });
  });

  it('rejects a revoked refresh token with 401', async () => {
    const h = buildHarness();
    const issued = await h.authSessions.issue(h.agent.id);

    await h.authSessions.revoke(issued.refreshToken, h.agent.id);

    await expect(h.authSessions.rotate(issued.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
      httpStatus: 401,
    });
  });

  it('rejects an expired refresh token with 401 after 30 days', async () => {
    const h = buildHarness();
    const issued = await h.authSessions.issue(h.agent.id);

    h.clock.advance(REFRESH_TOKEN_TTL_MS + 1000);

    await expect(h.authSessions.rotate(issued.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
      httpStatus: 401,
    });
  });

  it('rejects a replayed refresh token and keeps the rotated session alive', async () => {
    const h = buildHarness();
    const issued = await h.authSessions.issue(h.agent.id);

    const rotated = await h.authSessions.rotate(issued.refreshToken);

    await expect(h.authSessions.rotate(issued.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
      httpStatus: 401,
    });
    // The replay attempt must not have revoked the freshly minted session.
    await expect(h.authSessions.rotate(rotated.refreshToken)).resolves.toMatchObject({
      agent: { id: h.agent.id },
    });
  });

  it('rejects a malformed token without hitting the repository', async () => {
    const h = buildHarness();
    await expect(h.authSessions.rotate('too-short')).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
      httpStatus: 401,
    });
    expect(h.sessions.rows).toHaveLength(0);
  });

  it('rejects a session whose operator was deactivated', async () => {
    const h = buildHarness();
    const issued = await h.authSessions.issue(h.agent.id);
    h.agent.isActive = false;

    await expect(h.authSessions.rotate(issued.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
      httpStatus: 401,
    });
  });
});

/* ==========================================================================
 * logout
 * ========================================================================== */

describe('AuthSessionService.revoke', () => {
  it('revokes only the presented session of the caller', async () => {
    const h = buildHarness();
    const phone = await h.authSessions.issue(h.agent.id, { userAgent: 'phone' });
    const laptop = await h.authSessions.issue(h.agent.id, { userAgent: 'laptop' });

    const revoked = await h.authSessions.revoke(phone.refreshToken, h.agent.id);

    expect(revoked).toBe(true);
    const [phoneRow, laptopRow] = h.sessions.rows;
    expect(phoneRow.revokedAt).toEqual(h.clock.now());
    expect(laptopRow.revokedAt).toBeNull();
    expect(laptop.refreshToken).not.toBe(phone.refreshToken);
  });

  it('does not touch a session that belongs to another operator', async () => {
    const h = buildHarness();
    const issued = await h.authSessions.issue(h.agent.id);

    const revoked = await h.authSessions.revoke(issued.refreshToken, 'someone-else');

    expect(revoked).toBe(false);
    expect(h.sessions.rows[0].revokedAt).toBeNull();
  });

  it('answers false for an unknown token (logout is idempotent)', async () => {
    const h = buildHarness();
    await expect(h.authSessions.revoke('b'.repeat(96), h.agent.id)).resolves.toBe(false);
    expect(h.sessions.rows).toHaveLength(0);
  });

  it('revokeAllForUser closes every live session (logout everywhere)', async () => {
    const h = buildHarness();
    await h.authSessions.issue(h.agent.id, { userAgent: 'phone' });
    await h.authSessions.issue(h.agent.id, { userAgent: 'laptop' });

    const count = await h.authSessions.revokeAllForUser(h.agent.id);

    expect(count).toBe(2);
    expect(h.sessions.rows.every((row) => row.revokedAt !== null)).toBe(true);
    // A second call finds nothing left to revoke.
    await expect(h.authSessions.revokeAllForUser(h.agent.id)).resolves.toBe(0);
  });

  it('keeps a 30 day TTL on every issued session', async () => {
    const h = buildHarness();
    const issued = await h.authSessions.issue(h.agent.id);
    expect(issued.expiresAt.getTime() - h.clock.now().getTime()).toBe(30 * DAY_MS);
  });
});
