import { createHmac, timingSafeEqual } from 'node:crypto';
import { MailParser, simpleParser } from 'mailparser';
import type {
  AddressObject,
  Attachment,
  AttachmentStream,
  Headers,
  HeaderValue,
  MessageText,
  ParsedMail,
} from 'mailparser';
import {
  NotFoundError,
  ValidationError,
  detectOptOut,
  htmlToText,
  redactPiiForLogs,
  stripTrackingPixels,
} from '@sac/shared';
import type {
  AdapterDependencies,
  BuyerPiiSnapshot,
  HydratedInboundMessage,
  InboundAttachmentDescriptor,
  InboundEnvelope,
  ILogger,
  MarketplaceAccountRecord,
  MessageDirection,
  NormalizedOrderSnapshot,
  RawWebhookRequest,
  TicketType,
  WebhookVerification,
} from '@sac/shared';
import {
  MAX_INBOUND_ATTACHMENT_BYTES,
  MAX_IN_MEMORY_MIME_BYTES,
  MAX_PERSISTED_TEXT_CHARS,
  asRecord,
  isRecord,
  readHeaderMap,
  readRawHeader,
  readString,
  sha256Hex,
} from '../guards';
import {
  buildEmlStorageKey,
  buildInboundAttachmentKey,
  keyFromUri,
  parseChannelSettings,
  safeFileName,
} from '../mappers';
import {
  detectSystemSender,
  extractSellerCentralLink,
  isAnonymizedAmazonBuyerEmail,
  isApprovedSellerSender,
  locateOrderId,
  matchesInboundRoute,
  normalizeBodyText,
  normalizeEmailAddress,
  normalizeMessageId,
  splitReferences,
  truncateText,
} from './EmailThreading';
import type { OrderEnrichmentService } from '../client/OrderEnrichment';
import type { AmazonAccountSettings, OrderIdSource, SesRelayPayload } from '../types';

interface RelayParseSuccess {
  ok: true;
  payload: SesRelayPayload;
}

interface RelayParseFailure {
  ok: false;
  reason: string;
}

type RelayParseResult = RelayParseSuccess | RelayParseFailure;

interface BuildMessageParams {
  account: MarketplaceAccountRecord;
  settings: AmazonAccountSettings;
  parsed: ParsedMail;
  envelope: InboundEnvelope;
  messageId: string;
  bodyRawS3Uri: string;
  warnings: string[];
}

/**
 * Amazon inbound relay: HMAC verification, immutable `.eml` persistence and
 * hydration into normalized messages.
 *
 * The relay is an SES-driven HTTP receiver, so the only trust anchor is the
 * `x-sac-signature` HMAC over the exact raw body. Everything after that is
 * defensive decoding: the buyer identity is the Amazon-anonymized address, and
 * bounce/block notices never create tickets.
 */
export class SesRelayParser {
  private readonly deps: AdapterDependencies;
  private readonly enrichment: OrderEnrichmentService;
  private readonly onAccountSeen: (account: MarketplaceAccountRecord) => void;
  private readonly logger: ILogger;

  constructor(
    deps: AdapterDependencies,
    enrichment: OrderEnrichmentService,
    onAccountSeen: (account: MarketplaceAccountRecord) => void,
  ) {
    this.deps = deps;
    this.enrichment = enrichment;
    this.onAccountSeen = onAccountSeen;
    this.logger = deps.logger.child({ component: 'amazon.inbound' });
  }

  /* ======================================================================
   * verifyInbound
   * ==================================================================== */

  async verify(request: RawWebhookRequest): Promise<WebhookVerification> {
    const base: WebhookVerification = {
      valid: false,
      reason: 'UNVERIFIED',
      topic: 'email',
      accountLookup: { marketplace: 'AMAZON' },
      payload: {},
    };

    const secret = this.deps.config.amazon.sesInboundSharedSecret;
    if (!secret) return { ...base, reason: 'AMAZON_RELAY_SECRET_NOT_CONFIGURED' };

    const signature = readRawHeader(request.headers, 'x-sac-signature');
    if (!signature) return { ...base, reason: 'MISSING_SIGNATURE' };
    if (!verifyHmac(request.rawBody, signature, secret)) {
      return { ...base, reason: 'INVALID_SIGNATURE' };
    }

    const relayResult = this.parseRelayBody(request);
    if (!relayResult.ok) return { ...base, reason: relayResult.reason };
    const relay = relayResult.payload;

    const account = await this.resolveAccount(
      readRawHeader(request.headers, 'x-sac-account-id'),
      relay.envelopeTo,
    );
    if (!account) {
      this.logger.warn('amazon.inbound.unknown_account', {
        hasEnvelopeTo: relay.envelopeTo !== null,
      });
      return {
        ...base,
        eventId: relay.messageId,
        reason: 'UNKNOWN_ACCOUNT',
        payload: this.payloadForQueue(relay),
      };
    }
    this.onAccountSeen(account);

    const orderId = locateOrderId({ header: relay.headers['x-amazon-order-id'] ?? null }).orderId;

    return {
      valid: true,
      reason: 'AMAZON_RELAY_HMAC_VALID',
      eventId: relay.messageId,
      topic: 'email',
      resource: orderId,
      accountLookup: { marketplace: 'AMAZON', accountId: account.id },
      payload: this.payloadForQueue(relay),
    };
  }

  /* ======================================================================
   * hydrate
   * ==================================================================== */

  async hydrate(envelope: InboundEnvelope): Promise<HydratedInboundMessage[]> {
    if (envelope.marketplace !== 'AMAZON') {
      throw new ValidationError('AmazonChannelAdapter recebeu envelope de outro marketplace.', {
        marketplace: envelope.marketplace,
      });
    }
    const account = await this.deps.repos.accounts.findById(envelope.accountId);
    if (!account || account.marketplace !== 'AMAZON') {
      throw new NotFoundError('AmazonAccount', envelope.accountId);
    }
    this.onAccountSeen(account);

    const settings = parseChannelSettings(account.channelConfig);
    const payload = asRecord(envelope.payload);
    const warnings: string[] = [];

    const rawMime = await this.loadRawMime(payload, envelope);
    const parsed = await this.parseMime(rawMime);
    const messageId = this.resolveExternalMessageId(parsed, payload, rawMime);
    const bodyRawS3Uri = await this.persistRawEml(
      rawMime,
      messageId,
      envelope.receivedAt,
      account.id,
    );

    const message = await this.buildMessage({
      account,
      settings,
      parsed,
      envelope,
      messageId,
      bodyRawS3Uri,
      warnings,
    });
    return message ? [message] : [];
  }

  /* ======================================================================
   * Message building
   * ==================================================================== */

  private async buildMessage(params: BuildMessageParams): Promise<HydratedInboundMessage | null> {
    const { account, settings, parsed, envelope, messageId, bodyRawS3Uri, warnings } = params;
    const payload = asRecord(envelope.payload);
    const headers = parsed.headers;

    const subjectSource = readParsedHeader(headers, 'subject') ?? parsed.subject ?? null;
    const subject = subjectSource && subjectSource.trim().length > 0
      ? truncateText(subjectSource.trim(), 400)
      : null;

    const fromAddress = normalizeEmailAddress(
      firstAddress(parsed.from) ?? readString(payload.envelopeFrom),
    );
    const toAddress = normalizeEmailAddress(
      firstAddress(parsed.to) ?? readString(payload.envelopeTo),
    );

    const rawHtml =
      typeof parsed.html === 'string' && parsed.html.trim().length > 0 ? parsed.html : null;
    const html = rawHtml
      ? truncateText(stripTrackingPixels(rawHtml), MAX_PERSISTED_TEXT_CHARS)
      : null;
    const rawText =
      parsed.text && parsed.text.trim().length > 0
        ? parsed.text
        : rawHtml
          ? htmlToText(rawHtml)
          : '';
    const bodyText = normalizeBodyText(rawText);

    const inReplyTo = normalizeMessageId(
      readParsedHeader(headers, 'in-reply-to') ?? parsed.inReplyTo,
    );
    const references = splitReferences(
      parsed.references ?? readParsedHeader(headers, 'references'),
    );
    const marketplaceCreatedAt =
      parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : envelope.receivedAt;

    const orderLocation = locateOrderId({
      header: readParsedHeader(headers, 'x-amazon-order-id'),
      subject,
      body: bodyText,
    });

    const systemKind = detectSystemSender(fromAddress);
    const buyerAnonymizedEmail = isAnonymizedAmazonBuyerEmail(fromAddress) ? fromAddress : null;
    const externalSeller =
      systemKind === null && isApprovedSellerSender(fromAddress, settings, buyerAnonymizedEmail);
    const direction: MessageDirection =
      systemKind !== null
        ? 'OUTBOUND_SYSTEM'
        : externalSeller
          ? 'EXTERNAL_SELLER_PANEL'
          : 'INBOUND_BUYER';

    // ---- System senders (bounce/block notices): never create tickets ----
    if (systemKind !== null) {
      const orderId = orderLocation.orderId;
      this.logger.info('amazon.inbound.system_notice', {
        accountId: account.id,
        kind: systemKind,
        hasOrderId: orderId !== null,
      });
      if (!orderId) {
        this.logger.warn('amazon.inbound.system_notice_skipped', {
          accountId: account.id,
          reason: 'missing_order_id',
          kind: systemKind,
        });
        return null;
      }
      const ticket = await this.findTicketByOrder(orderId);
      if (!ticket) {
        this.logger.warn('amazon.inbound.system_notice_skipped', {
          accountId: account.id,
          orderId,
          reason: 'no_ticket',
          kind: systemKind,
        });
        return null;
      }
      const attachments = await this.buildInboundAttachments(
        parsed,
        messageId,
        marketplaceCreatedAt,
        warnings,
      );
      return {
        accountId: account.id,
        marketplace: 'AMAZON',
        externalReferenceId: truncateText(orderId, 180),
        ticketType: 'POST_SALE_ORDER',
        externalOrderId: orderId,
        packId: null,
        claimId: null,
        conversationId: null,
        returnSn: null,
        externalMessageId: messageId,
        inReplyToId: inReplyTo,
        references,
        direction: 'OUTBOUND_SYSTEM',
        channelRouteUsed: 'AMAZON_EMAIL_RELAY',
        messageType: 'action_system',
        bodyCleanText: bodyText,
        bodyHtml: html,
        contentPayload: {
          route: 'AMAZON_EMAIL_RELAY',
          system_kind: systemKind,
          delivery_status: 'BOUNCED_BLOCKED',
        },
        bodyRawS3Uri,
        marketplaceCreatedAt,
        buyer: {},
        order: null,
        buyerPii: null,
        attachments,
        channelMetadata: {
          system_notice_kind: systemKind,
          delivery_status: 'BOUNCED_BLOCKED',
          email_subject: subject,
          email_received_at: marketplaceCreatedAt.toISOString(),
          amazon_order_id: orderId,
        },
        hasActiveClaim: false,
        deliveryStatus: 'BOUNCED_BLOCKED',
        isSystemEvent: true,
        warnings,
      };
    }

    // ---- Buyer / external seller panel message ----
    const buyerContactSource = direction === 'INBOUND_BUYER' ? fromAddress : null;
    const contactHash = buyerContactSource ? this.deps.cipher.hash(buyerContactSource) : null;

    let order: NormalizedOrderSnapshot | null = null;
    let buyerPii: BuyerPiiSnapshot | null = null;
    if (orderLocation.orderId) {
      try {
        const bundle = await this.enrichment.fetchOrderBundle(
          account,
          orderLocation.orderId,
          buyerAnonymizedEmail,
        );
        order = bundle.order;
        buyerPii = bundle.buyerPii;
        warnings.push(...bundle.warnings);
      } catch (error) {
        warnings.push('AMAZON_ORDER_ENRICH_FAILED');
        this.logWarn('fetchOrderBundle', error, account.id, orderLocation.orderId);
      }
    }

    if (buyerPii) {
      await this.persistPiiForExistingTicket({
        accountId: account.id,
        orderId: orderLocation.orderId,
        inReplyTo,
        buyerAnonymizedEmail,
        buyerPii,
        warnings,
      });
    }

    const attachments = await this.buildInboundAttachments(
      parsed,
      messageId,
      marketplaceCreatedAt,
      warnings,
    );
    const sellerCentralLink = extractSellerCentralLink(bodyText, html);
    const optOut = detectOptOut(bodyText);
    const externalReferenceId = truncateText(
      orderLocation.orderId ??
        buyerAnonymizedEmail ??
        (contactHash ? `buyer:${contactHash}` : `email:${messageId}`),
      180,
    );
    const ticketType: TicketType = orderLocation.orderId ? 'POST_SALE_ORDER' : 'PRE_SALE';
    const safeFrom = direction === 'INBOUND_BUYER' ? buyerAnonymizedEmail : fromAddress;

    return {
      accountId: account.id,
      marketplace: 'AMAZON',
      externalReferenceId,
      ticketType,
      externalOrderId: orderLocation.orderId,
      packId: null,
      claimId: null,
      conversationId: null,
      returnSn: null,
      externalMessageId: messageId,
      inReplyToId: inReplyTo,
      references,
      direction,
      channelRouteUsed: 'AMAZON_EMAIL_RELAY',
      messageType: 'email',
      bodyCleanText: bodyText,
      bodyHtml: html,
      contentPayload: {
        route: 'AMAZON_EMAIL_RELAY',
        source: 'SES_RELAY',
        email_subject: subject,
        order_id_source: orderLocation.source,
        in_reply_to: inReplyTo,
        references,
        has_attachments: attachments.length > 0,
      },
      bodyRawS3Uri,
      marketplaceCreatedAt,
      buyer: {
        externalId: null,
        displayName: null,
        anonymizedEmail: buyerAnonymizedEmail,
        contactHash,
      },
      order,
      buyerPii,
      attachments,
      channelMetadata: {
        // `subject` is consumed by UnifiedTicketService.deriveSubject.
        subject,
        email_thread: { in_reply_to: inReplyTo, references, message_id: messageId },
        email_subject: subject,
        email_received_at: marketplaceCreatedAt.toISOString(),
        email_from: safeFrom,
        email_to: toAddress,
        order_id_source: orderLocation.source,
        buyer_opt_out: optOut,
        no_response_link: sellerCentralLink,
        external_channel: direction === 'EXTERNAL_SELLER_PANEL',
        has_attachments: attachments.length > 0,
        attachment_count: attachments.length,
        sources: ['SES_RELAY'],
        ...(warnings.length > 0 ? { enrichment_warnings: [...warnings] } : {}),
      },
      hasActiveClaim: false,
      statusHint: direction === 'EXTERNAL_SELLER_PANEL' ? 'WAITING_BUYER' : undefined,
      isSystemEvent: false,
      warnings,
    };
  }

  private async findTicketByOrder(
    orderId: string,
  ): Promise<{ id: string } | null> {
    const active = await this.deps.repos.tickets.findActiveByExternalOrderId('AMAZON', orderId, 60);
    if (active) return { id: active.id };
    const byReference = await this.deps.repos.tickets.findByExternalReference('AMAZON', orderId);
    return byReference ? { id: byReference.id } : null;
  }

  private async persistPiiForExistingTicket(input: {
    accountId: string;
    orderId: string | null;
    inReplyTo: string | null;
    buyerAnonymizedEmail: string | null;
    buyerPii: BuyerPiiSnapshot;
    warnings: string[];
  }): Promise<void> {
    try {
      const ticket = await this.deps.repos.tickets.findThreadingMatch({
        marketplace: 'AMAZON',
        accountId: input.accountId,
        inReplyToIds: input.inReplyTo ? [input.inReplyTo] : undefined,
        externalOrderId: input.orderId,
        buyerAnonymizedEmail: input.buyerAnonymizedEmail,
        activeWithinDays: 30,
      });
      // No ticket yet: `ingest()` creates it and persists `message.buyerPii`.
      if (!ticket) return;
      await this.enrichment.persistPii(ticket.id, input.buyerPii);
    } catch (error) {
      input.warnings.push('AMAZON_PII_PERSIST_FAILED');
      this.logWarn('persistPii', error, input.accountId, input.orderId);
    }
  }

  /* ======================================================================
   * Relay parsing
   * ==================================================================== */

  private parseRelayBody(request: RawWebhookRequest): RelayParseResult {
    const contentType = (readRawHeader(request.headers, 'content-type') ?? '').toLowerCase();
    const isRawMime = contentType.includes('message/rfc822');
    const text = request.rawBody.toString('utf8').trimStart();
    if (!isRawMime && text.startsWith('{')) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(text) as unknown;
      } catch {
        return { ok: false, reason: 'INVALID_RELAY_JSON' };
      }
      if (!isRecord(decoded)) return { ok: false, reason: 'INVALID_RELAY_JSON' };
      return this.normalizeJsonRelay(decoded, request);
    }
    return { ok: true, payload: this.parseRawMimeRelay(request) };
  }

  private normalizeJsonRelay(json: Record<string, unknown>, request: RawWebhookRequest): RelayParseResult {
    const headers = readHeaderMap(json.headers ?? json.Headers);
    const rawMimeBase64 =
      readBase64Field(json.rawMimeBase64) ?? encodeRawMimeString(json.rawMime);
    if (!rawMimeBase64) return { ok: false, reason: 'MISSING_RAW_MIME' };

    const messageId =
      readString(json.messageId) ??
      readString(headers['x-sac-message-id']) ??
      normalizeMessageId(headers['message-id']) ??
      sha256Hex(rawMimeBase64);
    const envelopeFrom =
      readString(json.envelopeFrom) ??
      readString(headers['x-sac-envelope-from']) ??
      normalizeEmailAddress(headers['from']);
    const envelopeTo =
      readString(json.envelopeTo) ??
      readString(headers['x-sac-envelope-to']) ??
      normalizeEmailAddress(headers['to']);
    const receivedAt =
      readString(json.receivedAt) ?? request.receivedAt.toISOString();

    return {
      ok: true,
      payload: {
        messageId: truncateText(messageId, 400),
        envelopeFrom,
        envelopeTo,
        headers,
        rawMimeBase64,
        receivedAt,
      },
    };
  }

  private parseRawMimeRelay(request: RawWebhookRequest): SesRelayPayload {
    const headers = parseRawHeaderBlock(request.rawBody);
    const messageId =
      readString(headers['x-sac-message-id']) ??
      normalizeMessageId(headers['message-id']) ??
      sha256Hex(request.rawBody);
    const envelopeFrom =
      readString(headers['x-sac-envelope-from']) ?? normalizeEmailAddress(headers['from']);
    const envelopeTo =
      readString(headers['x-sac-envelope-to']) ?? normalizeEmailAddress(headers['to']);
    return {
      messageId: truncateText(messageId, 400),
      envelopeFrom,
      envelopeTo,
      headers,
      rawMimeBase64: request.rawBody.toString('base64'),
      receivedAt: request.receivedAt.toISOString(),
    };
  }

  private payloadForQueue(relay: SesRelayPayload): Record<string, unknown> {
    return {
      messageId: relay.messageId,
      envelopeFrom: relay.envelopeFrom,
      envelopeTo: relay.envelopeTo,
      headers: relay.headers,
      rawMimeBase64: relay.rawMimeBase64,
      receivedAt: relay.receivedAt,
    };
  }

  private async resolveAccount(
    accountHeader: string | null,
    envelopeTo: string | null,
  ): Promise<MarketplaceAccountRecord | null> {
    if (accountHeader) {
      const byId = await this.deps.repos.accounts.findById(accountHeader);
      return byId && byId.marketplace === 'AMAZON' ? byId : null;
    }
    if (!envelopeTo) return null;
    const accounts = await this.deps.repos.accounts.list({ marketplace: 'AMAZON' });
    for (const account of accounts) {
      const settings = parseChannelSettings(account.channelConfig);
      if (matchesInboundRoute(envelopeTo, settings.inboundEmailRoutes)) return account;
    }
    return null;
  }

  private async loadRawMime(
    payload: Record<string, unknown>,
    envelope: InboundEnvelope,
  ): Promise<Buffer> {
    const inline = readBase64Field(payload.rawMimeBase64);
    if (inline) return Buffer.from(inline, 'base64');

    const rawMime =
      typeof payload.rawMime === 'string' && payload.rawMime.length > 0
        ? payload.rawMime
        : null;
    if (rawMime) return Buffer.from(rawMime, 'utf8');

    if (envelope.rawS3Uri) {
      const stored = await this.deps.storage.getObject(keyFromUri(envelope.rawS3Uri));
      if (stored.byteLength > 0) return stored;
    }

    throw new ValidationError(
      'Envelope Amazon sem MIME bruto (rawMimeBase64/rawMime/rawS3Uri).',
      { accountId: envelope.accountId, eventId: envelope.eventId ?? null },
    );
  }

  private async parseMime(rawMime: Buffer): Promise<ParsedMail> {
    if (rawMime.byteLength > MAX_IN_MEMORY_MIME_BYTES) {
      return this.parseMimeStreaming(rawMime);
    }
    return simpleParser(rawMime, { keepCidLinks: true });
  }

  /**
   * Streaming fallback for messages > 5 MB (contract requirement): buffers only
   * the parts we consume (text + attachments) instead of the whole MIME tree.
   */
  private async parseMimeStreaming(rawMime: Buffer): Promise<ParsedMail> {
    return await new Promise<ParsedMail>((resolve, reject) => {
      const parser = new MailParser({ skipImageLinks: true });
      const attachments: Attachment[] = [];
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      parser.on('error', fail);
      parser.on('data', (data: AttachmentStream | MessageText) => {
        if (data.type !== 'attachment') return;
        const attachment = data;
        const chunks: Buffer[] = [];
        attachment.content.on('data', (chunk: Buffer) => chunks.push(chunk));
        attachment.content.on('error', fail);
        attachment.content.on('end', () => {
          const content = Buffer.concat(chunks);
          attachments.push({
            type: 'attachment',
            contentType: attachment.contentType,
            partId: attachment.partId,
            contentDisposition: attachment.contentDisposition,
            filename: attachment.filename,
            headers: attachment.headers,
            contentId: attachment.contentId,
            cid: attachment.cid,
            related: attachment.related,
            content,
            release: null,
            checksum: sha256Hex(content),
            size: content.byteLength,
          });
          attachment.release?.();
        });
      });
      parser.on('end', () => {
        if (settled) return;
        settled = true;
        const headers: Headers =
          parser.headers === false ? new Map<string, HeaderValue>() : parser.headers;
        resolve({
          attachments,
          headers,
          headerLines: parser.headerLines === false ? [] : parser.headerLines,
          html: parser.html,
          text: parser.text === false ? undefined : parser.text,
          textAsHtml: parser.textAsHtml === false ? undefined : parser.textAsHtml,
          subject: parser.subject,
          references: parser.references,
          date: parser.date,
          to: parser.to,
          from: parser.from,
          cc: parser.cc,
          bcc: parser.bcc,
          messageId: parser.messageId,
          inReplyTo: parser.inReplyTo,
          replyTo: parser.replyTo,
        });
      });
      parser.end(rawMime);
    });
  }

  private resolveExternalMessageId(
    parsed: ParsedMail,
    payload: Record<string, unknown>,
    rawMime: Buffer,
  ): string {
    const id =
      normalizeMessageId(parsed.messageId) ??
      normalizeMessageId(readParsedHeader(parsed.headers, 'message-id')) ??
      normalizeMessageId(readParsedHeader(parsed.headers, 'x-sac-message-id')) ??
      normalizeMessageId(readString(payload.messageId)) ??
      sha256Hex(rawMime);
    return truncateText(id, 400);
  }

  private async persistRawEml(
    rawMime: Buffer,
    messageId: string,
    receivedAt: Date,
    accountId: string,
  ): Promise<string> {
    const key = buildEmlStorageKey(receivedAt, messageId);
    const stored = await this.deps.storage.putObject({
      key,
      body: rawMime,
      contentType: 'message/rfc822',
      metadata: { marketplace: 'AMAZON', accountId, messageId },
    });
    return stored.uri;
  }

  private async buildInboundAttachments(
    parsed: ParsedMail,
    messageId: string,
    marketplaceCreatedAt: Date,
    warnings: string[],
  ): Promise<InboundAttachmentDescriptor[]> {
    const descriptors: InboundAttachmentDescriptor[] = [];
    let index = 0;
    for (const attachment of parsed.attachments) {
      index += 1;
      const fileName = safeFileName(attachment.filename ?? '', `anexo-${index}`);
      const sizeBytes = Number.isFinite(attachment.size)
        ? attachment.size
        : attachment.content.byteLength;
      if (sizeBytes > MAX_INBOUND_ATTACHMENT_BYTES) {
        warnings.push(`AMAZON_ATTACHMENT_TOO_LARGE:${fileName}`);
        continue;
      }
      const key = buildInboundAttachmentKey(marketplaceCreatedAt, messageId, fileName, index);
      try {
        const stored = await this.deps.storage.putObject({
          key,
          body: attachment.content,
          contentType: attachment.contentType || 'application/octet-stream',
          metadata: { marketplace: 'AMAZON', messageId },
        });
        descriptors.push({
          fileName,
          mimeType: attachment.contentType || 'application/octet-stream',
          sizeBytes,
          s3Key: stored.key,
          sha256: sha256Hex(attachment.content),
          isEvidence: false,
        });
      } catch (error) {
        warnings.push(`AMAZON_ATTACHMENT_UPLOAD_FAILED:${fileName}`);
        this.logWarn('attachmentUpload', error, undefined, null);
      }
    }
    return descriptors;
  }

  private logWarn(
    operation: string,
    error: unknown,
    accountId: string | undefined,
    orderId: string | null,
  ): void {
    const message = error instanceof Error ? redactPiiForLogs(error.message) : 'erro desconhecido';
    this.logger.warn('amazon.inbound.degraded', {
      operation,
      accountId: accountId ?? null,
      orderId,
      error: message,
    });
  }
}

/* ==========================================================================
 * Module-level helpers
 * ========================================================================== */

function verifyHmac(rawBody: Buffer, providedSignature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const normalized = providedSignature.trim().toLowerCase().replace(/^sha256=/, '');
  if (!/^[0-9a-f]{64}$/.test(normalized)) return false;
  const provided = Buffer.from(normalized, 'hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function readBase64Field(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.replace(/\s+/g, '');
  if (raw.length === 0) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(raw)) return null;
  const decoded = Buffer.from(raw, 'base64');
  return decoded.byteLength > 0 ? raw : null;
}

function encodeRawMimeString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return Buffer.from(value, 'utf8').toString('base64');
}

function readParsedHeader(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim().length > 0) return entry.trim();
    }
    return null;
  }
  if (value instanceof Date) return value.toISOString();
  return null;
}

function firstAddress(value: AddressObject | AddressObject[] | undefined): string | null {
  if (!value) return null;
  const groups = Array.isArray(value) ? value : [value];
  for (const group of groups) {
    for (const entry of group.value) {
      if (typeof entry.address === 'string' && entry.address.length > 0) return entry.address;
    }
  }
  return null;
}

/** Cheap header-only parse of the raw MIME block (no body decoding). */
function parseRawHeaderBlock(raw: Buffer): Record<string, string> {
  const text = raw.subarray(0, Math.min(raw.byteLength, 128 * 1024)).toString('utf8');
  const separator = /\r?\n\r?\n/.exec(text);
  const headerText = separator ? text.slice(0, separator.index) : text;
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (key.length === 0 || value.length === 0) continue;
    if (headers[key] === undefined) headers[key] = value;
  }
  return headers;
}
