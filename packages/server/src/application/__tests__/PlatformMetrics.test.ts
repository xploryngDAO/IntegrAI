import { describe, expect, it } from 'vitest';

import { PlatformService } from '../PlatformService';
import { FrozenClock, silentLogger } from './accountFakes';
import {
  InMemoryPlatformTenantRepository,
  InMemoryTenantRepository,
  StubAgentRepository,
  StubPlatformRepository,
} from './platformFakes';

/**
 * Fase 4 - `GET /platform/tenants/:id/metrics`.
 *
 * The repository owns the Prisma aggregates; here the stub returns the raw
 * record and the service is asserted to:
 *  - expose plan/limits and the quota percentages;
 *  - zero-fill `ticketsByStatus` and the 14-day series;
 *  - compute `openTickets` from the shared status constants;
 *  - 404 an unknown workspace.
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;

function createHarness() {
  const clock = new FrozenClock(NOW);
  const agents = new StubAgentRepository();
  const tenants = new InMemoryTenantRepository(() => clock.now());
  const platformTenants = new InMemoryPlatformTenantRepository(tenants, () => clock.now());
  const platform = new StubPlatformRepository();
  const service = new PlatformService({
    logger: silentLogger,
    clock,
    repos: { agents, tenants, platformTenants, platform },
  });

  return { clock, agents, tenants, platformTenants, platform, service };
}

describe('PlatformService.tenantMetrics', () => {
  it('maps counts, plan, quotas and the derived percentages', async () => {
    const h = createHarness();
    h.tenants.seed({
      id: 'tenant-1',
      slug: 'acme',
      plan: 'PRO',
      maxAccounts: 10,
      maxAgents: 25,
    });
    h.platform.tenantMetricsRecord = {
      accounts: 3,
      agents: 5,
      ticketsByStatus: {
        UNREAD: 2,
        OPEN_WAITING_AGENT: 1,
        WAITING_BUYER: 4,
        NO_RESPONSE_NEEDED: 1,
        MEDIATION: 3,
        RESOLVED: 9,
      },
      slaAtRisk: 6,
      slaBreached: 2,
      avgFirstResponseMinutes: 42.34,
      messagesLast7d: 120,
      ticketsByDay: [
        { date: '2026-10-23', count: 1 },
        { date: '2026-11-05', count: 3 },
      ],
    };

    const metrics = await h.service.tenantMetrics('tenant-1');

    expect(metrics.plan).toBe('PRO');
    expect(metrics.limits).toEqual({ maxAccounts: 10, maxAgents: 25 });
    expect(metrics.accounts).toBe(3);
    expect(metrics.agents).toBe(5);
    expect(metrics.openTickets).toBe(10); // UNREAD + OPEN_WAITING_AGENT + WAITING_BUYER + MEDIATION
    expect(metrics.ticketsByStatus).toEqual({
      UNREAD: 2,
      OPEN_WAITING_AGENT: 1,
      WAITING_BUYER: 4,
      NO_RESPONSE_NEEDED: 1,
      MEDIATION: 3,
      RESOLVED: 9,
    });
    expect(metrics.slaAtRisk).toBe(6);
    expect(metrics.slaBreached).toBe(2);
    expect(metrics.avgFirstResponseMinutes).toBe(42.3);
    expect(metrics.messagesLast7d).toBe(120);
    expect(metrics.usagePct).toEqual({ accounts: 30, agents: 20 });

    // Rolling 7-day message window and the 120-minute SLA horizon.
    const request = h.platform.tenantMetricsRequests[0];
    expect(request?.tenantId).toBe('tenant-1');
    expect(request?.input.messagesSince).toEqual(new Date(NOW.getTime() - 7 * DAY_MS));
    expect(request?.input.slaHorizon).toEqual(new Date(NOW.getTime() + 120 * 60_000));
    // 14 calendar days (UTC), first day 13 days before today.
    expect(request?.input.ticketsSince).toEqual(new Date(Date.UTC(2026, 9, 23)));
  });

  it('always returns a 14-entry ticket series, zero-filling missing days', async () => {
    const h = createHarness();
    h.tenants.seed({ id: 'tenant-1', slug: 'acme' });
    h.platform.tenantMetricsRecord = {
      ...h.platform.tenantMetricsRecord,
      ticketsByDay: [
        { date: '2026-10-27', count: 4 },
        { date: '2026-11-02', count: 2 },
      ],
    };

    const metrics = await h.service.tenantMetrics('tenant-1');

    expect(metrics.ticketsLast14d).toHaveLength(14);
    expect(metrics.ticketsLast14d[0]?.date).toBe('2026-10-23');
    expect(metrics.ticketsLast14d[13]?.date).toBe('2026-11-05');
    expect(metrics.ticketsLast14d.find((entry) => entry.date === '2026-10-27')?.count).toBe(4);
    expect(metrics.ticketsLast14d.find((entry) => entry.date === '2026-11-02')?.count).toBe(2);
    expect(metrics.ticketsLast14d.filter((entry) => entry.count === 0)).toHaveLength(12);
    expect(metrics.ticketsLast14d.reduce((sum, entry) => sum + entry.count, 0)).toBe(6);
  });

  it('zero-fills statuses missing from the aggregate and keeps a null average null', async () => {
    const h = createHarness();
    h.tenants.seed({ id: 'tenant-1', slug: 'acme', plan: 'ENTERPRISE' });
    h.platform.tenantMetricsRecord = {
      accounts: 0,
      agents: 0,
      ticketsByStatus: {
        RESOLVED: 3,
      } as never,
      slaAtRisk: 0,
      slaBreached: 0,
      avgFirstResponseMinutes: null,
      messagesLast7d: 0,
      ticketsByDay: [],
    };

    const metrics = await h.service.tenantMetrics('tenant-1');

    expect(metrics.ticketsByStatus).toEqual({
      UNREAD: 0,
      OPEN_WAITING_AGENT: 0,
      WAITING_BUYER: 0,
      NO_RESPONSE_NEEDED: 0,
      MEDIATION: 0,
      RESOLVED: 3,
    });
    expect(metrics.openTickets).toBe(0);
    expect(metrics.avgFirstResponseMinutes).toBeNull();
    expect(metrics.ticketsLast14d).toHaveLength(14);
    expect(metrics.ticketsLast14d.every((entry) => entry.count === 0)).toBe(true);
    // ENTERPRISE quotas are practically unlimited.
    expect(metrics.usagePct).toEqual({ accounts: 0, agents: 0 });
  });

  it('reports usage above 100% without clamping it', async () => {
    const h = createHarness();
    h.tenants.seed({ id: 'tenant-1', slug: 'acme', maxAccounts: 2, maxAgents: 3 });
    h.platform.tenantMetricsRecord = {
      ...h.platform.tenantMetricsRecord,
      accounts: 3,
      agents: 6,
    };

    const metrics = await h.service.tenantMetrics('tenant-1');

    expect(metrics.usagePct).toEqual({ accounts: 150, agents: 200 });
  });

  it('returns 404 for an unknown workspace', async () => {
    const h = createHarness();

    await expect(h.service.tenantMetrics('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
    expect(h.platform.tenantMetricsRequests).toEqual([]);
  });
});
