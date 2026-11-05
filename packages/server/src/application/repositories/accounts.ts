import type { MarketplaceAccount, Prisma, PrismaClient } from '@prisma/client';
import type {
  AccountStatus,
  AccountTokenPatch,
  CreateAccountInput,
  IAccountRepository,
  Marketplace,
  MarketplaceAccountRecord,
} from '@sac/shared';
import { mapAccount, toInputJson } from './mappers';

/** Prisma implementation of `IAccountRepository`. */
export class PrismaAccountRepository implements IAccountRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateAccountInput): Promise<MarketplaceAccountRecord> {
    const record = await this.prisma.marketplaceAccount.create({
      data: {
        marketplace: input.marketplace,
        displayName: input.displayName,
        externalSellerId: input.externalSellerId,
        marketplaceSiteId: input.marketplaceSiteId,
        accessTokenEnc: input.accessTokenEnc ?? null,
        refreshTokenEnc: input.refreshTokenEnc ?? null,
        tokenExpiresAt: input.tokenExpiresAt ?? null,
        authExpiresAt: input.authExpiresAt ?? null,
        channelConfig: toInputJson(input.channelConfig ?? {}),
        status: input.status ?? 'ACTIVE',
      },
    });
    return mapAccount(record);
  }

  async findById(id: string): Promise<MarketplaceAccountRecord | null> {
    const record = await this.prisma.marketplaceAccount.findUnique({ where: { id } });
    return record ? mapAccount(record) : null;
  }

  async findByExternalSeller(
    marketplace: Marketplace,
    externalSellerId: string,
    marketplaceSiteId?: string,
  ): Promise<MarketplaceAccountRecord | null> {
    if (marketplaceSiteId) {
      const record = await this.prisma.marketplaceAccount.findUnique({
        where: {
          marketplace_externalSellerId_marketplaceSiteId: {
            marketplace,
            externalSellerId,
            marketplaceSiteId,
          },
        },
      });
      return record ? mapAccount(record) : null;
    }

    const record = await this.prisma.marketplaceAccount.findFirst({
      where: { marketplace, externalSellerId },
      orderBy: { createdAt: 'asc' },
    });
    return record ? mapAccount(record) : null;
  }

  async findFirstByMarketplace(marketplace: Marketplace): Promise<MarketplaceAccountRecord | null> {
    const record = await this.prisma.marketplaceAccount.findFirst({
      where: { marketplace },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    });
    return record ? mapAccount(record) : null;
  }

  async list(filter?: {
    marketplace?: Marketplace;
    status?: AccountStatus;
    tenantId?: string | null;
  }): Promise<MarketplaceAccountRecord[]> {
    const where: Prisma.MarketplaceAccountWhereInput = {};
    if (filter?.marketplace) where.marketplace = filter.marketplace;
    if (filter?.status) where.status = filter.status;
    if (filter?.tenantId) where.tenantId = filter.tenantId;

    const records = await this.prisma.marketplaceAccount.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });
    return records.map(mapAccount);
  }

  async updateTokens(id: string, patch: AccountTokenPatch): Promise<MarketplaceAccountRecord> {
    const data: Prisma.MarketplaceAccountUpdateInput = {};
    if (patch.accessTokenEnc !== undefined) data.accessTokenEnc = patch.accessTokenEnc;
    if (patch.refreshTokenEnc !== undefined) data.refreshTokenEnc = patch.refreshTokenEnc;
    if (patch.tokenExpiresAt !== undefined) data.tokenExpiresAt = patch.tokenExpiresAt;
    if (patch.authExpiresAt !== undefined) data.authExpiresAt = patch.authExpiresAt;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.lastTokenRefreshAt !== undefined) data.lastTokenRefreshAt = patch.lastTokenRefreshAt;
    if (patch.lastError !== undefined) data.lastError = patch.lastError;
    if (patch.lastErrorAt !== undefined) data.lastErrorAt = patch.lastErrorAt;

    const record = await this.prisma.marketplaceAccount.update({ where: { id }, data });
    return mapAccount(record);
  }

  async updateChannelConfig(
    id: string,
    config: Record<string, unknown>,
  ): Promise<MarketplaceAccountRecord> {
    const record = await this.prisma.marketplaceAccount.update({
      where: { id },
      data: { channelConfig: toInputJson(config) },
    });
    return mapAccount(record);
  }

  async setStatus(
    id: string,
    status: AccountStatus,
    error?: string | null,
  ): Promise<MarketplaceAccountRecord> {
    const data: Prisma.MarketplaceAccountUpdateInput = { status };
    if (error !== undefined) {
      data.lastError = error;
      data.lastErrorAt = error ? new Date() : null;
    }

    const record = await this.prisma.marketplaceAccount.update({ where: { id }, data });
    return mapAccount(record);
  }

  async delete(id: string): Promise<void> {
    // deleteMany keeps the operation idempotent (no P2025 on a repeated call).
    await this.prisma.marketplaceAccount.deleteMany({ where: { id } });
  }
}

export function createAccountRepository(prisma: PrismaClient): PrismaAccountRepository {
  return new PrismaAccountRepository(prisma);
}

