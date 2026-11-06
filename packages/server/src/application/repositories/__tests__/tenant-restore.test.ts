import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type {
  RestoreTenantInput,
  TenantBackupPayload,
  TenantBackupTicket,
} from '@sac/shared';
import { ValidationError } from '@sac/shared';

import { PrismaTenantRestoreRepository } from '../tenant-restore';

/**
 * `PrismaTenantRestoreRepository` owns the remapping and the transaction
 * boundary, so these tests pin the exact Prisma calls with a recording stub
 * (no database):
 *
 *  - ONE `$transaction`;
 *  - a NEW tenant row (never an update);
 *  - every business row receives a new uuid and remapped foreign keys;
 *  - agents are recreated with the service hash, `mustResetPassword=true`,
 *    no 2FA secret and `isPlatformAdmin=false`;
 *  - accounts return DISCONNECTED and token-free;
 *  - globally unique natural keys are disambiguated/cleared when taken.
 */

type Call = { model: string; op: string; args: Record<string, unknown> };

const NOW = new Date('2026-11-05T12:00:00.000Z');

function makePayload(): TenantBackupPayload {
  const ticket: TenantBackupTicket = {
    id: 'ticket-old',
    accountId: 'account-old',
    marketplace: 'MERCADO_LIVRE',
    ticketType: 'PRE_SALE',
    externalReferenceId: 'question-1',
    externalOrderId: 'order-ext-1',
    orderCacheId: 'order-old',
    packId: null,
    claimId: null,
    conversationId: null,
    returnSn: null,
    subject: 'Dúvida',
    buyerExternalId: 'buyer-1',
    buyerDisplayName: 'Comprador',
    buyerAnonymizedEmail: 'buyer@marketplace.test',
    buyerContactHash: 'hash',
    hasActiveClaim: false,
    status: 'OPEN_WAITING_AGENT',
    priority: 'MEDIUM',
    slaDeadlineAt: '2026-11-05T18:00:00.000Z',
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
    assignedAgentId: 'agent-old',
    assignedQueue: null,
    channelMetadata: { foo: 'bar' },
    tags: ['pre-venda'],
    createdAt: '2026-11-05T09:00:00.000Z',
    updatedAt: '2026-11-05T09:00:00.000Z',
  };

  return {
    meta: {
      kind: 'tenant-backup',
      formatVersion: '1.0',
      createdAt: NOW.toISOString(),
      createdBy: 'platform-admin',
      sourceTenantId: 'tenant-old',
      sourceTenantSlug: 'acme',
      sourceTenantName: 'Acme',
      counts: {
        agents: 1,
        accounts: 1,
        tickets: 1,
        messages: 1,
        attachments: 1,
        events: 1,
        outboundAttempts: 1,
        orders: 1,
        slaPolicies: 1,
        webhookEvents: 1,
      },
      notes: [],
    },
    tenant: {
      id: 'tenant-old',
      slug: 'acme',
      name: 'Acme',
      status: 'ACTIVE',
      plan: 'PRO',
      maxAccounts: 10,
      maxAgents: 25,
      billingStatus: 'ACTIVE',
      trialEndsAt: null,
      billingEmail: 'finance@acme.test',
      onboardingCompletedAt: null,
      createdAt: '2026-11-01T12:00:00.000Z',
      updatedAt: '2026-11-01T12:00:00.000Z',
    },
    agents: [
      {
        id: 'agent-old',
        email: 'ana@acme.test',
        name: 'Ana',
        role: 'ADMIN',
        presence: 'ONLINE',
        avatarColor: '#2563eb',
        maxConcurrent: 20,
        isActive: true,
        lastSeenAt: '2026-11-05T10:00:00.000Z',
        emailVerifiedAt: '2026-11-01T12:00:00.000Z',
        twoFactorEnabled: true,
        isPlatformAdmin: true,
        mustResetPassword: false,
        createdAt: '2026-11-01T12:00:00.000Z',
        updatedAt: '2026-11-01T12:00:00.000Z',
      },
    ],
    accounts: [
      {
        id: 'account-old',
        marketplace: 'MERCADO_LIVRE',
        displayName: 'Loja Meli',
        externalSellerId: '123456',
        marketplaceSiteId: 'MLB',
        status: 'ACTIVE',
        channelConfig: { site_id: 'MLB' },
        tokenExpiresAt: '2026-11-06T12:00:00.000Z',
        authExpiresAt: null,
        lastTokenRefreshAt: null,
        lastErrorAt: null,
        lastError: null,
        createdAt: '2026-11-01T12:00:00.000Z',
        updatedAt: '2026-11-01T12:00:00.000Z',
      },
    ],
    tickets: [ticket],
    messages: [
      {
        id: 'message-old',
        ticketId: 'ticket-old',
        externalMessageId: 'ext-1',
        inReplyToId: null,
        referencesIds: [],
        direction: 'INBOUND_BUYER',
        channelRouteUsed: 'MELI_QUESTIONS_API',
        messageType: 'text',
        bodyCleanText: 'Olá',
        bodyHtml: '<p>Olá</p>',
        contentPayload: { foo: 'bar' },
        bodyRawS3Uri: null,
        deliveryStatus: 'DELIVERED',
        errorDetail: null,
        isInternalNote: false,
        authorAgentId: 'agent-old',
        marketplaceCreatedAt: '2026-11-05T09:00:00.000Z',
        sentAt: null,
        deliveredAt: null,
        readAt: null,
        createdAt: '2026-11-05T09:00:00.000Z',
        updatedAt: '2026-11-05T09:00:00.000Z',
      },
    ],
    attachments: [
      {
        id: 'attachment-old',
        messageId: 'message-old',
        fileName: 'nota.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        sha256: null,
        s3Uri: 's3://attachments/attachments/nota.pdf',
        externalUploadId: null,
        isEvidence: true,
        createdAt: '2026-11-05T09:00:00.000Z',
      },
    ],
    events: [
      {
        id: 'event-old',
        ticketId: 'ticket-old',
        eventType: 'TICKET_CREATED',
        actorAgentId: 'agent-old',
        actorLabel: 'Ana',
        payload: { source: 'webhook' },
        createdAt: '2026-11-05T09:00:00.000Z',
      },
    ],
    outboundAttempts: [
      {
        id: 'attempt-old',
        ticketId: 'ticket-old',
        messageId: 'message-old',
        channelRoute: 'MELI_QUESTIONS_API',
        status: 'SENT',
        requestPayload: {},
        responsePayload: {},
        httpStatus: 200,
        attempt: 1,
        errorCode: null,
        errorMessage: null,
        durationMs: 10,
        createdAt: '2026-11-05T09:00:00.000Z',
      },
    ],
    orders: [
      {
        id: 'order-old',
        accountId: 'account-old',
        marketplace: 'MERCADO_LIVRE',
        externalOrderId: 'order-ext-1',
        packId: null,
        buyerExternalId: null,
        buyerNameOrNick: null,
        buyerAnonymizedEmail: null,
        orderStatus: 'PAID',
        fulfillmentType: null,
        totalAmount: 10,
        currency: 'BRL',
        trackingNumber: null,
        carrierName: null,
        itemsSnapshot: [],
        allowedActionsCache: {},
        shippingSnapshot: {},
        estimatedDeliveryAt: null,
        shippedAt: null,
        deliveredAt: null,
        lastSyncedAt: '2026-11-05T09:00:00.000Z',
        createdAt: '2026-11-05T09:00:00.000Z',
        updatedAt: '2026-11-05T09:00:00.000Z',
      },
    ],
    slaPolicies: [
      {
        id: 'policy-old',
        accountId: 'account-old',
        marketplace: 'MERCADO_LIVRE',
        ticketType: 'PRE_SALE',
        firstResponseMinutes: 60,
        targetMinutes: 120,
        warningMinutes: 30,
        businessHoursOnly: false,
        isActive: true,
      },
    ],
    webhookEvents: [
      {
        id: 'webhook-old',
        marketplace: 'MERCADO_LIVRE',
        accountId: 'account-old',
        eventId: 'event-ext-1',
        topic: 'questions',
        status: 'PROCESSED',
        signatureValid: true,
        attempts: 1,
        receivedAt: '2026-11-05T09:00:00.000Z',
        processedAt: '2026-11-05T09:01:00.000Z',
      },
    ],
  };
}

interface ExistingRows {
  agentEmails?: string[];
  accountKeys?: Array<{ marketplace: string; externalSellerId: string; marketplaceSiteId: string }>;
  orderKeys?: Array<{ marketplace: string; externalOrderId: string }>;
  messageExternalIds?: string[];
  webhookKeys?: Array<{ marketplace: string; eventId: string }>;
}

function createHarness(existing: ExistingRows = {}) {
  const calls: Call[] = [];
  const transactionOptions: unknown[] = [];
  const created: Record<string, Array<Record<string, unknown>>> = {};
  const push = (model: string, rows: Array<Record<string, unknown>>) => {
    created[model] = (created[model] ?? []).concat(rows);
  };

  const model = (name: string) => ({
    findMany: async (args: Record<string, unknown>) => {
      calls.push({ model: name, op: 'findMany', args });
      if (name === 'agent') return (existing.agentEmails ?? []).map((email) => ({ email }));
      if (name === 'marketplaceAccount') return existing.accountKeys ?? [];
      if (name === 'orderCache') return existing.orderKeys ?? [];
      if (name === 'ticketMessage') {
        return (existing.messageExternalIds ?? []).map((externalMessageId) => ({
          externalMessageId,
        }));
      }
      if (name === 'webhookEvent') return existing.webhookKeys ?? [];
      return [];
    },
    create: async (args: { data: Record<string, unknown> }) => {
      calls.push({ model: name, op: 'create', args });
      const row = { id: `new-${name}`, slug: 'acme-restored', ...args.data };
      push(name, [row]);
      return row;
    },
    createMany: async (args: { data: Array<Record<string, unknown>> }) => {
      calls.push({ model: name, op: 'createMany', args });
      push(name, args.data);
      return { count: args.data.length };
    },
  });

  const tenantModel = {
    create: async (args: { data: Record<string, unknown> }) => {
      calls.push({ model: 'tenant', op: 'create', args });
      return {
        id: 'tenant-new',
        slug: args.data.slug,
        name: args.data.name,
        status: args.data.status,
        ...args.data,
      };
    },
    findMany: async (args: Record<string, unknown>) => {
      calls.push({ model: 'tenant', op: 'findMany', args });
      return [];
    },
  };

  const tx = {
    tenant: tenantModel,
    agent: model('agent'),
    marketplaceAccount: model('marketplaceAccount'),
    orderCache: model('orderCache'),
    supportTicket: model('supportTicket'),
    slaPolicy: model('slaPolicy'),
    ticketMessage: model('ticketMessage'),
    messageAttachment: model('messageAttachment'),
    ticketEvent: model('ticketEvent'),
    outboundAttempt: model('outboundAttempt'),
    webhookEvent: model('webhookEvent'),
    tenantBackup: model('tenantBackup'),
  };

  const prisma = {
    $transaction: async (
      fn: (client: typeof tx) => Promise<unknown>,
      optionsArg: unknown,
    ): Promise<unknown> => {
      transactionOptions.push(optionsArg);
      calls.push({ model: '$transaction', op: 'begin', args: {} });
      return fn(tx);
    },
  } as unknown as PrismaClient;

  return {
    repository: new PrismaTenantRestoreRepository(prisma),
    calls,
    transactionOptions,
    created,
  };
}

function restoreInput(payload: TenantBackupPayload = makePayload()): RestoreTenantInput {
  return {
    payload,
    newSlug: 'acme-restored',
    newName: 'Acme Restored',
    backupKey: 'backups/acme/2026-11-05T12-00-00-000Z.json',
    sizeBytes: 2048,
    createdBy: 'platform-admin',
    now: NOW,
    passwordHashes: ['$2b$12$fakehashfakehashfakehashfakehashfakehashfakehash'],
  };
}

function only(created: Record<string, Array<Record<string, unknown>>>, model: string) {
  const rows = created[model] ?? [];
  expect(rows).toHaveLength(1);
  return rows[0] as Record<string, unknown>;
}

describe('PrismaTenantRestoreRepository.restore', () => {
  it('runs in one transaction and creates a NEW tenant with the plan/quotas', async () => {
    const h = createHarness();

    const result = await h.repository.restore(restoreInput());

    expect(h.transactionOptions).toHaveLength(1);
    expect(h.transactionOptions[0]).toMatchObject({ timeout: 120_000, maxWait: 10_000 });

    const tenantCreate = h.calls.find((call) => call.model === 'tenant' && call.op === 'create');
    expect(tenantCreate?.args).toMatchObject({
      data: {
        slug: 'acme-restored',
        name: 'Acme Restored',
        status: 'ACTIVE',
        plan: 'PRO',
        maxAccounts: 10,
        maxAgents: 25,
        billingStatus: 'TRIALING',
      },
    });
    expect(h.calls.some((call) => call.model === 'tenant' && call.op !== 'create')).toBe(false);

    expect(result.tenantId).toBe('tenant-new');
    expect(result.slug).toBe('acme-restored');
    expect(result.counts).toEqual(makePayload().meta.counts);
  });

  it('remaps ids, resets agent credentials/privileges and disconnects accounts', async () => {
    const h = createHarness();

    await h.repository.restore(restoreInput());

    const agent = only(h.created, 'agent');
    expect(agent.id).not.toBe('agent-old');
    expect(agent.tenantId).toBe('tenant-new');
    expect(agent.email).toBe('ana@acme.test');
    expect(agent.passwordHash).toBe(restoreInput().passwordHashes[0]);
    expect(agent.mustResetPassword).toBe(true);
    expect(agent.isPlatformAdmin).toBe(false);
    expect(agent.twoFactorSecretEnc).toBeNull();
    expect(agent.twoFactorEnabled).toBe(false);
    expect(agent.presence).toBe('OFFLINE');

    const account = only(h.created, 'marketplaceAccount');
    const accountId = account.id as string;
    expect(accountId).not.toBe('account-old');
    expect(account.tenantId).toBe('tenant-new');
    expect(account.status).toBe('DISCONNECTED');
    expect(account.accessTokenEnc).toBeNull();
    expect(account.refreshTokenEnc).toBeNull();
    expect(account.tokenExpiresAt).toBeNull();
    expect(account.authExpiresAt).toBeNull();

    const order = only(h.created, 'orderCache');
    expect(order.id).not.toBe('order-old');
    expect(order.accountId).toBe(accountId);
    expect(order.externalOrderId).toBe('order-ext-1');

    const ticket = only(h.created, 'supportTicket');
    expect(ticket.id).not.toBe('ticket-old');
    expect(ticket.tenantId).toBe('tenant-new');
    expect(ticket.accountId).toBe(accountId);
    expect(ticket.orderCacheId).toBe(order.id);
    expect(ticket.assignedAgentId).toBe(agent.id);

    const message = only(h.created, 'ticketMessage');
    expect(message.id).not.toBe('message-old');
    expect(message.ticketId).toBe(ticket.id);
    expect(message.authorAgentId).toBe(agent.id);
    expect(message.externalMessageId).toBe('ext-1');

    const attachment = only(h.created, 'messageAttachment');
    expect(attachment.messageId).toBe(message.id);

    const event = only(h.created, 'ticketEvent');
    expect(event.ticketId).toBe(ticket.id);
    expect(event.actorAgentId).toBe(agent.id);

    const attempt = only(h.created, 'outboundAttempt');
    expect(attempt.ticketId).toBe(ticket.id);
    expect(attempt.messageId).toBe(message.id);

    const sla = only(h.created, 'slaPolicy');
    expect(sla.accountId).toBe(accountId);

    const webhook = only(h.created, 'webhookEvent');
    expect(webhook.tenantId).toBe('tenant-new');
    expect(webhook.accountId).toBe(accountId);
    expect(webhook.eventId).toBe('event-ext-1');
    expect(webhook.payload).toEqual({});
    expect(webhook.payloadS3Uri).toBeNull();
    expect(webhook.resource).toBeNull();

    const index = only(h.created, 'tenantBackup');
    expect(index.tenantId).toBe('tenant-new');
    expect(index.s3Key).toBe('backups/acme/2026-11-05T12-00-00-000Z.json');
    expect(index.sizeBytes).toBe(2048);
  });

  it('disambiguates natural keys that already exist instead of failing', async () => {
    const h = createHarness({
      agentEmails: ['ana@acme.test'],
      accountKeys: [
        { marketplace: 'MERCADO_LIVRE', externalSellerId: '123456', marketplaceSiteId: 'MLB' },
      ],
      orderKeys: [{ marketplace: 'MERCADO_LIVRE', externalOrderId: 'order-ext-1' }],
      messageExternalIds: ['ext-1'],
      webhookKeys: [{ marketplace: 'MERCADO_LIVRE', eventId: 'event-ext-1' }],
    });

    await h.repository.restore(restoreInput());

    const agent = only(h.created, 'agent');
    expect(agent.email).toMatch(/^ana\+restored-acme-restored-1@acme\.test$/);

    const account = only(h.created, 'marketplaceAccount');
    expect(account.externalSellerId).toMatch(/^123456~r[a-z0-9]{8}1$/);

    const order = only(h.created, 'orderCache');
    expect(order.externalOrderId).toMatch(/^order-ext-1~r[a-z0-9]{8}1$/);

    expect(only(h.created, 'ticketMessage').externalMessageId).toBeNull();
    expect(only(h.created, 'webhookEvent').eventId).toBeNull();
  });

  it('rejects a backup with an unknown account reference (422) and rolls back', async () => {
    const h = createHarness();
    const payload = makePayload();
    payload.tickets[0].accountId = 'missing-account';

    await expect(h.repository.restore(restoreInput(payload))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(h.created.supportTicket ?? []).toHaveLength(0);
  });

  it('requires one password hash per agent', async () => {
    const h = createHarness();

    await expect(
      h.repository.restore({ ...restoreInput(), passwordHashes: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
