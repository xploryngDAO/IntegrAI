import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { PrismaPlatformRepository } from '../platform';

/**
 * Fase 4 - Prisma aggregates used by the platform console.
 *
 * A recording Prisma stub proves that every query is scoped by `tenant_id`
 * (or by the tenant id list) and that no count is computed across workspaces by
 * accident. No database is required.
 */

interface QueryArgs {
  where?: Record<string, unknown>;
}

function createTenantMetricsHarness() {
  const calls: {
    accounts: QueryArgs[];
    agents: QueryArgs[];
    ticketGroups: QueryArgs[];
    ticketCounts: QueryArgs[];
    messages: QueryArgs[];
    raw: Array<{ sql: string; values: unknown[] }>;
  } = {
    accounts: [],
    agents: [],
    ticketGroups: [],
    ticketCounts: [],
    messages: [],
    raw: [],
  };

  const prisma = {
    marketplaceAccount: {
      count: async (args: QueryArgs) => {
        calls.accounts.push(args);
        return 3;
      },
    },
    agent: {
      count: async (args: QueryArgs) => {
        calls.agents.push(args);
        return 5;
      },
    },
    supportTicket: {
      groupBy: async (args: QueryArgs) => {
        calls.ticketGroups.push(args);
        return [
          { status: 'UNREAD', _count: { _all: 2 } },
          { status: 'RESOLVED', _count: { _all: 1 } },
        ];
      },
      count: async (args: QueryArgs) => {
        calls.ticketCounts.push(args);
        return args.where?.slaBreached === true ? 2 : 4;
      },
    },
    ticketMessage: {
      count: async (args: QueryArgs) => {
        calls.messages.push(args);
        return 7;
      },
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(' ');
      calls.raw.push({ sql, values });
      if (sql.includes('avg_first_response_minutes')) {
        return [{ avg_first_response_minutes: 30 }];
      }
      return [{ day: '2026-11-05', count: 2 }];
    },
  } as unknown as PrismaClient;

  return { repository: new PrismaPlatformRepository(prisma), calls };
}

describe('PrismaPlatformRepository.tenantMetrics', () => {
  it('scopes every aggregate to the tenant and aggregates the raw day/avg queries', async () => {
    const h = createTenantMetricsHarness();
    const ticketsSince = new Date('2026-10-23T00:00:00.000Z');
    const messagesSince = new Date('2026-10-29T12:00:00.000Z');
    const slaHorizon = new Date('2026-11-05T14:00:00.000Z');

    const metrics = await h.repository.tenantMetrics('tenant-1', {
      messagesSince,
      ticketsSince,
      slaHorizon,
    });

    expect(h.calls.accounts[0]?.where).toEqual({ tenantId: 'tenant-1' });
    expect(h.calls.agents[0]?.where).toEqual({ tenantId: 'tenant-1' });
    expect(h.calls.ticketGroups[0]?.where).toEqual({ tenantId: 'tenant-1' });

    const atRisk = h.calls.ticketCounts.find((call) => call.where?.slaBreached === false);
    expect(atRisk?.where).toEqual({
      tenantId: 'tenant-1',
      status: { in: ['UNREAD', 'OPEN_WAITING_AGENT', 'WAITING_BUYER', 'MEDIATION'] },
      slaBreached: false,
      slaDeadlineAt: { lte: slaHorizon },
    });
    expect(h.calls.ticketCounts.find((call) => call.where?.slaBreached === true)?.where).toEqual({
      tenantId: 'tenant-1',
      slaBreached: true,
    });

    expect(h.calls.messages[0]?.where).toEqual({
      createdAt: { gte: messagesSince },
      ticket: { tenantId: 'tenant-1' },
    });

    expect(h.calls.raw).toHaveLength(2);
    const avg = h.calls.raw.find((call) => call.sql.includes('avg_first_response_minutes'));
    expect(avg?.values).toContain('tenant-1');
    const days = h.calls.raw.find((call) => call.sql.includes("to_char(date_trunc('day'"));
    expect(days?.values).toContain('tenant-1');
    expect(days?.values).toContain(ticketsSince);

    expect(metrics).toMatchObject({
      accounts: 3,
      agents: 5,
      slaAtRisk: 4,
      slaBreached: 2,
      avgFirstResponseMinutes: 30,
      messagesLast7d: 7,
      ticketsByDay: [{ date: '2026-11-05', count: 2 }],
    });
    expect(metrics.ticketsByStatus).toEqual({
      UNREAD: 2,
      OPEN_WAITING_AGENT: 0,
      WAITING_BUYER: 0,
      NO_RESPONSE_NEEDED: 0,
      MEDIATION: 0,
      RESOLVED: 1,
    });
  });
});

describe('PrismaPlatformRepository.alertSnapshot', () => {
  it('scopes the tenant list and every signal query to those tenants', async () => {
    const calls: Record<string, QueryArgs> = {};
    const prisma = {
      tenant: {
        findMany: async () => {
          calls.tenants = {};
          return [
            {
              id: 'tenant-1',
              slug: 'acme',
              name: 'Acme',
              status: 'ACTIVE',
              plan: 'PRO',
              maxAccounts: 10,
              maxAgents: 25,
            },
            {
              id: 'tenant-2',
              slug: 'beta',
              name: 'Beta',
              status: 'SUSPENDED',
              plan: 'FREE',
              maxAccounts: 1,
              maxAgents: 3,
            },
          ];
        },
      },
      marketplaceAccount: {
        findMany: async (args: QueryArgs) => {
          calls.accounts = args;
          return [
            {
              id: 'account-1',
              tenantId: 'tenant-1',
              marketplace: 'SHOPEE',
              displayName: 'Loja',
              status: 'TOKEN_EXPIRED',
              lastErrorAt: null,
              lastError: null,
            },
          ];
        },
        groupBy: async (args: QueryArgs) => {
          calls.accountGroups = args;
          return [{ tenantId: 'tenant-1', _count: { _all: 2 } }];
        },
      },
      agent: {
        groupBy: async (args: QueryArgs) => {
          calls.agentGroups = args;
          return [{ tenantId: 'tenant-1', _count: { _all: 4 } }];
        },
      },
      supportTicket: {
        groupBy: async (args: QueryArgs) => {
          calls.slaGroups = args;
          return [{ tenantId: 'tenant-1', _count: { _all: 11 } }];
        },
      },
      invitation: {
        groupBy: async (args: QueryArgs) => {
          calls.invitationGroups = args;
          return [{ tenantId: 'tenant-1', _count: { _all: 1 } }];
        },
      },
    } as unknown as PrismaClient;

    const repository = new PrismaPlatformRepository(prisma);
    const now = new Date('2026-11-05T12:00:00.000Z');
    const snapshot = await repository.alertSnapshot({
      now,
      errorSince: new Date('2026-11-04T12:00:00.000Z'),
      slaHorizon: new Date('2026-11-05T14:00:00.000Z'),
      invitationHorizon: new Date('2026-11-07T12:00:00.000Z'),
    });

    const tenantIds = ['tenant-1', 'tenant-2'];
    expect(calls.accounts?.where).toMatchObject({ tenantId: { in: tenantIds } });
    expect(calls.agentGroups?.where).toMatchObject({ tenantId: { in: tenantIds } });
    expect(calls.accountGroups?.where).toMatchObject({ tenantId: { in: tenantIds } });
    expect(calls.slaGroups?.where).toMatchObject({
      tenantId: { in: tenantIds },
      status: { in: ['UNREAD', 'OPEN_WAITING_AGENT', 'WAITING_BUYER', 'MEDIATION'] },
      slaBreached: false,
      slaDeadlineAt: { lte: new Date('2026-11-05T14:00:00.000Z') },
    });
    expect(calls.invitationGroups?.where).toEqual({
      tenantId: { in: tenantIds },
      acceptedAt: null,
      expiresAt: {
        gt: now,
        lte: new Date('2026-11-07T12:00:00.000Z'),
      },
    });

    expect(snapshot.tenants).toHaveLength(2);
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.usage).toEqual({
      'tenant-1': { accounts: 2, agents: 4 },
      'tenant-2': { accounts: 0, agents: 0 },
    });
    expect(snapshot.slaAtRisk).toEqual({ 'tenant-1': 11 });
    expect(snapshot.expiringInvitations).toEqual({ 'tenant-1': 1 });
  });
});

describe('PrismaPlatformRepository.billingByPlanAndStatus', () => {
  it('excludes soft-deleted workspaces and maps the buckets', async () => {
    let args: QueryArgs | undefined;
    const prisma = {
      tenant: {
        groupBy: async (input: QueryArgs) => {
          args = input;
          return [
            { plan: 'PRO', billingStatus: 'ACTIVE', _count: { _all: 2 } },
            { plan: 'PRO', billingStatus: 'TRIALING', _count: { _all: 1 } },
          ];
        },
      },
    } as unknown as PrismaClient;

    const repository = new PrismaPlatformRepository(prisma);
    const rows = await repository.billingByPlanAndStatus();

    expect(args?.where).toEqual({ deletedAt: null, status: { not: 'DELETED' } });
    expect(rows).toEqual([
      { plan: 'PRO', billingStatus: 'ACTIVE', tenants: 2 },
      { plan: 'PRO', billingStatus: 'TRIALING', tenants: 1 },
    ]);
  });
});
