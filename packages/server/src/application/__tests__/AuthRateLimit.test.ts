import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it } from 'vitest';

import { CACHE_KEYS } from '@sac/shared';
import type {
  EmailVerificationRecord,
  IAgentService,
  IEmailService,
  IEmailVerificationRepository,
  IRealtimePublisher,
  ISessionRepository,
  ITicketRepository,
  ITwoFactorRepository,
  LoginResult,
} from '@sac/shared';

import { AgentService } from '../AgentService';
import { AuthService } from '../AuthService';
import { TwoFactorService } from '../TwoFactorService';
import { totp } from '../auth/totp';
import { signTwoFactorChallengeToken } from '../auth/two-factor-token';
import { FrozenClock, FakeCipher, silentLogger } from './accountFakes';
import { InMemoryPasswordResetRepository } from './authFakes';
import {
  InMemoryTenantRepository,
  StubAgentRepository,
  makeTenant,
} from './platformFakes';
import { CountingCache } from './rateLimitFakes';

/**
 * Wiring tests for the sensitive-auth rate limits: the unit tests in
 * `rate-limit.test.ts` prove the helper, these prove that login, the 2FA
 * challenge and the two public e-mail endpoints actually go through it and
 * answer `429 RATE_LIMITED` at the documented thresholds.
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');
const JWT_SECRET = 'unit-test-secret-with-32-characters!!';
const PASSWORD = 'correct-horse-battery';
const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const IP_A = '203.0.113.10';
const IP_B = '198.51.100.20';

let passwordHash = '';

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

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

class RecordingEmailService implements IEmailService {
  readonly sent: string[] = [];

  async sendVerificationEmail(to: string): Promise<void> {
    this.sent.push(`verify:${to}`);
  }
  async sendPasswordResetEmail(to: string): Promise<void> {
    this.sent.push(`reset:${to}`);
  }
  async sendInvitationEmail(): Promise<void> {}
}

class InMemoryVerificationRepository implements IEmailVerificationRepository {
  private sequence = 0;

  constructor(private readonly clock: FrozenClock) {}

  async create(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<EmailVerificationRecord> {
    return {
      id: `verification-${(this.sequence += 1)}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      usedAt: null,
      createdAt: this.clock.now(),
    };
  }

  async findByTokenHash(): Promise<EmailVerificationRecord | null> {
    return null;
  }
  async markUsed(): Promise<void> {}
  async invalidateUnused(): Promise<number> {
    return 0;
  }
}

/* ==========================================================================
 * login
 * ========================================================================== */

function createLoginHarness() {
  const clock = new FrozenClock(NOW);
  const cache = new CountingCache(clock);
  const agents = new StubAgentRepository();
  const tenants = new InMemoryTenantRepository(() => clock.now());
  tenants.seed(makeTenant({ id: 'tenant-1', slug: 'acme' }));
  const agent = agents.seed({
    id: 'agent-1',
    email: 'ana@acme.test',
    passwordHash,
    tenantId: 'tenant-1',
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

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

  return { clock, cache, agents, agent, service };
}

function expectLogin(result: LoginResult): void {
  if ('twoFactorRequired' in result) throw new Error('Expected a session, got a 2FA challenge');
}

describe('POST /auth/login rate limit (10 / 15 min per e-mail + IP)', () => {
  it('answers 401 for the first 10 attempts and 429 on the 11th', async () => {
    const h = createLoginHarness();

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await expect(
        h.service.login('ana@acme.test', 'wrong-password', { ip: IP_A }),
      ).rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR', httpStatus: 401 });
    }

    await expect(
      h.service.login('ana@acme.test', 'wrong-password', { ip: IP_A }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      details: { bucket: 'auth.login' },
    });
  });

  it('does not spend the budget of another IP or another e-mail', async () => {
    const h = createLoginHarness();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        h.service.login('ana@acme.test', 'wrong-password', { ip: IP_A }),
      ).rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });
    }

    // Same account, different IP: its own window is still fresh.
    expectLogin(await h.service.login('ana@acme.test', PASSWORD, { ip: IP_B }));
    // Different account, saturated IP: also allowed (the key is e-mail + IP).
    await expect(
      h.service.login('nobody@acme.test', 'wrong-password', { ip: IP_A }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });
  });

  it('counts successful logins too (the window is about attempts)', async () => {
    const h = createLoginHarness();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expectLogin(await h.service.login('ana@acme.test', PASSWORD, { ip: IP_A }));
    }

    await expect(
      h.service.login('ana@acme.test', PASSWORD, { ip: IP_A }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429 });
  });

  it('clears the window after 15 minutes', async () => {
    const h = createLoginHarness();
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await h.service
        .login('ana@acme.test', 'wrong-password', { ip: IP_A })
        .catch(() => undefined);
    }

    h.clock.set(new Date(NOW.getTime() + 15 * 60 * 1_000 + 1));
    expectLogin(await h.service.login('ana@acme.test', PASSWORD, { ip: IP_A }));
  });

  it('still enforces the limit when Redis is down (in-process fallback)', async () => {
    const h = createLoginHarness();
    h.cache.failIncr = true;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        h.service.login('ana@acme.test', 'wrong-password', { ip: IP_A }),
      ).rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });
    }

    await expect(
      h.service.login('ana@acme.test', 'wrong-password', { ip: IP_A }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429 });
  });
});

/* ==========================================================================
 * 2FA challenge
 * ========================================================================== */

function createChallengeHarness() {
  const clock = new FrozenClock(NOW);
  const cache = new CountingCache(clock);
  const cipher = new FakeCipher();
  const agents = new StubAgentRepository();
  agents.seed({
    id: 'agent-1',
    email: 'ana@acme.test',
    tenantId: 'tenant-1',
    twoFactorEnabled: true,
    twoFactorSecretEnc: cipher.encrypt(TOTP_SECRET),
  });

  const twoFactorRepo: ITwoFactorRepository = {
    setPendingSecret: async () => {},
    enable: async () => {},
    disable: async () => {},
    replaceRecoveryCodes: async () => {},
    countUnusedRecoveryCodes: async () => 0,
    consumeRecoveryCode: async () => false,
  };

  const agentsService = {
    issueSession: async (): Promise<never> => {
      throw new Error('the session must not be issued by a rejected challenge');
    },
  } as unknown as IAgentService;

  const service = new TwoFactorService({
    logger: silentLogger,
    clock,
    cache,
    cipher,
    jwtSecret: JWT_SECRET,
    agentsService,
    repos: { agents, twoFactor: twoFactorRepo },
  });

  const token = (): string =>
    signTwoFactorChallengeToken({ userId: 'agent-1', tenantId: 'tenant-1', secret: JWT_SECRET });

  const jtiOf = (challengeToken: string): string => {
    const claims = jwt.verify(challengeToken, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'sac-hub',
      audience: 'sac-2fa',
    }) as jwt.JwtPayload;
    if (typeof claims.jti !== 'string') throw new Error('challenge token has no jti');
    return claims.jti;
  };

  const wrongCode = (): string => {
    const current = totp(TOTP_SECRET, clock.now());
    for (const candidate of ['000000', '111111', '222222', '333333']) {
      if (candidate !== current) return candidate;
    }
    return '999999';
  };

  return { clock, cache, service, token, jtiOf, wrongCode };
}

describe('POST /auth/2fa/challenge rate limit (5 per challenge jti / IP)', () => {
  it('allows 5 attempts, answers 429 on the 6th and burns the challenge', async () => {
    const h = createChallengeHarness();
    const challengeToken = h.token();
    const jti = h.jtiOf(challengeToken);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        h.service.challenge(challengeToken, h.wrongCode(), { ip: IP_A }),
      ).rejects.toMatchObject({ code: 'INVALID_TOTP', httpStatus: 401 });
    }

    // The window is spent: the challenge is burned, so even the correct code
    // cannot redeem it - and the next request is a 429, not a 401.
    expect(await h.cache.exists(CACHE_KEYS.twoFactorChallenge(jti))).toBe(true);

    await expect(
      h.service.challenge(challengeToken, totp(TOTP_SECRET, h.clock.now()), { ip: IP_A }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      details: { bucket: 'auth.2fa.challenge' },
    });
  });

  it('limits per source IP across different challenges', async () => {
    const h = createChallengeHarness();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        h.service.challenge(h.token(), h.wrongCode(), { ip: IP_A }),
      ).rejects.toMatchObject({ code: 'INVALID_TOTP' });
    }

    await expect(
      h.service.challenge(h.token(), h.wrongCode(), { ip: IP_A }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      details: { bucket: 'auth.2fa.challenge.ip' },
    });

    // Another source IP still has its own window.
    await expect(
      h.service.challenge(h.token(), h.wrongCode(), { ip: IP_B }),
    ).rejects.toMatchObject({ code: 'INVALID_TOTP' });
  });

  it('uses only the jti window when the request has no IP', async () => {
    const h = createChallengeHarness();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(h.service.challenge(h.token(), h.wrongCode())).rejects.toMatchObject({
        code: 'INVALID_TOTP',
      });
    }

    // No IP bucket exists, so a fresh challenge is still redeemable (and fails
    // on the code, not on the rate limit).
    await expect(h.service.challenge(h.token(), h.wrongCode())).rejects.toMatchObject({
      code: 'INVALID_TOTP',
      httpStatus: 401,
    });
  });

  it('keeps the 429 even when Redis is down (fallback window)', async () => {
    const h = createChallengeHarness();
    h.cache.failIncr = true;
    const challengeToken = h.token();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        h.service.challenge(challengeToken, h.wrongCode(), { ip: IP_A }),
      ).rejects.toMatchObject({ code: 'INVALID_TOTP' });
    }

    await expect(
      h.service.challenge(challengeToken, h.wrongCode(), { ip: IP_A }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429 });
  });
});

/* ==========================================================================
 * forgot-password / resend-verification
 * ========================================================================== */

function createAuthHarness(options: { withAccount: boolean }) {
  const clock = new FrozenClock(NOW);
  const cache = new CountingCache(clock);
  const email = new RecordingEmailService();
  const agents = new StubAgentRepository();
  const tenants = new InMemoryTenantRepository(() => clock.now());
  const passwordResets = new InMemoryPasswordResetRepository(clock);
  const emailVerifications = new InMemoryVerificationRepository(clock);

  if (options.withAccount) {
    agents.seed({
      id: 'agent-1',
      email: 'ana@acme.test',
      passwordHash,
      tenantId: 'tenant-1',
      emailVerifiedAt: null,
    });
  }

  const auth = new AuthService({
    logger: silentLogger,
    clock,
    cache,
    email,
    config: { webOrigin: 'https://app.test', appBaseUrl: 'https://api.test' },
    repos: {
      agents,
      tenants,
      emailVerifications,
      passwordResets,
      sessions: {} as unknown as ISessionRepository,
    },
  });

  return { clock, cache, email, auth };
}

describe('POST /auth/forgot-password rate limit (3 / 15 min per e-mail)', () => {
  it('accepts 3 requests and answers 429 on the 4th', async () => {
    const h = createAuthHarness({ withAccount: true });

    for (let request = 1; request <= 3; request += 1) {
      await expect(h.auth.forgotPassword('ana@acme.test')).resolves.toBeUndefined();
    }
    expect(h.email.sent).toHaveLength(3);

    await expect(h.auth.forgotPassword('ana@acme.test')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      details: { bucket: 'auth.forgot-password' },
    });
    // No extra e-mail was sent by the blocked request.
    expect(h.email.sent).toHaveLength(3);
  });

  it('charges unknown addresses the same way (no account enumeration)', async () => {
    const h = createAuthHarness({ withAccount: false });

    for (let request = 1; request <= 3; request += 1) {
      await expect(h.auth.forgotPassword('nobody@example.com')).resolves.toBeUndefined();
    }
    expect(h.email.sent).toHaveLength(0);

    await expect(h.auth.forgotPassword('nobody@example.com')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('opens a new window after 15 minutes', async () => {
    const h = createAuthHarness({ withAccount: true });
    for (let request = 0; request < 4; request += 1) {
      await h.auth.forgotPassword('ana@acme.test').catch(() => undefined);
    }

    h.clock.set(new Date(NOW.getTime() + 15 * 60 * 1_000 + 1));
    await expect(h.auth.forgotPassword('ana@acme.test')).resolves.toBeUndefined();
  });
});

describe('POST /auth/resend-verification rate limit (3 / 15 min per e-mail)', () => {
  it('accepts 3 requests and answers 429 on the 4th (on top of the 1/min throttle)', async () => {
    const h = createAuthHarness({ withAccount: true });

    for (let request = 1; request <= 3; request += 1) {
      await expect(h.auth.resendVerification('ana@acme.test')).resolves.toBeUndefined();
    }
    // The 1/minute throttle still collapses the burst into a single e-mail.
    expect(h.email.sent).toHaveLength(1);

    await expect(h.auth.resendVerification('ana@acme.test')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      details: { bucket: 'auth.resend-verification' },
    });
  });

  it('charges unknown addresses the same way and keeps the fallback working', async () => {
    const h = createAuthHarness({ withAccount: false });
    h.cache.failIncr = true;

    for (let request = 1; request <= 3; request += 1) {
      await expect(h.auth.resendVerification('nobody@example.com')).resolves.toBeUndefined();
    }

    await expect(h.auth.resendVerification('nobody@example.com')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
    });
  });
});
