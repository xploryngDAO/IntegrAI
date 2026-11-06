import { describe, expect, it } from 'vitest';

import { PlatformService } from '../PlatformService';
import { FrozenClock, silentLogger } from './accountFakes';
import {
  InMemoryPlatformTenantRepository,
  InMemoryTenantRepository,
  StubAgentRepository,
  StubPlatformRepository,
} from './platformFakes';

const NOW = new Date('2026-11-05T12:00:00.000Z');

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

  const admin = agents.seed({ id: 'agent-admin', isPlatformAdmin: true });
  const regular = agents.seed({ id: 'agent-regular', email: 'op@acme.test', isPlatformAdmin: false });

  return { clock, agents, tenants, platformTenants, platform, service, admin, regular };
}

describe('PlatformService.requirePlatformAdmin', () => {
  it('authorizes an active platform administrator', async () => {
    const h = createHarness();
    await expect(h.service.requirePlatformAdmin(h.admin.id)).resolves.toBeUndefined();
  });

  it('rejects a regular operator (even a tenant ADMIN) with 403', async () => {
    const h = createHarness();

    await expect(h.service.requirePlatformAdmin(h.regular.id)).rejects.toMatchObject({
      code: 'AUTHORIZATION_ERROR',
      httpStatus: 403,
    });
  });

  it('rejects an inactive platform administrator', async () => {
    const h = createHarness();
    h.admin.isActive = false;

    await expect(h.service.requirePlatformAdmin(h.admin.id)).rejects.toMatchObject({
      code: 'AUTHORIZATION_ERROR',
      httpStatus: 403,
    });
  });

  it('rejects an unknown principal', async () => {
    const h = createHarness();

    await expect(h.service.requirePlatformAdmin('missing')).rejects.toMatchObject({
      httpStatus: 403,
    });
  });
});

describe('PlatformService.listTenants', () => {
  it('returns tenants with plan, limits and per-tenant counts', async () => {
    const h = createHarness();
    const acme = h.tenants.seed({
      id: 'tenant-1',
      slug: 'acme',
      name: 'Acme',
      plan: 'PRO',
      createdAt: new Date('2026-11-01T10:00:00.000Z'),
    });
    const beta = h.tenants.seed({
      id: 'tenant-2',
      slug: 'beta',
      name: 'Beta',
      plan: 'FREE',
      createdAt: new Date('2026-11-02T10:00:00.000Z'),
    });
    h.platform.usage['tenant-1'] = { accounts: 3, agents: 5, tickets: 40 };
    h.platform.usage['tenant-2'] = { accounts: 1, agents: 2, tickets: 0 };

    const page = await h.service.listTenants({ page: 1, pageSize: 25 });

    expect(page.total).toBe(2);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(25);
    expect(page.totalPages).toBe(1);
    // Newest first.
    expect(page.items.map((item) => item.slug)).toEqual(['beta', 'acme']);
    expect(page.items[1]).toEqual({
      id: acme.id,
      slug: 'acme',
      name: 'Acme',
      plan: 'PRO',
      status: 'ACTIVE',
      limits: { maxAccounts: 10, maxAgents: 25 },
      counts: { accounts: 3, agents: 5, tickets: 40 },
      onboardingCompletedAt: null,
      deletedAt: null,
      createdAt: '2026-11-01T10:00:00.000Z',
    });
    expect(page.items[0]).toMatchObject({
      id: beta.id,
      plan: 'FREE',
      limits: { maxAccounts: 1, maxAgents: 3 },
    });
    expect(h.platform.usageRequests).toEqual([['tenant-2', 'tenant-1']]);
  });

  it('paginates without leaking counts between pages', async () => {
    const h = createHarness();
    for (let index = 0; index < 5; index += 1) {
      h.tenants.seed({
        id: `tenant-${index}`,
        slug: `tenant-${index}`,
        createdAt: new Date(`2026-11-0${index + 1}T10:00:00.000Z`),
      });
    }

    const page = await h.service.listTenants({ page: 2, pageSize: 2 });

    expect(page.total).toBe(5);
    expect(page.totalPages).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.items.map((item) => item.slug)).toEqual(['tenant-2', 'tenant-1']);
  });

  it('filters by name OR slug (case-insensitive) and keeps total/totalPages filtered', async () => {
    const h = createHarness();
    h.tenants.seed({
      id: 'tenant-1',
      slug: 'acme',
      name: 'Acme',
      createdAt: new Date('2026-11-01T10:00:00.000Z'),
    });
    h.tenants.seed({
      id: 'tenant-2',
      slug: 'beta',
      name: 'Beta',
      createdAt: new Date('2026-11-02T10:00:00.000Z'),
    });
    h.tenants.seed({
      id: 'tenant-3',
      slug: 'acme-store',
      name: 'Loja ACME',
      createdAt: new Date('2026-11-03T10:00:00.000Z'),
    });

    const page = await h.service.listTenants({ page: 1, pageSize: 1, search: '  AcMe  ' });

    expect(page.total).toBe(2);
    expect(page.totalPages).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].slug).toBe('acme-store');
    // Only the visible page asks for usage counts.
    expect(h.platform.usageRequests).toEqual([['tenant-3']]);
  });

  it('trims the search term and treats a blank term as "no filter"', async () => {
    const h = createHarness();
    h.tenants.seed({ id: 'tenant-1', slug: 'acme', name: 'Acme' });

    const blank = await h.service.listTenants({ page: 1, pageSize: 25, search: '   ' });

    expect(blank.total).toBe(1);
    expect(blank.items[0].slug).toBe('acme');
  });

  it('returns an empty page (total 0, totalPages 0) when nothing matches', async () => {
    const h = createHarness();
    h.tenants.seed({ id: 'tenant-1', slug: 'acme', name: 'Acme' });

    const page = await h.service.listTenants({ page: 1, pageSize: 25, search: 'nothing-here' });

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.totalPages).toBe(0);
  });
});

describe('PlatformService.updateTenant', () => {
  it('changing the plan alone realigns the quotas with the plan defaults', async () => {
    const h = createHarness();
    h.tenants.seed({ id: 'tenant-1', slug: 'acme', plan: 'FREE', maxAccounts: 1, maxAgents: 3 });

    const updated = await h.service.updateTenant('tenant-1', { plan: 'PRO' });

    expect(updated.plan).toBe('PRO');
    expect(updated.limits).toEqual({ maxAccounts: 10, maxAgents: 25 });
  });

  it('honors an explicit quota in the same request as the plan change', async () => {
    const h = createHarness();
    h.tenants.seed({ id: 'tenant-1', slug: 'acme', plan: 'FREE' });

    const updated = await h.service.updateTenant('tenant-1', {
      plan: 'PRO',
      maxAgents: 40,
    });

    expect(updated.plan).toBe('PRO');
    expect(updated.limits).toEqual({ maxAccounts: 10, maxAgents: 40 });
  });

  it('updates a single quota without touching the plan', async () => {
    const h = createHarness();
    h.tenants.seed({ id: 'tenant-1', slug: 'acme', plan: 'FREE', maxAccounts: 1, maxAgents: 3 });

    const updated = await h.service.updateTenant('tenant-1', { maxAccounts: 2 });

    expect(updated.plan).toBe('FREE');
    expect(updated.limits).toEqual({ maxAccounts: 2, maxAgents: 3 });
  });

  it('suspends a workspace through the console', async () => {
    const h = createHarness();
    h.tenants.seed({ id: 'tenant-1', slug: 'acme' });

    const updated = await h.service.updateTenant('tenant-1', { status: 'SUSPENDED' });

    expect(updated.status).toBe('SUSPENDED');
  });

  it('refuses to reactivate a soft-deleted workspace (409)', async () => {
    const h = createHarness();
    h.tenants.seed({
      id: 'tenant-1',
      slug: 'acme',
      status: 'DELETED',
      deletedAt: new Date('2026-11-04T12:00:00.000Z'),
    });

    await expect(
      h.service.updateTenant('tenant-1', { status: 'ACTIVE' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 });
  });

  it('returns 404 for an unknown workspace', async () => {
    const h = createHarness();

    await expect(h.service.updateTenant('missing', { plan: 'PRO' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('rejects an empty command and an invalid quota', async () => {
    const h = createHarness();
    h.tenants.seed({ id: 'tenant-1', slug: 'acme' });

    await expect(h.service.updateTenant('tenant-1', {})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      httpStatus: 422,
    });
    await expect(
      h.service.updateTenant('tenant-1', { maxAgents: 0 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
  });
});

describe('PlatformService.metrics', () => {
  it('maps the global totals and derives totalAccounts', async () => {
    const h = createHarness();
    h.platform.metricsRecord = {
      totalTenants: 12,
      activeTenants: 9,
      accountsByMarketplace: { AMAZON: 3, MERCADO_LIVRE: 7, SHOPEE: 2 },
      openTickets: 41,
      messagesLast24h: 512,
      slaAtRisk: 6,
    };

    const metrics = await h.service.metrics();

    expect(metrics).toEqual({
      generatedAt: NOW.toISOString(),
      totalTenants: 12,
      activeTenants: 9,
      accountsByMarketplace: { AMAZON: 3, MERCADO_LIVRE: 7, SHOPEE: 2 },
      totalAccounts: 12,
      openTickets: 41,
      messagesLast24h: 512,
      slaAtRisk: 6,
      slaRiskHorizonMinutes: 120,
    });

    const input = h.platform.metricsInputs[0];
    expect(input?.messagesSince).toEqual(new Date('2026-11-04T12:00:00.000Z'));
    expect(input?.slaHorizon).toEqual(new Date('2026-11-05T14:00:00.000Z'));
  });
});
