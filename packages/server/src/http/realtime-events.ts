import type { SupportTicketRecord } from '@sac/shared';
import { toTicketRealtimeEvent } from './mappers';
import type { HttpRouteContext } from './types';

/**
 * Realtime fan-out for HTTP-initiated mutations.
 *
 * The application services also publish from their own command paths; these
 * emissions are the HTTP layer's guarantee that an acknowledged REST mutation is
 * immediately visible to every operator, and are safe to duplicate because the
 * client treats `ticket:updated` as an idempotent snapshot.
 */
export function publishTicketMutation(
  ctx: HttpRouteContext,
  record: SupportTicketRecord,
  reason: string,
): void {
  ctx.hub.publisher.ticketUpdated(toTicketRealtimeEvent(record));
  ctx.hub.publisher.queueChanged({
    reason,
    ticketId: record.id,
    at: ctx.services.clock.now().toISOString(),
  });
}

/** Queue-only change (no ticket snapshot available from the service result). */
export function publishQueueMutation(ctx: HttpRouteContext, reason: string, ticketId?: string): void {
  ctx.hub.publisher.queueChanged({
    reason,
    ...(ticketId === undefined ? {} : { ticketId }),
    at: ctx.services.clock.now().toISOString(),
  });
}
