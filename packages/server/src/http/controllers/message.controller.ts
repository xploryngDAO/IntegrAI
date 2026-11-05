import type { OutboundAttachmentInput } from '@sac/shared';
import type { HttpRouteContext, RouteHandler } from '../types';
import {
  executeActionBodySchema,
  idempotencyKeyHeaderSchema,
  parseInput,
  policyCheckBodySchema,
  routePreviewQuerySchema,
  sendMessageBodySchema,
  ticketParamsSchema,
} from '../schemas';
import { ok } from '../responses';
import { requireAgent } from '../middleware/auth';
import { publishQueueMutation, publishTicketMutation } from '../realtime-events';
import { readHeader } from '../utils/query';
import { truncate } from '../utils/text';

export interface MessageControllers {
  list: RouteHandler;
  send: RouteHandler;
  policyCheck: RouteHandler;
  routePreview: RouteHandler;
  listActions: RouteHandler;
  executeAction: RouteHandler;
}

/**
 * Preview attachments only need the count to exercise attachment-related policy
 * rules; nothing is stored, nothing is sent.
 */
function previewAttachments(count: number): OutboundAttachmentInput[] {
  return Array.from({ length: count }, (_, index) => ({
    fileName: `attachment-${index + 1}`,
    mimeType: 'application/octet-stream',
    s3Key: `preview/attachment-${index + 1}`,
    sizeBytes: 0,
  }));
}

export function createMessageControllers(ctx: HttpRouteContext): MessageControllers {
  const { services } = ctx;

  return {
    /** `GET /tickets/:id/messages` - ordered by `marketplace_created_at`. */
    async list(request) {
      const { id } = parseInput(ticketParamsSchema, request.params, 'params');
      const detail = await services.tickets.getDetail(id);
      return ok(detail.messages);
    },

    /**
     * `POST /tickets/:id/messages`.
     * The route/policy is re-evaluated by `OutboundRouterService`; the client wins
     * nothing by forcing a channel - it only expresses intent.
     */
    async send(request) {
      const agent = requireAgent(request);
      const { id } = parseInput(ticketParamsSchema, request.params, 'params');
      const body = parseInput(sendMessageBodySchema, request.body, 'body');

      const rawIdempotencyKey = readHeader(request, 'idempotency-key');
      const idempotencyKey =
        rawIdempotencyKey === undefined
          ? null
          : parseInput(idempotencyKeyHeaderSchema, rawIdempotencyKey, 'headers');

      const result = await services.outbound.send({
        ticketId: id,
        agent: { id: agent.id, name: agent.name, email: agent.email },
        bodyText: body.bodyText,
        bodyHtml: body.bodyHtml ?? null,
        subject: body.subject ?? null,
        recipient: body.recipient ?? 'BUYER',
        forceImportant: body.forceImportant ?? false,
        closeWithoutResponse: body.closeWithoutResponse ?? false,
        attachmentS3Keys: body.attachmentS3Keys ?? [],
        meliActionGuideReasonId: body.meliActionGuideReasonId ?? null,
        shopeeMessageType: body.shopeeMessageType,
        shopeeOrderCardOrderSn: body.shopeeOrderCardOrderSn ?? null,
        shopeeItemCardItemId: body.shopeeItemCardItemId ?? null,
        idempotencyKey,
      });

      ctx.hub.publisher.messageCreated({
        ticketId: id,
        messageId: result.messageId,
        direction: 'OUTBOUND_AGENT',
        channelRouteUsed: result.routeUsed,
        preview: truncate(body.bodyText, 160),
        marketplaceCreatedAt: services.clock.now().toISOString(),
      });
      publishTicketMutation(ctx, result.ticket, 'MESSAGE_SENT');

      return ok(result);
    },

    /** `POST /tickets/:id/policy-check` - cheap, never calls the marketplace. */
    async policyCheck(request) {
      const { id } = parseInput(ticketParamsSchema, request.params, 'params');
      const body = parseInput(policyCheckBodySchema, request.body, 'body');

      const evaluation = await services.outbound.previewPolicy({
        ticketId: id,
        draft: {
          bodyText: body.bodyText,
          bodyHtml: body.bodyHtml ?? null,
          subject: body.subject ?? null,
          recipient: body.recipient ?? 'BUYER',
          attachments: previewAttachments(body.attachmentCount ?? 0),
          forceImportant: body.forceImportant ?? false,
        },
      });

      return ok(evaluation);
    },

    /** `GET /tickets/:id/route?recipient=` - composer banner. */
    async routePreview(request) {
      const { id } = parseInput(ticketParamsSchema, request.params, 'params');
      const query = parseInput(routePreviewQuerySchema, request.query, 'query');
      return ok(await services.outbound.resolveRoute(id, query.recipient));
    },

    /** `GET /tickets/:id/actions` - cockpit buttons. */
    async listActions(request) {
      const { id } = parseInput(ticketParamsSchema, request.params, 'params');
      return ok(await services.tickets.getAvailableActions(id));
    },

    /** `POST /tickets/:id/actions` - structured post-sale action. */
    async executeAction(request) {
      const agent = requireAgent(request);
      const { id } = parseInput(ticketParamsSchema, request.params, 'params');
      const body = parseInput(executeActionBodySchema, request.body, 'body');

      const attachments =
        body.attachmentS3Keys !== undefined && body.attachmentS3Keys.length > 0
          ? await services.files.resolveAttachmentInputs(body.attachmentS3Keys)
          : undefined;

      const result = await services.outbound.executeAction({
        ticketId: id,
        agent: { id: agent.id, name: agent.name, email: agent.email },
        kind: body.kind,
        bodyText: body.bodyText,
        attachments,
        lastReadMessageId: body.lastReadMessageId ?? null,
        payload: body.payload,
      });

      publishQueueMutation(ctx, 'TICKET_ACTION_EXECUTED', id);

      return ok(result);
    },
  };
}
