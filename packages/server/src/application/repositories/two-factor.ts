import type { PrismaClient } from '@prisma/client';
import type { ITwoFactorRepository } from '@sac/shared';

/**
 * Prisma implementation of `ITwoFactorRepository`.
 *
 * Security invariants enforced here:
 *  - `disable` wipes the encrypted secret and every recovery code in a single
 *    transaction, so a disabled account can never keep a usable break-glass path;
 *  - `consumeRecoveryCode` is a conditional `updateMany` (`used_at IS NULL`),
 *    which makes redemption atomic: two concurrent attempts cannot both win;
 *  - recovery codes are addressed by SHA-256 hash only (`code_hash` UNIQUE).
 */
export class PrismaTwoFactorRepository implements ITwoFactorRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async setPendingSecret(userId: string, secretEnc: string): Promise<void> {
    await this.prisma.agent.update({
      where: { id: userId },
      data: { twoFactorSecretEnc: secretEnc, twoFactorEnabled: false },
    });
  }

  async enable(userId: string, codeHashes: string[]): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.agent.update({
        where: { id: userId },
        data: { twoFactorEnabled: true },
      }),
      this.prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } }),
      this.prisma.twoFactorRecoveryCode.createMany({
        data: codeHashes.map((codeHash) => ({ userId, codeHash })),
      }),
    ]);
  }

  async disable(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.agent.update({
        where: { id: userId },
        data: { twoFactorEnabled: false, twoFactorSecretEnc: null },
      }),
      this.prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } }),
    ]);
  }

  async consumeRecoveryCode(userId: string, codeHash: string, at: Date): Promise<boolean> {
    const result = await this.prisma.twoFactorRecoveryCode.updateMany({
      where: { userId, codeHash, usedAt: null },
      data: { usedAt: at },
    });
    return result.count > 0;
  }
}

export function createTwoFactorRepository(prisma: PrismaClient): PrismaTwoFactorRepository {
  return new PrismaTwoFactorRepository(prisma);
}
