import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import type {
  ITenantSsoConnectionRepository,
  SsoDomainMatch,
  TenantSsoConnectionRecord,
  UpsertTenantSsoConnectionInput,
} from '@sac/shared';
import { mapSsoConnection, toInputJson } from './mappers';

/**
 * Prisma implementation of `ITenantSsoConnectionRepository`.
 *
 * The encrypted client secret is stored/returned as-is: only
 * `TenantSsoService` holds the cipher, so no other layer can decrypt it by
 * accident. `tenant_id` is UNIQUE, which makes `upsert` and `findByTenantId`
 * O(1) and guarantees one IdP per workspace.
 */
export class PrismaTenantSsoConnectionRepository implements ITenantSsoConnectionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByTenantId(tenantId: string): Promise<TenantSsoConnectionRecord | null> {
    const record = await this.prisma.tenantSsoConnection.findUnique({ where: { tenantId } });
    return record === null ? null : mapSsoConnection(record);
  }

  async findById(id: string): Promise<TenantSsoConnectionRecord | null> {
    const record = await this.prisma.tenantSsoConnection.findUnique({ where: { id } });
    return record === null ? null : mapSsoConnection(record);
  }

  async upsert(input: UpsertTenantSsoConnectionInput): Promise<TenantSsoConnectionRecord> {
    const data = {
      provider: input.provider,
      issuerUrl: input.issuerUrl,
      clientId: input.clientId,
      clientSecretEnc: input.clientSecretEnc,
      redirectUri: input.redirectUri,
      scopes: input.scopes,
      allowedDomains: input.allowedDomains,
      groupRoleMap: toInputJson(input.groupRoleMap as unknown as Record<string, unknown>),
      autoProvision: input.autoProvision,
      defaultRole: input.defaultRole,
      enforceSso: input.enforceSso,
      enabled: input.enabled,
    } satisfies Prisma.TenantSsoConnectionUpdateInput;

    const record = await this.prisma.tenantSsoConnection.upsert({
      where: { tenantId: input.tenantId },
      create: { tenantId: input.tenantId, ...data },
      update: data,
    });
    return mapSsoConnection(record);
  }

  async deleteByTenantId(tenantId: string): Promise<boolean> {
    const result = await this.prisma.tenantSsoConnection.deleteMany({ where: { tenantId } });
    return result.count > 0;
  }

  /**
   * Domain discovery used by `discover`/`start`.
   *
   * Only an ENABLED connection of an ACTIVE, non-deleted workspace can be
   * matched; suspended workspaces must not be able to start an SSO login. The
   * GIN index on `allowed_domains` serves `has`.
   */
  async findEnabledByDomain(domain: string): Promise<SsoDomainMatch | null> {
    const record = await this.prisma.tenantSsoConnection.findFirst({
      where: {
        enabled: true,
        allowedDomains: { has: domain },
        tenant: { status: 'ACTIVE', deletedAt: null },
      },
      include: { tenant: { select: { slug: true, status: true } } },
      orderBy: { createdAt: 'asc' },
    });
    if (record === null) return null;

    const { tenant, ...connection } = record;
    return {
      connection: mapSsoConnection(connection),
      tenantSlug: tenant.slug,
      tenantStatus: tenant.status,
    };
  }
}

export function createTenantSsoConnectionRepository(
  prisma: PrismaClient,
): PrismaTenantSsoConnectionRepository {
  return new PrismaTenantSsoConnectionRepository(prisma);
}
