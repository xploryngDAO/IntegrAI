import type { Prisma, PrismaClient } from '@prisma/client';
import { PLAN_LIMITS, normalizeTenantSearch } from '@sac/shared';
import type {
  CreateTenantInput,
  IPlatformTenantRepository,
  ITenantRepository,
  Paginated,
  PlatformTenantListQuery,
  TenantPolicyPatch,
  TenantRecord,
  UpdateTenantInput,
} from '@sac/shared';
import { mapTenant } from './mappers';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Console list filter: `name` OR `slug` contains the term.
 *
 * `mode: 'insensitive'` is Prisma/Postgres `ILIKE`, so the search is
 * case-insensitive at the database (no rows are loaded to filter in memory).
 * The SAME `where` is used by `count`, which keeps `total` and `totalPages`
 * correct for a filtered page.
 */
function tenantSearchWhere(search: string | undefined): Prisma.TenantWhereInput {
  if (search === undefined) return {};
  return {
    OR: [
      { name: { contains: search, mode: 'insensitive' } },
      { slug: { contains: search, mode: 'insensitive' } },
    ],
  };
}

/**
 * Prisma implementation of `ITenantRepository` (Fase 1 signup / Fase 2
 * onboarding) plus the admin-only writes used by the Fase 4 platform console.
 *
 * One class implements both ports so the tenant row is only ever mapped in one
 * place; the split interface keeps `TenantService` (operator-facing) unable to
 * change plan/quota/status by accident.
 */
export class PrismaTenantRepository implements ITenantRepository, IPlatformTenantRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateTenantInput): Promise<TenantRecord> {
    const plan = input.plan ?? 'FREE';
    const limits = PLAN_LIMITS[plan];

    const record = await this.prisma.tenant.create({
      data: {
        slug: input.slug,
        name: input.name,
        status: input.status ?? 'ACTIVE',
        plan,
        maxAccounts: limits.maxAccounts,
        maxAgents: limits.maxAgents,
      },
    });
    return mapTenant(record);
  }

  async findBySlug(slug: string): Promise<TenantRecord | null> {
    const record = await this.prisma.tenant.findUnique({ where: { slug } });
    return record ? mapTenant(record) : null;
  }

  async findById(id: string): Promise<TenantRecord | null> {
    const record = await this.prisma.tenant.findUnique({ where: { id } });
    return record ? mapTenant(record) : null;
  }

  async update(id: string, input: UpdateTenantInput): Promise<TenantRecord> {
    const data: { name?: string; onboardingCompletedAt?: Date | null } = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.onboardingCompletedAt !== undefined) {
      data.onboardingCompletedAt = input.onboardingCompletedAt;
    }

    const record = await this.prisma.tenant.update({ where: { id }, data });
    return mapTenant(record);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.tenant.delete({ where: { id } });
  }

  /* ==================================================================== */
  /* Platform console (Fase 4)                                            */
  /* ==================================================================== */

  async list(query: PlatformTenantListQuery): Promise<Paginated<TenantRecord>> {
    const currentPage = clampInt(query.page, 1, 100_000, DEFAULT_PAGE);
    const pageSize = clampInt(query.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
    const where = tenantSearchWhere(normalizeTenantSearch(query.search));

    const [records, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (currentPage - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.tenant.count({ where }),
    ]);

    return {
      items: records.map(mapTenant),
      total,
      page: currentPage,
      pageSize,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    };
  }

  async applyPolicies(id: string, patch: TenantPolicyPatch): Promise<TenantRecord> {
    const data: Prisma.TenantUpdateInput = {};
    if (patch.plan !== undefined) data.plan = patch.plan;
    if (patch.maxAccounts !== undefined) data.maxAccounts = patch.maxAccounts;
    if (patch.maxAgents !== undefined) data.maxAgents = patch.maxAgents;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.deletedAt !== undefined) data.deletedAt = patch.deletedAt;

    const record = await this.prisma.tenant.update({ where: { id }, data });
    return mapTenant(record);
  }

  /**
   * Soft delete. Accounts, agents, tickets and messages stay untouched: the
   * operator asked for erasure, but the audit trail must survive until the
   * physical-purge job exists (docs/PHASE4_PLATFORM.md).
   */
  async softDelete(id: string, at: Date): Promise<TenantRecord> {
    const record = await this.prisma.tenant.update({
      where: { id },
      data: { status: 'DELETED', deletedAt: at },
    });
    return mapTenant(record);
  }
}

export function createTenantRepository(prisma: PrismaClient): PrismaTenantRepository {
  return new PrismaTenantRepository(prisma);
}

/** Same implementation, narrowed to the admin-only port. */
export function createPlatformTenantRepository(
  prisma: PrismaClient,
): IPlatformTenantRepository {
  return new PrismaTenantRepository(prisma);
}
