import type {
  CreatePasswordResetInput,
  CreateSessionInput,
  IClock,
  IPasswordResetRepository,
  ISessionRepository,
  PasswordResetRecord,
  SessionRecord,
} from '@sac/shared';

/**
 * In-memory repositories shared by the auth unit tests.
 *
 * They mirror the Prisma implementations: opaque tokens are stored hashed,
 * `used_at`/`revoked_at` are the single-use markers and a revoke is conditional
 * (`revoked_at IS NULL`), exactly like the `updateMany` in the real repository.
 */

export class InMemoryPasswordResetRepository implements IPasswordResetRepository {
  readonly rows: PasswordResetRecord[] = [];
  private sequence = 0;

  constructor(private readonly clock: IClock) {}

  async create(input: CreatePasswordResetInput): Promise<PasswordResetRecord> {
    const row: PasswordResetRecord = {
      id: `reset-${(this.sequence += 1)}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      usedAt: null,
      createdAt: this.clock.now(),
    };
    this.rows.push(row);
    return row;
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetRecord | null> {
    return this.rows.find((row) => row.tokenHash === tokenHash) ?? null;
  }

  async markUsed(id: string, at: Date): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row !== undefined) row.usedAt = at;
  }

  async invalidateUnused(userId: string, at: Date): Promise<number> {
    let count = 0;
    for (const row of this.rows) {
      if (row.userId === userId && row.usedAt === null) {
        row.usedAt = at;
        count += 1;
      }
    }
    return count;
  }
}

export class InMemorySessionRepository implements ISessionRepository {
  readonly rows: SessionRecord[] = [];
  private sequence = 0;

  constructor(private readonly clock: IClock) {}

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    if (this.rows.some((row) => row.refreshTokenHash === input.refreshTokenHash)) {
      const conflict = new Error('Unique constraint failed on the fields: (`refresh_token_hash`)');
      (conflict as Error & { code?: string }).code = 'P2002';
      throw conflict;
    }
    const row: SessionRecord = {
      id: `session-${(this.sequence += 1)}`,
      userId: input.userId,
      tenantId: input.tenantId,
      refreshTokenHash: input.refreshTokenHash,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
      expiresAt: input.expiresAt,
      revokedAt: null,
      lastUsedAt: input.lastUsedAt ?? null,
      createdAt: this.clock.now(),
    };
    this.rows.push(row);
    return row;
  }

  async findByRefreshTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return this.rows.find((row) => row.refreshTokenHash === tokenHash) ?? null;
  }

  async findById(id: string): Promise<SessionRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async listActiveByUser(userId: string, at: Date): Promise<SessionRecord[]> {
    return this.rows
      .filter(
        (row) =>
          row.userId === userId && row.revokedAt === null && row.expiresAt.getTime() > at.getTime(),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async revoke(id: string, at: Date): Promise<boolean> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined || row.revokedAt !== null) return false;
    row.revokedAt = at;
    return true;
  }

  async revokeById(id: string, userId: string, at: Date): Promise<boolean> {
    const row = this.rows.find((entry) => entry.id === id && entry.userId === userId);
    if (row === undefined || row.revokedAt !== null) return false;
    row.revokedAt = at;
    return true;
  }

  async revokeAllExcept(
    userId: string,
    exceptSessionId: string | undefined,
    at: Date,
  ): Promise<number> {
    let count = 0;
    for (const row of this.rows) {
      if (
        row.userId === userId &&
        row.revokedAt === null &&
        (exceptSessionId === undefined || row.id !== exceptSessionId)
      ) {
        row.revokedAt = at;
        count += 1;
      }
    }
    return count;
  }

  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    let count = 0;
    for (const row of this.rows) {
      if (row.userId === userId && row.revokedAt === null) {
        row.revokedAt = at;
        count += 1;
      }
    }
    return count;
  }
}
