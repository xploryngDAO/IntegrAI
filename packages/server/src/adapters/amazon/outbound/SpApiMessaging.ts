import { createHash, randomUUID } from 'node:crypto';
import { MarketplaceApiError, ValidationError, redactPiiForLogs } from '@sac/shared';
import type {
  AdapterDependencies,
  AmazonProactiveAction,
  ILogger,
  MarketplaceAccountRecord,
  OutboundDraft,
  OutboundResult,
} from '@sac/shared';
import {
  MAX_RELAY_ATTACHMENT_BYTES,
  asRecord,
  readDate,
  readString,
} from '../guards';
import { keyFromUri } from '../mappers';
import { truncateText } from '../inbound/EmailThreading';
import { isAmazonProactiveAction } from './routeDecision';
import type { SpApiClient } from '../client/SpApiClient';

/**
 * Per-action request constraints from the official Messaging API v1 model
 * (`models/messaging-api-model/messaging.json`):
 *
 * - `confirmDeliveryDetails` / `unexpectedProblem`: `{ text }`, max 2000 chars,
 *   no attachments;
 * - `confirmCustomizationDetails`: `{ text (<=800), attachments (<=5) }`;
 * - `warranty`: `{ attachments (<=5), coverageStartDate?, coverageEndDate? }`
 *   — this action has NO free-text field.
 */
export interface AmazonMessagingActionSpec {
  supportsText: boolean;
  maxTextLength: number;
  maxAttachments: number;
}

export const AMAZON_MESSAGING_ACTION_SPECS: Record<
  AmazonProactiveAction,
  AmazonMessagingActionSpec
> = {
  confirmDeliveryDetails: { supportsText: true, maxTextLength: 2_000, maxAttachments: 0 },
  unexpectedProblem: { supportsText: true, maxTextLength: 2_000, maxAttachments: 0 },
  confirmCustomizationDetails: { supportsText: true, maxTextLength: 800, maxAttachments: 5 },
  warranty: { supportsText: false, maxTextLength: 0, maxAttachments: 5 },
};

export interface ProactiveContent {
  text?: string;
  /** Optional raw request metadata (e.g. warranty coverage dates). */
  metadata?: Record<string, unknown>;
}

export interface MessagingAttachmentRef {
  uploadDestinationId: string;
  fileName: string;
}

interface LoadedAttachment {
  fileName: string;
  mimeType: string;
  content: Buffer;
  md5Base64: string;
}

/**
 * Builds the exact JSON body accepted by each Messaging API operation.
 * Exported (pure) so unit tests can pin the wire format.
 */
export function buildMessagingRequestBody(
  actionName: AmazonProactiveAction,
  input: {
    text?: string;
    attachments?: MessagingAttachmentRef[];
    coverageStartDate?: string | null;
    coverageEndDate?: string | null;
  },
): Record<string, unknown> {
  const spec = AMAZON_MESSAGING_ACTION_SPECS[actionName];
  const body: Record<string, unknown> = {};
  if (spec.supportsText) body.text = input.text ?? '';
  if (spec.maxAttachments > 0 && input.attachments && input.attachments.length > 0) {
    body.attachments = input.attachments;
  }
  if (actionName === 'warranty') {
    if (input.coverageStartDate) body.coverageStartDate = input.coverageStartDate;
    if (input.coverageEndDate) body.coverageEndDate = input.coverageEndDate;
  }
  return body;
}

/**
 * Route 2 — proactive SP-API messaging.
 *
 * Used only when the buyer never wrote to us (Amazon forbids the SMTP relay in
 * that case). Attachments are uploaded through
 * `POST /uploads/2020-11-01/uploadDestinations/{messaging resource}` with the
 * required `marketplaceIds` + `contentMD5` query parameters, the raw bytes are
 * PUT to the pre-signed URL using the response `payload.headers`, and the
 * message is sent with
 * `POST /messaging/v1/orders/{orderId}/messages/{actionName}?marketplaceIds=<id>`
 * on the 1 req/s `amazon:messaging` token bucket.
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
    if (!isAmazonProactiveAction(actionName)) {
      throw new ValidationError(
        `Ação de mensageria "${actionName}" não é uma ação proativa Amazon permitida.`,
        { actionName },
      );
    }
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

    const spec = AMAZON_MESSAGING_ACTION_SPECS[actionName];
    const metadata = asRecord(content.metadata ?? draft.metadata);
    const text = (content.text ?? '').trim();
    const coverageStartDate = readActionDate(metadata, 'coverageStartDate', 'coverage_start_date');
    const coverageEndDate = readActionDate(metadata, 'coverageEndDate', 'coverage_end_date');

    validateActionContent(actionName, spec, {
      text,
      attachmentCount: draft.attachments.length,
      coverageStartDate,
      coverageEndDate,
    });

    const attachments = await this.loadAttachments(draft, spec);
    const uploaded: MessagingAttachmentRef[] = [];
    for (const attachment of attachments) {
      const destination = await this.spApi.createMessagingUploadDestination(
        account.id,
        marketplaceId,
        orderId,
        actionName,
        attachment.md5Base64,
      );
      try {
        // The response `payload.headers` are part of the S3 signature and must
        // be forwarded verbatim on the presigned PUT.
        await this.deps.storage.putToPresignedUrl(
          destination.url,
          attachment.content,
          destination.headers,
        );
      } catch (error) {
        const message =
          error instanceof Error ? redactPiiForLogs(error.message) : 'erro de transporte';
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

    const body = buildMessagingRequestBody(actionName, {
      text,
      attachments: uploaded,
      coverageStartDate,
      coverageEndDate,
    });
    const responseMessageId = await this.spApi.sendMessagingMessage(
      account.id,
      marketplaceId,
      orderId,
      actionName,
      body,
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
        ...(coverageStartDate ? { coverage_start_date: coverageStartDate } : {}),
        ...(coverageEndDate ? { coverage_end_date: coverageEndDate } : {}),
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

  private async loadAttachments(
    draft: OutboundDraft,
    spec: AmazonMessagingActionSpec,
  ): Promise<LoadedAttachment[]> {
    if (spec.maxAttachments === 0) return [];

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

/* ==========================================================================
 * Pure helpers
 * ========================================================================== */

export function validateActionContent(
  actionName: AmazonProactiveAction,
  spec: AmazonMessagingActionSpec,
  input: {
    text: string;
    attachmentCount: number;
    coverageStartDate?: string | null;
    coverageEndDate?: string | null;
  },
): void {
  if (spec.supportsText) {
    if (input.text.length === 0) {
      throw new ValidationError(
        `A ação "${actionName}" exige texto na mensagem.`,
        { actionName },
      );
    }
    if (input.text.length > spec.maxTextLength) {
      throw new ValidationError(
        `O texto da ação "${actionName}" excede o limite de ${spec.maxTextLength} caracteres do SP-API (${input.text.length}).`,
        { actionName, length: input.text.length, maxLength: spec.maxTextLength },
      );
    }
  } else if (input.text.length > 0) {
    throw new ValidationError(
      `A ação "${actionName}" do SP-API não aceita texto livre (apenas anexos/datas de cobertura). Remova o texto ou use outra ação proativa.`,
      { actionName },
    );
  }

  if (spec.maxAttachments === 0) {
    if (input.attachmentCount > 0) {
      throw new ValidationError(
        `A ação "${actionName}" do SP-API não aceita anexos. Use "confirmCustomizationDetails" ou "warranty" para enviar arquivos.`,
        { actionName, attachmentCount: input.attachmentCount },
      );
    }
    return;
  }

  if (input.attachmentCount > spec.maxAttachments) {
    throw new ValidationError(
      `A ação "${actionName}" aceita no máximo ${spec.maxAttachments} anexos (recebidos ${input.attachmentCount}).`,
      { actionName, attachmentCount: input.attachmentCount, maxAttachments: spec.maxAttachments },
    );
  }

  if (actionName === 'warranty') {
    const hasCoverage = Boolean(input.coverageStartDate) || Boolean(input.coverageEndDate);
    if (input.attachmentCount === 0 && !hasCoverage) {
      throw new ValidationError(
        'A ação "warranty" exige ao menos um anexo ou datas de cobertura (coverageStartDate/coverageEndDate) no payload.',
        { actionName },
      );
    }
  }
}

function readActionDate(
  metadata: Record<string, unknown>,
  primaryKey: string,
  alternateKey: string,
): string | null {
  const raw = readString(metadata[primaryKey]) ?? readString(metadata[alternateKey]);
  if (!raw) return null;
  const parsed = readDate(raw);
  if (!parsed) {
    throw new ValidationError(
      `Data inválida em "${primaryKey}": informe um timestamp ISO-8601.`,
      { key: primaryKey },
    );
  }
  return parsed.toISOString();
}
