import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createTicketControllers } from '../controllers/ticket.controller';
import { createMessageControllers } from '../controllers/message.controller';

/**
 * `/api/v1/tickets` - queue queries, ticket commands, outbound messaging,
 * composer previews and cockpit actions (contract §2-3).
 */
export const ticketRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const tickets = createTicketControllers(ctx);
  const messages = createMessageControllers(ctx);

  // Queue + detail
  app.get('/', tickets.list);
  app.get('/:id', tickets.detail);

  // Ticket commands
  app.post('/:id/assign', tickets.assign);
  app.post('/:id/status', tickets.changeStatus);
  app.post('/:id/close-without-response', tickets.closeWithoutResponse);
  app.post('/:id/read', tickets.markRead);
  app.post('/:id/notes', tickets.addNote);

  // Messaging + policy preview
  app.get('/:id/messages', messages.list);
  app.post('/:id/messages', messages.send);
  app.post('/:id/policy-check', messages.policyCheck);
  app.get('/:id/route', messages.routePreview);

  // Cockpit actions
  app.get('/:id/actions', messages.listActions);
  app.post('/:id/actions', messages.executeAction);
};
