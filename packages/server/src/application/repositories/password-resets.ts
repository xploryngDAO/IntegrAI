import type { PrismaClient } from '../../generated/prisma/client';
import type {
  CreatePasswordResetInput,
  IPasswordResetRepository,
  PasswordResetRecord,
} from '@sac/shared';
import { mapPasswordReset } from './mappers';

/**
 * Prisma implementation of `IPasswordResetRepository`.
 *
 * Only the SHA-256 hash of the 32-byte random token is persisted; the raw token
 * exists solely in the e-mail link. `used_at` is the single-use marker, so a
 * replayed link is indistinguishable from an unknown one.
 */
export class PrismaPasswordResetRepository implements IPasswordResetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreatePasswordResetInput): Promise<PasswordResetRecord> {
    const record = await this.prisma.passwordReset.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      },
    });
    return mapPasswordReset(record);
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetRecord | null> {
    const record = await this.prisma.passwordReset.findFirst({
      where: { tokenHash },
      orderBy: { createdAt: 'desc' },
    });
    return record ? mapPasswordReset(record) : null;
  }

  async markUsed(id: string, at: Date): Promise<void> {
    await this.prisma.passwordReset.update({
      where: { id },
      data: { usedAt: at },
    });
  }

  async invalidateUnused(userId: string, at: Date): Promise<number> {
    const result = await this.prisma.passwordReset.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: at },
    });
    return result.count;
  }
}

export function createPasswordResetRepository(
  prisma: PrismaClient,
): PrismaPasswordResetRepository {
  return new PrismaPasswordResetRepository(prisma);
}
