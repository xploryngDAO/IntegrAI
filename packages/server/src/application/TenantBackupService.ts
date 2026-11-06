import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

import type {
  AgentRecord,
  IClock,
  ILogger,
  IObjectStorage,
  ITenantBackupRepository,
  ITenantBackupService,
  ITenantRepository,
  ITenantRestoreRepository,
  MarketplaceAccountRecord,
  MessageAttachmentRecord,
  OrderCacheRecord,
  OutboundAttemptRecord,
  RestoreTenantCommand,
  RestoreTenantResult,
  SlaPolicyRecord,
  SupportTicketRecord,
  TenantBackupAccount,
  TenantBackupAgent,
  TenantBackupAttachment,
  TenantBackupCounts,
  TenantBackupEvent,
  TenantBackupMessage,
  TenantBackupOrder,
  TenantBackupOutboundAttempt,
  TenantBackupPayload,
  TenantBackupResult,
  TenantBackupSlaPolicy,
  TenantBackupTicket,
  TenantBackupView,
  TenantBackupWebhookEvent,
  TenantRecord,
  TicketEventRecord,
  TicketMessageRecord,
  WebhookEventRecord,
} from '@sac/shared';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  isAppError,
  isTenantPlan,
} from '@sac/shared';

import { sanitizeChannelConfig } from './tenant-secrets';

/**
 * ============================================================================
 * TenantBackupService - backup, list and restore (Fase 4)
 * ============================================================================
 *
 * `POST /platform/tenants/:id/backup`
 *   Collects EVERY row of the workspace and writes a versioned JSON artifact to
 *   `backups/<tenantSlug>/<timestamp>.json` through `IObjectStorage.putObject`.
 *   The artifact NEVER contains password hashes, TOTP secrets, encrypted
 *   marketplace tokens, sessions/invites/reset tokens, `buyer_pii_vault`, or
 *   the raw webhook payload/S3 dump. The small index row (`tenant_backups`) is
 *   written only after the object is stored.
 *
 * `GET /platform/tenants/:id/backups`
 *   Reads that index. `IObjectStorage` has no ListObjects, so the table is the
 *   single source of truth (and survives bucket listing limitations).
 *
 * `POST /platform/tenants/restore`
 *   Reads the artifact back, validates its structure, and asks the repository to
 *   create a BRAND-NEW workspace in one transaction. The source is never
 *   overwritten and credentials are never restored:
 *   - agents get a random temporary password and `mustResetPassword=true`
 *     (also `isPlatformAdmin=false`, 2FA off);
 *   - accounts are created `DISCONNECTED` with no tokens (stores must be
 *     reconnected);
 *   - every business row gets a new uuid and references are remapped.
 *
 * Error contract: 404 unknown workspace or missing S3 object; 422 malformed or
 * unsupported backup / invalid slug/name; 409 newSlug already taken.
 */

export const TENANT_BACKUP_KIND = 'tenant-backup';
export const TENANT_BACKUP_FORMAT_VERSION = '1.0';

const BCRYPT_ROUNDS = 12;
const TEMP_PASSWORD_BYTES = 24;
const MAX_SLUG_LENGTH = 80;
const MAX_NAME_LENGTH = 160;
const MAX_BACKUP_KEY_LENGTH = 512;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** Only artifacts under `backups/` can be restored (never an arbitrary key). */
const BACKUP_KEY_PATTERN = /^backups\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.json$/;

const BACKUP_NOTES: readonly string[] = [
  'Credenciais não são incluídas: password_hash, two_factor_secret_enc, códigos de recuperação, access_token_enc e refresh_token_enc ficam fora do arquivo.',
  'Sessões, convites, tokens de reset de senha e verificação de e-mail não são copiados (estado de autenticação nunca é restaurado).',
  'webhook_events é exportado apenas com metadados: payload bruto, payload_s3_uri e resource não entram no backup.',
  'buyer_pii_vault (dados restritos de marketplace) e os artefatos binários do S3 não fazem parte do backup; anexos entram apenas como metadados.',
  'O restore cria um workspace NOVO: tokens não voltam (reconecte as lojas) e cada operador recebe senha temporária aleatória com must_reset_password=true.',
];

const BACKUP_TABLES = [
  'agents',
  'accounts',
  'tickets',
  'messages',
  'attachments',
  'events',
  'outboundAttempts',
  'orders',
  'slaPolicies',
  'webhookEvents',
] as const;

export interface TenantBackupServiceDependencies {
  logger: ILogger;
  clock: IClock;
  storage: IObjectStorage;
  repos: {
    tenants: ITenantRepository;
    backups: ITenantBackupRepository;
    restore: ITenantRestoreRepository;
  };
}

export class TenantBackupService implements ITenantBackupService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly storage: IObjectStorage;
  private readonly tenants: ITenantRepository;
  private readonly backups: ITenantBackupRepository;
  private readonly restoreRepository: ITenantRestoreRepository;

  constructor(deps: TenantBackupServiceDependencies) {
    this.logger = deps.logger.child({ component: 'TenantBackupService' });
    this.clock = deps.clock;
    this.storage = deps.storage;
    this.tenants = deps.repos.tenants;
    this.backups = deps.repos.backups;
    this.restoreRepository = deps.repos.restore;
  }

  /* ==================================================================== */
  /* Backup                                                               */
  /* ==================================================================== */

  async createBackup(tenantId: string, actorId: string): Promise<TenantBackupResult> {
    const tenant = await this.tenants.findById(tenantId);
    if (tenant === null) throw new NotFoundError('Tenant', tenantId);

    const snapshot = await this.backups.snapshot(tenantId);
    const now = this.clock.now();
    const payload = buildBackupPayload(tenant, snapshot, actorId, now);
    const counts = payload.meta.counts;

    // Pretty-printed so the artifact is auditable by a human; the size is the
    // exact byte length persisted in S3.
    const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    const backupKey = buildBackupKey(tenant.slug, now);

    const stored = await this.storage.putObject({
      key: backupKey,
      body,
      contentType: 'application/json',
      metadata: {
        'tenant-id': tenant.id,
        'tenant-slug': tenant.slug,
        'backup-format': TENANT_BACKUP_FORMAT_VERSION,
        'created-by': actorId,
        counts: JSON.stringify(counts),
      },
    });

    // Index AFTER the object exists: a crash can leave an unindexed object
    // (harmless, lifecycle policy cleans it) but never a row pointing nowhere.
    await this.backups.record({
      tenantId,
      s3Key: backupKey,
      sizeBytes: stored.size > 0 ? stored.size : body.length,
      counts,
      createdBy: actorId,
      createdAt: now,
    });

    this.logger.info('tenant.backup.created', {
      tenantId,
      slug: tenant.slug,
      actorId,
      backupKey,
      sizeBytes: stored.size,
      counts,
    });

    return {
      backupKey,
      sizeBytes: stored.size > 0 ? stored.size : body.length,
      counts,
      createdAt: now.toISOString(),
    };
  }

  /* ==================================================================== */
  /* List                                                                 */
  /* ==================================================================== */

  async listBackups(tenantId: string): Promise<TenantBackupView[]> {
    const tenant = await this.tenants.findById(tenantId);
    if (tenant === null) throw new NotFoundError('Tenant', tenantId);

    const rows = await this.backups.listByTenant(tenantId);
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      backupKey: row.backupKey,
      sizeBytes: row.sizeBytes,
      counts: row.counts,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /* ==================================================================== */
  /* Restore                                                              */
  /* ==================================================================== */

  async restore(command: RestoreTenantCommand, actorId: string): Promise<RestoreTenantResult> {
    const newSlug = normalizeSlug(command.newSlug);
    const newName = normalizeName(command.newName);
    const backupKey = (command.backupKey ?? '').trim();
    validateBackupKey(backupKey);

    // Never overwrite: an existing workspace (even soft-deleted, whose slug is
    // still unique) refuses the restore with 409.
    const existing = await this.tenants.findBySlug(newSlug);
    if (existing !== null) {
      throw new ConflictError('Workspace slug is already in use', {
        code: 'TENANT_SLUG_CONFLICT',
        slug: newSlug,
      });
    }

    const bytes = await this.readBackupObject(backupKey);
    const payload = parseTenantBackup(bytes, backupKey);
    const now = this.clock.now();

    // bcrypt runs BEFORE the transaction: the restore never holds a database
    // connection while hashing. Passwords are random and never returned.
    const passwordHashes = await Promise.all(
      payload.agents.map(async () => bcrypt.hash(generateTemporaryPassword(), BCRYPT_ROUNDS)),
    );

    const result = await this.restoreRepository.restore({
      payload,
      newSlug,
      newName,
      backupKey,
      sizeBytes: bytes.length,
      createdBy: actorId,
      now,
      passwordHashes,
    });

    this.logger.info('tenant.backup.restored', {
      sourceTenantId: payload.meta.sourceTenantId,
      sourceSlug: payload.meta.sourceTenantSlug,
      newTenantId: result.tenantId,
      newSlug: result.slug,
      actorId,
      backupKey,
      counts: result.counts,
      // Tokens are not restored: the operator must reconnect every store.
      credentialsRestored: false,
    });

    return result;
  }

  /**
   * Reads the artifact, mapping a missing object to 404 (stable code
   * `STORAGE_OBJECT_NOT_FOUND` -> `NOT_FOUND`) instead of the 502 storage error.
   */
  private async readBackupObject(backupKey: string): Promise<Buffer> {
    try {
      return await this.storage.getObject(backupKey);
    } catch (error) {
      if (isAppError(error) && error.httpStatus === 404) {
        throw new NotFoundError('TenantBackup', backupKey);
      }
      throw error;
    }
  }
}

/* ====================================================================== */
/* Artifact building                                                      */
/* ====================================================================== */

/** Raw rows read by `ITenantBackupRepository.snapshot`. */
interface BackupSnapshot {
  agents: AgentRecord[];
  accounts: MarketplaceAccountRecord[];
  tickets: SupportTicketRecord[];
  messages: TicketMessageRecord[];
  attachments: MessageAttachmentRecord[];
  events: TicketEventRecord[];
  outboundAttempts: OutboundAttemptRecord[];
  orders: OrderCacheRecord[];
  slaPolicies: SlaPolicyRecord[];
  webhookEvents: WebhookEventRecord[];
}

/**
 * Builds the versioned artifact. This is the ONLY place that decides what is
 * persisted, so the "no secrets / no raw PII" contract is auditable here.
 * Exported for the unit tests (pure function).
 */
export function buildBackupPayload(
  tenant: TenantRecord,
  snapshot: BackupSnapshot,
  actorId: string,
  now: Date,
): TenantBackupPayload {
  const counts: TenantBackupCounts = {
    agents: snapshot.agents.length,
    accounts: snapshot.accounts.length,
    tickets: snapshot.tickets.length,
    messages: snapshot.messages.length,
    attachments: snapshot.attachments.length,
    events: snapshot.events.length,
    outboundAttempts: snapshot.outboundAttempts.length,
    orders: snapshot.orders.length,
    slaPolicies: snapshot.slaPolicies.length,
    webhookEvents: snapshot.webhookEvents.length,
  };

  return {
    meta: {
      kind: TENANT_BACKUP_KIND,
      formatVersion: TENANT_BACKUP_FORMAT_VERSION,
      createdAt: now.toISOString(),
      createdBy: actorId,
      sourceTenantId: tenant.id,
      sourceTenantSlug: tenant.slug,
      sourceTenantName: tenant.name,
      counts,
      notes: [...BACKUP_NOTES],
    },
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      plan: tenant.plan,
      maxAccounts: tenant.maxAccounts,
      maxAgents: tenant.maxAgents,
      billingStatus: tenant.billingStatus,
      trialEndsAt: isoOrNull(tenant.trialEndsAt),
      billingEmail: tenant.billingEmail,
      onboardingCompletedAt: isoOrNull(tenant.onboardingCompletedAt),
      createdAt: tenant.createdAt.toISOString(),
      updatedAt: tenant.updatedAt.toISOString(),
    },
    agents: snapshot.agents.map(toBackupAgent),
    accounts: snapshot.accounts.map(toBackupAccount),
    tickets: snapshot.tickets.map(toBackupTicket),
    messages: snapshot.messages.map(toBackupMessage),
    attachments: snapshot.attachments.map(toBackupAttachment),
    events: snapshot.events.map(toBackupEvent),
    outboundAttempts: snapshot.outboundAttempts.map(toBackupOutboundAttempt),
    orders: snapshot.orders.map(toBackupOrder),
    slaPolicies: snapshot.slaPolicies.map(toBackupSlaPolicy),
    webhookEvents: snapshot.webhookEvents.map(toBackupWebhookEvent),
  };
}

function toBackupAgent(agent: AgentRecord): TenantBackupAgent {
  // passwordHash and twoFactorSecretEnc are intentionally absent.
  return {
    id: agent.id,
    email: agent.email,
    name: agent.name,
    role: agent.role,
    presence: agent.presence,
    avatarColor: agent.avatarColor,
    maxConcurrent: agent.maxConcurrent,
    isActive: agent.isActive,
    lastSeenAt: isoOrNull(agent.lastSeenAt),
    emailVerifiedAt: isoOrNull(agent.emailVerifiedAt),
    twoFactorEnabled: agent.twoFactorEnabled,
    isPlatformAdmin: agent.isPlatformAdmin,
    mustResetPassword: agent.mustResetPassword,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

function toBackupAccount(account: MarketplaceAccountRecord): TenantBackupAccount {
  // accessTokenEnc / refreshTokenEnc are intentionally absent.
  return {
    id: account.id,
    marketplace: account.marketplace,
    displayName: account.displayName,
    externalSellerId: account.externalSellerId,
    marketplaceSiteId: account.marketplaceSiteId,
    status: account.status,
    channelConfig: sanitizeChannelConfig(account.channelConfig),
    tokenExpiresAt: isoOrNull(account.tokenExpiresAt),
    authExpiresAt: isoOrNull(account.authExpiresAt),
    lastTokenRefreshAt: isoOrNull(account.lastTokenRefreshAt),
    lastErrorAt: isoOrNull(account.lastErrorAt),
    lastError: account.lastError,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

function toBackupTicket(ticket: SupportTicketRecord): TenantBackupTicket {
  return {
    id: ticket.id,
    accountId: ticket.accountId,
    marketplace: ticket.marketplace,
    ticketType: ticket.ticketType,
    externalReferenceId: ticket.externalReferenceId,
    externalOrderId: ticket.externalOrderId,
    orderCacheId: ticket.orderCacheId,
    packId: ticket.packId,
    claimId: ticket.claimId,
    conversationId: ticket.conversationId,
    returnSn: ticket.returnSn,
    subject: ticket.subject,
    buyerExternalId: ticket.buyerExternalId,
    buyerDisplayName: ticket.buyerDisplayName,
    buyerAnonymizedEmail: ticket.buyerAnonymizedEmail,
    buyerContactHash: ticket.buyerContactHash,
    hasActiveClaim: ticket.hasActiveClaim,
    status: ticket.status,
    priority: ticket.priority,
    slaDeadlineAt: ticket.slaDeadlineAt.toISOString(),
    slaTargetAt: isoOrNull(ticket.slaTargetAt),
    slaLegMinutes: ticket.slaLegMinutes,
    slaBreached: ticket.slaBreached,
    slaState: ticket.slaState,
    firstResponseAt: isoOrNull(ticket.firstResponseAt),
    resolvedAt: isoOrNull(ticket.resolvedAt),
    lastInboundAt: isoOrNull(ticket.lastInboundAt),
    lastOutboundAt: isoOrNull(ticket.lastOutboundAt),
    lastMessageAt: isoOrNull(ticket.lastMessageAt),
    unreadCount: ticket.unreadCount,
    assignedAgentId: ticket.assignedAgentId,
    assignedQueue: ticket.assignedQueue,
    channelMetadata: ticket.channelMetadata,
    tags: [...ticket.tags],
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

function toBackupMessage(message: TicketMessageRecord): TenantBackupMessage {
  return {
    id: message.id,
    ticketId: message.ticketId,
    externalMessageId: message.externalMessageId,
    inReplyToId: message.inReplyToId,
    referencesIds: [...message.referencesIds],
    direction: message.direction,
    channelRouteUsed: message.channelRouteUsed,
    messageType: message.messageType,
    bodyCleanText: message.bodyCleanText,
    bodyHtml: message.bodyHtml,
    contentPayload: message.contentPayload,
    bodyRawS3Uri: message.bodyRawS3Uri,
    deliveryStatus: message.deliveryStatus,
    errorDetail: message.errorDetail,
    isInternalNote: message.isInternalNote,
    authorAgentId: message.authorAgentId,
    marketplaceCreatedAt: message.marketplaceCreatedAt.toISOString(),
    sentAt: isoOrNull(message.sentAt),
    deliveredAt: isoOrNull(message.deliveredAt),
    readAt: isoOrNull(message.readAt),
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}

function toBackupAttachment(attachment: MessageAttachmentRecord): TenantBackupAttachment {
  return {
    id: attachment.id,
    messageId: attachment.messageId,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    s3Uri: attachment.s3Uri,
    externalUploadId: attachment.externalUploadId,
    isEvidence: attachment.isEvidence,
    createdAt: attachment.createdAt.toISOString(),
  };
}

function toBackupEvent(event: TicketEventRecord): TenantBackupEvent {
  return {
    id: event.id,
    ticketId: event.ticketId,
    eventType: event.eventType,
    actorAgentId: event.actorAgentId,
    actorLabel: event.actorLabel,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

function toBackupOutboundAttempt(attempt: OutboundAttemptRecord): TenantBackupOutboundAttempt {
  return {
    id: attempt.id,
    ticketId: attempt.ticketId,
    messageId: attempt.messageId,
    channelRoute: attempt.channelRoute,
    status: attempt.status,
    requestPayload: attempt.requestPayload,
    responsePayload: attempt.responsePayload,
    httpStatus: attempt.httpStatus,
    attempt: attempt.attempt,
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
    durationMs: attempt.durationMs,
    createdAt: attempt.createdAt.toISOString(),
  };
}

function toBackupOrder(order: OrderCacheRecord): TenantBackupOrder {
  return {
    id: order.id,
    accountId: order.accountId,
    marketplace: order.marketplace,
    externalOrderId: order.externalOrderId,
    packId: order.packId,
    buyerExternalId: order.buyerExternalId,
    buyerNameOrNick: order.buyerNameOrNick,
    buyerAnonymizedEmail: order.buyerAnonymizedEmail,
    orderStatus: order.orderStatus,
    fulfillmentType: order.fulfillmentType,
    totalAmount: order.totalAmount,
    currency: order.currency,
    trackingNumber: order.trackingNumber,
    carrierName: order.carrierName,
    itemsSnapshot: order.itemsSnapshot,
    allowedActionsCache: order.allowedActionsCache,
    shippingSnapshot: order.shippingSnapshot,
    estimatedDeliveryAt: isoOrNull(order.estimatedDeliveryAt),
    shippedAt: isoOrNull(order.shippedAt),
    deliveredAt: isoOrNull(order.deliveredAt),
    lastSyncedAt: order.lastSyncedAt.toISOString(),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

function toBackupSlaPolicy(policy: SlaPolicyRecord): TenantBackupSlaPolicy {
  return {
    id: policy.id,
    accountId: policy.accountId,
    marketplace: policy.marketplace,
    ticketType: policy.ticketType,
    firstResponseMinutes: policy.firstResponseMinutes,
    targetMinutes: policy.targetMinutes,
    warningMinutes: policy.warningMinutes,
    businessHoursOnly: policy.businessHoursOnly,
    isActive: policy.isActive,
  };
}

function toBackupWebhookEvent(event: WebhookEventRecord): TenantBackupWebhookEvent {
  // Raw payload, resource and S3 pointer are intentionally absent.
  return {
    id: event.id,
    marketplace: event.marketplace,
    accountId: event.accountId,
    eventId: event.eventId,
    topic: event.topic,
    status: event.status,
    signatureValid: event.signatureValid,
    attempts: event.attempts,
    receivedAt: event.receivedAt.toISOString(),
    processedAt: isoOrNull(event.processedAt),
  };
}

/* ====================================================================== */
/* Parsing / validation                                                   */
/* ====================================================================== */

/**
 * Validates the artifact enough that the transactional restore can trust its
 * shape. A malformed JSON, a foreign `kind`, an unsupported version, a missing
 * array or a row without an id is a 422 (never a 500).
 */
export function parseTenantBackup(bytes: Buffer, backupKey: string): TenantBackupPayload {
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ValidationError('Backup object is not valid JSON', { backupKey });
  }

  if (!isRecord(decoded)) {
    throw new ValidationError('Backup object must be a JSON object', { backupKey });
  }

  const meta = decoded.meta;
  if (!isRecord(meta) || meta.kind !== TENANT_BACKUP_KIND) {
    throw new ValidationError('Backup object is not a tenant backup', { backupKey });
  }
  if (meta.formatVersion !== TENANT_BACKUP_FORMAT_VERSION) {
    throw new ValidationError('Unsupported tenant backup format version', {
      backupKey,
      formatVersion: meta.formatVersion,
      supported: TENANT_BACKUP_FORMAT_VERSION,
    });
  }

  const tenant = decoded.tenant;
  if (!isRecord(tenant)) {
    throw new ValidationError('Backup is missing the tenant settings', {
      backupKey,
      field: 'tenant',
    });
  }
  if (typeof tenant.slug !== 'string' || typeof tenant.name !== 'string') {
    throw new ValidationError('Backup tenant settings are incomplete', {
      backupKey,
      field: 'tenant.slug/name',
    });
  }
  if (!isTenantPlan(tenant.plan)) {
    throw new ValidationError('Backup tenant plan is invalid', {
      backupKey,
      field: 'tenant.plan',
    });
  }
  if (!isPositiveInt(tenant.maxAccounts) || !isPositiveInt(tenant.maxAgents)) {
    throw new ValidationError('Backup tenant quotas are invalid', {
      backupKey,
      field: 'tenant.maxAccounts/maxAgents',
    });
  }

  for (const table of BACKUP_TABLES) {
    const rows = decoded[table];
    if (!Array.isArray(rows)) {
      throw new ValidationError('Backup is missing a required table', {
        backupKey,
        table,
      });
    }
    const invalidIndex = rows.findIndex(
      (row) => !isRecord(row) || typeof row.id !== 'string' || row.id.length === 0,
    );
    if (invalidIndex >= 0) {
      throw new ValidationError('Backup contains an invalid row', {
        backupKey,
        table,
        index: invalidIndex,
      });
    }
  }

  return decoded as unknown as TenantBackupPayload;
}

function normalizeSlug(value: string): string {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    slug.length === 0 ||
    slug.length > MAX_SLUG_LENGTH ||
    !SLUG_PATTERN.test(slug)
  ) {
    throw new ValidationError('newSlug must be a URL-safe slug (1..80 chars)', {
      field: 'newSlug',
    });
  }
  return slug;
}

function normalizeName(value: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new ValidationError('newName must have 1..160 characters', { field: 'newName' });
  }
  return name;
}

function validateBackupKey(value: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_BACKUP_KEY_LENGTH ||
    !BACKUP_KEY_PATTERN.test(value)
  ) {
    throw new ValidationError('backupKey must point to backups/<tenant>/<timestamp>.json', {
      field: 'backupKey',
    });
  }
}

/* ====================================================================== */
/* Helpers                                                                */
/* ====================================================================== */

/** `backups/<tenantSlug>/2026-11-05T12-00-00-000Z.json` (filesystem safe). */
export function buildBackupKey(slug: string, at: Date): string {
  const timestamp = at.toISOString().replace(/[:.]/g, '-');
  return `backups/${slug}/${timestamp}.json`;
}

function generateTemporaryPassword(): string {
  return randomBytes(TEMP_PASSWORD_BYTES).toString('base64url');
}

function isoOrNull(date: Date | null | undefined): string | null {
  return date === null || date === undefined ? null : date.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
