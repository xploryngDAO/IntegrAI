import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AdapterDependencies, ChannelRuntimeConfig, RawWebhookRequest } from '@sac/shared';
import { SesRelayParser } from '../inbound/SesRelayParser';
import { OrderEnrichmentService } from '../client/OrderEnrichment';
import type { SpApiClient } from '../client/SpApiClient';

const config: ChannelRuntimeConfig = {
  appBaseUrl: 'http://localhost:3000',
  amazon: {
    lwaClientId: 'cid',
    lwaClientSecret: 'secret',
    spApiEndpoint: 'https://sellingpartnerapi-na.amazon.com',
    lwaTokenUrl: 'https://api.amazon.com/auth/o2/token',
    rdtEndpoint: 'https://sellingpartnerapi-na.amazon.com/tokens/2021-03-01/restrictedDataToken',
    region: 'NA',
    sesInboundSharedSecret: 'shared-secret',
    emailDomainAllowlist: [],
  },
  meli: {
    clientId: 'm',
    clientSecret: 'm',
    redirectUri: 'x',
    apiBase: 'https://api.mercadolivre.com',
    refreshIntervalSeconds: 1,
    webhookTopics: [],
  },
  shopee: {
    partnerId: 1,
    partnerKey: 'k',
    redirectUri: 'x',
    apiBase: 'https://partner.shopeemobile.com',
    refreshIntervalSeconds: 1,
    lostPushCron: '*/5 * * * *',
    lostPushLookbackMinutes: 60,
    webhookToleranceSeconds: 300,
  },
  smtp: { host: 'localhost', port: 1025, secure: false },
  s3: { bucket: 'sac', attachmentsBucket: 'sac' },
  piiRetentionDays: 30,
  rateLimits: {
    amazonMessagingPerSecond: 1,
    amazonOrdersPerSecond: 0.5,
    amazonOrdersBurst: 10,
    amazonRdtPerSecond: 1,
    meliPerSecond: 10,
    shopeePerSecond: 5,
  },
};

interface StubOptions {
  activeTicket?: { id: string } | null;
  referenceTicket?: { id: string } | null;
  findById?: (id: string) => unknown;
}

function makeDeps(options: StubOptions = {}): AdapterDependencies {
  const account = {
    id: 'acc-1',
    marketplace: 'AMAZON',
    displayName: 'Amazon',
    externalSellerId: 'SELLER',
    marketplaceSiteId: 'A2Q3Y263D00KWC',
    accessTokenEnc: null,
    refreshTokenEnc: null,
    tokenExpiresAt: null,
    authExpiresAt: null,
    channelConfig: {
      smtp_sender_email: 'atendimento@minhamarca.com.br',
      inbound_email_route: 'amazon-relay@sachub.demo',
      approved_sender_domains: ['minhamarca.com.br'],
    },
    status: 'ACTIVE',
    lastTokenRefreshAt: null,
    lastErrorAt: null,
    lastError: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  const logger = {
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  const deps = {
    logger,
    clock: { now: () => new Date('2026-11-05T12:00:00Z') },
    config,
    repos: {
      accounts: {
        findById: async (id: string) => (options.findById ? options.findById(id) : id === account.id ? account : null),
        list: async () => [account],
        setStatus: async () => account,
        updateTokens: async () => account,
      },
      tickets: {
        findThreadingMatch: async () => null,
        findActiveByExternalOrderId: async () => options.activeTicket ?? null,
        findByExternalReference: async () => options.referenceTicket ?? null,
        findOpenPreSaleByBuyerEmail: async () => null,
        findById: async () => null,
      },
      messages: {},
      orders: {},
      attachments: {},
      webhookEvents: {},
      piiVault: {},
      ticketEvents: {},
    },
    cache: { get: async () => null, set: async () => undefined },
    lock: { withLock: async (_r: string[], _t: number, fn: () => Promise<unknown>) => fn() },
    rateLimiter: { acquire: async () => undefined, consume: async () => true },
    storage: {
      putObject: async (input: { key: string; body: Buffer | string; contentType?: string }) => ({
        key: input.key,
        uri: `s3://sac/${input.key}`,
        size: Buffer.byteLength(input.body),
        sha256: 'x',
      }),
      getObject: async () => Buffer.from(''),
      putToPresignedUrl: async () => undefined,
      presignGet: async () => 'x',
      buildUri: (key: string) => `s3://sac/${key}`,
    },
    cipher: {
      encrypt: (v: string) => v,
      decrypt: (v: string) => v,
      hash: (v: string) => `hash:${v}`,
      keyId: 'k',
    },
    realtime: {
      ticketUpdated: () => undefined,
      messageCreated: () => undefined,
      queueChanged: () => undefined,
      channelHealth: () => undefined,
      agentPresence: () => undefined,
    },
    http: {
      request: async () => {
        throw new Error('network not expected in this test');
      },
      requestBinary: async () => {
        throw new Error('network not expected in this test');
      },
    },
    queue: { publish: async () => 'job', publishToDlq: async () => undefined },
  };
  return deps as unknown as AdapterDependencies;
}

function makeMime(overrides: {
  from: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): Buffer {
  const lines = [
    `From: ${overrides.from}`,
    'To: amazon-relay@sachub.demo',
    `Subject: ${overrides.subject}`,
    'Message-ID: <m1@marketplace.amazon.com.br>',
    'Date: Wed, 05 Nov 2026 11:55:00 -0300',
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (overrides.inReplyTo) lines.push(`In-Reply-To: ${overrides.inReplyTo}`);
  if (overrides.references) lines.push(`References: ${overrides.references}`);
  lines.push('', overrides.body);
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

function parser(deps: AdapterDependencies): SesRelayParser {
  const enrichment = new OrderEnrichmentService(deps, {} as SpApiClient);
  return new SesRelayParser(deps, enrichment, () => undefined);
}

function envelope(payload: Record<string, unknown>) {
  return {
    marketplace: 'AMAZON' as const,
    accountId: 'acc-1',
    payload,
    receivedAt: new Date('2026-11-05T12:00:00Z'),
    eventId: 'evt',
  };
}

describe('SesRelayParser (temporary validation)', () => {
  it('hydrates a pre-sale buyer message', async () => {
    const deps = makeDeps();
    const raw = makeMime({
      from: 'Camila <abc123@marketplace.amazon.com.br>',
      subject: 'Compatibilidade do carregador',
      body: 'Ola, o carregador funciona no Galaxy S23?\n\n------------- Mensagem original -------------\nDe: Amazon <no-reply@amazon.com.br>',
      inReplyTo: '<abc@x>',
      references: '<a@x> <b@y>',
    });
    const messages = await parser(deps).hydrate(
      envelope({ messageId: 'm1', rawMimeBase64: raw.toString('base64') }),
    );
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.direction).toBe('INBOUND_BUYER');
    expect(message.ticketType).toBe('PRE_SALE');
    expect(message.externalReferenceId).toBe('abc123@marketplace.amazon.com.br');
    expect(message.buyer.anonymizedEmail).toBe('abc123@marketplace.amazon.com.br');
    expect(message.buyer.contactHash).toBe('hash:abc123@marketplace.amazon.com.br');
    expect(message.externalMessageId).toBe('m1@marketplace.amazon.com.br');
    expect(message.inReplyToId).toBe('abc@x');
    expect(message.references).toEqual(['a@x', 'b@y']);
    expect(message.bodyCleanText).toBe('Ola, o carregador funciona no Galaxy S23?');
    expect(message.bodyRawS3Uri).toMatch(/^s3:\/\/sac\/amazon\/inbound\/2026\/11\/05\/m1_/);
    expect(message.channelMetadata.subject).toBe('Compatibilidade do carregador');
    expect(message.warnings).toEqual([]);
  });

  it('turns a bounce notice into a BOUNCED_BLOCKED system message on the existing ticket', async () => {
    const deps = makeDeps({ activeTicket: { id: 't1' } });
    const raw = makeMime({
      from: 'Amazon <no-reply@amazon.com.br>',
      subject: 'Sua mensagem nao foi entregue 123-4567890-1234567',
      body: 'Sua mensagem nao pode ser entregue.',
    });
    const messages = await parser(deps).hydrate(
      envelope({ messageId: 'm1', rawMimeBase64: raw.toString('base64') }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.direction).toBe('OUTBOUND_SYSTEM');
    expect(messages[0]!.messageType).toBe('action_system');
    expect(messages[0]!.deliveryStatus).toBe('BOUNCED_BLOCKED');
    expect(messages[0]!.externalOrderId).toBe('123-4567890-1234567');
  });

  it('skips bounce notices without an existing ticket', async () => {
    const deps = makeDeps();
    const raw = makeMime({
      from: 'no-reply@amazon.com.br',
      subject: 'Bounce 123-4567890-1234567',
      body: 'Bounce.',
    });
    const messages = await parser(deps).hydrate(
      envelope({ messageId: 'm1', rawMimeBase64: raw.toString('base64') }),
    );
    expect(messages).toEqual([]);
  });

  it('classifies external seller panel replies and detects opt-out/no-response link', async () => {
    const deps = makeDeps();
    const raw = makeMime({
      from: 'Atendimento <atendimento@minhamarca.com.br>',
      subject: 'Re: Pedido',
      body:
        'Resposta enviada pelo painel.\nNao me envie mais mensagens promocionais.\nhttps://sellercentral.amazon.com/messaging/no-response-needed?orderId=123-4567890-1234567',
    });
    const messages = await parser(deps).hydrate(
      envelope({ messageId: 'm1', rawMimeBase64: raw.toString('base64') }),
    );
    const message = messages[0]!;
    expect(message.direction).toBe('EXTERNAL_SELLER_PANEL');
    expect(message.statusHint).toBe('WAITING_BUYER');
    expect(message.channelMetadata.external_channel).toBe(true);
    expect(message.channelMetadata.buyer_opt_out).toBe(true);
    expect(message.channelMetadata.no_response_link).toContain('sellercentral.amazon.com');
  });

  it('verifies the relay HMAC and resolves the account by inbound route', async () => {
    const deps = makeDeps();
    const raw = makeMime({
      from: 'abc123@marketplace.amazon.com.br',
      subject: 'Oi',
      body: 'Ola',
    });
    const relay = {
      messageId: 'relay-1',
      envelopeFrom: 'abc123@marketplace.amazon.com.br',
      envelopeTo: 'amazon-relay@sachub.demo',
      headers: {},
      rawMimeBase64: raw.toString('base64'),
      receivedAt: '2026-11-05T12:00:00Z',
    };
    const body = Buffer.from(JSON.stringify(relay), 'utf8');
    const signature = createHmac('sha256', 'shared-secret').update(body).digest('hex');
    const request: RawWebhookRequest = {
      method: 'POST',
      url: 'https://sac.test/webhooks/amazon',
      headers: { 'content-type': 'application/json', 'x-sac-signature': signature },
      query: {},
      rawBody: body,
      receivedAt: new Date('2026-11-05T12:00:00Z'),
    };
    const verification = await parser(deps).verify(request);
    expect(verification.valid).toBe(true);
    expect(verification.eventId).toBe('relay-1');
    expect(verification.topic).toBe('email');
    expect(verification.accountLookup.accountId).toBe('acc-1');
  });
});
