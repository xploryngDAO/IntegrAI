import { describe, expect, it } from 'vitest';

import type {
  IEmailService,
  IPlanLimitService,
  PlanUsageView,
} from '@sac/shared';
import { PlanLimitReachedError } from '@sac/shared';

import { AccountService } from '../AccountService';
import { InvitationService } from '../InvitationService';
import { hashToken } from '../auth/access-token';
import {
  FakeCipher,
  FrozenClock,
  InMemoryAccountRepository,
  InMemoryCache,
  RecordingHttpClient,
  fakeAdapterRegistry,
  silentLogger,
  testChannelConfig,
} from './accountFakes';
import {
  InMemoryTenantRepository,
  StubAgentRepository,
  StubInvitationRepository,
  makeTenant,
} from './platformFakes';

/**
 * Proves the Fase 4 quota gate is wired into the two write paths, not only
 * implemented: connecting a NEW store and inviting/accepting an operator.
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');
const TENANT_ID = 'tenant-1';
const JWT_SECRET = 'unit-test-secret-with-32-characters!!';

const limitReached = (resource: 'agents' | 'accounts', limit: number, current: number) =>
  new PlanLimitReachedError({ plan: 'FREE', limit, current, resource });

class FakePlanLimits implements IPlanLimitService {
  readonly calls: string[] = [];
  accountError: PlanLimitReachedError | null = null;
  inviteError: PlanLimitReachedError | null = null;
  addAgentError: PlanLimitReachedError | null = null;

  async usage(): Promise<PlanUsageView> {
    return { plan: 'FREE', limits: { maxAccounts: 1, maxAgents: 3 }, usage: { agents: 1, accounts: 1 } };
  }

  async assertCanAddAgent(): Promise<void> {
    this.calls.push('addAgent');
    if (this.addAgentError !== null) throw this.addAgentError;
  }

  async assertCanInviteAgent(
    _tenantId: string,
    _options?: { excludeEmail?: string },
  ): Promise<void> {
    this.calls.push('inviteAgent');
    if (this.inviteError !== null) throw this.inviteError;
  }

  async assertCanAddAccount(): Promise<void> {
    this.calls.push('addAccount');
    if (this.accountError !== null) throw this.accountError;
  }
}

const silentEmail: IEmailService = {
  async sendVerificationEmail(): Promise<void> {},
  async sendPasswordResetEmail(): Promise<void> {},
  async sendInvitationEmail(): Promise<void> {},
  async sendNewSessionAlert(): Promise<void> {},
};

function createAccountHarness() {
  const clock = new FrozenClock(NOW);
  const accounts = new InMemoryAccountRepository(clock);
  const planLimits = new FakePlanLimits();
  const service = new AccountService({
    logger: silentLogger,
    clock,
    cache: new InMemoryCache(),
    cipher: new FakeCipher(),
    http: new RecordingHttpClient(() => ({ status: 500 })),
    config: testChannelConfig(),
    adapters: fakeAdapterRegistry,
    planLimits,
    repos: { accounts },
  });
  return { clock, accounts, planLimits, service };
}

const connectInput = {
  marketplace: 'MERCADO_LIVRE' as const,
  displayName: 'Loja Meli',
  externalSellerId: '123456',
  marketplaceSiteId: 'MLB',
  refreshToken: 'refresh-token',
  accessToken: 'access-token',
};

describe('AccountService + plan limits (max_accounts)', () => {
  it('checks the quota of the caller tenant before creating a new store', async () => {
    const h = createAccountHarness();

    await h.service.connectWithCredentials(connectInput, TENANT_ID);

    expect(h.planLimits.calls).toEqual(['addAccount']);
    expect(h.accounts.rows).toHaveLength(1);
    expect(h.accounts.rows[0]?.tenantId).toBe(TENANT_ID);
  });

  it('propagates PLAN_LIMIT_REACHED and does not persist the account', async () => {
    const h = createAccountHarness();
    h.planLimits.accountError = limitReached('accounts', 1, 1);

    const failure = await h.service
      .connectWithCredentials(connectInput, TENANT_ID)
      .then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      httpStatus: 409,
      details: { plan: 'FREE', limit: 1, current: 1, resource: 'accounts' },
    });
    expect(h.accounts.rows).toHaveLength(0);
  });

  it('does not consume the quota when reconnecting an existing store', async () => {
    const h = createAccountHarness();
    h.accounts.seed({
      tenantId: TENANT_ID,
      marketplace: 'MERCADO_LIVRE',
      externalSellerId: connectInput.externalSellerId,
      marketplaceSiteId: connectInput.marketplaceSiteId,
    });
    h.planLimits.accountError = limitReached('accounts', 1, 1);

    await expect(h.service.connectWithCredentials(connectInput, TENANT_ID)).resolves.toMatchObject({
      accountId: 'account-1',
    });
    expect(h.planLimits.calls).toEqual([]);
  });

  it('skips the tenant quota for a legacy account without a workspace', async () => {
    const h = createAccountHarness();
    h.planLimits.accountError = limitReached('accounts', 1, 1);

    await expect(h.service.connectWithCredentials(connectInput, null)).resolves.toBeDefined();
    expect(h.planLimits.calls).toEqual([]);
  });
});

function createInvitationHarness(planLimits: FakePlanLimits) {
  const clock = new FrozenClock(NOW);
  const tenants = new InMemoryTenantRepository(() => clock.now());
  tenants.seed(makeTenant({ id: TENANT_ID, slug: 'acme' }));
  const agents = new StubAgentRepository();
  const invitations = new StubInvitationRepository();

  const service = new InvitationService({
    logger: silentLogger,
    clock,
    email: silentEmail,
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '1h',
    config: { webOrigin: 'https://app.acme.test', appBaseUrl: 'https://api.acme.test' },
    planLimits,
    repos: { invitations, agents, tenants },
  });

  return { clock, tenants, agents, invitations, service };
}

const actor = { id: 'agent-admin', name: 'Ana Admin', tenantId: TENANT_ID };

describe('InvitationService + plan limits (max_agents)', () => {
  it('checks the seat quota when creating an invitation', async () => {
    const planLimits = new FakePlanLimits();
    const h = createInvitationHarness(planLimits);

    await h.service.create({ email: 'new@acme.test', role: 'AGENT', actor });

    expect(planLimits.calls).toEqual(['inviteAgent']);
    expect(h.invitations.rows).toHaveLength(1);
  });

  it('rejects an invitation when every seat is taken, without persisting it', async () => {
    const planLimits = new FakePlanLimits();
    planLimits.inviteError = limitReached('agents', 3, 3);
    const h = createInvitationHarness(planLimits);

    await expect(
      h.service.create({ email: 'new@acme.test', role: 'AGENT', actor }),
    ).rejects.toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      httpStatus: 409,
      details: { limit: 3, current: 3, plan: 'FREE' },
    });
    expect(h.invitations.rows).toHaveLength(0);
  });

  it('checks the quota again when the invitation is accepted', async () => {
    const planLimits = new FakePlanLimits();
    planLimits.addAgentError = limitReached('agents', 3, 3);
    const h = createInvitationHarness(planLimits);

    const token = 'a'.repeat(64);
    h.invitations.seed({
      tenantId: TENANT_ID,
      email: 'new@acme.test',
      tokenHash: hashToken(token),
      role: 'AGENT',
    });

    await expect(
      h.service.accept({ token, name: 'Novo Operador', password: 'Sup3rSecret!!' }),
    ).rejects.toMatchObject({ code: 'PLAN_LIMIT_REACHED', httpStatus: 409 });

    expect(planLimits.calls).toEqual(['addAgent']);
    expect(h.agents.rows).toHaveLength(0);
    expect(h.invitations.rows[0]?.acceptedAt).toBeNull();
  });
});
