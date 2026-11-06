import { describe, expect, it } from 'vitest';
import type { PrismaClient, Tenant } from '@prisma/client';

import { PrismaTenantPurgeRepository } from '../tenant-purge';

/**
 * `PrismaTenantPurgeRepository` owns the LGPD delete order, so these tests pin
 * the exact Prisma calls with a recording stub (no database):
 *
 *  - `findPurgeable` filters `status='DELETED'` + `deleted_at <= cutoff`;
 *  - `purge` runs inside ONE `$transaction`;
 *  - the delete order is FK-safe (children before parents, tenant last);
 *  - every delete is scoped to the workspace (`tenantId` in the filter), so a
 *    bug can never delete another tenant's rows;
 *  - the per-table counts are returned for the structured log.
 */

type Call = { model: string; op: string; args: Record<string, unknown> };

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

const COUNT_PER_MODEL: Record<string, number> = {
  session: 4,
  invitation: 2,
  passwordReset: 3,
  emailVerification: 1,
  twoFactorRecoveryCode: 8,
  buyerPiiVault: 5,
  messageAttachment: 6,
  ticketMessage: 20,
  ticketEvent: 10,
  outboundAttempt: 7,
  supportTicket: 9,
  orderCache: 8,
  slaPolicy: 3,
  webhookEvent: 11,
  marketplaceAccount: 2,
  agent: 4,
  tenant: 1,
};

function makeTenantRow(overrides: Partial<Tenant> = {}): Tenant {
  const at = new Date('2026-10-01T12:00:00.000Z');
  return {
    id: overrides.id ?? TENANT_ID,
    slug: overrides.slug ?? 'acme',
    name: overrides.name ?? 'Acme',
    status: overrides.status ?? 'DELETED',
    plan: overrides.plan ?? 'FREE',
    maxAccounts: overrides.maxAccounts ?? 1,
    maxAgents: overrides.maxAgents ?? 3,
    onboardingCompletedAt: overrides.onboardingCompletedAt ?? null,
    deletedAt: overrides.deletedAt ?? at,
    createdAt: overrides.createdAt ?? at,
    updatedAt: overrides.updatedAt ?? at,
  };
}

function createHarness(options: { rows?: Tenant[]; agentIds?: string[]; accountIds?: string[] } = {}) {
  const calls: Call[] = [];
  const transactionOptions: unknown[] = [];
  const rows = options.rows ?? [makeTenantRow()];
  const agentIds = options.agentIds ?? ['agent-1', 'agent-2'];
  const accountIds = options.accountIds ?? [];

  const model = (name: string) => ({
    deleteMany: async (args: Record<string, unknown>) => {
      calls.push({ model: name, op: 'deleteMany', args });
      return { count: COUNT_PER_MODEL[name] ?? 0 };
    },
    findMany: async (args: Record<string, unknown>) => {
      calls.push({ model: name, op: 'findMany', args });
      if (name === 'agent') return agentIds.map((id) => ({ id }));
      if (name === 'marketplaceAccount') return accountIds.map((id) => ({ id }));
      return [];
    },
  });

  const tenantModel = {
    ...model('tenant'),
    findMany: async (args: Record<string, unknown>) => {
      calls.push({ model: 'tenant', op: 'findMany', args });
      return rows;
    },
  };

  const tx = {
    session: model('session'),
    invitation: model('invitation'),
    agent: model('agent'),
    passwordReset: model('passwordReset'),
    emailVerification: model('emailVerification'),
    twoFactorRecoveryCode: model('twoFactorRecoveryCode'),
    buyerPiiVault: model('buyerPiiVault'),
    messageAttachment: model('messageAttachment'),
    ticketMessage: model('ticketMessage'),
    ticketEvent: model('ticketEvent'),
    outboundAttempt: model('outboundAttempt'),
    supportTicket: model('supportTicket'),
    orderCache: model('orderCache'),
    slaPolicy: model('slaPolicy'),
    webhookEvent: model('webhookEvent'),
    marketplaceAccount: model('marketplaceAccount'),
    tenant: tenantModel,
  };

  const prisma = {
    tenant: tenantModel,
    $transaction: async (
      fn: (client: typeof tx) => Promise<unknown>,
      optionsArg: unknown,
    ): Promise<unknown> => {
      transactionOptions.push(optionsArg);
      calls.push({ model: '$transaction', op: 'begin', args: {} });
      return fn(tx);
    },
  } as unknown as PrismaClient;

  return {
    repository: new PrismaTenantPurgeRepository(prisma),
    calls,
    transactionOptions,
    agentIds,
  };
}

describe('PrismaTenantPurgeRepository.findPurgeable', () => {
  it('selects DELETED workspaces older than the cutoff, oldest first', async () => {
    const h = createHarness({ rows: [makeTenantRow()] });
    const cutoff = new Date('2026-10-06T12:00:00.000Z');

    const candidates = await h.repository.findPurgeable(cutoff, 25);

    const call = h.calls.find((entry) => entry.op === 'findMany');
    expect(call?.args).toEqual({
      where: { status: 'DELETED', deletedAt: { not: null, lte: cutoff } },
      orderBy: { deletedAt: 'asc' },
      take: 25,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: TENANT_ID, slug: 'acme', status: 'DELETED' });
  });

  it('normalizes an invalid batch size to a bounded integer', async () => {
    const h = createHarness();

    await h.repository.findPurgeable(new Date('2026-10-06T12:00:00.000Z'), 0);
    await h.repository.findPurgeable(new Date('2026-10-06T12:00:00.000Z'), 10_000);

    const takes = h.calls
      .filter((entry) => entry.op === 'findMany')
      .map((entry) => entry.args.take);
    expect(takes).toEqual([25, 500]);
  });
});

describe('PrismaTenantPurgeRepository.purge', () => {
  it('runs every delete inside one transaction with an FK-safe order', async () => {
    const h = createHarness();

    await h.repository.purge(TENANT_ID);

    expect(h.transactionOptions).toHaveLength(1);
    expect(h.transactionOptions[0]).toMatchObject({
      timeout: 120_000,
      maxWait: 10_000,
    });

    const deleted = h.calls.filter((entry) => entry.op === 'deleteMany');
    expect(deleted.map((entry) => entry.model)).toEqual([
      'session',
      'invitation',
      'passwordReset',
      'emailVerification',
      'twoFactorRecoveryCode',
      'buyerPiiVault',
      'messageAttachment',
      'ticketMessage',
      'ticketEvent',
      'outboundAttempt',
      'supportTicket',
      'orderCache',
      'slaPolicy',
      'webhookEvent',
      'marketplaceAccount',
      'agent',
      'tenant',
    ]);
  });

  it('scopes every delete to the workspace', async () => {
    const h = createHarness();

    await h.repository.purge(TENANT_ID);

    const deleted = h.calls.filter((entry) => entry.op === 'deleteMany');
    for (const call of deleted) {
      const serialized = JSON.stringify(call.args.where);
      const scopedByTenant = serialized.includes('"tenantId"') && serialized.includes(TENANT_ID);
      const scopedByOperator =
        serialized.includes('"userId"') &&
        h.agentIds.every((id) => serialized.includes(`"${id}"`));
      // The last delete is the workspace row itself (`where: { id }`).
      const scopedByPrimaryKey =
        call.model === 'tenant' && serialized === JSON.stringify({ id: TENANT_ID });
      expect(scopedByTenant || scopedByOperator || scopedByPrimaryKey).toBe(true);
    }

    // The token tables are scoped through the tenant's operator ids.
    const agentsCall = h.calls.find(
      (entry) => entry.model === 'agent' && entry.op === 'findMany',
    );
    expect(agentsCall?.args).toEqual({
      where: { tenantId: TENANT_ID },
      select: { id: true },
    });
    const passwordResets = deleted.find((entry) => entry.model === 'passwordReset');
    expect(passwordResets?.args.where).toEqual({
      userId: { in: ['agent-1', 'agent-2'] },
    });
  });

  it('returns the per-table counts', async () => {
    const h = createHarness();

    const counts = await h.repository.purge(TENANT_ID);

    expect(counts).toEqual({
      sessions: 4,
      invitations: 2,
      passwordResets: 3,
      emailVerifications: 1,
      twoFactorRecoveryCodes: 8,
      buyerPiiVault: 5,
      messageAttachments: 6,
      messages: 20,
      ticketEvents: 10,
      outboundAttempts: 7,
      tickets: 9,
      orders: 8,
      slaPolicies: 3,
      webhookEvents: 11,
      accounts: 2,
      agents: 4,
      tenant: 1,
    });
  });

  it('skips the operator-token deletes when the tenant has no operators', async () => {
    const h = createHarness({ agentIds: [] });

    const counts = await h.repository.purge(TENANT_ID);

    expect(counts.passwordResets).toBe(0);
    expect(counts.emailVerifications).toBe(0);
    expect(counts.twoFactorRecoveryCodes).toBe(0);
    expect(h.calls.some((entry) => entry.model === 'passwordReset')).toBe(false);
    expect(h.calls.some((entry) => entry.model === 'emailVerification')).toBe(false);
    expect(h.calls.some((entry) => entry.model === 'twoFactorRecoveryCode')).toBe(false);
  });

  it('also removes legacy webhook events of the workspace accounts', async () => {
    const h = createHarness({ accountIds: ['account-1', 'account-2'] });

    await h.repository.purge(TENANT_ID);

    const webhooks = h.calls.find(
      (entry) => entry.model === 'webhookEvent' && entry.op === 'deleteMany',
    );
    // `account_id` is SET NULL on delete, so rows with a NULL tenant_id need the
    // account scope to be removed with the workspace.
    expect(webhooks?.args.where).toEqual({
      OR: [{ tenantId: TENANT_ID }, { accountId: { in: ['account-1', 'account-2'] } }],
    });
  });
});
