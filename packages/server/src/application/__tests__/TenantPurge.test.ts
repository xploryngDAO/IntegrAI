import { describe, expect, it } from 'vitest';

import type {
  ITenantPurgeRepository,
  TenantPurgeCounts,
  TenantRecord,
} from '@sac/shared';

import { TenantPurgeService, emptyCounts } from '../TenantPurgeService';
import { FrozenClock, silentLogger } from './accountFakes';
import { InMemoryTenantRepository, makeTenant } from './platformFakes';

/**
 * LGPD purge policy tests (Fase 4).
 *
 * The Prisma repository is covered separately; here an in-memory purge port
 * proves the retention rules:
 *  - only workspaces soft-deleted BEFORE the cutoff are candidates;
 *  - one failing tenant never aborts the sweep;
 *  - the manual endpoint skips the grace period but never purges a live one.
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

class InMemoryPurgeRepository implements ITenantPurgeRepository {
  readonly candidates: TenantRecord[] = [];
  /** Candidates forced into the result regardless of `deleted_at` (bad repo). */
  readonly forced: TenantRecord[] = [];
  readonly purged: string[] = [];
  readonly failFor = new Set<string>();
  lastQuery: { cutoff: Date; limit: number } | null = null;

  async findPurgeable(cutoff: Date, limit: number): Promise<TenantRecord[]> {
    this.lastQuery = { cutoff, limit };
    const eligible = this.candidates
      .filter(
        (tenant) =>
          tenant.status === 'DELETED' &&
          tenant.deletedAt !== null &&
          tenant.deletedAt.getTime() <= cutoff.getTime(),
      )
      .sort((a, b) => (a.deletedAt?.getTime() ?? 0) - (b.deletedAt?.getTime() ?? 0));
    return [...eligible, ...this.forced].slice(0, limit);
  }

  async purge(tenantId: string): Promise<TenantPurgeCounts> {
    if (this.failFor.has(tenantId)) throw new Error('database unavailable');
    this.purged.push(tenantId);
    return { ...emptyCounts(), sessions: 2, tickets: 3, tenant: 1 };
  }
}

function createHarness(options: { retentionDays?: number } = {}) {
  const clock = new FrozenClock(NOW);
  const tenants = new InMemoryTenantRepository(() => clock.now());
  const purge = new InMemoryPurgeRepository();
  const service = new TenantPurgeService({
    logger: silentLogger,
    clock,
    ...(options.retentionDays !== undefined ? { retentionDays: options.retentionDays } : {}),
    repos: { tenants, purge },
  });

  const seedCandidate = (id: string, deletedAt: Date, overrides: Partial<TenantRecord> = {}) => {
    const tenant = tenants.seed({
      id,
      slug: id,
      status: 'DELETED',
      deletedAt,
      ...overrides,
    });
    purge.candidates.push(tenant);
    return tenant;
  };

  return { clock, tenants, purge, service, seedCandidate };
}

describe('TenantPurgeService.run', () => {
  it('purges only workspaces soft-deleted beyond the 30-day grace period', async () => {
    const h = createHarness();
    h.seedCandidate('old', daysAgo(31));
    h.seedCandidate('recent', daysAgo(29));
    const live = h.tenants.seed(makeTenant({ id: 'live', slug: 'live' }));
    h.purge.candidates.push(live);

    const result = await h.service.run();

    expect(result.scanned).toBe(1);
    expect(result.purged.map((entry) => entry.tenantId)).toEqual(['old']);
    expect(result.purged[0]).toMatchObject({
      tenantId: 'old',
      slug: 'old',
      manual: false,
      counts: { sessions: 2, tickets: 3, tenant: 1 },
    });
    expect(result.purged[0].deletedAt).toBe(daysAgo(31).toISOString());
    expect(result.purged[0].purgedAt).toBe(NOW.toISOString());
    expect(result.failures).toEqual([]);
    expect(h.purge.purged).toEqual(['old']);
  });

  it('uses the configured retention window and cutoff', async () => {
    const h = createHarness({ retentionDays: 7 });
    h.seedCandidate('eight-days', daysAgo(8));
    h.seedCandidate('six-days', daysAgo(6));

    const result = await h.service.run({ limit: 10 });

    expect(result.purged.map((entry) => entry.tenantId)).toEqual(['eight-days']);
    expect(h.purge.lastQuery?.cutoff).toEqual(new Date(NOW.getTime() - 7 * DAY_MS));
    expect(h.purge.lastQuery?.limit).toBe(10);
  });

  it('drains the backlog oldest-first, bounded by the batch size', async () => {
    const h = createHarness();
    h.seedCandidate('third', daysAgo(31));
    h.seedCandidate('first', daysAgo(90));
    h.seedCandidate('second', daysAgo(60));

    const result = await h.service.run({ limit: 2 });

    expect(h.purge.lastQuery?.limit).toBe(2);
    expect(result.purged.map((entry) => entry.tenantId)).toEqual(['first', 'second']);
    expect(result.purged.map((entry) => entry.manual)).toEqual([false, false]);
  });

  it('keeps sweeping when one workspace fails and reports it', async () => {
    const h = createHarness();
    h.seedCandidate('broken', daysAgo(60));
    h.seedCandidate('healthy', daysAgo(40));
    h.purge.failFor.add('broken');

    const result = await h.service.run();

    expect(result.scanned).toBe(2);
    expect(result.purged.map((entry) => entry.tenantId)).toEqual(['healthy']);
    expect(result.failures).toEqual([
      { tenantId: 'broken', error: 'database unavailable' },
    ]);
  });

  it('never hard-deletes a candidate that is not soft-deleted (defensive)', async () => {
    const h = createHarness();
    const live = h.tenants.seed(
      makeTenant({ id: 'sneaky', slug: 'sneaky', status: 'DELETED', deletedAt: null }),
    );
    h.purge.forced.push(live);

    const result = await h.service.run();

    expect(result.purged).toEqual([]);
    expect(result.failures).toEqual([
      { tenantId: 'sneaky', error: 'TENANT_NOT_SOFT_DELETED' },
    ]);
    expect(h.purge.purged).toEqual([]);
  });

  it('defaults the batch size to the shared constant', async () => {
    const h = createHarness();

    await h.service.run();

    expect(h.purge.lastQuery?.limit).toBe(25);
  });
});

describe('TenantPurgeService.purgeTenant (manual platform endpoint)', () => {
  it('purges a soft-deleted workspace without waiting for the grace period', async () => {
    const h = createHarness();
    h.tenants.seed(
      makeTenant({
        id: 'tenant-1',
        slug: 'acme',
        status: 'DELETED',
        deletedAt: daysAgo(1),
      }),
    );

    const result = await h.service.purgeTenant('tenant-1', 'agent-platform');

    expect(result).toMatchObject({
      tenantId: 'tenant-1',
      slug: 'acme',
      manual: true,
      counts: { sessions: 2, tickets: 3, tenant: 1 },
    });
    expect(h.purge.purged).toEqual(['tenant-1']);
  });

  it('refuses a workspace that was never soft-deleted (409 TENANT_NOT_DELETED)', async () => {
    const h = createHarness();
    h.tenants.seed(makeTenant({ id: 'tenant-1', slug: 'acme' }));

    await expect(h.service.purgeTenant('tenant-1', 'agent-platform')).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
      details: { code: 'TENANT_NOT_DELETED' },
    });
    expect(h.purge.purged).toEqual([]);
  });

  it('answers 404 for an unknown workspace', async () => {
    const h = createHarness();

    await expect(h.service.purgeTenant('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('propagates a repository failure (the caller sees the error)', async () => {
    const h = createHarness();
    h.tenants.seed(
      makeTenant({
        id: 'tenant-1',
        slug: 'acme',
        status: 'DELETED',
        deletedAt: daysAgo(2),
      }),
    );
    h.purge.failFor.add('tenant-1');

    await expect(h.service.purgeTenant('tenant-1')).rejects.toThrow('database unavailable');
  });
});
