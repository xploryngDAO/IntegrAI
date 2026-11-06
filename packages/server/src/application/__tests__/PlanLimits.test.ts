import { describe, expect, it } from 'vitest';

import { PlanLimitReachedError } from '@sac/shared';

import { PlanLimitService } from '../PlanLimitService';
import { FrozenClock, silentLogger } from './accountFakes';
import {
  InMemoryTenantRepository,
  StubInvitationRepository,
  StubPlatformRepository,
} from './platformFakes';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const TENANT_ID = 'tenant-1';

function createHarness(
  tenantOverrides: Parameters<InMemoryTenantRepository['seed']>[0] = {},
) {
  const clock = new FrozenClock(NOW);
  const tenants = new InMemoryTenantRepository(() => clock.now());
  const tenant = tenants.seed({ id: TENANT_ID, slug: 'acme', ...tenantOverrides });
  const platform = new StubPlatformRepository();
  const invitations = new StubInvitationRepository();
  const service = new PlanLimitService({
    logger: silentLogger,
    clock,
    repos: { tenants, platform, invitations },
  });
  return { clock, tenants, tenant, platform, invitations, service };
}

async function expectPlanLimit(promise: Promise<unknown>): Promise<PlanLimitReachedError> {
  const failure = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(PlanLimitReachedError);
  return failure as PlanLimitReachedError;
}

describe('PlanLimitService - max_agents', () => {
  it('allows a new operator while the FREE plan still has a seat', async () => {
    const h = createHarness({ plan: 'FREE', maxAgents: 3 });
    h.platform.usage[TENANT_ID] = { accounts: 1, agents: 2, tickets: 10 };

    await expect(h.service.assertCanAddAgent(TENANT_ID)).resolves.toBeUndefined();
  });

  it('rejects with 409 PLAN_LIMIT_REACHED and {limit,current,plan} at the limit', async () => {
    const h = createHarness({ plan: 'FREE', maxAgents: 3 });
    h.platform.usage[TENANT_ID] = { accounts: 0, agents: 3, tickets: 0 };

    const failure = await expectPlanLimit(h.service.assertCanAddAgent(TENANT_ID));

    expect(failure.httpStatus).toBe(409);
    expect(failure.code).toBe('PLAN_LIMIT_REACHED');
    expect(failure.details).toEqual({
      plan: 'FREE',
      limit: 3,
      current: 3,
      resource: 'agents',
    });
  });

  it('counts pending invitations as reserved seats when inviting', async () => {
    const h = createHarness({ plan: 'FREE', maxAgents: 3 });
    h.platform.usage[TENANT_ID] = { accounts: 0, agents: 2, tickets: 0 };
    h.invitations.seed({ tenantId: TENANT_ID, expiresAt: new Date('2026-11-09T12:00:00.000Z') });

    // 2 active + 1 pending = 3 -> no seat left for another invite.
    const failure = await expectPlanLimit(h.service.assertCanInviteAgent(TENANT_ID));
    expect(failure.details).toMatchObject({ limit: 3, current: 3, plan: 'FREE' });
  });

  it('lets a resend for an already pending address through even at the seat limit', async () => {
    const h = createHarness({ plan: 'FREE', maxAgents: 3 });
    h.platform.usage[TENANT_ID] = { accounts: 0, agents: 2, tickets: 0 };
    h.invitations.seed({
      tenantId: TENANT_ID,
      email: 'invitee@acme.test',
      expiresAt: new Date('2026-11-09T12:00:00.000Z'),
    });

    // The same address is already reserved: a resend must not need a new seat.
    await expect(
      h.service.assertCanInviteAgent(TENANT_ID, { excludeEmail: 'INVITEE@acme.test' }),
    ).resolves.toBeUndefined();
    // A different address would need the 3rd (and last) free seat.
    await expect(
      h.service.assertCanInviteAgent(TENANT_ID, { excludeEmail: 'other@acme.test' }),
    ).rejects.toBeInstanceOf(PlanLimitReachedError);
  });

  it('ignores expired and already accepted invitations', async () => {
    const h = createHarness({ plan: 'FREE', maxAgents: 3 });
    h.platform.usage[TENANT_ID] = { accounts: 0, agents: 2, tickets: 0 };
    h.invitations.seed({
      tenantId: TENANT_ID,
      email: 'expired@acme.test',
      expiresAt: new Date('2026-11-01T12:00:00.000Z'),
    });
    h.invitations.seed({
      tenantId: TENANT_ID,
      email: 'accepted@acme.test',
      acceptedAt: new Date('2026-11-02T12:00:00.000Z'),
    });

    await expect(h.service.assertCanInviteAgent(TENANT_ID)).resolves.toBeUndefined();
  });

  it('does not reserve seats for invitations of another tenant', async () => {
    const h = createHarness({ plan: 'FREE', maxAgents: 3 });
    h.platform.usage[TENANT_ID] = { accounts: 0, agents: 2, tickets: 0 };
    h.invitations.seed({ tenantId: 'other-tenant' });

    await expect(h.service.assertCanInviteAgent(TENANT_ID)).resolves.toBeUndefined();
  });

  it('has no practical limit on ENTERPRISE', async () => {
    const h = createHarness({ plan: 'ENTERPRISE' });
    h.platform.usage[TENANT_ID] = { accounts: 5_000, agents: 50_000, tickets: 0 };

    await expect(h.service.assertCanAddAgent(TENANT_ID)).resolves.toBeUndefined();
    await expect(h.service.assertCanAddAccount(TENANT_ID)).resolves.toBeUndefined();
  });

  it('honors a console-granted quota above the plan default', async () => {
    const h = createHarness({ plan: 'FREE', maxAgents: 10 });
    h.platform.usage[TENANT_ID] = { accounts: 0, agents: 9, tickets: 0 };

    await expect(h.service.assertCanAddAgent(TENANT_ID)).resolves.toBeUndefined();
  });
});

describe('PlanLimitService - max_accounts', () => {
  it('rejects a new store when the FREE plan (1 account) is exhausted', async () => {
    const h = createHarness({ plan: 'FREE', maxAccounts: 1 });
    h.platform.usage[TENANT_ID] = { accounts: 1, agents: 1, tickets: 0 };

    const failure = await expectPlanLimit(h.service.assertCanAddAccount(TENANT_ID));

    expect(failure.code).toBe('PLAN_LIMIT_REACHED');
    expect(failure.details).toEqual({
      plan: 'FREE',
      limit: 1,
      current: 1,
      resource: 'accounts',
    });
  });

  it('allows the first store of a FREE workspace', async () => {
    const h = createHarness({ plan: 'FREE', maxAccounts: 1 });
    h.platform.usage[TENANT_ID] = { accounts: 0, agents: 1, tickets: 0 };

    await expect(h.service.assertCanAddAccount(TENANT_ID)).resolves.toBeUndefined();
  });
});

describe('PlanLimitService - workspace lifecycle', () => {
  it('rejects a soft-deleted workspace with 403 TENANT_INACTIVE', async () => {
    const h = createHarness({
      status: 'DELETED',
      deletedAt: new Date('2026-11-04T12:00:00.000Z'),
    });

    const failure = await h.service
      .assertCanAddAgent(TENANT_ID)
      .then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({ code: 'TENANT_INACTIVE', httpStatus: 403 });
  });

  it('rejects a suspended workspace with 403 TENANT_INACTIVE', async () => {
    const h = createHarness({ status: 'SUSPENDED' });

    await expect(h.service.assertCanAddAccount(TENANT_ID)).rejects.toMatchObject({
      code: 'TENANT_INACTIVE',
      httpStatus: 403,
    });
  });

  it('returns 404 for an unknown tenant', async () => {
    const h = createHarness();

    await expect(h.service.assertCanAddAccount('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('exposes plan, effective limits and usage (upgrade prompt)', async () => {
    const h = createHarness({ plan: 'PRO' });
    h.platform.usage[TENANT_ID] = { accounts: 4, agents: 7, tickets: 12 };

    await expect(h.service.usage(TENANT_ID)).resolves.toEqual({
      plan: 'PRO',
      limits: { maxAccounts: 10, maxAgents: 25 },
      usage: { agents: 7, accounts: 4 },
    });
  });
});
