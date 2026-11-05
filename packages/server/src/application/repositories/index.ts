import type { PrismaClient } from '@prisma/client';
import type { AdapterRepositories } from '@sac/shared';
import { PrismaAccountRepository, createAccountRepository } from './accounts';
import { createAgentRepository, PrismaAgentRepository } from './agents';
import { createAttachmentRepository, PrismaAttachmentRepository } from './attachments';
import { createMessageRepository, PrismaMessageRepository } from './messages';
import { createOrderRepository, PrismaOrderRepository } from './orders';
import { createPiiVaultRepository, PrismaPiiVaultRepository } from './pii-vault';
import { createSlaPolicyRepository, PrismaSlaPolicyRepository } from './sla-policies';
import { createTicketEventRepository, PrismaTicketEventRepository } from './ticket-events';
import { createTicketRepository, PrismaTicketRepository } from './tickets';
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
export { createMessageRepository, PrismaMessageRepository };
export { createOrderRepository, PrismaOrderRepository };
export { createPiiVaultRepository, PrismaPiiVaultRepository };
export { createSlaPolicyRepository, PrismaSlaPolicyRepository };
export { createTicketEventRepository, PrismaTicketEventRepository };
export { createTicketRepository, PrismaTicketRepository };
export { createWebhookEventRepository, PrismaWebhookEventRepository };

export { isRecordNotFound, isUniqueConstraintViolation } from './errors';
export {
  mapAccount,
  mapAgent,
  mapAttachment,
  mapMessage,
  mapOrder,
  mapPii,
  mapSlaPolicy,
  mapTicket,
  mapTicketEvent,
  mapWebhookEvent,
  toInputJson,
  toInputJsonArray,
  toJsonArray,
  toJsonObject,
} from './mappers';
