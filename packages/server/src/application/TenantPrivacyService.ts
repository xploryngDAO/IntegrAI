import bcrypt from 'bcryptjs';

import type {
  AgentRecord,
  DeleteTenantCommand,
  DeleteTenantResult,
  IAgentRepository,
  IClock,
  ILogger,
  IPlatformTenantRepository,
  ITenantDataRepository,
  ITenantPrivacyService,
  ITenantRepository,
  MarketplaceAccountRecord,
  TenantExportAccount,
  TenantExportAgent,
  TenantExportEvent,
  TenantExportMessage,
  TenantExportPayload,
  TenantExportTicket,
  TenantRecord,
  TicketEventRecord,
  TicketMessageRecord,
  SupportTicketRecord,
} from '@sac/shared';
import {
  AppError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
  isTenantActive,
} from '@sac/shared';

/**
 * ============================================================================
 * TenantPrivacyService - LGPD export and soft delete (Fase 4)
 * ============================================================================
 *
 *  - `exportData` builds a tenant-scoped JSON artifact with NO credentials:
 *    password hashes, TOTP secrets, marketplace access/refresh tokens and raw
 *    buyer PII (`buyer_pii_vault`) are all excluded. Marketplace account
 *    `channel_config` is copied after dropping anything that looks like a
 *    secret, so a custom connector field can never leak a token.
 *  - `deleteTenant` requires a re-authentication from the caller ADMIN (bcrypt
 *    password comparison) plus the exact workspace slug, then performs a SOFT
 *    delete (`status='DELETED'`, `deleted_at=now`) and revokes every live
 *    refresh session of the tenant. Accounts, tickets and messages are kept for
 *    audit; the physical purge is a future platform job.
 *
 * Errors are stable: 404 unknown tenant, 409 already deleted, 422 slug/field
 * validation, 403 wrong password or caller that is not an ADMIN of the tenant.
 */

const EXPORT_TICKET_LIMIT = 1_000;
const EXPORT_MESSAGE_LIMIT = 5_000;
const EXPORT_FORMAT_VERSION = '1.0';
const MAX_PASSWORD_LENGTH = 200;

const EXPORT_NOTES: readonly string[] = [
  'Credenciais não são exportadas: password_hash, two_factor_secret_enc, access_token_enc, refresh_token_enc e códigos de recuperação ficam fora do JSON.',
  'Dados restritos de comprador (buyer_pii_vault) não fazem parte da exportação; eles são expurgados pelo job de retenção do marketplace.',
  'Tickets omitem PII crua do comprador (nome, e-mail anonimizado, documento, telefone); mensagens incluem apenas o texto limpo, sem HTML nem artefatos brutos (S3).',
  'A exportação é limitada por tenant: no máximo 1.000 tickets e 5.000 mensagens; o campo meta.truncated indica corte.',
];

const DELETE_PURGE_NOTE =
  'Exclusão física (purge) ainda não é executada por este endpoint: é um job futuro de plataforma, previsto em docs/PHASE4_PLATFORM.md; os dados permanecem preservados para auditoria.';

const SECRET_KEY_PATTERN = /(token|secret|password|senha|api[_-]?key|private[_-]?key)/i;

export interface TenantPrivacyServiceDependencies {
  logger: ILogger;
  clock: IClock;
  repos: {
    tenants: ITenantRepository;
    /** Admin-only writes (soft delete), same Prisma implementation. */
    tenantAdmin: IPlatformTenantRepository;
    agents: IAgentRepository;
    tenantData: ITenantDataRepository;
  };
}

export class TenantPrivacyService implements ITenantPrivacyService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly tenants: ITenantRepository;
  private readonly tenantAdmin: IPlatformTenantRepository;
  private readonly agents: IAgentRepository;
  private readonly tenantData: ITenantDataRepository;

  constructor(deps: TenantPrivacyServiceDependencies) {
    this.logger = deps.logger.child({ component: 'TenantPrivacyService' });
    this.clock = deps.clock;
    this.tenants = deps.repos.tenants;
    this.tenantAdmin = deps.repos.tenantAdmin;
    this.agents = deps.repos.agents;
    this.tenantData = deps.repos.tenantData;
  }

  /* ==================================================================== */
  /* Export                                                               */
  /* ==================================================================== */

  async exportData(tenantId: string, actorId: string): Promise<TenantExportPayload> {
    const tenant = await this.tenants.findById(tenantId);
    if (tenant === null) throw new NotFoundError('Tenant', tenantId);

    const snapshot = await this.tenantData.snapshot(tenantId, {
      ticketLimit: EXPORT_TICKET_LIMIT,
      messageLimit: EXPORT_MESSAGE_LIMIT,
    });
    const now = this.clock.now();

    this.logger.info('tenant.export.generated', {
      tenantId,
      actorId,
      agents: snapshot.agents.length,
      accounts: snapshot.accounts.length,
      tickets: snapshot.tickets.length,
      messages: snapshot.messages.length,
      truncated: snapshot.truncated,
    });

    return {
      meta: {
        formatVersion: EXPORT_FORMAT_VERSION,
        exportedAt: now.toISOString(),
        exportedBy: actorId,
        tenantId,
        limits: { maxAccounts: tenant.maxAccounts, maxAgents: tenant.maxAgents },
        ticketLimit: EXPORT_TICKET_LIMIT,
        messageLimit: EXPORT_MESSAGE_LIMIT,
        truncated: snapshot.truncated,
        notes: [...EXPORT_NOTES],
      },
      tenant: mapTenant(tenant),
      agents: snapshot.agents.map(toExportAgent),
      accounts: snapshot.accounts.map(toExportAccount),
      tickets: snapshot.tickets.map(toExportTicket),
      messages: snapshot.messages.map(toExportMessage),
      events: snapshot.events.map(toExportEvent),
    };
  }

  /* ==================================================================== */
  /* Soft delete                                                          */
  /* ==================================================================== */

  async deleteTenant(
    tenantId: string,
    command: DeleteTenantCommand,
    actorId: string,
  ): Promise<DeleteTenantResult> {
    const now = this.clock.now();
    const tenant = await this.tenants.findById(tenantId);
    if (tenant === null) throw new NotFoundError('Tenant', tenantId);

    if (!isTenantActive(tenant)) {
      throw new ConflictError('Workspace is already deleted or suspended', {
        code: 'TENANT_ALREADY_DELETED',
        status: tenant.status,
      });
    }

    const confirmSlug = (command.confirmSlug ?? '').trim().toLowerCase();
    if (confirmSlug !== tenant.slug.toLowerCase()) {
      throw new ValidationError('Confirmation slug does not match the workspace slug', {
        field: 'confirmSlug',
      });
    }

    const password = command.password ?? '';
    if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
      throw new ValidationError('Password confirmation is required', { field: 'password' });
    }

    const actor = await this.agents.findById(actorId);
    if (
      actor === null ||
      actor.tenantId !== tenantId ||
      actor.role !== 'ADMIN' ||
      !actor.isActive
    ) {
      // The route already enforces ADMIN + JWT tenant; this protects service
      // callers (workers/internal jobs) from deleting another workspace.
      throw new AuthorizationError('Only an active ADMIN of this workspace can delete it');
    }

    let passwordMatches = false;
    try {
      passwordMatches = await bcrypt.compare(password, actor.passwordHash);
    } catch {
      passwordMatches = false;
    }
    if (!passwordMatches) {
      this.logger.warn('tenant.delete.invalid_password', { tenantId, actorId });
      throw new AppError('INVALID_PASSWORD', 'Password confirmation failed', 403, {
        field: 'password',
      });
    }

    // Kill every live refresh session before the workspace is marked deleted:
    // the access tokens are already rejected by the JWT guard (TENANT_INACTIVE).
    const revokedSessions = await this.tenantData.revokeSessions(tenantId, now);
    const updated = await this.tenantAdmin.softDelete(tenantId, now);

    this.logger.info('tenant.deleted', {
      tenantId,
      slug: updated.slug,
      actorId,
      revokedSessions,
      deletedAt: now.toISOString(),
    });

    return {
      tenantId: updated.id,
      slug: updated.slug,
      status: 'DELETED',
      deletedAt: now.toISOString(),
      purge: { scheduled: false, note: DELETE_PURGE_NOTE },
    };
  }
}

/* ====================================================================== */
/* Projections (no secrets, no raw buyer PII)                             */
/* ====================================================================== */

function mapTenant(tenant: TenantRecord): TenantExportPayload['tenant'] {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    plan: tenant.plan,
    limits: { maxAccounts: tenant.maxAccounts, maxAgents: tenant.maxAgents },
    onboardingCompletedAt: tenant.onboardingCompletedAt?.toISOString() ?? null,
    deletedAt: tenant.deletedAt?.toISOString() ?? null,
    createdAt: tenant.createdAt.toISOString(),
    updatedAt: tenant.updatedAt.toISOString(),
  };
}

function toExportAgent(agent: AgentRecord): TenantExportAgent {
  return {
    id: agent.id,
    email: agent.email,
    name: agent.name,
    role: agent.role,
    presence: agent.presence,
    isActive: agent.isActive,
    isPlatformAdmin: agent.isPlatformAdmin,
    emailVerifiedAt: agent.emailVerifiedAt?.toISOString() ?? null,
    twoFactorEnabled: agent.twoFactorEnabled,
    lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
    createdAt: agent.createdAt.toISOString(),
  };
}

function toExportAccount(account: MarketplaceAccountRecord): TenantExportAccount {
  return {
    id: account.id,
    marketplace: account.marketplace,
    displayName: account.displayName,
    externalSellerId: account.externalSellerId,
    marketplaceSiteId: account.marketplaceSiteId,
    status: account.status,
    channelConfig: sanitizeChannelConfig(account.channelConfig),
    tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
    authExpiresAt: account.authExpiresAt?.toISOString() ?? null,
    createdAt: account.createdAt.toISOString(),
  };
}

function toExportTicket(ticket: SupportTicketRecord): TenantExportTicket {
  return {
    id: ticket.id,
    marketplace: ticket.marketplace,
    accountId: ticket.accountId,
    ticketType: ticket.ticketType,
    status: ticket.status,
    priority: ticket.priority,
    externalReferenceId: ticket.externalReferenceId,
    externalOrderId: ticket.externalOrderId,
    subject: ticket.subject,
    hasActiveClaim: ticket.hasActiveClaim,
    slaDeadlineAt: ticket.slaDeadlineAt.toISOString(),
    slaState: ticket.slaState,
    slaBreached: ticket.slaBreached,
    firstResponseAt: ticket.firstResponseAt?.toISOString() ?? null,
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
    lastMessageAt: ticket.lastMessageAt?.toISOString() ?? null,
    unreadCount: ticket.unreadCount,
    assignedAgentId: ticket.assignedAgentId,
    tags: ticket.tags,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

function toExportMessage(message: TicketMessageRecord): TenantExportMessage {
  return {
    id: message.id,
    ticketId: message.ticketId,
    direction: message.direction,
    channelRouteUsed: message.channelRouteUsed,
    messageType: message.messageType,
    bodyCleanText: message.bodyCleanText,
    deliveryStatus: message.deliveryStatus,
    isInternalNote: message.isInternalNote,
    authorAgentId: message.authorAgentId,
    marketplaceCreatedAt: message.marketplaceCreatedAt.toISOString(),
    sentAt: message.sentAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
  };
}

function toExportEvent(event: TicketEventRecord): TenantExportEvent {
  return {
    id: event.id,
    ticketId: event.ticketId,
    eventType: event.eventType,
    actorLabel: event.actorLabel,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

/** Copy `channel_config` dropping any key that looks like a credential. */
function sanitizeChannelConfig(config: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}
