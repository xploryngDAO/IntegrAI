import { createHash } from 'node:crypto';

import bcrypt from 'bcryptjs';
import { beforeAll, describe, expect, it } from 'vitest';

import type {
  AgentPresenceStatus,
  AgentRecord,
  CreateAgentInput,
  EmailVerificationRecord,
  IAgentRepository,
  IAuthSessionService,
  ICache,
  IClock,
  IEmailService,
  IEmailVerificationRepository,
  ILogger,
  IRealtimePublisher,
  ITenantRepository,
  ITicketRepository,
  LoginResult,
  LoginSuccess,
  TenantRecord,
} from '@sac/shared';

import { AgentService } from '../AgentService';
import { AuthService, slugifyCompanyName } from '../AuthService';
import { AuthSessionService } from '../AuthSessionService';
import {
  InMemoryPasswordResetRepository,
  InMemorySessionRepository,
} from './authFakes';

/* ==========================================================================
 * Test doubles
 * ========================================================================== */

const TEST_PASSWORD = 'correct-horse-battery';
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

class FakeCache implements ICache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly hashes = new Map<string, Record<string, string>>();
  private readonly sets = new Map<string, Set<string>>();
  cacheDown = false;

  constructor(private readonly clock: IClock) {}

  private alive(key: string): { value: unknown; expiresAt: number } | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.clock.now().getTime()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.alive(key);
    return entry === null ? null : (entry.value as T);
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: this.clock.now().getTime() + Math.max(1, ttlSeconds) * 1000,
    });
  }

  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.cacheDown) throw new Error('redis unavailable');
    if (this.alive(key) !== null) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
    this.hashes.delete(key);
    this.sets.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.alive(key) !== null;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.alive(key);
    if (entry === null) return -2;
    return Math.ceil((entry.expiresAt - this.clock.now().getTime()) / 1000);
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.alive(key);
    const next = (entry === null ? 0 : Number(entry.value)) + 1;
    this.entries.set(key, {
      value: next,
      expiresAt:
        entry === null
          ? this.clock.now().getTime() + Math.max(1, ttlSeconds) * 1000
          : entry.expiresAt,
    });
    return next;
  }

  async hset(key: string, values: Record<string, string>): Promise<void> {
    this.hashes.set(key, { ...(this.hashes.get(key) ?? {}), ...values });
  }

  async hgetall<T extends Record<string, string>>(key: string): Promise<T | null> {
    const hash = this.hashes.get(key);
    return hash === undefined ? null : (hash as T);
  }

  async sadd(key: string, members: string[]): Promise<void> {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const member of members) set.add(member);
    this.sets.set(key, set);
  }

  async srem(key: string, members: string[]): Promise<void> {
    const set = this.sets.get(key);
    if (set === undefined) return;
    for (const member of members) set.delete(member);
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Set<string>())];
  }
}

interface SentEmail {
  to: string;
  link: string;
  name?: string;
}

class FakeEmailService implements IEmailService {
  readonly sent: SentEmail[] = [];
  readonly sentResets: SentEmail[] = [];
  failNext = false;

  async sendVerificationEmail(to: string, link: string, name?: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('smtp unavailable');
    }
    this.sent.push({ to, link, name });
  }

  async sendPasswordResetEmail(to: string, link: string, name?: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('smtp unavailable');
    }
    this.sentResets.push({ to, link, name });
  }

  async sendInvitationEmail(): Promise<void> {
    // Invitations are covered by Invitations.test.ts.
  }
}

class InMemoryTenantRepository implements ITenantRepository {
  readonly rows: TenantRecord[] = [];
  private sequence = 0;

  constructor(private readonly clock: IClock) {}

  async create(input: { slug: string; name: string; status?: string }): Promise<TenantRecord> {
    const at = this.clock.now();
    const row: TenantRecord = {
      id: `tenant-${(this.sequence += 1)}`,
      slug: input.slug,
      name: input.name,
      status: input.status ?? 'ACTIVE',
      createdAt: at,
      updatedAt: at,
    };
    this.rows.push(row);
    return row;
  }

  async findBySlug(slug: string): Promise<TenantRecord | null> {
    return this.rows.find((row) => row.slug === slug) ?? null;
  }

  async findById(id: string): Promise<TenantRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
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
      role: 'ADMIN',
      presence: 'OFFLINE',
      avatarColor: '#2563eb',
      maxConcurrent: 20,
      isActive: input.isActive ?? true,
      lastSeenAt: null,
      emailVerifiedAt: input.emailVerifiedAt ?? null,
      twoFactorSecretEnc: null,
      twoFactorEnabled: false,
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

class InMemoryEmailVerificationRepository implements IEmailVerificationRepository {
  readonly rows: EmailVerificationRecord[] = [];
  private sequence = 0;

  constructor(private readonly clock: IClock) {}

  async create(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<EmailVerificationRecord> {
    const row: EmailVerificationRecord = {
      id: `verification-${(this.sequence += 1)}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      usedAt: null,
      createdAt: this.clock.now(),
    };
    this.rows.push(row);
    return row;
  }

  async findByTokenHash(tokenHash: string): Promise<EmailVerificationRecord | null> {
    return this.rows.find((row) => row.tokenHash === tokenHash) ?? null;
  }

  async markUsed(id: string, at: Date): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row !== undefined) row.usedAt = at;
  }

  async invalidateUnused(userId: string, at: Date): Promise<number> {
    let count = 0;
    for (const row of this.rows) {
      if (row.userId === userId && row.usedAt === null) {
        row.usedAt = at;
        count += 1;
      }
    }
    return count;
  }
}

function silentRealtime(): IRealtimePublisher {
  return {
    ticketUpdated(): void {},
    messageCreated(): void {},
    queueChanged(): void {},
    channelHealth(): void {},
    agentPresence(): void {},
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function extractToken(link: string): string {
  const token = new URL(link).searchParams.get('token');
  if (token === null) throw new Error(`No token in link: ${link}`);
  return token;
}

function buildHarness(overrides?: { webOrigin?: string; appBaseUrl?: string }) {
  const clock = new FakeClock(new Date('2026-01-01T12:00:00.000Z'));
  const cache = new FakeCache(clock);
  const email = new FakeEmailService();
  const tenants = new InMemoryTenantRepository(clock);
  const agents = new InMemoryAgentRepository(clock);
  const emailVerifications = new InMemoryEmailVerificationRepository(clock);
  const passwordResets = new InMemoryPasswordResetRepository(clock);
  const sessions = new InMemorySessionRepository(clock);

  const auth = new AuthService({
    logger,
    clock,
    cache,
    email,
    config: {
      webOrigin: overrides?.webOrigin ?? 'https://app.test, http://localhost:5173',
      appBaseUrl: overrides?.appBaseUrl ?? 'https://api.test',
    },
    repos: { agents, tenants, emailVerifications, passwordResets, sessions },
  });

  return {
    clock,
    cache,
    email,
    tenants,
    agents,
    emailVerifications,
    passwordResets,
    sessions,
    auth,
  };
}

function buildAgentService(
  agents: InMemoryAgentRepository,
  clock: FakeClock,
  sessions?: IAuthSessionService,
): AgentService {
  const tickets = {
    countActiveByAgent: async (): Promise<number> => 0,
  } as unknown as ITicketRepository;

  return new AgentService({
    logger,
    clock,
    cache: new FakeCache(clock),
    realtime: silentRealtime(),
    jwtSecret: 'unit-test-secret-with-32-characters!!',
    jwtExpiresIn: '1h',
    presenceTtlSeconds: 120,
    ...(sessions !== undefined ? { sessions } : {}),
    repos: { agents, tickets },
  });
}

/** Login returns a union (session | 2FA challenge); these tests expect a session. */
function expectLoginSuccess(result: LoginResult): LoginSuccess {
  if ('twoFactorRequired' in result) {
    throw new Error('Expected an authenticated session, got a 2FA challenge');
  }
  return result;
}

let verifiedPasswordHash = '';

beforeAll(async () => {
  verifiedPasswordHash = await bcrypt.hash(TEST_PASSWORD, 12);
});

/* ==========================================================================
 * signup
 * ========================================================================== */

describe('AuthService.signup', () => {
  it('creates the tenant + ADMIN, hashes the password and stores only the token hash', async () => {
    const h = buildHarness();

    const result = await h.auth.signup({
      companyName: 'Loja do João & Cia',
      name: 'João',
      email: ' Admin@Example.com ',
      password: TEST_PASSWORD,
    });

    expect(result).toEqual({
      tenantId: expect.any(String) as string,
      userId: expect.any(String) as string,
      emailVerificationRequired: true,
    });

    expect(h.tenants.rows).toHaveLength(1);
    const tenant = h.tenants.rows[0];
    expect(tenant).toMatchObject({
      id: result.tenantId,
      slug: 'loja-do-joao-cia',
      name: 'Loja do João & Cia',
      status: 'ACTIVE',
    });

    expect(h.agents.rows).toHaveLength(1);
    const agent = h.agents.rows[0];
    expect(agent).toMatchObject({
      id: result.userId,
      email: 'admin@example.com',
      role: 'ADMIN',
      tenantId: tenant.id,
      emailVerifiedAt: null,
      isActive: true,
    });
    // bcrypt cost 12, never the plaintext.
    expect(agent.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(agent.passwordHash).not.toContain(TEST_PASSWORD);
    await expect(bcrypt.compare(TEST_PASSWORD, agent.passwordHash)).resolves.toBe(true);

    expect(h.emailVerifications.rows).toHaveLength(1);
    const verification = h.emailVerifications.rows[0];
    const token = extractToken(h.email.sent[0].link);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verification.tokenHash).toBe(sha256(token));
    expect(verification.tokenHash).not.toBe(token);
    expect(verification.userId).toBe(agent.id);
    expect(verification.usedAt).toBeNull();
    expect(verification.expiresAt.getTime() - h.clock.now().getTime()).toBe(DAY_MS);

    expect(h.email.sent).toHaveLength(1);
    expect(h.email.sent[0].to).toBe('admin@example.com');
    expect(h.email.sent[0].name).toBe('João');
    expect(h.email.sent[0].link).toBe(
      `https://app.test/verify-email?token=${encodeURIComponent(token)}`,
    );
  });

  it('rejects a duplicate e-mail globally with 409 and creates no tenant', async () => {
    const h = buildHarness();
    h.agents.seed({
      email: 'admin@example.com',
      passwordHash: verifiedPasswordHash,
      emailVerifiedAt: new Date(),
    });

    await expect(
      h.auth.signup({
        companyName: 'Outra Loja',
        name: 'Maria',
        email: 'ADMIN@example.com',
        password: TEST_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 });

    expect(h.tenants.rows).toHaveLength(0);
    expect(h.agents.rows).toHaveLength(1);
    expect(h.email.sent).toHaveLength(0);
  });

  it('rejects a password shorter than 12 characters', async () => {
    const h = buildHarness();
    await expect(
      h.auth.signup({
        companyName: 'Loja Curta',
        name: 'Ana',
        email: 'ana@example.com',
        password: 'short-pass',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
    expect(h.tenants.rows).toHaveLength(0);
  });

  it('allocates a suffixed slug when the company slug is already taken', async () => {
    const h = buildHarness();
    await h.auth.signup({
      companyName: 'Acme',
      name: 'Ana',
      email: 'ana@acme.test',
      password: TEST_PASSWORD,
    });
    await h.auth.signup({
      companyName: 'Acme',
      name: 'Bia',
      email: 'bia@acme.test',
      password: TEST_PASSWORD,
    });

    expect(h.tenants.rows.map((row) => row.slug)).toEqual(['acme', 'acme-2']);
  });

  it('falls back to APP_BASE_URL when WEB_ORIGIN is empty', async () => {
    const h = buildHarness({ webOrigin: '' });
    await h.auth.signup({
      companyName: 'Fallback',
      name: 'Ana',
      email: 'ana@fallback.test',
      password: TEST_PASSWORD,
    });
    expect(h.email.sent[0].link).toMatch(/^https:\/\/api\.test\/verify-email\?token=/);
  });

  it('still completes when the e-mail service fails (link can be resent)', async () => {
    const h = buildHarness();
    h.email.failNext = true;

    const result = await h.auth.signup({
      companyName: 'SMTP Down',
      name: 'Ana',
      email: 'ana@smtp.test',
      password: TEST_PASSWORD,
    });

    expect(result.emailVerificationRequired).toBe(true);
    expect(h.agents.rows).toHaveLength(1);
    expect(h.emailVerifications.rows).toHaveLength(1);
    expect(h.email.sent).toHaveLength(0);
  });
});

describe('slugifyCompanyName', () => {
  it('normalizes accents, punctuation and casing', () => {
    expect(slugifyCompanyName('  Café & Cia!! ')).toBe('cafe-cia');
    expect(slugifyCompanyName('Loja   do   João')).toBe('loja-do-joao');
    expect(slugifyCompanyName('***')).toBe('tenant');
  });
});

/* ==========================================================================
 * verify-email
 * ========================================================================== */

describe('AuthService.verifyEmail', () => {
  async function signupAndGetToken(h: ReturnType<typeof buildHarness>): Promise<string> {
    await h.auth.signup({
      companyName: 'Verificação',
      name: 'Ana',
      email: 'ana@verify.test',
      password: TEST_PASSWORD,
    });
    return extractToken(h.email.sent[0].link);
  }

  it('marks the operator as verified and burns the token', async () => {
    const h = buildHarness();
    const token = await signupAndGetToken(h);

    await h.auth.verifyEmail(token);

    expect(h.agents.rows[0].emailVerifiedAt).toEqual(h.clock.now());
    expect(h.emailVerifications.rows[0].usedAt).toEqual(h.clock.now());
  });

  it('rejects an unknown token', async () => {
    const h = buildHarness();
    await expect(h.auth.verifyEmail('f'.repeat(64))).rejects.toMatchObject({
      code: 'INVALID_VERIFICATION_TOKEN',
      httpStatus: 400,
    });
  });

  it('rejects a token after its 24h TTL', async () => {
    const h = buildHarness();
    const token = await signupAndGetToken(h);

    h.clock.advance(DAY_MS + 1000);

    await expect(h.auth.verifyEmail(token)).rejects.toMatchObject({
      code: 'INVALID_VERIFICATION_TOKEN',
    });
    expect(h.agents.rows[0].emailVerifiedAt).toBeNull();
  });

  it('rejects a replayed (already used) token', async () => {
    const h = buildHarness();
    const token = await signupAndGetToken(h);

    await h.auth.verifyEmail(token);

    await expect(h.auth.verifyEmail(token)).rejects.toMatchObject({
      code: 'INVALID_VERIFICATION_TOKEN',
    });
  });

  it('invalidates the previous link when a new one is issued', async () => {
    const h = buildHarness();
    const first = await signupAndGetToken(h);

    await h.auth.resendVerification('ana@verify.test');
    const second = extractToken(h.email.sent[1].link);

    expect(second).not.toBe(first);
    await expect(h.auth.verifyEmail(first)).rejects.toMatchObject({
      code: 'INVALID_VERIFICATION_TOKEN',
    });

    await h.auth.verifyEmail(second);
    expect(h.agents.rows[0].emailVerifiedAt).not.toBeNull();
  });
});

/* ==========================================================================
 * resend-verification
 * ========================================================================== */

describe('AuthService.resendVerification', () => {
  it('always resolves for an unknown e-mail and sends nothing', async () => {
    const h = buildHarness();
    await expect(h.auth.resendVerification('nobody@example.com')).resolves.toBeUndefined();
    expect(h.email.sent).toHaveLength(0);
  });

  it('sends a fresh link once, then throttles for 1 minute', async () => {
    const h = buildHarness();
    await h.auth.signup({
      companyName: 'Resend',
      name: 'Ana',
      email: 'ana@resend.test',
      password: TEST_PASSWORD,
    });

    await h.auth.resendVerification('ana@resend.test');
    expect(h.email.sent).toHaveLength(2);

    await h.auth.resendVerification('ana@resend.test');
    expect(h.email.sent).toHaveLength(2);

    h.clock.advance(61_000);
    await h.auth.resendVerification('ana@resend.test');
    expect(h.email.sent).toHaveLength(3);
  });

  it('falls back to an in-memory 1/minute window when Redis is unavailable', async () => {
    const h = buildHarness();
    await h.auth.signup({
      companyName: 'Redis Down',
      name: 'Ana',
      email: 'ana@redisdown.test',
      password: TEST_PASSWORD,
    });
    h.cache.cacheDown = true;

    await h.auth.resendVerification('ana@redisdown.test');
    expect(h.email.sent).toHaveLength(2);

    await h.auth.resendVerification('ana@redisdown.test');
    expect(h.email.sent).toHaveLength(2);

    h.clock.advance(61_000);
    await h.auth.resendVerification('ana@redisdown.test');
    expect(h.email.sent).toHaveLength(3);
  });

  it('does nothing for an account that is already verified', async () => {
    const h = buildHarness();
    await h.auth.signup({
      companyName: 'Verified',
      name: 'Ana',
      email: 'ana@verified.test',
      password: TEST_PASSWORD,
    });
    await h.auth.verifyEmail(extractToken(h.email.sent[0].link));

    await h.auth.resendVerification('ana@verified.test');
    expect(h.email.sent).toHaveLength(1);
  });
});

/* ==========================================================================
 * login gate (AgentService)
 * ========================================================================== */

describe('AgentService.login + e-mail verification', () => {
  it('blocks login with 403 EMAIL_NOT_VERIFIED when email_verified_at is null', async () => {
    const clock = new FakeClock(new Date('2026-01-01T12:00:00.000Z'));
    const agents = new InMemoryAgentRepository(clock);
    agents.seed({
      email: 'pending@example.com',
      passwordHash: verifiedPasswordHash,
      emailVerifiedAt: null,
    });
    const service = buildAgentService(agents, clock);

    await expect(service.login('pending@example.com', TEST_PASSWORD)).rejects.toMatchObject({
      code: 'EMAIL_NOT_VERIFIED',
      httpStatus: 403,
    });
  });

  it('answers 401 (not 403) for a wrong password on an unverified account', async () => {
    const clock = new FakeClock(new Date('2026-01-01T12:00:00.000Z'));
    const agents = new InMemoryAgentRepository(clock);
    agents.seed({
      email: 'pending@example.com',
      passwordHash: verifiedPasswordHash,
      emailVerifiedAt: null,
    });
    const service = buildAgentService(agents, clock);

    await expect(service.login('pending@example.com', 'wrong-password')).rejects.toMatchObject({
      code: 'AUTHENTICATION_ERROR',
      httpStatus: 401,
    });
  });

  it('keeps logging in the verified bootstrap ADMIN (seed)', async () => {
    const clock = new FakeClock(new Date('2026-01-01T12:00:00.000Z'));
    const agents = new InMemoryAgentRepository(clock);
    const admin = agents.seed({
      email: 'admin@integrai.test',
      passwordHash: verifiedPasswordHash,
      emailVerifiedAt: new Date('2025-11-01T00:00:00.000Z'),
      tenantId: 'tenant-bootstrap',
    });
    const service = buildAgentService(agents, clock);

    const result = expectLoginSuccess(await service.login('admin@integrai.test', TEST_PASSWORD));

    expect(result.agent).toMatchObject({
      id: admin.id,
      email: 'admin@integrai.test',
      tenantId: 'tenant-bootstrap',
    });
    expect(result.token.length).toBeGreaterThan(0);
  });
});

describe('AgentService.login + refresh token issuance', () => {
  it('creates a session and returns the raw refresh token (hashed at rest)', async () => {
    const clock = new FakeClock(new Date('2026-01-01T12:00:00.000Z'));
    const agents = new InMemoryAgentRepository(clock);
    const sessions = new InMemorySessionRepository(clock);
    const agent = agents.seed({
      email: 'admin@tenant.test',
      passwordHash: verifiedPasswordHash,
      emailVerifiedAt: new Date('2025-11-01T00:00:00.000Z'),
      tenantId: 'tenant-1',
    });
    const sessionService = new AuthSessionService({
      logger,
      clock,
      jwtSecret: 'unit-test-secret-with-32-characters!!',
      jwtExpiresIn: '1h',
      repos: { agents, sessions },
    });
    const service = buildAgentService(agents, clock, sessionService);

    const result = expectLoginSuccess(
      await service.login('admin@tenant.test', TEST_PASSWORD, {
        userAgent: 'Mozilla/5.0 (test)',
        ip: '203.0.113.10',
      }),
    );

    expect(result.token.length).toBeGreaterThan(0);
    expect(typeof result.refreshToken).toBe('string');
    const refreshToken = result.refreshToken ?? '';
    expect(refreshToken).toMatch(/^[0-9a-f]{96}$/);

    expect(sessions.rows).toHaveLength(1);
    const session = sessions.rows[0];
    expect(session).toMatchObject({
      userId: agent.id,
      tenantId: 'tenant-1',
      userAgent: 'Mozilla/5.0 (test)',
      ip: '203.0.113.10',
      revokedAt: null,
    });
    expect(session.refreshTokenHash).toBe(sha256(refreshToken));
    expect(session.refreshTokenHash).not.toBe(refreshToken);
    expect(session.expiresAt.getTime() - clock.now().getTime()).toBe(30 * DAY_MS);
  });

  it('omits the refresh token when the operator has no tenant', async () => {
    const clock = new FakeClock(new Date('2026-01-01T12:00:00.000Z'));
    const agents = new InMemoryAgentRepository(clock);
    const sessions = new InMemorySessionRepository(clock);
    agents.seed({
      email: 'legacy@tenant.test',
      passwordHash: verifiedPasswordHash,
      emailVerifiedAt: new Date('2025-11-01T00:00:00.000Z'),
      tenantId: null,
    });
    const sessionService = new AuthSessionService({
      logger,
      clock,
      jwtSecret: 'unit-test-secret-with-32-characters!!',
      jwtExpiresIn: '1h',
      repos: { agents, sessions },
    });
    const service = buildAgentService(agents, clock, sessionService);

    const result = expectLoginSuccess(await service.login('legacy@tenant.test', TEST_PASSWORD));

    expect(result.refreshToken).toBeUndefined();
    expect(sessions.rows).toHaveLength(0);
  });

  it('still logs in when the session store fails', async () => {
    const clock = new FakeClock(new Date('2026-01-01T12:00:00.000Z'));
    const agents = new InMemoryAgentRepository(clock);
    agents.seed({
      email: 'admin@broken.test',
      passwordHash: verifiedPasswordHash,
      emailVerifiedAt: new Date('2025-11-01T00:00:00.000Z'),
      tenantId: 'tenant-1',
    });
    const failingSessions = {
      async issue(): Promise<never> {
        throw new Error('database unavailable');
      },
      async rotate(): Promise<never> {
        throw new Error('database unavailable');
      },
      async revoke(): Promise<boolean> {
        return false;
      },
      async revokeAllForUser(): Promise<number> {
        return 0;
      },
    } as unknown as IAuthSessionService;
    const service = buildAgentService(agents, clock, failingSessions);

    const result = expectLoginSuccess(await service.login('admin@broken.test', TEST_PASSWORD));

    expect(result.token.length).toBeGreaterThan(0);
    expect(result.refreshToken).toBeUndefined();
  });
});
