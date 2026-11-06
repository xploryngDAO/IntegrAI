import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../../generated/prisma/client';

import { PrismaAdminUserRepository } from '../admin-users';

/**
 * `PrismaAdminUserRepository.overview` is where `GET /admin/overview` becomes
 * SQL. The service only forwards the JWT tenant and the injected clock, so the
 * correctness of the endpoint lives in the aggregates pinned here:
 *
 *  - every `where` carries the tenant id (never a client value);
 *  - "live" sessions are `revoked_at IS NULL AND expires_at > now`;
 *  - "pending" invites are `accepted_at IS NULL AND expires_at > now`;
 *  - accounts are one `groupBy (marketplace, status)`: `total` counts every
 *    status, `connected` only `ACTIVE`, `byMarketplace` partitions the total and
 *    always exposes AMAZON/MERCADO_LIVRE/SHOPEE (zero-filled);
 *  - tickets are one `groupBy (status)` plus a count of unassigned tickets whose
 *    status is NOT terminal (`NO_RESPONSE_NEEDED`, `RESOLVED` — the schema has
 *    no `CLOSED`);
 *  - audit is `created_at >= now - 24h`;
 *  - no concern loads business rows (counts/groupBy only).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const AT = new Date('2026-11-06T12:00:00.000Z');
const AUDIT_SINCE = new Date(AT.getTime() - 24 * 60 * 60 * 1_000);

interface QueryArgs {
  where?: Record<string, unknown>;
  by?: string[];
  _count?: Record<string, boolean>;
}

function createHarness() {
  const calls = {
    agentGroups: undefined as QueryArgs | undefined,
    sessions: undefined as QueryArgs | undefined,
    invitations: undefined as QueryArgs | undefined,
    accountGroups: undefined as QueryArgs | undefined,
    ticketGroups: undefined as QueryArgs | undefined,
    unassignedTickets: undefined as QueryArgs | undefined,
    audit: undefined as QueryArgs | undefined,
  };

  const prisma = {
    agent: {
      groupBy: async (args: QueryArgs) => {
        calls.agentGroups = args;
        return [
          { role: 'ADMIN', isActive: true, _count: { _all: 1 } },
          { role: 'AGENT', isActive: true, _count: { _all: 1 } },
          { role: 'AGENT', isActive: false, _count: { _all: 1 } },
        ];
      },
    },
    session: {
      count: async (args: QueryArgs) => {
        calls.sessions = args;
        return 2;
      },
    },
    invitation: {
      count: async (args: QueryArgs) => {
        calls.invitations = args;
        return 3;
      },
    },
    marketplaceAccount: {
      groupBy: async (args: QueryArgs) => {
        calls.accountGroups = args;
        return [
          { marketplace: 'AMAZON', status: 'ACTIVE', _count: { _all: 2 } },
          { marketplace: 'MERCADO_LIVRE', status: 'TOKEN_EXPIRED', _count: { _all: 1 } },
          { marketplace: 'SHOPEE', status: 'DISCONNECTED', _count: { _all: 1 } },
        ];
      },
    },
    supportTicket: {
      groupBy: async (args: QueryArgs) => {
        calls.ticketGroups = args;
        return [
          { status: 'UNREAD', _count: { _all: 2 } },
          { status: 'RESOLVED', _count: { _all: 5 } },
        ];
      },
      count: async (args: QueryArgs) => {
        calls.unassignedTickets = args;
        return 4;
      },
    },
    auditEvent: {
      count: async (args: QueryArgs) => {
        calls.audit = args;
        return 9;
      },
    },
  } as unknown as PrismaClient;

  return { repository: new PrismaAdminUserRepository(prisma), calls };
}

describe('PrismaAdminUserRepository.overview', () => {
  it('aggregates the tenant with one query per concern and maps every counter', async () => {
    const h = createHarness();

    const overview = await h.repository.overview(TENANT, AT);

    // --- tenant scoping and predicates -----------------------------------
    expect(h.calls.agentGroups?.where).toEqual({ tenantId: TENANT });
    expect(h.calls.agentGroups?.by).toEqual(['role', 'isActive']);

    expect(h.calls.sessions?.where).toEqual({
      tenantId: TENANT,
      revokedAt: null,
      expiresAt: { gt: AT },
    });
    expect(h.calls.invitations?.where).toEqual({
      tenantId: TENANT,
      acceptedAt: null,
      expiresAt: { gt: AT },
    });

    // Accounts: ONE grouped read; connected is derived from the status bucket.
    expect(h.calls.accountGroups?.where).toEqual({ tenantId: TENANT });
    expect(h.calls.accountGroups?.by).toEqual(['marketplace', 'status']);

    // Tickets: total/unread from the status buckets, unassigned from a count.
    expect(h.calls.ticketGroups?.where).toEqual({ tenantId: TENANT });
    expect(h.calls.ticketGroups?.by).toEqual(['status']);
    expect(h.calls.unassignedTickets?.where).toEqual({
      tenantId: TENANT,
      assignedAgentId: null,
      // The schema has no CLOSED: terminal = NO_RESPONSE_NEEDED + RESOLVED.
      status: { notIn: ['NO_RESPONSE_NEEDED', 'RESOLVED'] },
    });

    expect(h.calls.audit?.where).toEqual({
      tenantId: TENANT,
      createdAt: { gte: AUDIT_SINCE },
    });

    // --- projection -------------------------------------------------------
    expect(overview).toEqual({
      users: { total: 3, active: 2, admins: 1 },
      sessions: { active: 2 },
      invitations: { pending: 3 },
      accounts: {
        total: 4,
        connected: 2,
        byMarketplace: { AMAZON: 2, MERCADO_LIVRE: 1, SHOPEE: 1 },
      },
      tickets: { total: 7, unread: 2, unassigned: 4 },
      audit: { last24h: 9 },
    });
  });

  it('zero-fills every counter and all three marketplaces for an empty workspace', async () => {
    const calls: QueryArgs[] = [];
    const prisma = {
      agent: {
        groupBy: async (args: QueryArgs) => {
          calls.push(args);
          return [];
        },
      },
      session: { count: async () => 0 },
      invitation: { count: async () => 0 },
      marketplaceAccount: { groupBy: async () => [] },
      supportTicket: { groupBy: async () => [], count: async () => 0 },
      auditEvent: { count: async () => 0 },
    } as unknown as PrismaClient;

    const overview = await new PrismaAdminUserRepository(prisma).overview(
      OTHER_TENANT,
      AT,
    );

    expect(calls[0]?.where).toEqual({ tenantId: OTHER_TENANT });
    expect(overview).toEqual({
      users: { total: 0, active: 0, admins: 0 },
      sessions: { active: 0 },
      invitations: { pending: 0 },
      accounts: {
        total: 0,
        connected: 0,
        byMarketplace: { AMAZON: 0, MERCADO_LIVRE: 0, SHOPEE: 0 },
      },
      tickets: { total: 0, unread: 0, unassigned: 0 },
      audit: { last24h: 0 },
    });
  });
});
