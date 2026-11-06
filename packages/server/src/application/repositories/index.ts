import type { PrismaClient } from '@prisma/client';
import type { AdapterRepositories } from '@sac/shared';
import { PrismaAccountRepository, createAccountRepository } from './accounts';
import { createAgentRepository, PrismaAgentRepository } from './agents';
import { createAttachmentRepository, PrismaAttachmentRepository } from './attachments';
import {
  createEmailVerificationRepository,
  PrismaEmailVerificationRepository,
} from './email-verifications';
import { createInvitationRepository, PrismaInvitationRepository } from './invitations';
import { createMessageRepository, PrismaMessageRepository } from './messages';
import { createOrderRepository, PrismaOrderRepository } from './orders';
import {
  createPasswordResetRepository,
  PrismaPasswordResetRepository,
} from './password-resets';
import { createPiiVaultRepository, PrismaPiiVaultRepository } from './pii-vault';
import { createPlatformRepository, PrismaPlatformRepository } from './platform';
import { createSessionRepository, PrismaSessionRepository } from './sessions';
import { createSlaPolicyRepository, PrismaSlaPolicyRepository } from './sla-policies';
import { createTenantDataRepository, PrismaTenantDataRepository } from './tenant-data';
import {
  createTenantPurgeRepository,
  PrismaTenantPurgeRepository,
} from './tenant-purge';
import {
  createPlatformTenantRepository,
  createTenantRepository,
  PrismaTenantRepository,
} from './tenants';
import { createTicketEventRepository, PrismaTicketEventRepository } from './ticket-events';
import { createTicketRepository, PrismaTicketRepository } from './tickets';
import { createTwoFactorRepository, PrismaTwoFactorRepository } from './two-factor';
import { createWebhookEventRepository, PrismaWebhookEventRepository } from './webhook-events';

/**
 * Repository factory bundle expected by `AdapterRepositories` (the adapters
 * receive this exact object through their dependency injection).
 */
export function createRepositories(prisma: PrismaClient): AdapterRepositories {
  return {
    accounts: createAccountRepository(prisma),
    tickets: createTicketRepository(prisma),
    messages: createMessageRepository(prisma),
    orders: createOrderRepository(prisma),
    attachments: createAttachmentRepository(prisma),
    webhookEvents: createWebhookEventRepository(prisma),
    piiVault: createPiiVaultRepository(prisma),
    ticketEvents: createTicketEventRepository(prisma),
  };
}

export { createAccountRepository, PrismaAccountRepository };
export { createAgentRepository, PrismaAgentRepository };
export { createAttachmentRepository, PrismaAttachmentRepository };
export {
  createEmailVerificationRepository,
  PrismaEmailVerificationRepository,
};
export { createInvitationRepository, PrismaInvitationRepository };
export { createMessageRepository, PrismaMessageRepository };
export { createOrderRepository, PrismaOrderRepository };
export {
  createPasswordResetRepository,
  PrismaPasswordResetRepository,
};
export { createPiiVaultRepository, PrismaPiiVaultRepository };
export { createPlatformRepository, PrismaPlatformRepository };
export { createSessionRepository, PrismaSessionRepository };
export { createSlaPolicyRepository, PrismaSlaPolicyRepository };
export { createTenantDataRepository, PrismaTenantDataRepository };
export { createTenantPurgeRepository, PrismaTenantPurgeRepository };
export {
  createPlatformTenantRepository,
  createTenantRepository,
  PrismaTenantRepository,
};
export { createTicketEventRepository, PrismaTicketEventRepository };
export { createTicketRepository, PrismaTicketRepository };
export { createTwoFactorRepository, PrismaTwoFactorRepository };
export { createWebhookEventRepository, PrismaWebhookEventRepository };

export { isRecordNotFound, isUniqueConstraintViolation } from './errors';
export {
  mapAccount,
  mapAgent,
  mapAttachment,
  mapEmailVerification,
  mapInvitation,
  mapMessage,
  mapOrder,
  mapPasswordReset,
  mapPii,
  mapSession,
  mapSlaPolicy,
  mapTenant,
  mapTicket,
  mapTicketEvent,
  mapWebhookEvent,
  toInputJson,
  toInputJsonArray,
  toJsonArray,
  toJsonObject,
} from './mappers';
