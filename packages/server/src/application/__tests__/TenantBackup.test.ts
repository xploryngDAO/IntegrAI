import { describe, expect, it } from 'vitest';

import type {
  AgentRecord,
  IObjectStorage,
  ITenantBackupRepository,
  ITenantRestoreRepository,
  MarketplaceAccountRecord,
  MessageAttachmentRecord,
  OrderCacheRecord,
  OutboundAttemptRecord,
  PutObjectInput,
  RecordTenantBackupInput,
  RestoreTenantInput,
  RestoreTenantOutcome,
  SlaPolicyRecord,
  SupportTicketRecord,
  TenantBackupRecord,
  TenantBackupSnapshot,
  TenantRecord,
  TicketEventRecord,
  TicketMessageRecord,
  WebhookEventRecord,
} from '@sac/shared';
import { AppError } from '@sac/shared';

import {
  TenantBackupService,
  buildBackupKey,
  buildBackupPayload,
  parseTenantBackup,
} from '../TenantBackupService';
import { FrozenClock, silentLogger } from './accountFakes';
import { InMemoryTenantRepository, makeAgent, makeTenant } from './platformFakes';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const TENANT_ID = 'tenant-1';
const ACTOR_ID = 'platform-admin';

/* ====================================================================== */
/* Fakes                                                                  */
/* ====================================================================== */

class FakeStorage implements IObjectStorage {
  readonly objects = new Map<string, Buffer>();
  readonly putCalls: PutObjectInput[] = [];

  async putObject(input: PutObjectInput) {
    const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;
    this.objects.set(input.key, body);
    this.putCalls.push(input);
    return {
      key: input.key,
      uri: `s3://sac-hub-raw/${input.key}`,
      size: body.length,
      sha256: 'fake-sha256',
    };
  }

  async getObject(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (value === undefined) {
      throw new AppError('STORAGE_OBJECT_NOT_FOUND', `Object ${key} not found`, 404);
    }
    return value;
  }

  async putToPresignedUrl(): Promise<void> {}

  async presignGet(): Promise<string> {
    return 'https://example.test/presigned';
  }

  buildUri(key: string): string {
    return `s3://sac-hub-raw/${key}`;
  }

  async deleteObject(): Promise<void> {}

  async deleteObjects(): Promise<{ deleted: number; failed: number }> {
    return { deleted: 0, failed: 0 };
  }
}

class FakeBackupRepository implements ITenantBackupRepository {
  snapshotResult: TenantBackupSnapshot = emptySnapshot();
  readonly records: TenantBackupRecord[] = [];
  readonly snapshotCalls: string[] = [];

  async snapshot(tenantId: string): Promise<TenantBackupSnapshot> {
    this.snapshotCalls.push(tenantId);
    return this.snapshotResult;
  }

  async record(input: RecordTenantBackupInput): Promise<TenantBackupRecord> {
    const row: TenantBackupRecord = {
      id: `backup-${this.records.length + 1}`,
      tenantId: input.tenantId,
      backupKey: input.s3Key,
      sizeBytes: input.sizeBytes,
      counts: input.counts,
      createdBy: input.createdBy,
      createdAt: input.createdAt,
    };
    this.records.push(row);
    return row;
  }

  async listByTenant(tenantId: string): Promise<TenantBackupRecord[]> {
    return this.records.filter((row) => row.tenantId === tenantId);
  }
}

class FakeRestoreRepository implements ITenantRestoreRepository {
  readonly calls: RestoreTenantInput[] = [];
  result: RestoreTenantOutcome = {
    tenantId: 'new-tenant',
    slug: 'acme-restored',
    counts: countsFor(emptySnapshot()),
  };
  error: Error | null = null;

  async restore(input: RestoreTenantInput): Promise<RestoreTenantOutcome> {
    this.calls.push(input);
    if (this.error !== null) throw this.error;
    return {
      ...this.result,
      counts: countsFor(input.payload as unknown as TenantBackupSnapshot),
    };
  }
}

function createHarness(tenantOverrides: Partial<TenantRecord> = {}) {
  const clock = new FrozenClock(NOW);
  const tenants = new InMemoryTenantRepository(() => clock.now());
  const tenant = tenants.seed(
    makeTenant({ id: TENANT_ID, slug: 'acme', name: 'Acme', plan: 'PRO', ...tenantOverrides }),
  );
  const backups = new FakeBackupRepository();
  const storage = new FakeStorage();
  const restore = new FakeRestoreRepository();
  const service = new TenantBackupService({
    logger: silentLogger,
    clock,
    storage,
    repos: { tenants, backups, restore },
  });
  return { clock, tenants, tenant, backups, storage, restore, service };
}

/* ====================================================================== */
/* Fixtures                                                               */
/* ====================================================================== */

function emptySnapshot(): TenantBackupSnapshot {
  return {
    agents: [],
    accounts: [],
    tickets: [],
    messages: [],
    attachments: [],
    events: [],
    outboundAttempts: [],
    orders: [],
    slaPolicies: [],
    webhookEvents: [],
  };
}

function countsFor(snapshot: TenantBackupSnapshot) {
  return {
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
}

function makeAccount(overrides: Partial<MarketplaceAccountRecord> = {}): MarketplaceAccountRecord {
  return {
    id: 'account-1',
    tenantId: TENANT_ID,
    marketplace: 'MERCADO_LIVRE',
    displayName: 'Loja Meli',
    externalSellerId: '123456',
    marketplaceSiteId: 'MLB',
    accessTokenEnc: 'ACCESS_TOKEN_SHOULD_NOT_LEAK',
    refreshTokenEnc: 'REFRESH_TOKEN_SHOULD_NOT_LEAK',
    tokenExpiresAt: new Date('2026-11-06T12:00:00.000Z'),
    authExpiresAt: null,
    channelConfig: {
      site_id: 'MLB',
      smtp_sender_email: 'loja@acme.test',
      api_key: 'API_KEY_SHOULD_NOT_LEAK',
    },
    status: 'ACTIVE',
    lastTokenRefreshAt: null,
    lastErrorAt: null,
    lastError: null,
    createdAt: new Date('2026-11-01T12:00:00.000Z'),
    updatedAt: new Date('2026-11-01T12:00:00.000Z'),
    ...overrides,
  };
}

function makeTicket(overrides: Partial<SupportTicketRecord> = {}): SupportTicketRecord {
  return {
    id: 'ticket-1',
    tenantId: TENANT_ID,
    accountId: 'account-1',
    marketplace: 'MERCADO_LIVRE',
    ticketType: 'PRE_SALE',
    externalReferenceId: 'question-1',
    externalOrderId: 'order-1',
    orderCacheId: 'order-row-1',
    packId: null,
    claimId: null,
    conversationId: null,
    returnSn: null,
    subject: 'Dúvida',
    buyerExternalId: 'buyer-1',
    buyerDisplayName: 'Comprador Teste',
    buyerAnonymizedEmail: 'buyer@marketplace.test',
    buyerContactHash: 'buyer-hash',
    hasActiveClaim: false,
    status: 'OPEN_WAITING_AGENT',
    priority: 'MEDIUM',
    slaDeadlineAt: new Date('2026-11-05T18:00:00.000Z'),
    slaTargetAt: null,
    slaLegMinutes: null,
    slaBreached: false,
    slaState: 'ON_TRACK',
    firstResponseAt: null,
    resolvedAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastMessageAt: null,
    unreadCount: 1,
    assignedAgentId: 'agent-1',
    assignedQueue: null,
    channelMetadata: { foo: 'bar' },
    tags: ['pre-venda'],
    createdAt: new Date('2026-11-05T09:00:00.000Z'),
    updatedAt: new Date('2026-11-05T09:00:00.000Z'),
    ...overrides,
  };
}

function makeMessage(overrides: Partial<TicketMessageRecord> = {}): TicketMessageRecord {
  return {
    id: 'message-1',
    ticketId: 'ticket-1',
    externalMessageId: 'ext-1',
    inReplyToId: null,
    referencesIds: [],
    direction: 'INBOUND_BUYER',
    channelRouteUsed: 'MELI_QUESTIONS_API',
    messageType: 'text',
    bodyCleanText: 'Olá',
    bodyHtml: '<p>Olá</p>',
    contentPayload: { foo: 'bar' },
    bodyRawS3Uri: 's3://raw/messages/1.eml',
    deliveryStatus: 'DELIVERED',
    errorDetail: null,
    isInternalNote: false,
    authorAgentId: 'agent-1',
    marketplaceCreatedAt: new Date('2026-11-05T09:00:00.000Z'),
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    createdAt: new Date('2026-11-05T09:00:00.000Z'),
    updatedAt: new Date('2026-11-05T09:00:00.000Z'),
    ...overrides,
  };
}

function makeAttachment(overrides: Partial<MessageAttachmentRecord> = {}): MessageAttachmentRecord {
  return {
    id: 'attachment-1',
    messageId: 'message-1',
    fileName: 'nota.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1234,
    sha256: 'abc',
    s3Uri: 's3://attachments/attachments/nota.pdf',
    externalUploadId: null,
    isEvidence: true,
    createdAt: new Date('2026-11-05T09:00:00.000Z'),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<TicketEventRecord> = {}): TicketEventRecord {
  return {
    id: 'event-1',
    ticketId: 'ticket-1',
    eventType: 'TICKET_CREATED',
    actorAgentId: 'agent-1',
    actorLabel: 'Ana',
    payload: { source: 'webhook' },
    createdAt: new Date('2026-11-05T09:00:00.000Z'),
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<OutboundAttemptRecord> = {}): OutboundAttemptRecord {
  return {
    id: 'attempt-1',
    ticketId: 'ticket-1',
    messageId: 'message-1',
    channelRoute: 'MELI_QUESTIONS_API',
    status: 'SENT',
    requestPayload: { text: 'resposta' },
    responsePayload: { id: 'resp-1' },
    httpStatus: 200,
    attempt: 1,
    errorCode: null,
    errorMessage: null,
    durationMs: 42,
    createdAt: new Date('2026-11-05T09:00:00.000Z'),
    ...overrides,
  };
}

function makeOrder(overrides: Partial<OrderCacheRecord> = {}): OrderCacheRecord {
  return {
    id: 'order-row-1',
    accountId: 'account-1',
    marketplace: 'MERCADO_LIVRE',
    externalOrderId: 'order-1',
    packId: null,
    buyerExternalId: 'buyer-1',
    buyerNameOrNick: 'Comprador Teste',
    buyerAnonymizedEmail: 'buyer@marketplace.test',
    orderStatus: 'PAID',
    fulfillmentType: 'FULFILLMENT',
    totalAmount: 99.9,
    currency: 'BRL',
    trackingNumber: null,
    carrierName: null,
    itemsSnapshot: [
      { title: 'Produto', quantity: 1, unitPrice: 99.9, sku: 'SKU-1' },
    ],
    allowedActionsCache: { can_refund: true },
    shippingSnapshot: { mode: 'me2' },
    estimatedDeliveryAt: null,
    shippedAt: null,
    deliveredAt: null,
    lastSyncedAt: new Date('2026-11-05T09:00:00.000Z'),
    createdAt: new Date('2026-11-05T09:00:00.000Z'),
    updatedAt: new Date('2026-11-05T09:00:00.000Z'),
    ...overrides,
  };
}

function makePolicy(overrides: Partial<SlaPolicyRecord> = {}): SlaPolicyRecord {
  return {
    id: 'policy-1',
    accountId: 'account-1',
    marketplace: 'MERCADO_LIVRE',
    ticketType: 'PRE_SALE',
    firstResponseMinutes: 60,
    targetMinutes: 120,
    warningMinutes: 30,
    businessHoursOnly: false,
    isActive: true,
    ...overrides,
  };
}

function makeWebhookEvent(overrides: Partial<WebhookEventRecord> = {}): WebhookEventRecord {
  return {
    id: 'webhook-1',
    marketplace: 'MERCADO_LIVRE',
    accountId: 'account-1',
    eventId: 'event-ext-1',
    topic: 'questions',
    resource: 'RESOURCE_SHOULD_NOT_LEAK',
    status: 'PROCESSED',
    signatureValid: true,
    payload: { raw: 'WEBHOOK_RAW_SHOULD_NOT_LEAK' },
    payloadS3Uri: 's3://raw/WEBHOOK_PAYLOAD_SHOULD_NOT_LEAK.json',
    attempts: 1,
    error: 'ERROR_SHOULD_NOT_LEAK',
    receivedAt: new Date('2026-11-05T09:00:00.000Z'),
    processedAt: new Date('2026-11-05T09:01:00.000Z'),
    ...overrides,
  };
}

function makeAgentFixture(): AgentRecord {
  return makeAgent({
    id: 'agent-1',
    tenantId: TENANT_ID,
    email: 'ana@acme.test',
    passwordHash: 'PASSWORD_HASH_SHOULD_NOT_LEAK',
    twoFactorSecretEnc: 'TOTP_SECRET_SHOULD_NOT_LEAK',
    twoFactorEnabled: true,
  });
}

function fullSnapshot(): TenantBackupSnapshot {
  return {
    agents: [makeAgentFixture()],
    accounts: [makeAccount()],
    tickets: [makeTicket()],
    messages: [makeMessage()],
    attachments: [makeAttachment()],
    events: [makeEvent()],
    outboundAttempts: [makeAttempt()],
    orders: [makeOrder()],
    slaPolicies: [makePolicy()],
    webhookEvents: [makeWebhookEvent()],
  };
}

/* ====================================================================== */
/* Backup                                                                 */
/* ====================================================================== */

describe('TenantBackupService.createBackup', () => {
  it('writes the artifact under backups/<slug>/<timestamp>.json and indexes it', async () => {
    const h = createHarness();
    h.backups.snapshotResult = fullSnapshot();

    const result = await h.service.createBackup(TENANT_ID, ACTOR_ID);

    expect(h.backups.snapshotCalls).toEqual([TENANT_ID]);
    expect(result.backupKey).toBe('backups/acme/2026-11-05T12-00-00-000Z.json');
    expect(result.createdAt).toBe(NOW.toISOString());
    expect(result.counts).toEqual(countsFor(fullSnapshot()));
    expect(result.sizeBytes).toBeGreaterThan(0);

    expect(h.storage.putCalls).toHaveLength(1);
    const put = h.storage.putCalls[0];
    expect(put.key).toBe(result.backupKey);
    expect(put.contentType).toBe('application/json');
    expect(put.metadata).toMatchObject({
      'tenant-id': TENANT_ID,
      'tenant-slug': 'acme',
      'backup-format': '1.0',
      'created-by': ACTOR_ID,
    });

    expect(h.backups.records).toHaveLength(1);
    expect(h.backups.records[0]).toMatchObject({
      tenantId: TENANT_ID,
      backupKey: result.backupKey,
      sizeBytes: result.sizeBytes,
      createdBy: ACTOR_ID,
      counts: result.counts,
    });

    const stored = JSON.parse((await h.storage.getObject(result.backupKey)).toString('utf8'));
    expect(stored.meta).toMatchObject({
      kind: 'tenant-backup',
      formatVersion: '1.0',
      sourceTenantId: TENANT_ID,
      sourceTenantSlug: 'acme',
      counts: result.counts,
    });
    expect(stored.tenant).toMatchObject({ slug: 'acme', plan: 'PRO' });
    expect(stored.agents).toHaveLength(1);
    expect(stored.accounts).toHaveLength(1);
    expect(stored.tickets).toHaveLength(1);
    expect(stored.messages).toHaveLength(1);
    expect(stored.attachments).toHaveLength(1);
    expect(stored.events).toHaveLength(1);
    expect(stored.outboundAttempts).toHaveLength(1);
    expect(stored.orders).toHaveLength(1);
    expect(stored.slaPolicies).toHaveLength(1);
    expect(stored.webhookEvents).toHaveLength(1);
  });

  it('never leaks credentials, encrypted tokens or the raw webhook payload', async () => {
    const h = createHarness();
    h.backups.snapshotResult = fullSnapshot();

    const result = await h.service.createBackup(TENANT_ID, ACTOR_ID);
    const stored = JSON.parse(
      (await h.storage.getObject(result.backupKey)).toString('utf8'),
    ) as Record<string, unknown>;
    // The `meta.notes` documentation intentionally names the excluded columns;
    // scan the DATA payload (everything else) for forbidden fields/values.
    const serialized = JSON.stringify({
      ...stored,
      meta: { ...(stored.meta as Record<string, unknown>), notes: [] },
    });

    for (const forbidden of [
      'passwordHash',
      'password_hash',
      'PASSWORD_HASH_SHOULD_NOT_LEAK',
      'twoFactorSecretEnc',
      'TOTP_SECRET_SHOULD_NOT_LEAK',
      'accessTokenEnc',
      'ACCESS_TOKEN_SHOULD_NOT_LEAK',
      'refreshTokenEnc',
      'REFRESH_TOKEN_SHOULD_NOT_LEAK',
      'API_KEY_SHOULD_NOT_LEAK',
      'WEBHOOK_RAW_SHOULD_NOT_LEAK',
      'WEBHOOK_PAYLOAD_SHOULD_NOT_LEAK',
      'RESOURCE_SHOULD_NOT_LEAK',
      'ERROR_SHOULD_NOT_LEAK',
      'payloadS3Uri',
      'payload_s3_uri',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const data = JSON.parse(serialized);
    expect(data.agents[0]).not.toHaveProperty('passwordHash');
    expect(data.agents[0]).not.toHaveProperty('twoFactorSecretEnc');
    expect(data.accounts[0]).not.toHaveProperty('accessTokenEnc');
    expect(data.accounts[0]).not.toHaveProperty('refreshTokenEnc');
    expect(data.accounts[0].channelConfig).toEqual({
      site_id: 'MLB',
      smtp_sender_email: 'loja@acme.test',
    });
    expect(data.webhookEvents[0]).not.toHaveProperty('payload');
    expect(data.webhookEvents[0]).not.toHaveProperty('resource');
  });

  it('returns 404 for an unknown workspace and writes nothing', async () => {
    const h = createHarness();

    await expect(h.service.createBackup('missing', ACTOR_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
    expect(h.storage.putCalls).toHaveLength(0);
  });
});

describe('TenantBackupService.listBackups', () => {
  it('returns the index rows (newest first) of the workspace', async () => {
    const h = createHarness();
    h.backups.snapshotResult = fullSnapshot();
    await h.service.createBackup(TENANT_ID, ACTOR_ID);

    const rows = await h.service.listBackups(TENANT_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT_ID,
      backupKey: 'backups/acme/2026-11-05T12-00-00-000Z.json',
      sizeBytes: expect.any(Number),
      createdBy: ACTOR_ID,
      createdAt: NOW.toISOString(),
    });
  });

  it('returns 404 for an unknown workspace', async () => {
    const h = createHarness();

    await expect(h.service.listBackups('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
  });
});

/* ====================================================================== */
/* Restore                                                                */
/* ====================================================================== */

async function createBackupObject(h: ReturnType<typeof createHarness>): Promise<string> {
  h.backups.snapshotResult = fullSnapshot();
  const result = await h.service.createBackup(TENANT_ID, ACTOR_ID);
  return result.backupKey;
}

describe('TenantBackupService.restore', () => {
  it('creates a NEW workspace from the artifact (normalized slug/name, fresh hashes)', async () => {
    const h = createHarness();
    const backupKey = await createBackupObject(h);

    const result = await h.service.restore(
      { backupKey, newSlug: '  Acme-Restored  ', newName: '  Acme Restored  ' },
      ACTOR_ID,
    );

    expect(h.restore.calls).toHaveLength(1);
    const call = h.restore.calls[0];
    expect(call.newSlug).toBe('acme-restored');
    expect(call.newName).toBe('Acme Restored');
    expect(call.backupKey).toBe(backupKey);
    expect(call.createdBy).toBe(ACTOR_ID);
    expect(call.now).toEqual(NOW);
    expect(call.payload.meta.sourceTenantId).toBe(TENANT_ID);
    expect(call.payload.agents).toHaveLength(1);
    expect(call.passwordHashes).toHaveLength(1);
    // A random temporary hash, never the source hash.
    expect(call.passwordHashes[0]).not.toBe('PASSWORD_HASH_SHOULD_NOT_LEAK');
    expect(call.passwordHashes[0]).toMatch(/^\$2[aby]\$/);
    expect(call.sizeBytes).toBeGreaterThan(0);

    expect(result).toMatchObject({ tenantId: 'new-tenant' });
    expect(result.counts).toEqual(countsFor(fullSnapshot()));
  });

  it('rejects a slug that already exists with 409 before touching S3', async () => {
    const h = createHarness();
    const backupKey = await createBackupObject(h);

    await expect(
      h.service.restore({ backupKey, newSlug: 'acme', newName: 'Clone' }, ACTOR_ID),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
      details: { code: 'TENANT_SLUG_CONFLICT' },
    });
    expect(h.restore.calls).toHaveLength(0);
  });

  it('answers 404 when the S3 object does not exist', async () => {
    const h = createHarness();

    await expect(
      h.service.restore(
        {
          backupKey: 'backups/acme/2026-11-05T12-00-00-000Z.json',
          newSlug: 'clone',
          newName: 'Clone',
        },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    expect(h.restore.calls).toHaveLength(0);
  });

  it('answers 422 for invalid JSON, a foreign kind/version or a missing table', async () => {
    const h = createHarness();
    const cases: Array<{ key: string; body: string }> = [
      { key: 'backups/acme/invalid-json.json', body: '{not json' },
      {
        key: 'backups/acme/wrong-kind.json',
        body: JSON.stringify({ meta: { kind: 'lgpd-export', formatVersion: '1.0' } }),
      },
      {
        key: 'backups/acme/wrong-version.json',
        body: JSON.stringify({ meta: { kind: 'tenant-backup', formatVersion: '9.9' } }),
      },
      {
        key: 'backups/acme/missing-table.json',
        body: JSON.stringify({
          meta: { kind: 'tenant-backup', formatVersion: '1.0' },
          tenant: { slug: 'acme', name: 'Acme', plan: 'PRO', maxAccounts: 1, maxAgents: 3 },
          agents: [],
          accounts: [],
          tickets: [],
          // messages intentionally missing
          attachments: [],
          events: [],
          outboundAttempts: [],
          orders: [],
          slaPolicies: [],
          webhookEvents: [],
        }),
      },
    ];

    for (const item of cases) {
      h.storage.objects.set(item.key, Buffer.from(item.body, 'utf8'));
      await expect(
        h.service.restore({ backupKey: item.key, newSlug: 'clone', newName: 'Clone' }, ACTOR_ID),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
    }
    expect(h.restore.calls).toHaveLength(0);
  });

  it('rejects an invalid slug, name or backupKey with 422', async () => {
    const h = createHarness();
    const invalid = [
      { backupKey: 'backups/acme/x.json', newSlug: 'Not Valid!', newName: 'Clone' },
      { backupKey: 'backups/acme/x.json', newSlug: 'clone', newName: '   ' },
      { backupKey: 'other/acme/x.json', newSlug: 'clone', newName: 'Clone' },
      { backupKey: 'backups/acme/x.txt', newSlug: 'clone', newName: 'Clone' },
    ];

    for (const command of invalid) {
      await expect(h.service.restore(command, ACTOR_ID)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        httpStatus: 422,
      });
    }
    expect(h.restore.calls).toHaveLength(0);
  });
});

/* ====================================================================== */
/* Pure helpers                                                           */
/* ====================================================================== */

describe('tenant backup helpers', () => {
  it('builds a filesystem-safe key', () => {
    expect(buildBackupKey('acme', NOW)).toBe('backups/acme/2026-11-05T12-00-00-000Z.json');
  });

  it('buildBackupPayload drops every secret but keeps business data', () => {
    const tenant = makeTenant({ id: TENANT_ID, slug: 'acme', plan: 'PRO' });
    const payload = buildBackupPayload(tenant, fullSnapshot(), ACTOR_ID, NOW);
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain('SHOULD_NOT_LEAK');
    expect(payload.tickets[0]).toMatchObject({
      buyerDisplayName: 'Comprador Teste',
      externalReferenceId: 'question-1',
    });
    expect(payload.accounts[0]?.status).toBe('ACTIVE');
    expect(payload.webhookEvents[0]).toMatchObject({
      eventId: 'event-ext-1',
      status: 'PROCESSED',
    });
  });

  it('parseTenantBackup returns the same shape it serialized', () => {
    const tenant = makeTenant({ id: TENANT_ID, slug: 'acme', plan: 'PRO' });
    const payload = buildBackupPayload(tenant, fullSnapshot(), ACTOR_ID, NOW);
    const parsed = parseTenantBackup(
      Buffer.from(JSON.stringify(payload), 'utf8'),
      'backups/acme/x.json',
    );

    expect(parsed.meta.sourceTenantId).toBe(TENANT_ID);
    expect(parsed.tickets).toHaveLength(1);
  });
});
