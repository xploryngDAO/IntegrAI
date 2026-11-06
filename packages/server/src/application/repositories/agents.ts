import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import type {
  AgentPresenceStatus,
  AgentRecord,
  CreateAgentInput,
  IAgentRepository,
} from '@sac/shared';
import { mapAgent } from './mappers';

/** Prisma implementation of `IAgentRepository`. */
export class PrismaAgentRepository implements IAgentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateAgentInput): Promise<AgentRecord> {
    const record = await this.prisma.agent.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash: input.passwordHash,
        role: input.role,
        avatarColor: input.avatarColor,
        maxConcurrent: input.maxConcurrent,
        tenantId: input.tenantId ?? null,
        emailVerifiedAt: input.emailVerifiedAt ?? null,
      },
    });
    return mapAgent(record);
  }

  async findByEmail(email: string): Promise<AgentRecord | null> {
    const record = await this.prisma.agent.findUnique({ where: { email } });
    return record ? mapAgent(record) : null;
  }

  async findById(id: string): Promise<AgentRecord | null> {
    const record = await this.prisma.agent.findUnique({ where: { id } });
    return record ? mapAgent(record) : null;
  }

  async list(filter?: {
    presence?: AgentPresenceStatus;
    activeOnly?: boolean;
    tenantId?: string | null;
  }): Promise<AgentRecord[]> {
    const where: Prisma.AgentWhereInput = {};
    if (filter?.presence) where.presence = filter.presence;
    if (filter?.activeOnly) where.isActive = true;
    if (filter?.tenantId) where.tenantId = filter.tenantId;

    const records = await this.prisma.agent.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return records.map(mapAgent);
  }

  async updatePresence(
    id: string,
    presence: AgentPresenceStatus,
    at: Date,
  ): Promise<AgentRecord> {
    const record = await this.prisma.agent.update({
      where: { id },
      data: { presence, lastSeenAt: at },
    });
    return mapAgent(record);
  }

  async updateName(id: string, name: string): Promise<AgentRecord> {
    const record = await this.prisma.agent.update({
      where: { id },
      data: { name },
    });
    return mapAgent(record);
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    // A password reset also clears the restore marker: the operator chose a new
    // password, so the random temporary one no longer applies.
    await this.prisma.agent.update({
      where: { id },
      data: { passwordHash, mustResetPassword: false },
    });
  }

  async markEmailVerified(id: string, at: Date): Promise<void> {
    await this.prisma.agent.update({
      where: { id },
      data: { emailVerifiedAt: at },
    });
  }
}

export function createAgentRepository(prisma: PrismaClient): PrismaAgentRepository {
  return new PrismaAgentRepository(prisma);
}
