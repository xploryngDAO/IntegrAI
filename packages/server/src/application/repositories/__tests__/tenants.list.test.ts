import { describe, expect, it } from 'vitest';
import type { PrismaClient, Tenant } from '../../../generated/prisma/client';

import { PrismaTenantRepository } from '../tenants';

/**
 * `PrismaTenantRepository.list` is the ONLY place the console search touches the
 * database, so these tests assert the exact `where` Prisma receives:
 *
 *  - `name` OR `slug` with a case-insensitive `contains`;
 *  - the SAME `where` on `findMany` and `count` (otherwise `total`/`totalPages`
 *    would describe the unfiltered table);
 *  - a blank term degrades to "no filter" (empty `where`).
 *
 * The Prisma client is a small recording stub: no database is required.
 */

interface TenantQueryArgs {
  where?: Record<string, unknown>;
  orderBy?: unknown;
  skip?: number;
  take?: number;
}

function makeTenantRow(overrides: Partial<Tenant> = {}): Tenant {
  const at = new Date('2026-11-01T12:00:00.000Z');
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
    slug: overrides.slug ?? 'acme',
    name: overrides.name ?? 'Acme',
    status: overrides.status ?? 'ACTIVE',
    plan: overrides.plan ?? 'FREE',
    maxAccounts: overrides.maxAccounts ?? 1,
    maxAgents: overrides.maxAgents ?? 3,
    billingStatus: overrides.billingStatus ?? 'TRIALING',
    trialEndsAt: overrides.trialEndsAt ?? null,
    billingEmail: overrides.billingEmail ?? null,
    onboardingCompletedAt: overrides.onboardingCompletedAt ?? null,
    require2fa: overrides.require2fa ?? false,
    deletedAt: overrides.deletedAt ?? null,
    createdAt: overrides.createdAt ?? at,
    updatedAt: overrides.updatedAt ?? at,
  };
}

function createHarness(options: { rows?: Tenant[]; total?: number } = {}) {
  const rows = options.rows ?? [makeTenantRow()];
  const total = options.total ?? rows.length;
  const findManyCalls: TenantQueryArgs[] = [];
  const countCalls: TenantQueryArgs[] = [];

  const prisma = {
    tenant: {
      findMany: async (args: TenantQueryArgs): Promise<Tenant[]> => {
        findManyCalls.push(args);
        const skip = args.skip ?? 0;
        const take = args.take ?? rows.length;
        return rows.slice(skip, skip + take);
      },
      count: async (args: TenantQueryArgs): Promise<number> => {
        countCalls.push(args);
        return total;
      },
    },
  } as unknown as PrismaClient;

  return {
    repository: new PrismaTenantRepository(prisma),
    findManyCalls,
    countCalls,
  };
}

describe('PrismaTenantRepository.list (console search)', () => {
  it('sends no where clause when the search is absent', async () => {
    const h = createHarness();

    const page = await h.repository.list({ page: 1, pageSize: 25 });

    expect(h.findManyCalls[0]?.where).toEqual({});
    expect(h.countCalls[0]?.where).toEqual({});
    expect(page.total).toBe(1);
    expect(page.items[0]?.slug).toBe('acme');
  });

  it('filters name OR slug with a case-insensitive contains on findMany AND count', async () => {
    const h = createHarness({ total: 7 });

    const page = await h.repository.list({ page: 2, pageSize: 5, search: '  ACME ' });

    const expectedWhere = {
      OR: [
        { name: { contains: 'ACME', mode: 'insensitive' } },
        { slug: { contains: 'ACME', mode: 'insensitive' } },
      ],
    };
    expect(h.findManyCalls[0]?.where).toEqual(expectedWhere);
    expect(h.countCalls[0]?.where).toEqual(expectedWhere);
    expect(h.findManyCalls[0]?.skip).toBe(5);
    expect(h.findManyCalls[0]?.take).toBe(5);
    // `total`/`totalPages` describe the FILTERED set (7), not the table.
    expect(page.total).toBe(7);
    expect(page.totalPages).toBe(2);
  });

  it('treats a blank term as "no filter"', async () => {
    const h = createHarness();

    await h.repository.list({ page: 1, pageSize: 25, search: '    ' });

    expect(h.findManyCalls[0]?.where).toEqual({});
    expect(h.countCalls[0]?.where).toEqual({});
  });

  it('returns totalPages 0 for an empty result', async () => {
    const h = createHarness({ rows: [], total: 0 });

    const page = await h.repository.list({ page: 1, pageSize: 25, search: 'ghost' });

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.totalPages).toBe(0);
  });
});
