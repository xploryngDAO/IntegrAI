import type { PrismaClient } from '../../generated/prisma/client';
import type {
  CreateSessionInput,
  ISessionRepository,
  SessionFingerprintQuery,
  SessionRecord,
} from '@sac/shared';
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
        lastUsedAt: input.lastUsedAt ?? null,
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

  async findById(id: string): Promise<SessionRecord | null> {
    const record = await this.prisma.session.findUnique({ where: { id } });
    return record ? mapSession(record) : null;
  }

  async listActiveByUser(userId: string, at: Date): Promise<SessionRecord[]> {
    const records = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: at } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return records.map(mapSession);
  }

  /**
   * New-device probe: a single indexed `findFirst` on (userId, createdAt) with
   * an exact match on both fingerprint columns. `select: { id: true }` keeps
   * the row payload minimal; revoked/expired sessions deliberately still match
   * (the device was known even if that session is gone).
   */
  async hasSessionWithFingerprint(
    userId: string,
    query: SessionFingerprintQuery,
  ): Promise<boolean> {
    const match = await this.prisma.session.findFirst({
      where: {
        userId,
        ip: query.ip,
        userAgent: query.userAgent,
        createdAt: { gte: query.since },
      },
      select: { id: true },
    });
    return match !== null;
  }

  async revoke(id: string, at: Date): Promise<boolean> {
    const result = await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at },
    });
    return result.count > 0;
  }

  async revokeById(id: string, userId: string, at: Date): Promise<boolean> {
    const result = await this.prisma.session.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: at },
    });
    return result.count > 0;
  }

  async revokeAllExcept(
    userId: string,
    exceptSessionId: string | undefined,
    at: Date,
  ): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId !== undefined ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: at },
    });
    return result.count;
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
