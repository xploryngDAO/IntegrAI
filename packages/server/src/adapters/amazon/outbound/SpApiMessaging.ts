import { createHash, randomUUID } from 'node:crypto';
import {
  MarketplaceApiError,
  ValidationError,
  redactPiiForLogs,
} from '@sac/shared';
import type {
  AdapterDependencies,
  ILogger,
  MarketplaceAccountRecord,
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
import { truncateText } from '../inbound/EmailThreading';
import type { SpApiClient } from '../client/SpApiClient';

export interface ProactiveContent {
  text: string;
}

interface LoadedAttachment {
  fileName: string;
  mimeType: string;
  content: Buffer;
  md5Base64: string;
}

/**
 * Route 2 — proactive SP-API messaging.
 *
 * Used only when the buyer never wrote to us (Amazon forbids the SMTP relay in
 * that case). Uploads each attachment through
 * `POST /uploads/2020-11-01/uploadDestinations/messaging` (Content-MD5 of the
 * bytes), PUTs the raw bytes to the pre-signed URL, then sends the message with
 * `POST /messaging/v1/orders/{orderId}/messages/{actionName}` — all on the
 * 1 req/s `amazon:messaging` token bucket.
 */
export class SpApiMessaging {
  private readonly deps: AdapterDependencies;
  private readonly spApi: SpApiClient;
  private readonly logger: ILogger;

  constructor(deps: AdapterDependencies, spApi: SpApiClient) {
    this.deps = deps;
    this.spApi = spApi;
    this.logger = deps.logger.child({ component: 'amazon.outbound.spapi' });
  }

  async send(
    draft: OutboundDraft,
    account: MarketplaceAccountRecord,
    actionName: string,
    content: ProactiveContent,
  ): Promise<OutboundResult> {
    const orderId = draft.externalOrderId;
    if (!orderId) {
      throw new ValidationError(
        'Mensagem proativa Amazon exige o order id do pedido.',
        { ticketId: draft.ticketId, actionName },
      );
    }
    const marketplaceId = account.marketplaceSiteId;
    if (!marketplaceId) {
      throw new ValidationError('Conta Amazon sem marketplaceSiteId configurado.', {
        accountId: account.id,
      });
    }
    const text = truncateText((content.text ?? '').trim(), MAX_PERSISTED_TEXT_CHARS);
    if (text.length === 0) {
      throw new ValidationError('Mensagem proativa Amazon não pode ter corpo vazio.', {
        ticketId: draft.ticketId,
        actionName,
      });
    }

    const attachments = await this.loadAttachments(draft);
    const uploaded: Array<{ uploadDestinationId: string; fileName: string }> = [];
    for (const attachment of attachments) {
      const destination = await this.spApi.createMessagingUploadDestination(
        account.id,
        marketplaceId,
        attachment.md5Base64,
      );
      try {
        await this.deps.storage.putToPresignedUrl(destination.url, attachment.content);
      } catch (error) {
        const message = error instanceof Error ? redactPiiForLogs(error.message) : 'erro de transporte';
        this.logger.warn('amazon.outbound.attachment_upload_failed', {
          ticketId: draft.ticketId,
          fileName: attachment.fileName,
          error: message,
        });
        throw new MarketplaceApiError(
          'AMAZON',
          502,
          `Falha ao enviar anexo "${attachment.fileName}" para o uploadDestination do Amazon.`,
          { fileName: attachment.fileName, uploadDestinationId: destination.uploadDestinationId },
          true,
        );
      }
      uploaded.push({
        uploadDestinationId: destination.uploadDestinationId,
        fileName: attachment.fileName,
      });
    }

    const responseMessageId = await this.spApi.sendMessagingMessage(
      account.id,
      marketplaceId,
      orderId,
      actionName,
      { text, attachments: uploaded },
    );
    const externalMessageId = truncateText(
      responseMessageId ?? `sac-amazon-${randomUUID()}`,
      400,
    );

    this.logger.info('amazon.outbound.spapi_sent', {
      ticketId: draft.ticketId,
      accountId: account.id,
      actionName,
      messageId: externalMessageId,
      attachmentCount: uploaded.length,
    });

    return {
      routeUsed: 'AMAZON_SP_API_MESSAGING',
      externalMessageId,
      deliveryStatus: 'SENT',
      contentPayload: {
        route: 'AMAZON_SP_API_MESSAGING',
        actionName,
        marketplaceId,
        uploadDestinationIds: uploaded.map((item) => item.uploadDestinationId),
        attachmentCount: uploaded.length,
      },
      marketplaceCreatedAt: this.deps.clock.now(),
      attachments: draft.attachments.map((attachment, index) => ({
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        s3Uri: this.deps.storage.buildUri(keyFromUri(attachment.s3Key)),
        externalUploadId: uploaded[index]?.uploadDestinationId ?? null,
      })),
    };
  }

  private async loadAttachments(draft: OutboundDraft): Promise<LoadedAttachment[]> {
    const declaredBytes = draft.attachments.reduce(
      (total, attachment) =>
        total + (Number.isFinite(attachment.sizeBytes) ? attachment.sizeBytes : 0),
      0,
    );
    if (declaredBytes > MAX_RELAY_ATTACHMENT_BYTES) {
      throw new ValidationError(
        'Anexos excedem o limite de 10 MB da mensageria SP-API.',
        { declaredBytes, limitBytes: MAX_RELAY_ATTACHMENT_BYTES },
      );
    }

    const loaded: LoadedAttachment[] = [];
    let totalBytes = 0;
    for (const attachment of draft.attachments) {
      const content = await this.deps.storage.getObject(keyFromUri(attachment.s3Key));
      totalBytes += content.byteLength;
      if (totalBytes > MAX_RELAY_ATTACHMENT_BYTES) {
        throw new ValidationError(
          'Anexos excedem o limite de 10 MB da mensageria SP-API.',
          { totalBytes, limitBytes: MAX_RELAY_ATTACHMENT_BYTES },
        );
      }
      loaded.push({
        fileName: attachment.fileName,
        mimeType: attachment.mimeType || 'application/octet-stream',
        content,
        md5Base64: createHash('md5').update(content).digest('base64'),
      });
    }
    return loaded;
  }
}

/** Re-exported so callers can inspect the exact response body without `any`. */
export function readMessageId(value: unknown): string | null {
  const record = asRecord(value);
  return readString(record.messageId) ?? readString(asRecord(record.payload).messageId);
}
