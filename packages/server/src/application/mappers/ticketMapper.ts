import type {
  BuyerPiiRecord,
  CustomerView,
  SupportTicketRecord,
  TicketEventRecord,
  TicketListItem,
  TicketMessageRecord,
} from '@sac/shared';

import { asRecord, asString, iso, pickRecord } from './common';

export interface TicketListItemContext {
  accountDisplayName: string | null;
  assignedAgentName: string | null;
}

/**
 * Persistence record -> queue list projection.
 *
 * Deliberately excludes every buyer PII field: the queue runs at high volume and
 * Amazon restricted data must never leave the PII vault through this path.
 */
export function toTicketListItem(
  ticket: SupportTicketRecord,
  context: TicketListItemContext,
): TicketListItem {
  return {
    id: ticket.id,
    marketplace: ticket.marketplace,
    accountId: ticket.accountId,
    accountDisplayName: context.accountDisplayName ?? ticket.marketplace,
    ticketType: ticket.ticketType,
    subject: ticket.subject,
    externalReferenceId: ticket.externalReferenceId,
    externalOrderId: ticket.externalOrderId,
    buyerDisplayName: ticket.buyerDisplayName,
    buyerAnonymizedEmail: ticket.buyerAnonymizedEmail,
    hasActiveClaim: ticket.hasActiveClaim,
    status: ticket.status,
    priority: ticket.priority,
    slaDeadlineAt: ticket.slaDeadlineAt.toISOString(),
    slaState: ticket.slaState,
    slaBreached: ticket.slaBreached,
    firstResponseAt: iso(ticket.firstResponseAt),
    lastMessageAt: iso(ticket.lastMessageAt),
    unreadCount: ticket.unreadCount,
    assignedAgentId: ticket.assignedAgentId,
    assignedAgentName: context.assignedAgentName,
    assignedQueue: ticket.assignedQueue,
    channelMetadata: asRecord(ticket.channelMetadata),
    tags: Array.isArray(ticket.tags) ? ticket.tags : [],
  };
}

export interface CustomerViewInput {
  ticket: SupportTicketRecord;
  /** `null` when the vault row is missing, purged or past `expiresAt`. */
  pii: BuyerPiiRecord | null;
}

/**
 * Customer 360 projection.
 *
 * PII is resolved by the caller only when the vault row is still valid; for
 * Amazon this is the RDT-protected data with a 30-day hard purge, so the UI
 * renders the retention badge from `piiProtection`.
 */
export function toCustomerView(input: CustomerViewInput): CustomerView {
  const { ticket, pii } = input;
  const consents = pickRecord(asRecord(ticket.channelMetadata), 'consents');
  const displayName =
    (pii?.buyerName ?? null) || ticket.buyerDisplayName || null;

  return {
    externalId: ticket.buyerExternalId,
    displayName,
    anonymizedEmail: ticket.buyerAnonymizedEmail,
    document: pii?.buyerDocument ?? null,
    phone: pii?.buyerPhone ?? null,
    email: pii?.buyerEmail ?? null,
    shippingAddress: pii ? asRecord(pii.shippingAddress) : null,
    piiProtection: ticket.marketplace === 'AMAZON' ? 'RDT_30D_PURGE' : 'STANDARD',
    consents: consents ?? {},
  };
}

export function toTicketEventView(event: TicketEventRecord): {
  id: string;
  eventType: string;
  actorLabel: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
} {
  return {
    id: event.id,
    eventType: event.eventType,
    actorLabel: event.actorLabel,
    payload: asRecord(event.payload),
    createdAt: event.createdAt.toISOString(),
  };
}

/**
 * `firstResponseAt` is only meaningful for a real agent reply, never for an
 * internal note or a system notice. Kept here so every service uses the same
 * rule when it decides whether a ticket has been answered.
 */
export function isAgentReply(message: TicketMessageRecord): boolean {
  return (
    message.direction === 'OUTBOUND_AGENT' &&
    message.isInternalNote !== true &&
    message.deliveryStatus !== 'FAILED' &&
    message.deliveryStatus !== 'BOUNCED_BLOCKED' &&
    message.deliveryStatus !== 'MODERATION_REJECTED'
  );
}

/** Returns the parsed claim due date carried by a hydrated Meli payload. */
export function readDueDate(metadata: Record<string, unknown> | null | undefined): Date | null {
  if (!metadata) return null;
  const raw = metadata.due_date ?? metadata.dueDate;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
  if (typeof raw === 'string') {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

export function readStringMetadata(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!metadata) return null;
  return asString(metadata[key]);
}
