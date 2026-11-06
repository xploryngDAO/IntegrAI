import type { PrismaClient } from '../../generated/prisma/client';
import type { AdapterRepositories } from '@sac/shared';
import { PrismaAccountRepository, createAccountRepository } from './accounts';
import { PrismaAdminUserRepository, createAdminUserRepository } from './admin-users';
import { createAgentRepository, PrismaAgentRepository } from './agents';
import { createAttachmentRepository, PrismaAttachmentRepository } from './attachments';
import {
  PrismaAuditEventRepository,
  createAuditEventRepository,
} from './audit-events';
import {
  createBillingEventRepository,
  PrismaBillingEventRepository,
} from './billing-events';
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
import { createAgentSsoRepository, PrismaAgentSsoRepository } from './sso-agents';
import {
  createTenantSsoConnectionRepository,
  PrismaTenantSsoConnectionRepository,
} from './sso-connections';
import {
  createTenantBackupRepository,
  PrismaTenantBackupRepository,
} from './tenant-backup';
import { createTenantDataRepository, PrismaTenantDataRepository } from './tenant-data';
import {
  createTenantRestoreRepository,
  PrismaTenantRestoreRepository,
} from './tenant-restore';
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
export { createAdminUserRepository, PrismaAdminUserRepository };
export { createAgentRepository, PrismaAgentRepository };
export { createAttachmentRepository, PrismaAttachmentRepository };
export { createAuditEventRepository, PrismaAuditEventRepository };
export { createBillingEventRepository, PrismaBillingEventRepository };
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
export { createAgentSsoRepository, PrismaAgentSsoRepository };
export {
  createTenantSsoConnectionRepository,
  PrismaTenantSsoConnectionRepository,
};
export { createTenantBackupRepository, PrismaTenantBackupRepository };
export { createTenantDataRepository, PrismaTenantDataRepository };
export { createTenantPurgeRepository, PrismaTenantPurgeRepository };
export { createTenantRestoreRepository, PrismaTenantRestoreRepository };
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
  mapAuditEvent,
  mapEmailVerification,
  mapInvitation,
  mapMessage,
  mapOrder,
  mapOutboundAttempt,
  mapPasswordReset,
  mapPii,
  mapSession,
  mapSlaPolicy,
  mapSsoConnection,
  mapTenant,
  mapTenantBackupRecord,
  mapTicket,
  mapTicketEvent,
  mapWebhookEvent,
  normalizeBackupCounts,
  normalizeGroupRoleMap,
  toInputJson,
  toInputJsonArray,
  toJsonArray,
  toJsonObject,
} from './mappers';
