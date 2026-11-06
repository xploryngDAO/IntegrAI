import bcrypt from 'bcryptjs';
import { beforeAll, describe, expect, it } from 'vitest';

import type {
  ITenantDataRepository,
  MarketplaceAccountRecord,
  SupportTicketRecord,
  TenantDataSnapshot,
  TenantDataSnapshotOptions,
  TicketEventRecord,
  TicketMessageRecord,
} from '@sac/shared';

import { TenantPrivacyService } from '../TenantPrivacyService';
import { FrozenClock, silentLogger } from './accountFakes';
import {
  InMemoryPlatformTenantRepository,
  InMemoryTenantRepository,
  StubAgentRepository,
} from './platformFakes';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const TENANT_ID = 'tenant-1';
const PASSWORD = 'CorrectHorse123!';

class StubTenantDataRepository implements ITenantDataRepository {
  snapshotResult: TenantDataSnapshot = {
    agents: [],
    accounts: [],
    tickets: [],
    messages: [],
    events: [],
    truncated: { tickets: false, messages: false },
  };
  readonly snapshotCalls: Array<{ tenantId: string; options?: TenantDataSnapshotOptions }> = [];
  readonly revoked: Array<{ tenantId: string; at: Date }> = [];
  revokedCount = 2;

  async snapshot(
    tenantId: string,
    options?: TenantDataSnapshotOptions,
  ): Promise<TenantDataSnapshot> {
    this.snapshotCalls.push({ tenantId, options });
    return this.snapshotResult;
  }

  async revokeSessions(tenantId: string, at: Date): Promise<number> {
    this.revoked.push({ tenantId, at });
    return this.revokedCount;
  }
}

function makeAccount(overrides: Partial<MarketplaceAccountRecord> = {}): MarketplaceAccountRecord {
  return {
    id: overrides.id ?? 'account-1',
    tenantId: TENANT_ID,
    marketplace: 'MERCADO_LIVRE',
    displayName: 'Loja Meli',
    externalSellerId: '123456',
    marketplaceSiteId: 'MLB',
    accessTokenEnc: 'enc:ACCESS_TOKEN_SHOULD_NOT_LEAK',
    refreshTokenEnc: 'enc:REFRESH_TOKEN_SHOULD_NOT_LEAK',
    tokenExpiresAt: new Date('2026-11-06T12:00:00.000Z'),
    authExpiresAt: null,
    channelConfig: {
      site_id: 'MLB',
      smtp_sender_email: 'loja@acme.test',
      api_key: 'API_KEY_SHOULD_NOT_LEAK',
      refresh_token: 'CONFIG_REFRESH_SHOULD_NOT_LEAK',
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
    id: overrides.id ?? 'ticket-1',
    tenantId: TENANT_ID,
    accountId: 'account-1',
    marketplace: 'MERCADO_LIVRE',
    ticketType: 'PRE_SALE',
    externalReferenceId: 'question-1',
    externalOrderId: null,
    orderCacheId: null,
    packId: null,
    claimId: null,
    conversationId: null,
    returnSn: null,
    subject: 'Dúvida sobre o produto',
    buyerExternalId: 'BUYER_ID_SHOULD_NOT_LEAK',
    buyerDisplayName: 'BUYER_NAME_SHOULD_NOT_LEAK',
    buyerAnonymizedEmail: 'BUYER_EMAIL_SHOULD_NOT_LEAK@marketplace.test',
    buyerContactHash: 'BUYER_HASH_SHOULD_NOT_LEAK',
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
    assignedAgentId: null,
    assignedQueue: null,
    channelMetadata: {},
    tags: ['pre-venda'],
    createdAt: new Date('2026-11-05T09:00:00.000Z'),
    updatedAt: new Date('2026-11-05T09:00:00.000Z'),
    ...overrides,
  };
}

function makeMessage(overrides: Partial<TicketMessageRecord> = {}): TicketMessageRecord {
  return {
    id: overrides.id ?? 'message-1',
    ticketId: 'ticket-1',
    externalMessageId: 'ext-1',
    inReplyToId: null,
    referencesIds: [],
    direction: 'INBOUND_BUYER',
    channelRouteUsed: 'MELI_QUESTIONS_API',
    messageType: 'text',
    bodyCleanText: 'Olá, o produto tem garantia?',
    bodyHtml: '<p>HTML_SHOULD_NOT_LEAK</p>',
    contentPayload: { raw: 'PAYLOAD_SHOULD_NOT_LEAK' },
    bodyRawS3Uri: 's3://raw/SHOULD_NOT_LEAK.eml',
    deliveryStatus: 'DELIVERED',
    errorDetail: null,
    isInternalNote: false,
    authorAgentId: null,
    marketplaceCreatedAt: new Date('2026-11-05T09:00:00.000Z'),
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    createdAt: new Date('2026-11-05T09:00:00.000Z'),
    updatedAt: new Date('2026-11-05T09:00:00.000Z'),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<TicketEventRecord> = {}): TicketEventRecord {
  return {
    id: overrides.id ?? 'event-1',
    ticketId: 'ticket-1',
    eventType: 'TICKET_CREATED',
    actorAgentId: null,
    actorLabel: 'Sistema',
    payload: { source: 'webhook' },
    createdAt: new Date('2026-11-05T09:00:00.000Z'),
  };
}

let passwordHash = '';

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

function createHarness(tenantOverrides: Parameters<InMemoryTenantRepository['seed']>[0] = {}) {
  const clock = new FrozenClock(NOW);
  const tenants = new InMemoryTenantRepository(() => clock.now());
  const tenant = tenants.seed({
    id: TENANT_ID,
    slug: 'acme',
    name: 'Acme',
    plan: 'PRO',
    ...tenantOverrides,
  });
  const tenantAdmin = new InMemoryPlatformTenantRepository(tenants, () => clock.now());
  const agents = new StubAgentRepository();
  const admin = agents.seed({
    id: 'agent-admin',
    tenantId: TENANT_ID,
    passwordHash,
    role: 'ADMIN',
    isPlatformAdmin: false,
  });
  const tenantData = new StubTenantDataRepository();
  const service = new TenantPrivacyService({
    logger: silentLogger,
    clock,
    repos: { tenants, tenantAdmin, agents, tenantData },
  });

  return { clock, tenants, tenant, tenantAdmin, agents, admin, tenantData, service };
}

describe('TenantPrivacyService.exportData', () => {
  it('exports tenant, agents, accounts, tickets, messages, events and metadata', async () => {
    const h = createHarness();
    h.tenantData.snapshotResult = {
      agents: [h.admin],
      accounts: [makeAccount()],
      tickets: [makeTicket()],
      messages: [makeMessage()],
      events: [makeEvent()],
      truncated: { tickets: false, messages: false },
    };

    const artifact = await h.service.exportData(TENANT_ID, h.admin.id);

    expect(h.tenantData.snapshotCalls[0]).toEqual({
      tenantId: TENANT_ID,
      options: { ticketLimit: 1_000, messageLimit: 5_000 },
    });
    expect(artifact.tenant).toMatchObject({
      id: TENANT_ID,
      slug: 'acme',
      plan: 'PRO',
      limits: { maxAccounts: 10, maxAgents: 25 },
    });
    expect(artifact.meta).toMatchObject({
      formatVersion: '1.0',
      exportedAt: NOW.toISOString(),
      exportedBy: h.admin.id,
      tenantId: TENANT_ID,
      limits: { maxAccounts: 10, maxAgents: 25 },
      truncated: { tickets: false, messages: false },
    });
    expect(artifact.meta.notes.length).toBeGreaterThan(0);
    expect(artifact.agents).toHaveLength(1);
    expect(artifact.accounts).toHaveLength(1);
    expect(artifact.tickets).toHaveLength(1);
    expect(artifact.messages).toHaveLength(1);
    expect(artifact.events).toHaveLength(1);
  });

  it('never leaks credentials, tokens or raw buyer PII', async () => {
    const h = createHarness();
    h.tenantData.snapshotResult = {
      agents: [h.admin],
      accounts: [makeAccount()],
      tickets: [makeTicket()],
      messages: [makeMessage()],
      events: [makeEvent()],
      truncated: { tickets: false, messages: false },
    };

    const artifact = await h.service.exportData(TENANT_ID, h.admin.id);
    const serialized = JSON.stringify(artifact);

    for (const forbidden of [
      'passwordHash',
      'twoFactorSecretEnc',
      'accessTokenEnc',
      'refreshTokenEnc',
      'ACCESS_TOKEN_SHOULD_NOT_LEAK',
      'REFRESH_TOKEN_SHOULD_NOT_LEAK',
      'API_KEY_SHOULD_NOT_LEAK',
      'CONFIG_REFRESH_SHOULD_NOT_LEAK',
      'BUYER_ID_SHOULD_NOT_LEAK',
      'BUYER_NAME_SHOULD_NOT_LEAK',
      'BUYER_EMAIL_SHOULD_NOT_LEAK',
      'BUYER_HASH_SHOULD_NOT_LEAK',
      'HTML_SHOULD_NOT_LEAK',
      'PAYLOAD_SHOULD_NOT_LEAK',
      '.eml',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    expect(artifact.agents[0]).not.toHaveProperty('passwordHash');
    expect(artifact.agents[0]).not.toHaveProperty('twoFactorSecretEnc');
    expect(artifact.accounts[0]).not.toHaveProperty('accessTokenEnc');
    expect(artifact.accounts[0]).not.toHaveProperty('refreshTokenEnc');
    expect(artifact.accounts[0]?.channelConfig).toEqual({
      site_id: 'MLB',
      smtp_sender_email: 'loja@acme.test',
    });
    expect(artifact.tickets[0]).not.toHaveProperty('buyerDisplayName');
    expect(artifact.tickets[0]).not.toHaveProperty('buyerAnonymizedEmail');
    expect(artifact.messages[0]).not.toHaveProperty('bodyHtml');
    expect(artifact.messages[0]).not.toHaveProperty('contentPayload');
    expect(artifact.messages[0]).not.toHaveProperty('bodyRawS3Uri');
  });

  it('reports truncation in metadata', async () => {
    const h = createHarness();
    h.tenantData.snapshotResult = {
      agents: [],
      accounts: [],
      tickets: [],
      messages: [],
      events: [],
      truncated: { tickets: true, messages: true },
    };

    const artifact = await h.service.exportData(TENANT_ID, h.admin.id);

    expect(artifact.meta.truncated).toEqual({ tickets: true, messages: true });
  });

  it('returns 404 for an unknown workspace', async () => {
    const h = createHarness();

    await expect(h.service.exportData('missing', h.admin.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
  });
});

describe('TenantPrivacyService.deleteTenant', () => {
  it('soft deletes after password + slug confirmation and revokes sessions', async () => {
    const h = createHarness();

    const result = await h.service.deleteTenant(
      TENANT_ID,
      { password: PASSWORD, confirmSlug: '  ACME  ' },
      h.admin.id,
    );

    expect(result).toEqual({
      tenantId: TENANT_ID,
      slug: 'acme',
      status: 'DELETED',
      deletedAt: NOW.toISOString(),
      purge: { scheduled: false, note: expect.any(String) },
    });
    expect(h.tenant.status).toBe('DELETED');
    expect(h.tenant.deletedAt).toEqual(NOW);
    expect(h.tenantData.revoked).toEqual([{ tenantId: TENANT_ID, at: NOW }]);
    expect(result.purge.note).toMatch(/job futuro|purge/i);
  });

  it('rejects a wrong password with 403 and changes nothing', async () => {
    const h = createHarness();

    await expect(
      h.service.deleteTenant(TENANT_ID, { password: 'WrongPassword1!', confirmSlug: 'acme' }, h.admin.id),
    ).rejects.toMatchObject({ code: 'INVALID_PASSWORD', httpStatus: 403 });

    expect(h.tenant.status).toBe('ACTIVE');
    expect(h.tenant.deletedAt).toBeNull();
    expect(h.tenantData.revoked).toHaveLength(0);
  });

  it('rejects a mismatched confirmation slug with 422', async () => {
    const h = createHarness();

    await expect(
      h.service.deleteTenant(TENANT_ID, { password: PASSWORD, confirmSlug: 'other' }, h.admin.id),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });

    expect(h.tenant.status).toBe('ACTIVE');
  });

  it('rejects an actor that is not an ADMIN of the tenant with 403', async () => {
    const h = createHarness();
    const operator = h.agents.seed({
      id: 'agent-operator',
      tenantId: TENANT_ID,
      passwordHash,
      role: 'AGENT',
    });

    await expect(
      h.service.deleteTenant(TENANT_ID, { password: PASSWORD, confirmSlug: 'acme' }, operator.id),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_ERROR', httpStatus: 403 });
  });

  it('rejects an ADMIN from another tenant with 403', async () => {
    const h = createHarness();
    const foreignAdmin = h.agents.seed({
      id: 'agent-foreign',
      tenantId: 'other-tenant',
      passwordHash,
      role: 'ADMIN',
    });

    await expect(
      h.service.deleteTenant(TENANT_ID, { password: PASSWORD, confirmSlug: 'acme' }, foreignAdmin.id),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_ERROR', httpStatus: 403 });
  });

  it('rejects a workspace that is already deleted with 409', async () => {
    const h = createHarness({
      status: 'DELETED',
      deletedAt: new Date('2026-11-04T12:00:00.000Z'),
    });

    await expect(
      h.service.deleteTenant(TENANT_ID, { password: PASSWORD, confirmSlug: 'acme' }, h.admin.id),
    ).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 });
  });

  it('returns 404 for an unknown workspace', async () => {
    const h = createHarness();

    await expect(
      h.service.deleteTenant('missing', { password: PASSWORD, confirmSlug: 'acme' }, h.admin.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });
});
