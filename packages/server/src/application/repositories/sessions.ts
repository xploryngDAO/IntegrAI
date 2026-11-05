import type { PrismaClient } from '@prisma/client';
import type { CreateSessionInput, ISessionRepository, SessionRecord } from '@sac/shared';
import { mapSession } from './mappers';

/**
 * Prisma implementation of `ISessionRepository` (rotating refresh tokens).
 *
 * `refresh_token_hash` is UNIQUE, so a token can never address two rows. Every
 * revoke is a conditional `updateMany` (`revoked_at IS NULL`) which makes the
 * rotation atomic: only one concurrent refresh can burn a given token.
 */
export class PrismaSessionRepository implements ISessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const record = await this.prisma.session.create({
      data: {
        userId: input.userId,
        tenantId: input.tenantId,
        refreshTokenHash: input.refreshTokenHash,
        userAgent: input.userAgent ?? null,
        ip: input.ip ?? null,
        expiresAt: input.expiresAt,
      },
    });
    return mapSession(record);
  }

  async findByRefreshTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const record = await this.prisma.session.findUnique({
      where: { refreshTokenHash: tokenHash },
    });
    return record ? mapSession(record) : null;
  }

  async revoke(id: string, at: Date): Promise<boolean> {
    const result = await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at },
    });
    return result.count > 0;
  }

  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: at },
    });
    return result.count;
  }
}

export function createSessionRepository(prisma: PrismaClient): PrismaSessionRepository {
  return new PrismaSessionRepository(prisma);
}
