import type {
  AttachmentView,
  MessageAttachmentRecord,
  MessageView,
  TicketMessageRecord,
} from '@sac/shared';

import { asRecord, truncate } from './common';

const PREVIEW_LENGTH = 180;

/**
 * Message -> JSON projection.
 *
 * `downloadUrl` is intentionally left `null` here: presigning every attachment of
 * every thread on a detail load would be a network fan-out. The HTTP layer mints
 * signed URLs on demand (`GET /files/signed`).
 */
export function toMessageView(
  message: TicketMessageRecord,
  attachments: MessageAttachmentRecord[],
): MessageView {
  return {
    id: message.id,
    externalMessageId: message.externalMessageId,
    direction: message.direction,
    channelRouteUsed: message.channelRouteUsed,
    messageType: message.messageType,
    bodyCleanText: message.bodyCleanText,
    bodyHtml: message.bodyHtml,
    deliveryStatus: message.deliveryStatus,
    isInternalNote: message.isInternalNote,
    authorAgentId: message.authorAgentId,
    marketplaceCreatedAt: message.marketplaceCreatedAt.toISOString(),
    attachments: attachments.map(toAttachmentView),
    contentPayload: asRecord(message.contentPayload),
  };
}

export function toAttachmentView(attachment: MessageAttachmentRecord): AttachmentView {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    s3Uri: attachment.s3Uri,
    isEvidence: attachment.isEvidence,
    downloadUrl: null,
  };
}

/** One-line preview used by the realtime `message:created` socket event. */
export function messagePreview(message: Pick<TicketMessageRecord, 'bodyCleanText' | 'messageType'>): string {
  const text = (message.bodyCleanText ?? '').replace(/\s+/g, ' ').trim();
  if (text.length > 0) return truncate(text, PREVIEW_LENGTH);
  return message.messageType ? `[${message.messageType}]` : '';
}
