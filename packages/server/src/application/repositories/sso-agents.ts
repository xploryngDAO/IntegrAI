import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import type {
  AgentRecord,
  CreateSsoAgentInput,
  IAgentSsoRepository,
  UpdateSsoAgentInput,
} from '@sac/shared';
import { mapAgent } from './mappers';

/**
 * JIT provisioning writes for the SSO flow (`agents` table).
 *
 * Deliberately narrow (mirror of `PrismaTwoFactorRepository`): creation always
 * yields an ACTIVE, e-mail-verified operator with `must_reset_password = false`
 * and a random password hash, and the update path can only refresh name, role
 * and the verification flags. Nothing here can change the tenant, the password
 * or the platform-admin flag.
 */
export class PrismaAgentSsoRepository implements IAgentSsoRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByEmail(email: string): Promise<AgentRecord | null> {
    const record = await this.prisma.agent.findUnique({ where: { email } });
    return record === null ? null : mapAgent(record);
  }

  async create(input: CreateSsoAgentInput): Promise<AgentRecord> {
    const record = await this.prisma.agent.create({
      data: {
        tenantId: input.tenantId,
        email: input.email,
        name: input.name,
        passwordHash: input.passwordHash,
        role: input.role,
        emailVerifiedAt: input.emailVerifiedAt,
        isActive: true,
        mustResetPassword: false,
      },
    });
    return mapAgent(record);
  }

  async updateFromSso(id: string, patch: UpdateSsoAgentInput): Promise<AgentRecord> {
    const data: Prisma.AgentUpdateInput = {
      name: patch.name,
      emailVerifiedAt: patch.emailVerifiedAt,
      mustResetPassword: patch.mustResetPassword,
    };
    // An unmapped login must never demote an existing operator: the service
    // omits `role` when no IdP group matched `group_role_map`.
    if (patch.role !== undefined) data.role = patch.role;

    const record = await this.prisma.agent.update({ where: { id }, data });
    return mapAgent(record);
  }
}

export function createAgentSsoRepository(prisma: PrismaClient): PrismaAgentSsoRepository {
  return new PrismaAgentSsoRepository(prisma);
}
