import type { PrismaClient } from '../../generated/prisma/client';
import type {
  ISlaPolicyRepository,
  Marketplace,
  SlaPolicyRecord,
  TicketType,
} from '@sac/shared';
import { mapSlaPolicy } from './mappers';

/**
 * Prisma implementation of `ISlaPolicyRepository`.
 *
 * Resolution order for `find`: account-specific (active) policy, then the
 * global (accountId = NULL) policy for the same marketplace/ticket type.
 */
export class PrismaSlaPolicyRepository implements ISlaPolicyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async find(
    accountId: string | null,
    marketplace: Marketplace,
    ticketType: TicketType,
  ): Promise<SlaPolicyRecord | null> {
    if (accountId) {
      const accountPolicy = await this.prisma.slaPolicy.findUnique({
        where: {
          accountId_marketplace_ticketType: { accountId, marketplace, ticketType },
        },
      });
      if (accountPolicy && accountPolicy.isActive) return mapSlaPolicy(accountPolicy);
    }

    const globalPolicy = await this.prisma.slaPolicy.findFirst({
      where: { accountId: null, marketplace, ticketType, isActive: true },
    });
    return globalPolicy ? mapSlaPolicy(globalPolicy) : null;
  }

  async listByMarketplace(marketplace: Marketplace): Promise<SlaPolicyRecord[]> {
    const records = await this.prisma.slaPolicy.findMany({
      where: { marketplace, isActive: true },
      orderBy: [{ accountId: 'asc' }, { ticketType: 'asc' }],
    });
    return records.map(mapSlaPolicy);
  }
}

export function createSlaPolicyRepository(prisma: PrismaClient): PrismaSlaPolicyRepository {
  return new PrismaSlaPolicyRepository(prisma);
}
