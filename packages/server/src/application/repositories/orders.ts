import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import type {
  IOrderRepository,
  Marketplace,
  OrderCacheRecord,
  UpsertOrderInput,
} from '@sac/shared';
import { isUniqueConstraintViolation } from './errors';
import { mapOrder, toInputJson, toInputJsonArray } from './mappers';

/** Prisma implementation of `IOrderRepository`. */
export class PrismaOrderRepository implements IOrderRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(input: UpsertOrderInput): Promise<OrderCacheRecord> {
    const create = buildCreateData(input);
    const update = buildUpdateData(input);

    try {
      const record = await this.prisma.orderCache.upsert({
        where: {
          accountId_externalOrderId: {
            accountId: input.accountId,
            externalOrderId: input.externalOrderId,
          },
        },
        create,
        update,
      });
      return mapOrder(record);
    } catch (error) {
      // `orders_cache` also has `@@unique([marketplace, externalOrderId])`: if a
      // different account already mirrored the order we update that row instead
      // of dropping the enrichment.
      if (isUniqueConstraintViolation(error)) {
        const existing = await this.findByExternalOrderId(input.marketplace, input.externalOrderId);
        if (existing) {
          const record = await this.prisma.orderCache.update({
            where: { id: existing.id },
            data: update,
          });
          return mapOrder(record);
        }
      }
      throw error;
    }
  }

  async findById(id: string): Promise<OrderCacheRecord | null> {
    const record = await this.prisma.orderCache.findUnique({ where: { id } });
    return record ? mapOrder(record) : null;
  }

  async findByExternalOrderId(
    marketplace: Marketplace,
    externalOrderId: string,
  ): Promise<OrderCacheRecord | null> {
    const record = await this.prisma.orderCache.findFirst({
      where: { marketplace, externalOrderId },
      orderBy: { lastSyncedAt: 'desc' },
    });
    return record ? mapOrder(record) : null;
  }

  async findByPackId(accountId: string, packId: string): Promise<OrderCacheRecord | null> {
    const record = await this.prisma.orderCache.findFirst({
      where: { accountId, packId },
      orderBy: { lastSyncedAt: 'desc' },
    });
    return record ? mapOrder(record) : null;
  }

  async listByTicket(ticketId: string): Promise<OrderCacheRecord[]> {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { orderCacheId: true, externalOrderId: true, accountId: true },
    });
    if (!ticket) return [];

    const or: Prisma.OrderCacheWhereInput[] = [{ tickets: { some: { id: ticketId } } }];
    if (ticket.orderCacheId) or.push({ id: ticket.orderCacheId });
    if (ticket.externalOrderId) {
      or.push({ accountId: ticket.accountId, externalOrderId: ticket.externalOrderId });
    }

    const records = await this.prisma.orderCache.findMany({
      where: { OR: or },
      orderBy: { lastSyncedAt: 'desc' },
    });
    return records.map(mapOrder);
  }

  async updateActions(id: string, actions: Record<string, unknown>): Promise<OrderCacheRecord> {
    const record = await this.prisma.orderCache.update({
      where: { id },
      data: {
        allowedActionsCache: toInputJson(actions),
        lastSyncedAt: new Date(),
      },
    });
    return mapOrder(record);
  }
}

function buildCreateData(input: UpsertOrderInput): Prisma.OrderCacheUncheckedCreateInput {
  return {
    accountId: input.accountId,
    marketplace: input.marketplace,
    externalOrderId: input.externalOrderId,
    packId: input.packId ?? null,
    buyerExternalId: input.buyerExternalId ?? null,
    buyerNameOrNick: input.buyerNameOrNick ?? null,
    buyerAnonymizedEmail: input.buyerAnonymizedEmail ?? null,
    orderStatus: input.orderStatus,
    fulfillmentType: input.fulfillmentType ?? null,
    totalAmount: input.totalAmount,
    currency: input.currency ?? 'BRL',
    trackingNumber: input.trackingNumber ?? null,
    carrierName: input.carrierName ?? null,
    itemsSnapshot: toInputJsonArray(input.itemsSnapshot ?? []),
    allowedActionsCache: toInputJson(input.allowedActionsCache ?? {}),
    shippingSnapshot: toInputJson(input.shippingSnapshot ?? {}),
    estimatedDeliveryAt: input.estimatedDeliveryAt ?? null,
    shippedAt: input.shippedAt ?? null,
    deliveredAt: input.deliveredAt ?? null,
    lastSyncedAt: new Date(),
  };
}

function buildUpdateData(input: UpsertOrderInput): Prisma.OrderCacheUncheckedUpdateInput {
  return {
    packId: input.packId ?? null,
    buyerExternalId: input.buyerExternalId ?? null,
    buyerNameOrNick: input.buyerNameOrNick ?? null,
    buyerAnonymizedEmail: input.buyerAnonymizedEmail ?? null,
    orderStatus: input.orderStatus,
    fulfillmentType: input.fulfillmentType ?? null,
    totalAmount: input.totalAmount,
    currency: input.currency ?? 'BRL',
    trackingNumber: input.trackingNumber ?? null,
    carrierName: input.carrierName ?? null,
    itemsSnapshot: toInputJsonArray(input.itemsSnapshot ?? []),
    allowedActionsCache: toInputJson(input.allowedActionsCache ?? {}),
    shippingSnapshot: toInputJson(input.shippingSnapshot ?? {}),
    estimatedDeliveryAt: input.estimatedDeliveryAt ?? null,
    shippedAt: input.shippedAt ?? null,
    deliveredAt: input.deliveredAt ?? null,
    lastSyncedAt: new Date(),
  };
}

export function createOrderRepository(prisma: PrismaClient): PrismaOrderRepository {
  return new PrismaOrderRepository(prisma);
}
