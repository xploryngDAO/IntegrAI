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
  ILogger,
  IRealtimePublisher,
  ITicketRepository,
  ITwoFactorRepository,
  LoginResult,
  TwoFactorRecoveryCodeRecord,
} from '@sac/shared';

import { SecretCipher } from '../../infrastructure/crypto/cipher';
import { AgentService } from '../AgentService';
import { AuthSessionService } from '../AuthSessionService';
import { TwoFactorService } from '../TwoFactorService';
import { totp } from '../auth/totp';
import { hashRecoveryCode } from '../auth/recovery-codes';
import { InMemorySessionRepository } from './authFakes';

/* ==========================================================================
 * Test doubles
 * ========================================================================== */

const TEST_PASSWORD = 'correct-horse-battery';
const JWT_SECRET = 'unit-test-secret-with-32-characters!!';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const VERIFY_WINDOW_MS = 60 * 1000;

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
    if (this.alive(key) !== null) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
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
    const next = entry === null ? 1 : Number(entry.value) + 1;
    await this.set(key, next, ttlSeconds);
    return next;
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

class InMemoryTwoFactorRepository implements ITwoFactorRepository {
  readonly codes: TwoFactorRecoveryCodeRecord[] = [];
  private sequence = 0;

  constructor(
    private readonly agents: InMemoryAgentRepository,
    private readonly clock: IClock,
  ) {}

  private requireAgent(userId: string): AgentRecord {
    const agent = this.agents.rows.find((row) => row.id === userId);
    if (agent === undefined) throw new Error(`agent not found: ${userId}`);
    return agent;
  }

  async setPendingSecret(userId: string, secretEnc: string): Promise<void> {
    const agent = this.requireAgent(userId);
    agent.twoFactorSecretEnc = secretEnc;
    agent.twoFactorEnabled = false;
  }

  async enable(userId: string, codeHashes: string[]): Promise<void> {
    this.requireAgent(userId).twoFactorEnabled = true;
    this.deleteRecoveryCodes(userId);
    for (const codeHash of codeHashes) {
      this.codes.push({
        id: `recovery-${(this.sequence += 1)}`,
        userId,
        codeHash,
        usedAt: null,
        createdAt: this.clock.now(),
      });
    }
  }

  async disable(userId: string): Promise<void> {
    const agent = this.requireAgent(userId);
    agent.twoFactorEnabled = false;
    agent.twoFactorSecretEnc = null;
    this.deleteRecoveryCodes(userId);
  }

  async replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<void> {
    this.deleteRecoveryCodes(userId);
    for (const codeHash of codeHashes) {
      this.codes.push({
        id: `recovery-${(this.sequence += 1)}`,
        userId,
        codeHash,
        usedAt: null,
        createdAt: this.clock.now(),
      });
    }
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    return this.codes.filter((entry) => entry.userId === userId && entry.usedAt === null).length;
  }

  async consumeRecoveryCode(userId: string, codeHash: string, at: Date): Promise<boolean> {
    const row = this.codes.find(
      (entry) => entry.userId === userId && entry.codeHash === codeHash && entry.usedAt === null,
    );
    if (row === undefined) return false;
    row.usedAt = at;
    return true;
  }

  private deleteRecoveryCodes(userId: string): number {
    let count = 0;
    for (let index = this.codes.length - 1; index >= 0; index -= 1) {
      if (this.codes[index].userId === userId) {
        this.codes.splice(index, 1);
        count += 1;
      }
    }
    return count;
  }
}

const silentRealtime: IRealtimePublisher = {
  ticketUpdated(): void {},
  messageCreated(): void {},
  queueChanged(): void {},
  channelHealth(): void {},
  agentPresence(): void {},
};

/* ==========================================================================
 * Harness
 * ========================================================================== */

let passwordHash = '';

beforeAll(async () => {
  passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
});

interface Harness {
  clock: FakeClock;
  agents: InMemoryAgentRepository;
  sessions: InMemorySessionRepository;
  twoFactorRepo: InMemoryTwoFactorRepository;
  cache: FakeCache;
  cipher: SecretCipher;
  agent: AgentRecord;
  agentService: AgentService;
  service: TwoFactorService;
  enroll(): Promise<{ secret: string; recoveryCodes: string[] }>;
}

function buildHarness(): Harness {
  const clock = new FakeClock(new Date('2026-03-01T09:00:00.000Z'));
  const agents = new InMemoryAgentRepository(clock);
  const sessions = new InMemorySessionRepository(clock);
  const twoFactorRepo = new InMemoryTwoFactorRepository(agents, clock);
  const cache = new FakeCache(clock);
  const cipher = new SecretCipher({ masterKey: MASTER_KEY, keyId: 'test-v1' });
  const agent = agents.seed({
    email: 'ana@acme.test',
    name: 'Ana',
    passwordHash,
    tenantId: 'tenant-1',
  });

  const tickets = {
    countActiveByAgent: async (): Promise<number> => 0,
  } as unknown as ITicketRepository;

  const authSessions = new AuthSessionService({
    logger,
    clock,
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '15m',
    repos: { agents, sessions },
  });

  const agentService = new AgentService({
    logger,
    clock,
    cache,
    realtime: silentRealtime,
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '15m',
    presenceTtlSeconds: 120,
    sessions: authSessions,
    repos: { agents, tickets },
  });

  const service = new TwoFactorService({
    logger,
    clock,
    cache,
    cipher,
    jwtSecret: JWT_SECRET,
    agentsService: agentService,
    repos: { agents, twoFactor: twoFactorRepo },
  });

  const enroll = async (): Promise<{ secret: string; recoveryCodes: string[] }> => {
    const setup = await service.setup(agent.id);
    const verified = await service.verify(agent.id, totp(setup.secret, clock.now()));
    return { secret: setup.secret, recoveryCodes: verified.recoveryCodes };
  };

  return { clock, agents, sessions, twoFactorRepo, cache, cipher, agent, agentService, service, enroll };
}

function challengeTokenFrom(result: LoginResult): string {
  if (!('twoFactorRequired' in result)) {
    throw new Error('Expected a TWO_FACTOR_REQUIRED login result');
  }
  return result.challengeToken;
}

/* ==========================================================================
 * setup
 * ========================================================================== */

describe('TwoFactorService.setup', () => {
  it('stores the secret encrypted, leaves 2FA pending and returns an otpauth URL', async () => {
    const h = buildHarness();

    const result = await h.service.setup(h.agent.id);

    expect(result.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(result.otpauthUrl.startsWith('otpauth://totp/')).toBe(true);

    const url = new URL(result.otpauthUrl);
    expect(url.host).toBe('totp');
    expect(url.searchParams.get('secret')).toBe(result.secret);
    expect(url.searchParams.get('issuer')).toBe('SAC Hub');
    expect(url.searchParams.get('algorithm')).toBe('SHA1');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');

    expect(h.agent.twoFactorEnabled).toBe(false);
    expect(h.agent.twoFactorSecretEnc).not.toBeNull();
    expect(h.agent.twoFactorSecretEnc).not.toContain(result.secret);
    expect(h.cipher.decrypt(h.agent.twoFactorSecretEnc ?? '')).toBe(result.secret);
  });

  it('regenerates the pending secret when setup is repeated before enabling', async () => {
    const h = buildHarness();

    const first = await h.service.setup(h.agent.id);
    const second = await h.service.setup(h.agent.id);

    expect(second.secret).not.toBe(first.secret);
    expect(h.cipher.decrypt(h.agent.twoFactorSecretEnc ?? '')).toBe(second.secret);
    expect(h.agent.twoFactorEnabled).toBe(false);
  });

  it('rejects a new setup when 2FA is already enabled (409)', async () => {
    const h = buildHarness();
    await h.enroll();

    await expect(h.service.setup(h.agent.id)).rejects.toMatchObject({
      code: 'TWO_FACTOR_ALREADY_ENABLED',
      httpStatus: 409,
    });
  });
});

/* ==========================================================================
 * verify
 * ========================================================================== */

describe('TwoFactorService.verify', () => {
  it('enables 2FA and returns 8 one-time recovery codes (hashes only at rest)', async () => {
    const h = buildHarness();
    const setup = await h.service.setup(h.agent.id);
    const code = totp(setup.secret, h.clock.now());

    const result = await h.service.verify(h.agent.id, code);

    expect(result.enabled).toBe(true);
    expect(result.recoveryCodes).toHaveLength(8);
    expect(new Set(result.recoveryCodes).size).toBe(8);
    for (const recoveryCode of result.recoveryCodes) {
      expect(recoveryCode).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    }

    expect(h.agent.twoFactorEnabled).toBe(true);
    expect(h.twoFactorRepo.codes).toHaveLength(8);
    for (const row of h.twoFactorRepo.codes) {
      expect(row.userId).toBe(h.agent.id);
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.usedAt).toBeNull();
      expect(result.recoveryCodes).not.toContain(row.codeHash);
    }
    const hashes = h.twoFactorRepo.codes.map((row) => row.codeHash);
    expect(hashes).toEqual(
      expect.arrayContaining(result.recoveryCodes.map((recoveryCode) => hashRecoveryCode(recoveryCode))),
    );
  });

  it('accepts a code from the ±1 window around the current step', async () => {
    const h = buildHarness();
    const setup = await h.service.setup(h.agent.id);

    // Code generated one step in the future is still accepted (clock skew).
    const code = totp(setup.secret, new Date(h.clock.now().getTime() + 30_000));
    await expect(h.service.verify(h.agent.id, code)).resolves.toMatchObject({ enabled: true });
  });

  it('rejects an invalid code with 400 INVALID_TOTP and keeps 2FA disabled', async () => {
    const h = buildHarness();
    await h.service.setup(h.agent.id);

    await expect(h.service.verify(h.agent.id, '000000')).rejects.toMatchObject({
      code: 'INVALID_TOTP',
      httpStatus: 400,
    });
    expect(h.agent.twoFactorEnabled).toBe(false);
    expect(h.twoFactorRepo.codes).toHaveLength(0);
  });

  it('rejects an expired code (outside the window)', async () => {
    const h = buildHarness();
    const setup = await h.service.setup(h.agent.id);
    const code = totp(setup.secret, h.clock.now());

    h.clock.advance(2 * VERIFY_WINDOW_MS);

    await expect(h.service.verify(h.agent.id, code)).rejects.toMatchObject({
      code: 'INVALID_TOTP',
      httpStatus: 400,
    });
  });

  it('requires setup before verifying (409)', async () => {
    const h = buildHarness();

    await expect(h.service.verify(h.agent.id, '000000')).rejects.toMatchObject({
      code: 'TWO_FACTOR_SETUP_REQUIRED',
      httpStatus: 409,
    });
  });

  it('rejects a second verification after 2FA is enabled (409)', async () => {
    const h = buildHarness();
    const { secret } = await h.enroll();

    await expect(
      h.service.verify(h.agent.id, totp(secret, h.clock.now())),
    ).rejects.toMatchObject({
      code: 'TWO_FACTOR_ALREADY_ENABLED',
      httpStatus: 409,
    });
    // The original recovery code set is untouched.
    expect(h.twoFactorRepo.codes).toHaveLength(8);
  });
});

/* ==========================================================================
 * disable
 * ========================================================================== */

describe('TwoFactorService.disable', () => {
  it('requires the correct password (401) and leaves 2FA enabled', async () => {
    const h = buildHarness();
    const { secret } = await h.enroll();

    await expect(
      h.service.disable(h.agent.id, 'wrong-password', totp(secret, h.clock.now())),
    ).rejects.toMatchObject({ code: 'INVALID_PASSWORD', httpStatus: 401 });

    expect(h.agent.twoFactorEnabled).toBe(true);
    expect(h.agent.twoFactorSecretEnc).not.toBeNull();
    expect(h.twoFactorRepo.codes).toHaveLength(8);
  });

  it('requires a valid TOTP or recovery code', async () => {
    const h = buildHarness();
    await h.enroll();

    await expect(h.service.disable(h.agent.id, TEST_PASSWORD)).rejects.toMatchObject({
      code: 'INVALID_TOTP',
      httpStatus: 400,
    });
    await expect(
      h.service.disable(h.agent.id, TEST_PASSWORD, '000000'),
    ).rejects.toMatchObject({ code: 'INVALID_TOTP', httpStatus: 400 });
    expect(h.agent.twoFactorEnabled).toBe(true);
  });

  it('disables with a valid TOTP code and wipes the secret + recovery codes', async () => {
    const h = buildHarness();
    const { secret } = await h.enroll();

    await h.service.disable(h.agent.id, TEST_PASSWORD, totp(secret, h.clock.now()));

    expect(h.agent.twoFactorEnabled).toBe(false);
    expect(h.agent.twoFactorSecretEnc).toBeNull();
    expect(h.twoFactorRepo.codes).toHaveLength(0);
  });

  it('disables with a one-time recovery code', async () => {
    const h = buildHarness();
    const { recoveryCodes } = await h.enroll();

    await h.service.disable(h.agent.id, TEST_PASSWORD, recoveryCodes[0]);

    expect(h.agent.twoFactorEnabled).toBe(false);
    expect(h.agent.twoFactorSecretEnc).toBeNull();
    expect(h.twoFactorRepo.codes).toHaveLength(0);
  });

  it('rejects disabling when 2FA is not enabled (409)', async () => {
    const h = buildHarness();

    await expect(
      h.service.disable(h.agent.id, TEST_PASSWORD, '000000'),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_NOT_ENABLED', httpStatus: 409 });
  });
});

/* ==========================================================================
 * recovery codes: regenerate + count
 * ========================================================================== */

describe('TwoFactorService.regenerateRecoveryCodes', () => {
  it('replaces the whole set atomically: old codes stop working, new ones work once', async () => {
    const h = buildHarness();
    const { secret, recoveryCodes: oldCodes } = await h.enroll();

    const result = await h.service.regenerateRecoveryCodes(
      h.agent.id,
      TEST_PASSWORD,
      totp(secret, h.clock.now()),
    );

    expect(result.recoveryCodes).toHaveLength(8);
    expect(new Set(result.recoveryCodes).size).toBe(8);
    for (const recoveryCode of result.recoveryCodes) {
      expect(recoveryCode).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    }

    // The previous set is gone from the store (deleted in the same transaction).
    expect(h.twoFactorRepo.codes).toHaveLength(8);
    const hashes = h.twoFactorRepo.codes.map((row) => row.codeHash);
    for (const oldCode of oldCodes) {
      expect(hashes).not.toContain(hashRecoveryCode(oldCode));
    }
    expect(hashes).toEqual(
      expect.arrayContaining(result.recoveryCodes.map((code) => hashRecoveryCode(code))),
    );
    for (const row of h.twoFactorRepo.codes) {
      expect(row.usedAt).toBeNull();
    }
    expect(h.agent.twoFactorEnabled).toBe(true);

    // An old recovery code no longer redeems a challenge...
    const oldChallenge = challengeTokenFrom(
      await h.agentService.login('ana@acme.test', TEST_PASSWORD),
    );
    await expect(h.service.challenge(oldChallenge, oldCodes[0])).rejects.toMatchObject({
      code: 'INVALID_TOTP',
      httpStatus: 401,
    });

    // ...while a regenerated code works exactly once.
    const first = challengeTokenFrom(
      await h.agentService.login('ana@acme.test', TEST_PASSWORD),
    );
    await expect(h.service.challenge(first, result.recoveryCodes[0])).resolves.toMatchObject({
      agent: { id: h.agent.id },
    });

    const second = challengeTokenFrom(
      await h.agentService.login('ana@acme.test', TEST_PASSWORD),
    );
    await expect(h.service.challenge(second, result.recoveryCodes[0])).rejects.toMatchObject({
      code: 'INVALID_TOTP',
      httpStatus: 401,
    });
  });

  it('requires the correct password (401) and keeps the current codes', async () => {
    const h = buildHarness();
    const { secret, recoveryCodes } = await h.enroll();
    const before = h.twoFactorRepo.codes.map((row) => row.id);

    await expect(
      h.service.regenerateRecoveryCodes(
        h.agent.id,
        'wrong-password',
        totp(secret, h.clock.now()),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PASSWORD', httpStatus: 401 });

    expect(h.twoFactorRepo.codes.map((row) => row.id)).toEqual(before);
    expect(h.twoFactorRepo.codes).toHaveLength(8);
    const hashes = h.twoFactorRepo.codes.map((row) => row.codeHash);
    expect(hashes).toEqual(
      expect.arrayContaining(recoveryCodes.map((code) => hashRecoveryCode(code))),
    );
  });

  it('requires a valid TOTP or recovery code (400) and keeps the current codes', async () => {
    const h = buildHarness();
    const { secret, recoveryCodes } = await h.enroll();
    const before = h.twoFactorRepo.codes.map((row) => row.id);

    await expect(
      h.service.regenerateRecoveryCodes(h.agent.id, TEST_PASSWORD, '000000'),
    ).rejects.toMatchObject({ code: 'INVALID_TOTP', httpStatus: 400 });
    await expect(
      h.service.regenerateRecoveryCodes(h.agent.id, TEST_PASSWORD),
    ).rejects.toMatchObject({ code: 'INVALID_TOTP', httpStatus: 400 });

    expect(h.twoFactorRepo.codes.map((row) => row.id)).toEqual(before);
    const hashes = h.twoFactorRepo.codes.map((row) => row.codeHash);
    expect(hashes).toEqual(
      expect.arrayContaining(recoveryCodes.map((code) => hashRecoveryCode(code))),
    );
    // The service never enables/changes 2FA state on failure.
    expect(h.agent.twoFactorEnabled).toBe(true);
    expect(h.cipher.decrypt(h.agent.twoFactorSecretEnc ?? '')).toBe(secret);
  });

  it('accepts a current recovery code (single-use rule) and rotates the whole set', async () => {
    const h = buildHarness();
    const { recoveryCodes } = await h.enroll();

    const result = await h.service.regenerateRecoveryCodes(
      h.agent.id,
      TEST_PASSWORD,
      recoveryCodes[0],
    );

    expect(result.recoveryCodes).toHaveLength(8);
    expect(result.recoveryCodes).not.toContain(recoveryCodes[0]);
    expect(h.twoFactorRepo.codes).toHaveLength(8);
    for (const row of h.twoFactorRepo.codes) {
      expect(row.usedAt).toBeNull();
    }
  });

  it('rejects regeneration when 2FA is not enabled (409)', async () => {
    const h = buildHarness();

    await expect(
      h.service.regenerateRecoveryCodes(h.agent.id, TEST_PASSWORD, '000000'),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_NOT_ENABLED', httpStatus: 409 });
    expect(h.twoFactorRepo.codes).toHaveLength(0);
  });

  it('answers 429 RATE_LIMITED after 5 attempts in the window', async () => {
    const h = buildHarness();
    const { secret } = await h.enroll();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        h.service.regenerateRecoveryCodes(h.agent.id, 'wrong-password', '000000'),
      ).rejects.toMatchObject({ code: 'INVALID_PASSWORD', httpStatus: 401 });
    }

    await expect(
      h.service.regenerateRecoveryCodes(
        h.agent.id,
        TEST_PASSWORD,
        totp(secret, h.clock.now()),
      ),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      details: { bucket: 'auth.2fa.recovery-codes.regenerate' },
    });
    // The blocked request did not rotate the codes.
    expect(h.twoFactorRepo.codes).toHaveLength(8);
  });
});

describe('TwoFactorService.countRecoveryCodes', () => {
  it('reports only unused codes and follows consumption/regeneration', async () => {
    const h = buildHarness();
    await expect(h.service.countRecoveryCodes(h.agent.id)).resolves.toEqual({ remaining: 0 });

    const { secret, recoveryCodes } = await h.enroll();
    await expect(h.service.countRecoveryCodes(h.agent.id)).resolves.toEqual({ remaining: 8 });

    // One code is redeemed: the count drops.
    expect(
      await h.twoFactorRepo.consumeRecoveryCode(
        h.agent.id,
        hashRecoveryCode(recoveryCodes[0]),
        h.clock.now(),
      ),
    ).toBe(true);
    await expect(h.service.countRecoveryCodes(h.agent.id)).resolves.toEqual({ remaining: 7 });

    // Regeneration restores the full set.
    await h.service.regenerateRecoveryCodes(
      h.agent.id,
      TEST_PASSWORD,
      totp(secret, h.clock.now()),
    );
    await expect(h.service.countRecoveryCodes(h.agent.id)).resolves.toEqual({ remaining: 8 });
  });
});

describe('TwoFactorService.status', () => {
  it('reflects the enabled flag through the lifecycle', async () => {
    const h = buildHarness();
    await expect(h.service.status(h.agent.id)).resolves.toEqual({ enabled: false });

    const { secret } = await h.enroll();
    await expect(h.service.status(h.agent.id)).resolves.toEqual({ enabled: true });

    await h.service.disable(h.agent.id, TEST_PASSWORD, totp(secret, h.clock.now()));
    await expect(h.service.status(h.agent.id)).resolves.toEqual({ enabled: false });
  });
});

/* ==========================================================================
 * login gate
 * ========================================================================== */

describe('AgentService.login + 2FA gate', () => {
  it('returns a short-lived challenge JWT instead of tokens when 2FA is enabled', async () => {
    const h = buildHarness();
    await h.enroll();

    const result = await h.agentService.login('ana@acme.test', TEST_PASSWORD);

    expect(result).toMatchObject({ twoFactorRequired: true });
    expect('token' in result).toBe(false);
    expect(h.sessions.rows).toHaveLength(0);
    expect(h.agent.presence).toBe('OFFLINE');

    const challengeToken = challengeTokenFrom(result);
    const claims = jwt.verify(challengeToken, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'sac-hub',
      audience: 'sac-2fa',
    }) as jwt.JwtPayload;

    expect(claims.sub).toBe(h.agent.id);
    expect(claims.scope).toBe('2fa');
    expect(claims.tenantId).toBe('tenant-1');
    expect(typeof claims.jti).toBe('string');
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(300);

    // The challenge JWT must never be accepted as a Bearer session.
    await expect(h.agentService.verifyToken(challengeToken)).rejects.toMatchObject({
      code: 'AUTHENTICATION_ERROR',
      httpStatus: 401,
    });
  });

  it('still answers 401 for a wrong password before the 2FA gate', async () => {
    const h = buildHarness();
    await h.enroll();

    await expect(
      h.agentService.login('ana@acme.test', 'wrong-password'),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR', httpStatus: 401 });
  });

  it('keeps a normal login (no challenge) for operators without 2FA', async () => {
    const h = buildHarness();

    const result = await h.agentService.login('ana@acme.test', TEST_PASSWORD);

    expect('token' in result).toBe(true);
    expect(h.sessions.rows).toHaveLength(1);
  });
});

/* ==========================================================================
 * challenge
 * ========================================================================== */

describe('TwoFactorService.challenge', () => {
  it('redeems a TOTP code and issues the same session shape as login', async () => {
    const h = buildHarness();
    const { secret } = await h.enroll();
    const login = await h.agentService.login('ana@acme.test', TEST_PASSWORD);
    const challengeToken = challengeTokenFrom(login);

    const session = await h.service.challenge(
      challengeToken,
      totp(secret, h.clock.now()),
      { userAgent: 'Mozilla/5.0 (test)', ip: '203.0.113.9' },
    );

    expect(session.token.length).toBeGreaterThan(0);
    expect(session.refreshToken).toMatch(/^[0-9a-f]{96}$/);
    expect(session.agent).toMatchObject({
      id: h.agent.id,
      email: 'ana@acme.test',
      role: 'ADMIN',
      presence: 'ONLINE',
      tenantId: 'tenant-1',
    });

    const claims = jwt.verify(session.token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'sac-hub',
      audience: 'sac-web',
    }) as jwt.JwtPayload;
    expect(claims.sub).toBe(h.agent.id);
    expect(claims.scope).toBeUndefined();

    expect(h.sessions.rows).toHaveLength(1);
    expect(h.sessions.rows[0].userAgent).toBe('Mozilla/5.0 (test)');
    expect(h.sessions.rows[0].refreshTokenHash).not.toBe(session.refreshToken);
  });

  it('rejects an invalid TOTP code with 401 INVALID_TOTP', async () => {
    const h = buildHarness();
    await h.enroll();
    const challengeToken = challengeTokenFrom(
      await h.agentService.login('ana@acme.test', TEST_PASSWORD),
    );

    await expect(
      h.service.challenge(challengeToken, '000000'),
    ).rejects.toMatchObject({ code: 'INVALID_TOTP', httpStatus: 401 });
    expect(h.sessions.rows).toHaveLength(0);
  });

  it('accepts a recovery code exactly once (single use)', async () => {
    const h = buildHarness();
    const { recoveryCodes } = await h.enroll();
    const first = challengeTokenFrom(
      await h.agentService.login('ana@acme.test', TEST_PASSWORD),
    );

    const session = await h.service.challenge(first, recoveryCodes[0]);
    expect(session.token.length).toBeGreaterThan(0);

    const used = h.twoFactorRepo.codes.find(
      (row) => row.codeHash === hashRecoveryCode(recoveryCodes[0]),
    );
    expect(used?.usedAt).toEqual(h.clock.now());

    // A new login/challenge with the same recovery code is rejected.
    const second = challengeTokenFrom(
      await h.agentService.login('ana@acme.test', TEST_PASSWORD),
    );
    await expect(
      h.service.challenge(second, recoveryCodes[0]),
    ).rejects.toMatchObject({ code: 'INVALID_TOTP', httpStatus: 401 });
    expect(h.sessions.rows).toHaveLength(1);
  });

  it('accepts a recovery code regardless of formatting/case', async () => {
    const h = buildHarness();
    const { recoveryCodes } = await h.enroll();
    const challengeToken = challengeTokenFrom(
      await h.agentService.login('ana@acme.test', TEST_PASSWORD),
    );
    const messy = ` ${recoveryCodes[0].toLowerCase().replace('-', ' ')} `;

    await expect(h.service.challenge(challengeToken, messy)).resolves.toMatchObject({
      agent: { id: h.agent.id },
    });
  });

  it('rejects a replayed TOTP code even with a fresh challenge token', async () => {
    const h = buildHarness();
    const { secret } = await h.enroll();
    const at = h.clock.now();
    const code = totp(secret, at);

    const first = challengeTokenFrom(
      await h.agentService.login('ana@acme.test', TEST_PASSWORD),
    );
    await h.service.challenge(first, code);

    const second = challengeTokenFrom(
      await h.agentService.login('ana@acme.test', TEST_PASSWORD),
    );
    await expect(h.service.challenge(second, code)).rejects.toMatchObject({
      code: 'INVALID_TOTP',
      httpStatus: 401,
    });
    expect(h.sessions.rows).toHaveLength(1);
  });

  it('burns the challenge token after a successful redemption', async () => {
    const h = buildHarness();
    const { secret } = await h.enroll();
    const first = challengeTokenFrom(
      await h.agentService.login('ana@acme.test', TEST_PASSWORD),
    );
    await h.service.challenge(first, totp(secret, h.clock.now()));

    // 30 s later the next time-step is valid, but the challenge is already spent.
    h.clock.advance(30_000);
    const nextCode = totp(secret, h.clock.now());
    await expect(h.service.challenge(first, nextCode)).rejects.toMatchObject({
      code: 'INVALID_CHALLENGE_TOKEN',
      httpStatus: 401,
    });
    expect(h.sessions.rows).toHaveLength(1);

    // A fresh challenge with the new time-step still works.
    const second = challengeTokenFrom(
      await h.agentService.login('ana@acme.test', TEST_PASSWORD),
    );
    await expect(h.service.challenge(second, nextCode)).resolves.toMatchObject({
      agent: { id: h.agent.id },
    });
  });

  it('rejects a tampered/foreign challenge token', async () => {
    const h = buildHarness();
    await h.enroll();

    await expect(h.service.challenge('not-a-jwt', '000000')).rejects.toMatchObject({
      code: 'INVALID_CHALLENGE_TOKEN',
      httpStatus: 401,
    });

    const foreign = jwt.sign(
      { scope: '2fa', tenantId: 'tenant-1', jti: 'jti-1' },
      'another-secret-with-32-characters!!!',
      { algorithm: 'HS256', expiresIn: '5m', issuer: 'sac-hub', audience: 'sac-web', subject: h.agent.id },
    );
    await expect(h.service.challenge(foreign, '000000')).rejects.toMatchObject({
      code: 'INVALID_CHALLENGE_TOKEN',
      httpStatus: 401,
    });
  });

  it('rejects a challenge token for an operator whose 2FA was disabled', async () => {
    const h = buildHarness();
    const { secret } = await h.enroll();
    const challengeToken = challengeTokenFrom(
      await h.agentService.login('ana@acme.test', TEST_PASSWORD),
    );

    await h.service.disable(h.agent.id, TEST_PASSWORD, totp(secret, h.clock.now()));

    await expect(
      h.service.challenge(challengeToken, totp(secret, h.clock.now())),
    ).rejects.toMatchObject({ code: 'INVALID_CHALLENGE_TOKEN', httpStatus: 401 });
  });
});
