import type {
  AgentRole,
  MessageView,
  SupportTicketRecord,
  TicketListFilter,
  TicketMessageRecord,
  TicketRealtimeEvent,
} from '@sac/shared';
import type { TicketListQuery } from './schemas/ticket.schema';

/**
 * HTTP-layer projections.
 *
 * The application services own the canonical domain mappers; the HTTP layer only
 * needs the few projections that are purely transport concerns (query string ->
 * repository filter, record -> realtime event, record -> `MessageView` for the
 * internal-note response, whose contract is a message view rather than a record).
 */

/** Map the queue query string to the repository filter consumed by `ITicketQueryService`. */
export function toTicketFilter(query: TicketListQuery, currentAgentId: string): TicketListFilter {
  const filter: TicketListFilter = {};

  if (query.filter !== undefined) filter.queueKey = query.filter;
  if (query.marketplace !== undefined) filter.marketplace = query.marketplace;
  if (query.accountId !== undefined) filter.accountId = query.accountId;
  if (query.search !== undefined) filter.search = query.search;
  if (query.status !== undefined) filter.status = query.status;

  // Hints that let the query service satisfy each virtual queue; `queueKey`
  // remains authoritative in case the service maps them itself.
  switch (query.filter) {
    case 'SLA_CRITICAL':
      filter.onlySlaCritical = true;
      break;
    case 'UNASSIGNED':
      filter.onlyUnassigned = true;
      break;
    case 'CLAIMS':
      filter.hasActiveClaim = true;
      break;
    case 'WAITING_ME':
      filter.assignedAgentId = currentAgentId;
      break;
    case 'PRE_SALE':
      filter.ticketType = ['PRE_SALE'];
      break;
    default:
      break;
  }

  return filter;
}

/** Realtime snapshot broadcast after any mutation of a ticket. */
export function toTicketRealtimeEvent(record: SupportTicketRecord): TicketRealtimeEvent {
  return {
    ticketId: record.id,
    marketplace: record.marketplace,
    status: record.status,
    priority: record.priority,
    slaDeadlineAt: record.slaDeadlineAt.toISOString(),
    assignedAgentId: record.assignedAgentId,
    unreadCount: record.unreadCount,
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * `POST /tickets/:id/notes` returns a `MessageView`. Internal notes never carry
 * attachments, so the projection is exhaustive without extra repository calls.
 */
export function toMessageView(record: TicketMessageRecord): MessageView {
  return {
    id: record.id,
    externalMessageId: record.externalMessageId,
    direction: record.direction,
    channelRouteUsed: record.channelRouteUsed,
    messageType: record.messageType,
    bodyCleanText: record.bodyCleanText,
    bodyHtml: record.bodyHtml,
    deliveryStatus: record.deliveryStatus,
    isInternalNote: record.isInternalNote,
    authorAgentId: record.authorAgentId,
    marketplaceCreatedAt: record.marketplaceCreatedAt.toISOString(),
    attachments: [],
    contentPayload: record.contentPayload,
  };
}

/** `IAgentService` returns the role as a plain string; narrow it for the contract. */
export function toAgentRole(value: string): AgentRole {
  return value === 'ADMIN' || value === 'SUPERVISOR' || value === 'AGENT' ? value : 'AGENT';
}
