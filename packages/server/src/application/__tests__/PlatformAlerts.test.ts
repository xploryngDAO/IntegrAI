import { describe, expect, it } from 'vitest';

import type {
  PlatformAlertAccountRecord,
  PlatformAlertSnapshot,
  PlatformAlertTenantRecord,
} from '@sac/shared';

import { PlatformService } from '../PlatformService';
import { FrozenClock, silentLogger } from './accountFakes';
import {
  InMemoryPlatformTenantRepository,
  InMemoryTenantRepository,
  StubAgentRepository,
  StubPlatformRepository,
} from './platformFakes';

/**
 * Fase 4 - `GET /platform/alerts`.
 *
 * Alerts are DERIVED: the repository returns a cross-tenant snapshot and the
 * service applies the thresholds. These tests exercise every alert type and both
 * severity levels of the quota/SLA rules.
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');

function tenant(overrides: Partial<PlatformAlertTenantRecord> = {}): PlatformAlertTenantRecord {
  return {
    id: 'tenant-1',
    slug: 'acme',
    name: 'Acme',
    status: 'ACTIVE',
    plan: 'PRO',
    maxAccounts: 10,
    maxAgents: 25,
    ...overrides,
  };
}

function account(overrides: Partial<PlatformAlertAccountRecord> = {}): PlatformAlertAccountRecord {
  return {
    id: 'account-1',
    tenantId: 'tenant-1',
    marketplace: 'MERCADO_LIVRE',
    displayName: 'Loja principal',
    status: 'ACTIVE',
    lastErrorAt: null,
    lastError: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<PlatformAlertSnapshot> = {}): PlatformAlertSnapshot {
  return {
    tenants: [tenant()],
    accounts: [],
    usage: { 'tenant-1': { accounts: 1, agents: 2 } },
    slaAtRisk: {},
    expiringInvitations: {},
    ...overrides,
  };
}

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

describe('PlatformService.alerts', () => {
  it('flags a suspended workspace', async () => {
    const h = createHarness();
    h.platform.alertSnapshotRecord = snapshot({
      tenants: [tenant({ status: 'SUSPENDED' })],
    });

    const result = await h.service.alerts();

    expect(result.generatedAt).toBe(NOW.toISOString());
    expect(result.total).toBe(1);
    expect(result.alerts[0]).toMatchObject({
      severity: 'warning',
      tenantId: 'tenant-1',
      tenantSlug: 'acme',
      type: 'TENANT_SUSPENDED',
      value: 1,
    });
    expect(result.alerts[0]?.message).toContain('suspended');
  });

  it('flags an account that is not ACTIVE (disconnected is critical)', async () => {
    const h = createHarness();
    h.platform.alertSnapshotRecord = snapshot({
      accounts: [
        account({ status: 'DISCONNECTED' }),
        account({ id: 'account-2', displayName: 'Loja 2', status: 'TOKEN_EXPIRED' }),
      ],
    });

    const result = await h.service.alerts();

    const disconnected = result.alerts.find((entry) => entry.message.includes('DISCONNECTED'));
    expect(disconnected).toMatchObject({ severity: 'critical', type: 'ACCOUNT_STATUS' });
    expect(disconnected?.value).toBe(1);

    const expired = result.alerts.find(
      (entry) => entry.type === 'ACCOUNT_STATUS' && entry.message.includes('TOKEN_EXPIRED'),
    );
    expect(expired).toMatchObject({ severity: 'warning' });
  });

  it('flags a recent account error with its age in minutes', async () => {
    const h = createHarness();
    h.platform.alertSnapshotRecord = snapshot({
      accounts: [
        account({
          lastErrorAt: new Date(NOW.getTime() - 30 * 60_000),
          lastError: 'token refresh failed',
        }),
      ],
    });

    const result = await h.service.alerts();

    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({
      severity: 'warning',
      type: 'ACCOUNT_ERROR',
      tenantId: 'tenant-1',
      value: 30,
    });
    expect(result.alerts[0]?.message).toContain('token refresh failed');
  });

  it('warns at 80% of the agents quota and becomes critical at 100%', async () => {
    const h = createHarness();
    h.platform.alertSnapshotRecord = snapshot({
      tenants: [tenant({ maxAgents: 10 })],
      usage: { 'tenant-1': { accounts: 0, agents: 8 } },
    });
    const warning = await h.service.alerts();
    expect(warning.alerts).toEqual([
      expect.objectContaining({ type: 'AGENTS_QUOTA', severity: 'warning', value: 80 }),
    ]);

    h.platform.alertSnapshotRecord = snapshot({
      tenants: [tenant({ maxAgents: 10 })],
      usage: { 'tenant-1': { accounts: 0, agents: 10 } },
    });
    const critical = await h.service.alerts();
    expect(critical.alerts).toEqual([
      expect.objectContaining({ type: 'AGENTS_QUOTA', severity: 'critical', value: 100 }),
    ]);
  });

  it('warns at 80% of the accounts quota and reports values above 100%', async () => {
    const h = createHarness();
    h.platform.alertSnapshotRecord = snapshot({
      tenants: [tenant({ maxAccounts: 4 })],
      usage: { 'tenant-1': { accounts: 5, agents: 0 } },
    });

    const result = await h.service.alerts();

    expect(result.alerts).toEqual([
      expect.objectContaining({ type: 'ACCOUNTS_QUOTA', severity: 'critical', value: 125 }),
    ]);
    expect(result.alerts[0]?.message).toContain('5/4');
  });

  it('does not alert below 80% of a quota', async () => {
    const h = createHarness();
    h.platform.alertSnapshotRecord = snapshot({
      tenants: [tenant({ maxAgents: 10 })],
      usage: { 'tenant-1': { accounts: 0, agents: 7 } },
    });

    const result = await h.service.alerts();

    expect(result.alerts).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('alerts on high SLA risk (> 10) and escalates above 20', async () => {
    const h = createHarness();
    h.platform.alertSnapshotRecord = snapshot({ slaAtRisk: { 'tenant-1': 11 } });
    const warning = await h.service.alerts();
    expect(warning.alerts).toEqual([
      expect.objectContaining({ type: 'SLA_AT_RISK', severity: 'warning', value: 11 }),
    ]);

    h.platform.alertSnapshotRecord = snapshot({ slaAtRisk: { 'tenant-1': 21 } });
    const critical = await h.service.alerts();
    expect(critical.alerts).toEqual([
      expect.objectContaining({ type: 'SLA_AT_RISK', severity: 'critical', value: 21 }),
    ]);
  });

  it('does not alert on SLA risk at the threshold', async () => {
    const h = createHarness();
    h.platform.alertSnapshotRecord = snapshot({ slaAtRisk: { 'tenant-1': 10 } });

    const result = await h.service.alerts();

    expect(result.alerts).toEqual([]);
  });

  it('reports pending invitations expiring in 48h as info', async () => {
    const h = createHarness();
    h.platform.alertSnapshotRecord = snapshot({
      expiringInvitations: { 'tenant-1': 2 },
    });

    const result = await h.service.alerts();

    expect(result.alerts).toEqual([
      expect.objectContaining({ type: 'INVITATIONS_EXPIRING', severity: 'info', value: 2 }),
    ]);
    expect(result.alerts[0]?.message).toContain('2 pending invitation');
  });

  it('orders critical -> warning -> info and then by tenant', async () => {
    const h = createHarness();
    h.platform.alertSnapshotRecord = snapshot({
      tenants: [
        tenant({ id: 'tenant-a', slug: 'alpha', status: 'SUSPENDED' }),
        tenant({ id: 'tenant-b', slug: 'beta' }),
      ],
      accounts: [account({ id: 'account-b', tenantId: 'tenant-b', status: 'DISCONNECTED' })],
      usage: {
        'tenant-a': { accounts: 0, agents: 0 },
        'tenant-b': { accounts: 0, agents: 0 },
      },
      expiringInvitations: { 'tenant-a': 1 },
    });

    const result = await h.service.alerts();

    expect(result.alerts.map((entry) => `${entry.severity}:${entry.tenantSlug}:${entry.type}`)).toEqual([
      'critical:beta:ACCOUNT_STATUS',
      'warning:alpha:TENANT_SUSPENDED',
      'info:alpha:INVITATIONS_EXPIRING',
    ]);
    expect(result.total).toBe(3);
  });

  it('passes the alert windows to the repository', async () => {
    const h = createHarness();
    h.platform.alertSnapshotRecord = snapshot();

    await h.service.alerts();

    expect(h.platform.alertInputs[0]).toEqual({
      now: NOW,
      errorSince: new Date(NOW.getTime() - 24 * 60 * 60_000),
      slaHorizon: new Date(NOW.getTime() + 120 * 60_000),
      invitationHorizon: new Date(NOW.getTime() + 48 * 60 * 60_000),
    });
  });

  it('ignores accounts without a tenant or of an unknown tenant', async () => {
    const h = createHarness();
    h.platform.alertSnapshotRecord = snapshot({
      accounts: [
        account({ id: 'legacy', tenantId: null, status: 'DISCONNECTED' }),
        account({ id: 'ghost', tenantId: 'tenant-ghost', status: 'DISCONNECTED' }),
      ],
    });

    const result = await h.service.alerts();

    expect(result.alerts).toEqual([]);
  });
});
