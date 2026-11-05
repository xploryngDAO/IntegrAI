import type { HttpRouteContext, RouteHandler } from '../types';
import {
  assignTicketBodySchema,
  changeTicketStatusBodySchema,
  parseInput,
  ticketIdParamsSchema,
  ticketListQuerySchema,
  ticketNoteBodySchema,
} from '../schemas';
import { ok } from '../responses';
import { requireAgent } from '../middleware/auth';
import { toMessageView, toTicketFilter } from '../mappers';
import { publishQueueMutation, publishTicketMutation } from '../realtime-events';
import { truncate } from '../utils/text';

export interface TicketControllers {
  list: RouteHandler;
  detail: RouteHandler;
  assign: RouteHandler;
  changeStatus: RouteHandler;
  closeWithoutResponse: RouteHandler;
  markRead: RouteHandler;
  addNote: RouteHandler;
}

export function createTicketControllers(ctx: HttpRouteContext): TicketControllers {
  const { services } = ctx;

  return {
    /** `GET /tickets` - the queue column. */
    async list(request) {
      const query = parseInput(ticketListQuerySchema, request.query, 'query');
      const agent = requireAgent(request);
      const filter = { ...toTicketFilter(query, agent.id), tenantId: agent.tenantId };
      return ok(await services.tickets.listQueue(filter, { page: query.page, pageSize: query.pageSize }));
    },

    /** `GET /tickets/:id` - full workspace payload (order, PII-gated customer, thread). */
    async detail(request) {
      const { id } = parseInput(ticketIdParamsSchema, request.params, 'params');
      const agent = requireAgent(request);
      return ok(await services.tickets.getDetail(id, agent.tenantId));
    },

    /** `POST /tickets/:id/assign`. */
    async assign(request) {
      const agent = requireAgent(request);
      const { id } = parseInput(ticketIdParamsSchema, request.params, 'params');
      const body = parseInput(assignTicketBodySchema, request.body, 'body');
      const record = await services.ticketCommands.assign(id, body.agentId, agent.name);
      publishTicketMutation(ctx, record, 'TICKET_ASSIGNED');
      return ok(record);
    },

    /** `POST /tickets/:id/status`. */
    async changeStatus(request) {
      const agent = requireAgent(request);
      const { id } = parseInput(ticketIdParamsSchema, request.params, 'params');
      const body = parseInput(changeTicketStatusBodySchema, request.body, 'body');
      const record = await services.ticketCommands.changeStatus(id, body.status, {
        agentId: agent.id,
        label: agent.name,
      });
      publishTicketMutation(ctx, record, 'TICKET_STATUS_CHANGED');
      return ok(record);
    },

    /** `POST /tickets/:id/close-without-response` (Amazon Route 3 / silent close). */
    async closeWithoutResponse(request) {
      const agent = requireAgent(request);
      const { id } = parseInput(ticketIdParamsSchema, request.params, 'params');
      const record = await services.ticketCommands.closeWithoutResponse(id, {
        id: agent.id,
        name: agent.name,
      });
      publishTicketMutation(ctx, record, 'TICKET_CLOSED_WITHOUT_RESPONSE');
      return ok(record);
    },

    /** `POST /tickets/:id/read` - also protects the Shopee 12h CRR index. */
    async markRead(request) {
      const agent = requireAgent(request);
      const { id } = parseInput(ticketIdParamsSchema, request.params, 'params');
      const record = await services.ticketCommands.markAsRead(id, { id: agent.id, name: agent.name });
      publishTicketMutation(ctx, record, 'TICKET_READ');
      return ok(record);
    },

    /** `POST /tickets/:id/notes` - internal note, never sent to the marketplace. */
    async addNote(request) {
      const agent = requireAgent(request);
      const { id } = parseInput(ticketIdParamsSchema, request.params, 'params');
      const body = parseInput(ticketNoteBodySchema, request.body, 'body');

      const record = await services.ticketCommands.addInternalNote(
        id,
        { id: agent.id, name: agent.name },
        body.text,
      );
      const view = toMessageView(record);

      ctx.hub.publisher.messageCreated({
        ticketId: id,
        messageId: record.id,
        direction: record.direction,
        channelRouteUsed: record.channelRouteUsed,
        preview: truncate(body.text, 160),
        marketplaceCreatedAt: record.marketplaceCreatedAt.toISOString(),
      });
      publishQueueMutation(ctx, 'INTERNAL_NOTE_ADDED', id);

      return ok(view);
    },
  };
}
