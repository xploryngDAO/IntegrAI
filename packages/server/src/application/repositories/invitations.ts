import type { PrismaClient } from '@prisma/client';
import type {
  IInvitationRepository,
  InvitationRecord,
  UpsertInvitationInput,
} from '@sac/shared';
import { mapInvitation } from './mappers';
import { isUniqueConstraintViolation } from './errors';

/**
 * Prisma implementation of `IInvitationRepository` (Fase 1 operator invites).
 *
 * Invariants enforced here, not in the service:
 *  - `(tenant_id, email)` is UNIQUE, so a resend is an `upsert` that replaces
 *    the token hash/expiry instead of inserting a second row (no duplicate
 *    invitations and no window where an older link still works);
 *  - `accept` is a conditional `updateMany` on `accepted_at IS NULL`, so only
 *    one concurrent acceptance can consume the invitation;
 *  - `revoke` expires the row in place (`expires_at = now`) and only matches a
 *    still-pending invitation of the caller tenant.
 */
export class PrismaInvitationRepository implements IInvitationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(input: UpsertInvitationInput): Promise<InvitationRecord> {
    const where = { tenantId_email: { tenantId: input.tenantId, email: input.email } };
    const update = {
      role: input.role,
      tokenHash: input.tokenHash,
      invitedBy: input.invitedBy ?? null,
      expiresAt: input.expiresAt,
      // A resend re-opens the invitation; an already accepted row is blocked
      // earlier by the service (the operator exists, so the e-mail conflicts).
      acceptedAt: null,
    };

    try {
      const record = await this.prisma.invitation.upsert({
        where,
        create: {
          tenantId: input.tenantId,
          email: input.email,
          role: input.role,
          tokenHash: input.tokenHash,
          invitedBy: input.invitedBy ?? null,
          expiresAt: input.expiresAt,
        },
        update,
      });
      return mapInvitation(record);
    } catch (error) {
      // Two ADMIN resends racing on the same `(tenant, email)` can both miss
      // the row and then hit the unique index: fall back to the refresh path.
      if (!isUniqueConstraintViolation(error)) throw error;
      const record = await this.prisma.invitation.update({ where, data: update });
      return mapInvitation(record);
    }
  }

  async findByTokenHash(tokenHash: string): Promise<InvitationRecord | null> {
    const record = await this.prisma.invitation.findFirst({
      where: { tokenHash },
      orderBy: { createdAt: 'desc' },
    });
    return record ? mapInvitation(record) : null;
  }

  async findById(id: string): Promise<InvitationRecord | null> {
    const record = await this.prisma.invitation.findUnique({ where: { id } });
    return record ? mapInvitation(record) : null;
  }

  async listByTenant(tenantId: string): Promise<InvitationRecord[]> {
    const records = await this.prisma.invitation.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return records.map(mapInvitation);
  }

  async accept(id: string, at: Date): Promise<InvitationRecord | null> {
    const result = await this.prisma.invitation.updateMany({
      where: { id, acceptedAt: null },
      data: { acceptedAt: at },
    });
    if (result.count === 0) return null;

    const record = await this.prisma.invitation.findUnique({ where: { id } });
    return record ? mapInvitation(record) : null;
  }

  async revoke(id: string, tenantId: string, at: Date): Promise<boolean> {
    const result = await this.prisma.invitation.updateMany({
      where: { id, tenantId, acceptedAt: null, expiresAt: { gt: at } },
      data: { expiresAt: at },
    });
    return result.count > 0;
  }
}

export function createInvitationRepository(
  prisma: PrismaClient,
): PrismaInvitationRepository {
  return new PrismaInvitationRepository(prisma);
}
