import type { PrismaClient } from '../../generated/prisma/client';
import type {
  CreateEmailVerificationInput,
  EmailVerificationRecord,
  IEmailVerificationRepository,
} from '@sac/shared';
import { mapEmailVerification } from './mappers';

/**
 * Prisma implementation of `IEmailVerificationRepository`.
 *
 * Only the SHA-256 hash of the random token is ever persisted; the raw token
 * exists solely in memory until the verification e-mail leaves the process.
 */
export class PrismaEmailVerificationRepository implements IEmailVerificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateEmailVerificationInput): Promise<EmailVerificationRecord> {
    const record = await this.prisma.emailVerification.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      },
    });
    return mapEmailVerification(record);
  }

  async findByTokenHash(tokenHash: string): Promise<EmailVerificationRecord | null> {
    const record = await this.prisma.emailVerification.findFirst({
      where: { tokenHash },
      orderBy: { createdAt: 'desc' },
    });
    return record ? mapEmailVerification(record) : null;
  }

  async markUsed(id: string, at: Date): Promise<void> {
    await this.prisma.emailVerification.update({
      where: { id },
      data: { usedAt: at },
    });
  }

  async invalidateUnused(userId: string, at: Date): Promise<number> {
    const result = await this.prisma.emailVerification.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: at },
    });
    return result.count;
  }
}

export function createEmailVerificationRepository(
  prisma: PrismaClient,
): PrismaEmailVerificationRepository {
  return new PrismaEmailVerificationRepository(prisma);
}
