import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  BuyerPiiRecord,
  IPiiVaultRepository,
  UpsertPiiInput,
} from '@sac/shared';
import { mapPii, toInputJson } from './mappers';

/**
 * Prisma implementation of `IPiiVaultRepository`.
 *
 * The vault is the only place Amazon restricted data may live; rows carry an
 * `expires_at` (shipment + PII_RETENTION_DAYS) and are hard-deleted by the
 * `queue.pii.purge` cron through `purgeExpired`.
 */
export class PrismaPiiVaultRepository implements IPiiVaultRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(input: UpsertPiiInput): Promise<BuyerPiiRecord> {
    const record = await this.prisma.buyerPiiVault.upsert({
      where: { ticketId: input.ticketId },
      create: {
        ticketId: input.ticketId,
        marketplace: input.marketplace,
        buyerName: input.buyerName ?? null,
        buyerEmail: input.buyerEmail ?? null,
        buyerDocument: input.buyerDocument ?? null,
        buyerPhone: input.buyerPhone ?? null,
        shippingAddress: toInputJson(input.shippingAddress ?? {}),
        sourceEndpoints: input.sourceEndpoints ?? [],
        expiresAt: input.expiresAt,
      },
      update: {
        marketplace: input.marketplace,
        buyerName: input.buyerName ?? null,
        buyerEmail: input.buyerEmail ?? null,
        buyerDocument: input.buyerDocument ?? null,
        buyerPhone: input.buyerPhone ?? null,
        shippingAddress: toInputJson(input.shippingAddress ?? {}),
        sourceEndpoints: input.sourceEndpoints ?? [],
        expiresAt: input.expiresAt,
        // Re-collection revives a previously purged row.
        purgedAt: null,
      },
    });
    return mapPii(record);
  }

  async findByTicketId(ticketId: string): Promise<BuyerPiiRecord | null> {
    const record = await this.prisma.buyerPiiVault.findUnique({ where: { ticketId } });
    return record ? mapPii(record) : null;
  }

  async purgeExpired(now: Date): Promise<number> {
    const result = await this.prisma.buyerPiiVault.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return result.count;
  }

  async deleteByTicketId(ticketId: string): Promise<void> {
    await this.prisma.buyerPiiVault.deleteMany({ where: { ticketId } });
  }
}


export function createPiiVaultRepository(prisma: PrismaClient): PrismaPiiVaultRepository {
  return new PrismaPiiVaultRepository(prisma);
}
