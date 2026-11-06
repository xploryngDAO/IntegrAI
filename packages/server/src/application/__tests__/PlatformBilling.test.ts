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
 * Fase 4 - billing base (`/platform/billing/summary` and
 * `PATCH /platform/tenants/:id/billing`).
 *
 * No payment gateway is called: the tests assert the MRR math over the plan
 * list prices and the persistence/validation of the subscription fields.
 */

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

  return { clock, agents, tenants, platformTenants, platform, service };
}

describe('PlatformService.billingSummary', () => {
  it('computes MRR from ACTIVE subscriptions and reports trials/past due', async () => {
    const h = createHarness();
    h.platform.billingRows = [
      { plan: 'FREE', billingStatus: 'ACTIVE', tenants: 2 },
      { plan: 'PRO', billingStatus: 'ACTIVE', tenants: 2 },
      { plan: 'PRO', billingStatus: 'TRIALING', tenants: 3 },
      { plan: 'PRO', billingStatus: 'CANCELED', tenants: 4 },
      { plan: 'ENTERPRISE', billingStatus: 'ACTIVE', tenants: 1 },
      { plan: 'ENTERPRISE', billingStatus: 'PAST_DUE', tenants: 1 },
    ];

    const summary = await h.service.billingSummary();

    expect(summary).toEqual({
      mrr: 2 * 299 + 1 * 1_499,
      byPlan: [
        { plan: 'FREE', tenants: 2, mrr: 0 },
        { plan: 'PRO', tenants: 2, mrr: 598 },
        { plan: 'ENTERPRISE', tenants: 1, mrr: 1_499 },
      ],
      trialing: 3,
      pastDue: 1,
    });
    expect(h.platform.billingRequests).toBe(1);
  });

  it('returns zeros and every plan when there are no subscription buckets', async () => {
    const h = createHarness();

    const summary = await h.service.billingSummary();

    expect(summary).toEqual({
      mrr: 0,
      byPlan: [
        { plan: 'FREE', tenants: 0, mrr: 0 },
        { plan: 'PRO', tenants: 0, mrr: 0 },
        { plan: 'ENTERPRISE', tenants: 0, mrr: 0 },
      ],
      trialing: 0,
      pastDue: 0,
    });
  });

  it('does not recognize canceled or trialing subscriptions as MRR', async () => {
    const h = createHarness();
    h.platform.billingRows = [
      { plan: 'ENTERPRISE', billingStatus: 'TRIALING', tenants: 5 },
      { plan: 'ENTERPRISE', billingStatus: 'CANCELED', tenants: 5 },
    ];

    const summary = await h.service.billingSummary();

    expect(summary.mrr).toBe(0);
    expect(summary.trialing).toBe(5);
    expect(summary.pastDue).toBe(0);
    expect(summary.byPlan.find((entry) => entry.plan === 'ENTERPRISE')).toEqual({
      plan: 'ENTERPRISE',
      tenants: 0,
      mrr: 0,
    });
  });
});

describe('PlatformService.updateBilling', () => {
  it('persists status, trial end and a trimmed billing e-mail', async () => {
    const h = createHarness();
    h.tenants.seed({ id: 'tenant-1', slug: 'acme', plan: 'PRO' });

    const view = await h.service.updateBilling('tenant-1', {
      billingStatus: 'ACTIVE',
      trialEndsAt: new Date('2026-12-01T00:00:00.000Z'),
      billingEmail: '  Finance@Acme.Test  ',
    });

    expect(view).toEqual({
      tenantId: 'tenant-1',
      slug: 'acme',
      plan: 'PRO',
      billingStatus: 'ACTIVE',
      trialEndsAt: '2026-12-01T00:00:00.000Z',
      billingEmail: 'Finance@Acme.Test',
      monthlyPriceBrl: 299,
      updatedAt: NOW.toISOString(),
    });

    const tenant = h.tenants.rows[0];
    expect(tenant).toMatchObject({
      billingStatus: 'ACTIVE',
      trialEndsAt: new Date('2026-12-01T00:00:00.000Z'),
      billingEmail: 'Finance@Acme.Test',
    });
  });

  it('clears the trial end and the billing e-mail with null', async () => {
    const h = createHarness();
    h.tenants.seed({
      id: 'tenant-1',
      slug: 'acme',
      plan: 'PRO',
      billingStatus: 'PAST_DUE',
      trialEndsAt: new Date('2026-11-30T00:00:00.000Z'),
      billingEmail: 'old@acme.test',
    });

    const view = await h.service.updateBilling('tenant-1', {
      trialEndsAt: null,
      billingEmail: null,
    });

    expect(view.billingStatus).toBe('PAST_DUE');
    expect(view.trialEndsAt).toBeNull();
    expect(view.billingEmail).toBeNull();
  });

  it('accepts a status-only update and keeps the other fields', async () => {
    const h = createHarness();
    h.tenants.seed({
      id: 'tenant-1',
      slug: 'acme',
      plan: 'ENTERPRISE',
      trialEndsAt: new Date('2026-12-01T00:00:00.000Z'),
      billingEmail: 'finance@acme.test',
    });

    const view = await h.service.updateBilling('tenant-1', { billingStatus: 'CANCELED' });

    expect(view.billingStatus).toBe('CANCELED');
    expect(view.trialEndsAt).toBe('2026-12-01T00:00:00.000Z');
    expect(view.billingEmail).toBe('finance@acme.test');
    expect(view.monthlyPriceBrl).toBe(1_499);
  });

  it('returns 404 for an unknown workspace', async () => {
    const h = createHarness();

    await expect(
      h.service.updateBilling('missing', { billingStatus: 'ACTIVE' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('refuses to change billing of a soft-deleted workspace (409)', async () => {
    const h = createHarness();
    h.tenants.seed({
      id: 'tenant-1',
      slug: 'acme',
      status: 'DELETED',
      deletedAt: new Date('2026-11-01T00:00:00.000Z'),
    });

    await expect(
      h.service.updateBilling('tenant-1', { billingStatus: 'ACTIVE' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 });
  });

  it('rejects an empty command and invalid fields with 422', async () => {
    const h = createHarness();
    h.tenants.seed({ id: 'tenant-1', slug: 'acme' });

    await expect(h.service.updateBilling('tenant-1', {})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      httpStatus: 422,
    });
    await expect(
      h.service.updateBilling('tenant-1', { billingEmail: 'not-an-email' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
    await expect(
      h.service.updateBilling('tenant-1', { billingEmail: '   ' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
    await expect(
      h.service.updateBilling('tenant-1', { trialEndsAt: new Date('invalid') }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
  });
});
