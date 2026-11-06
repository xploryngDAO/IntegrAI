import type {
  Agent,
  BuyerPiiVault,
  EmailVerification,
  Invitation,
  MarketplaceAccount,
  MessageAttachment,
  OrderCache,
  OutboundAttempt,
  PasswordReset,
  Prisma,
  Session,
  SlaPolicy,
  SupportTicket,
  Tenant,
  TenantBackup,
  TicketEvent,
  TicketMessage,
  WebhookEvent,
} from '@prisma/client';
import type {
  AgentRecord,
  BuyerPiiRecord,
  EmailVerificationRecord,
  InvitationRecord,
  Marketplace,
  MarketplaceAccountRecord,
  MessageAttachmentRecord,
  OrderCacheRecord,
  OrderItemSnapshot,
  OutboundAttemptRecord,
  PasswordResetRecord,
  SessionRecord,
  SlaPolicyRecord,
  SupportTicketRecord,
  TenantBackupCounts,
  TenantBackupRecord,
  TenantRecord,
  TicketEventRecord,
  TicketMessageRecord,
  WebhookEventRecord,
} from '@sac/shared';

/**
 * Prisma row -> `@sac/shared` DTO mappers.
 *
 * Rules: `Decimal` becomes `number`, `Json` becomes a plain object/array with
 * null guards, dates stay `Date` (the HTTP layer serializes to ISO). No mapper
 * performs I/O and none of them includes relations, so the projections stay
 * predictable.
 */

/** Json column -> plain object (`{}` for null/array/scalar values). */
export function toJsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Json column -> typed array (`[]` for null/non-array values). */
export function toJsonArray<T>(value: Prisma.JsonValue | null | undefined): T[] {
  if (!Array.isArray(value)) return [];
  return value as unknown as T[];
}

/** Plain object -> Prisma JSON input. */
export function toInputJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/** Arbitrary JSON-safe array -> Prisma JSON input. */
export function toInputJsonArray(value: unknown[]): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function toNumber(value: Prisma.Decimal | number | string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return value.toNumber();
}

export function mapAccount(record: MarketplaceAccount): MarketplaceAccountRecord {
  return {
    id: record.id,
    tenantId: record.tenantId,
    marketplace: record.marketplace as Marketplace,
    displayName: record.displayName,
    externalSellerId: record.externalSellerId,
    marketplaceSiteId: record.marketplaceSiteId,
    accessTokenEnc: record.accessTokenEnc,
    refreshTokenEnc: record.refreshTokenEnc,
    tokenExpiresAt: record.tokenExpiresAt,
    authExpiresAt: record.authExpiresAt,
    channelConfig: toJsonObject(record.channelConfig),
    status: record.status,
    lastTokenRefreshAt: record.lastTokenRefreshAt,
    lastErrorAt: record.lastErrorAt,
    lastError: record.lastError,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function mapOrder(record: OrderCache): OrderCacheRecord {
  return {
    id: record.id,
    accountId: record.accountId,
    marketplace: record.marketplace as Marketplace,
    externalOrderId: record.externalOrderId,
    packId: record.packId,
    buyerExternalId: record.buyerExternalId,
    buyerNameOrNick: record.buyerNameOrNick,
    buyerAnonymizedEmail: record.buyerAnonymizedEmail,
    orderStatus: record.orderStatus,
    fulfillmentType: record.fulfillmentType,
    totalAmount: toNumber(record.totalAmount),
    currency: record.currency,
    trackingNumber: record.trackingNumber,
    carrierName: record.carrierName,
    itemsSnapshot: toJsonArray<OrderItemSnapshot>(record.itemsSnapshot),
    allowedActionsCache: toJsonObject(record.allowedActionsCache),
    shippingSnapshot: toJsonObject(record.shippingSnapshot),
    estimatedDeliveryAt: record.estimatedDeliveryAt,
    shippedAt: record.shippedAt,
    deliveredAt: record.deliveredAt,
    lastSyncedAt: record.lastSyncedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function mapTicket(record: SupportTicket): SupportTicketRecord {
  return {
    id: record.id,
    tenantId: record.tenantId,
    accountId: record.accountId,
    marketplace: record.marketplace as Marketplace,
    ticketType: record.ticketType,
    externalReferenceId: record.externalReferenceId,
    externalOrderId: record.externalOrderId,
    orderCacheId: record.orderCacheId,
    packId: record.packId,
    claimId: record.claimId,
    conversationId: record.conversationId,
    returnSn: record.returnSn,
    subject: record.subject,
    buyerExternalId: record.buyerExternalId,
    buyerDisplayName: record.buyerDisplayName,
    buyerAnonymizedEmail: record.buyerAnonymizedEmail,
    buyerContactHash: record.buyerContactHash,
    hasActiveClaim: record.hasActiveClaim,
    status: record.status,
    priority: record.priority,
    slaDeadlineAt: record.slaDeadlineAt,
    slaTargetAt: record.slaTargetAt,
    slaLegMinutes: record.slaLegMinutes,
    slaBreached: record.slaBreached,
    slaState: record.slaState,
    firstResponseAt: record.firstResponseAt,
    resolvedAt: record.resolvedAt,
    lastInboundAt: record.lastInboundAt,
    lastOutboundAt: record.lastOutboundAt,
    lastMessageAt: record.lastMessageAt,
    unreadCount: record.unreadCount,
    assignedAgentId: record.assignedAgentId,
    assignedQueue: record.assignedQueue,
    channelMetadata: toJsonObject(record.channelMetadata),
    tags: record.tags,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function mapMessage(record: TicketMessage): TicketMessageRecord {
  return {
    id: record.id,
    ticketId: record.ticketId,
    externalMessageId: record.externalMessageId,
    inReplyToId: record.inReplyToId,
    referencesIds: record.referencesIds,
    direction: record.direction,
    channelRouteUsed: record.channelRouteUsed,
    messageType: record.messageType,
    bodyCleanText: record.bodyCleanText,
    bodyHtml: record.bodyHtml,
    contentPayload: toJsonObject(record.contentPayload),
    bodyRawS3Uri: record.bodyRawS3Uri,
    deliveryStatus: record.deliveryStatus,
    errorDetail: record.errorDetail,
    isInternalNote: record.isInternalNote,
    authorAgentId: record.authorAgentId,
    marketplaceCreatedAt: record.marketplaceCreatedAt,
    sentAt: record.sentAt,
    deliveredAt: record.deliveredAt,
    readAt: record.readAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function mapAttachment(record: MessageAttachment): MessageAttachmentRecord {
  return {
    id: record.id,
    messageId: record.messageId,
    fileName: record.fileName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    s3Uri: record.s3Uri,
    externalUploadId: record.externalUploadId,
    isEvidence: record.isEvidence,
    createdAt: record.createdAt,
  };
}

export function mapWebhookEvent(record: WebhookEvent): WebhookEventRecord {
  return {
    id: record.id,
    marketplace: record.marketplace as Marketplace,
    accountId: record.accountId,
    eventId: record.eventId,
    topic: record.topic,
    resource: record.resource,
    status: record.status,
    signatureValid: record.signatureValid,
    payload: toJsonObject(record.payload),
    payloadS3Uri: record.payloadS3Uri,
    attempts: record.attempts,
    error: record.error,
    receivedAt: record.receivedAt,
    processedAt: record.processedAt,
  };
}

export function mapPii(record: BuyerPiiVault): BuyerPiiRecord {
  return {
    id: record.id,
    ticketId: record.ticketId,
    marketplace: record.marketplace as Marketplace,
    buyerName: record.buyerName,
    buyerEmail: record.buyerEmail,
    buyerDocument: record.buyerDocument,
    buyerPhone: record.buyerPhone,
    shippingAddress: toJsonObject(record.shippingAddress),
    sourceEndpoints: record.sourceEndpoints,
    collectedAt: record.collectedAt,
    expiresAt: record.expiresAt,
    purgedAt: record.purgedAt,
  };
}

export function mapTicketEvent(record: TicketEvent): TicketEventRecord {
  return {
    id: record.id,
    ticketId: record.ticketId,
    eventType: record.eventType,
    actorAgentId: record.actorAgentId,
    actorLabel: record.actorLabel,
    payload: toJsonObject(record.payload),
    createdAt: record.createdAt,
  };
}

export function mapOutboundAttempt(record: OutboundAttempt): OutboundAttemptRecord {
  return {
    id: record.id,
    ticketId: record.ticketId,
    messageId: record.messageId,
    channelRoute: record.channelRoute,
    status: record.status,
    requestPayload: toJsonObject(record.requestPayload),
    responsePayload: toJsonObject(record.responsePayload),
    httpStatus: record.httpStatus,
    attempt: record.attempt,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    durationMs: record.durationMs,
    createdAt: record.createdAt,
  };
}

export function mapAgent(record: Agent): AgentRecord {
  return {
    id: record.id,
    tenantId: record.tenantId,
    email: record.email,
    name: record.name,
    passwordHash: record.passwordHash,
    role: record.role,
    presence: record.presence,
    avatarColor: record.avatarColor,
    maxConcurrent: record.maxConcurrent,
    isActive: record.isActive,
    lastSeenAt: record.lastSeenAt,
    emailVerifiedAt: record.emailVerifiedAt,
    twoFactorSecretEnc: record.twoFactorSecretEnc,
    twoFactorEnabled: record.twoFactorEnabled,
    isPlatformAdmin: record.isPlatformAdmin,
    mustResetPassword: record.mustResetPassword,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}


export function mapTenant(record: Tenant): TenantRecord {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    status: record.status,
    plan: record.plan,
    maxAccounts: record.maxAccounts,
    maxAgents: record.maxAgents,
    billingStatus: record.billingStatus,
    trialEndsAt: record.trialEndsAt,
    billingEmail: record.billingEmail,
    onboardingCompletedAt: record.onboardingCompletedAt,
    deletedAt: record.deletedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Default counts, used when a row was written by an older format. */
export function emptyBackupCounts(): TenantBackupCounts {
  return {
    agents: 0,
    accounts: 0,
    tickets: 0,
    messages: 0,
    attachments: 0,
    events: 0,
    outboundAttempts: 0,
    orders: 0,
    slaPolicies: 0,
    webhookEvents: 0,
  };
}

/**
 * Normalizes the `counts` JSONB column. Unknown/negative values become 0 so a
 * hand-edited row can never produce `NaN` in the console.
 */
export function normalizeBackupCounts(value: unknown): TenantBackupCounts {
  const counts = emptyBackupCounts();
  const source = toJsonObject(value as Prisma.JsonValue | null | undefined);
  for (const key of Object.keys(counts) as Array<keyof TenantBackupCounts>) {
    const raw = source[key];
    counts[key] = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 0;
  }
  return counts;
}

export function mapTenantBackupRecord(record: TenantBackup): TenantBackupRecord {
  return {
    id: record.id,
    tenantId: record.tenantId,
    backupKey: record.s3Key,
    sizeBytes: record.sizeBytes,
    counts: normalizeBackupCounts(record.counts),
    createdBy: record.createdBy,
    createdAt: record.createdAt,
  };
}

export function mapEmailVerification(record: EmailVerification): EmailVerificationRecord {
  return {
    id: record.id,
    userId: record.userId,
    tokenHash: record.tokenHash,
    expiresAt: record.expiresAt,
    usedAt: record.usedAt,
    createdAt: record.createdAt,
  };
}

export function mapPasswordReset(record: PasswordReset): PasswordResetRecord {
  return {
    id: record.id,
    userId: record.userId,
    tokenHash: record.tokenHash,
    expiresAt: record.expiresAt,
    usedAt: record.usedAt,
    createdAt: record.createdAt,
  };
}

export function mapInvitation(record: Invitation): InvitationRecord {
  return {
    id: record.id,
    tenantId: record.tenantId,
    email: record.email,
    role: record.role,
    tokenHash: record.tokenHash,
    invitedBy: record.invitedBy,
    expiresAt: record.expiresAt,
    acceptedAt: record.acceptedAt,
    createdAt: record.createdAt,
  };
}

export function mapSession(record: Session): SessionRecord {
  return {
    id: record.id,
    userId: record.userId,
    tenantId: record.tenantId,
    refreshTokenHash: record.refreshTokenHash,
    userAgent: record.userAgent,
    ip: record.ip,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    createdAt: record.createdAt,
  };
}

export function mapSlaPolicy(record: SlaPolicy): SlaPolicyRecord {
  return {
    id: record.id,
    accountId: record.accountId,
    marketplace: record.marketplace as Marketplace,
    ticketType: record.ticketType,
    firstResponseMinutes: record.firstResponseMinutes,
    targetMinutes: record.targetMinutes,
    warningMinutes: record.warningMinutes,
    businessHoursOnly: record.businessHoursOnly,
    isActive: record.isActive,
  };
}
