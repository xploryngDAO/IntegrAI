import { randomUUID } from 'node:crypto';
import { createTransport } from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import {
  MarketplaceApiError,
  ValidationError,
  applyImportantPrefix,
  ensureReplySubject,
  htmlToText,
  redactPiiForLogs,
  stripTrackingPixels,
} from '@sac/shared';
import type {
  AdapterDependencies,
  ILogger,
  OutboundAttachmentInput,
  OutboundDraft,
  OutboundResult,
} from '@sac/shared';
import {
  MAX_PERSISTED_TEXT_CHARS,
  MAX_RELAY_ATTACHMENT_BYTES,
  asRecord,
  readString,
} from '../guards';
import { keyFromUri } from '../mappers';
import { normalizeEmailAddress, normalizeMessageId, truncateText } from '../inbound/EmailThreading';
import type { AmazonAccountSettings } from '../types';

export interface RelayContent {
  text: string;
  html: string | null;
}

interface LoadedAttachment {
  fileName: string;
  mimeType: string;
  content: Buffer;
}

/**
 * Route 1 — Buyer-Seller relay over SMTP.
 *
 * Required for receptive replies: Amazon forbids proactive e-mail contact with
 * buyers who never messaged the seller, so this route is only used when the
 * ticket has a prior inbound buyer message. Preserves `Re:` subject,
 * `In-Reply-To`/`References` threading and the `[Important]` prefix.
 */
export class EmailRelaySender {
  private readonly deps: AdapterDependencies;
  private readonly logger: ILogger;
  private transporterInstance: ReturnType<typeof createTransport> | null = null;

  constructor(deps: AdapterDependencies) {
    this.deps = deps;
    this.logger = deps.logger.child({ component: 'amazon.outbound.relay' });
  }

  async send(
    draft: OutboundDraft,
    settings: AmazonAccountSettings,
    content: RelayContent,
  ): Promise<OutboundResult> {
    const from = this.resolveFrom(draft, settings);
    const to = this.resolveTo(draft);
    const subject = applyImportantPrefix(
      ensureReplySubject(draft.subject ?? ''),
      Boolean(draft.forceImportant),
    );
    const text = this.buildText(content, draft);
    const html = content.html
      ? truncateText(stripTrackingPixels(content.html), MAX_PERSISTED_TEXT_CHARS)
      : null;
    const attachments = await this.loadAttachments(draft.attachments);

    const mailOptions: SendMailOptions = {
      from,
      to,
      subject,
      text: text.length > 0 ? text : undefined,
      html: html ?? undefined,
      inReplyTo: bracketMessageId(draft.inReplyToId),
      references:
        draft.references && draft.references.length > 0
          ? draft.references
              .map((reference) => bracketMessageId(reference) ?? reference)
              .join(' ')
          : undefined,
      attachments: attachments.map((attachment) => ({
        filename: attachment.fileName,
        content: attachment.content,
        contentType: attachment.mimeType,
      })),
    };

    let info: unknown;
    try {
      info = await this.transporter().sendMail(mailOptions);
    } catch (error) {
      throw mapSmtpError(error);
    }

    const infoRecord = asRecord(info);
    const rawMessageId = readString(infoRecord.messageId) ?? `sac-amazon-${randomUUID()}`;
    // Persist the Message-ID in the same normalized form inbound parsing uses
    // (no angle brackets) so `In-Reply-To` matching keeps working.
    const messageId = truncateText(normalizeMessageId(rawMessageId) ?? rawMessageId, 400);
    const rejected = Array.isArray(infoRecord.rejected) ? infoRecord.rejected : [];
    if (rejected.length > 0) {
      throw new MarketplaceApiError(
        'AMAZON',
        422,
        'O relay SMTP recusou um ou mais destinatários da mensagem.',
        { rejectedCount: rejected.length, ticketId: draft.ticketId },
        false,
      );
    }

    this.logger.info('amazon.outbound.relay_sent', {
      ticketId: draft.ticketId,
      accountId: draft.accountId,
      messageId,
      attachmentCount: attachments.length,
    });

    return {
      routeUsed: 'AMAZON_EMAIL_RELAY',
      externalMessageId: messageId,
      deliveryStatus: 'SENT',
      contentPayload: {
        route: 'AMAZON_EMAIL_RELAY',
        smtpMessageId: messageId,
        from,
        to,
        subject,
        accepted: Array.isArray(infoRecord.accepted) ? infoRecord.accepted.length : null,
        rejected: rejected.length,
        attachmentCount: attachments.length,
      },
      marketplaceCreatedAt: this.deps.clock.now(),
      attachments: draft.attachments.map((attachment) => ({
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        s3Uri: this.deps.storage.buildUri(keyFromUri(attachment.s3Key)),
        externalUploadId: null,
      })),
    };
  }

  private transporter(): ReturnType<typeof createTransport> {
    if (!this.transporterInstance) {
      const smtp = this.deps.config.smtp;
      this.transporterInstance = createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth:
          smtp.user && smtp.password
            ? { user: smtp.user, pass: smtp.password }
            : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      });
    }
    return this.transporterInstance;
  }

  private resolveFrom(draft: OutboundDraft, settings: AmazonAccountSettings): string {
    const from = normalizeEmailAddress(draft.smtpSenderEmail ?? settings.smtpSenderEmail);
    if (!from) {
      throw new ValidationError(
        'Rota SMTP Amazon exige um remetente aprovado (smtp_sender_email) configurado na conta.',
        { accountId: draft.accountId },
      );
    }
    return from;
  }

  private resolveTo(draft: OutboundDraft): string {
    const to = normalizeEmailAddress(draft.buyerAnonymizedEmail);
    if (!to) {
      throw new ValidationError(
        'Rota SMTP Amazon exige o e-mail anonimizado do comprador.',
        { ticketId: draft.ticketId },
      );
    }
    return to;
  }

  private buildText(content: RelayContent, draft: OutboundDraft): string {
    const source =
      content.text && content.text.trim().length > 0
        ? content.text
        : content.html
          ? htmlToText(content.html)
          : draft.bodyText;
    return truncateText(source ?? '', MAX_PERSISTED_TEXT_CHARS);
  }

  private async loadAttachments(
    inputs: readonly OutboundAttachmentInput[],
  ): Promise<LoadedAttachment[]> {
    const declaredBytes = inputs.reduce(
      (total, input) => total + (Number.isFinite(input.sizeBytes) ? input.sizeBytes : 0),
      0,
    );
    if (declaredBytes > MAX_RELAY_ATTACHMENT_BYTES) {
      throw new ValidationError(
        'Anexos excedem o limite de 10 MB do Buyer-Seller relay.',
        { declaredBytes, limitBytes: MAX_RELAY_ATTACHMENT_BYTES },
      );
    }

    const loaded: LoadedAttachment[] = [];
    let totalBytes = 0;
    for (const input of inputs) {
      const content = await this.deps.storage.getObject(keyFromUri(input.s3Key));
      totalBytes += content.byteLength;
      if (totalBytes > MAX_RELAY_ATTACHMENT_BYTES) {
        throw new ValidationError(
          'Anexos excedem o limite de 10 MB do Buyer-Seller relay.',
          { totalBytes, limitBytes: MAX_RELAY_ATTACHMENT_BYTES },
        );
      }
      loaded.push({
        fileName: input.fileName,
        mimeType: input.mimeType || 'application/octet-stream',
        content,
      });
    }
    return loaded;
  }
}

/* ==========================================================================
 * Helpers
 * ========================================================================== */

function bracketMessageId(value: string | null | undefined): string | undefined {
  const id = normalizeMessageId(value);
  return id ? `<${id}>` : undefined;
}

function mapSmtpError(error: unknown): MarketplaceApiError {
  const code = readString(asRecord(error).code);
  const message = error instanceof Error ? redactPiiForLogs(error.message) : 'erro SMTP desconhecido';
  const transientCodes = [
    'ECONNECTION',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ESOCKET',
    'ECONNRESET',
    'EDNS',
    'EAI_AGAIN',
    'EPROTOCOL',
  ];
  const retryable = code !== null && (transientCodes.includes(code) || /^E5/.test(code));
  return new MarketplaceApiError(
    'AMAZON',
    retryable ? 503 : 422,
    `Falha no relay SMTP: ${message}`,
    { code },
    retryable,
  );
}
