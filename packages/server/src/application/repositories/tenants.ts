import type { PrismaClient } from '@prisma/client';
import type {
  CreateTenantInput,
  ITenantRepository,
  TenantRecord,
  UpdateTenantInput,
} from '@sac/shared';
import { mapTenant } from './mappers';

/** Prisma implementation of `ITenantRepository` (Fase 1 signup / Fase 2 onboarding). */
export class PrismaTenantRepository implements ITenantRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateTenantInput): Promise<TenantRecord> {
    const record = await this.prisma.tenant.create({
      data: {
        slug: input.slug,
        name: input.name,
        status: input.status ?? 'ACTIVE',
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
}

export function createTenantRepository(prisma: PrismaClient): PrismaTenantRepository {
  return new PrismaTenantRepository(prisma);
}
