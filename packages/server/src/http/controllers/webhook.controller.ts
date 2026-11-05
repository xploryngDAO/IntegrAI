import { WEBHOOK_BUDGET_MS, isAppError } from '@sac/shared';
import type { Marketplace, RawWebhookRequest } from '@sac/shared';
import type { HttpRouteContext, RouteHandler } from '../types';
import { WEBHOOK_DURATION_HEADER } from '../constants';
import { isRecord } from '../utils/guards';
import { joinBaseUrl, queryToStringRecord } from '../utils/query';

interface WebhookFailure {
  httpStatus: number;
  body: Record<string, unknown>;
  retryable: boolean;
}

/** Infrastructure failures where the marketplace MUST retry the push. */
const RETRYABLE_ERROR_CODES: readonly string[] = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'NR_CLOSED',
  'NR_CLOSING',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
];

/** Marketplace-specific success acknowledgements (contract §7). */
function successBody(marketplace: Marketplace): Record<string, unknown> {
  return marketplace === 'SHOPEE' ? { status: 'ACK' } : { status: 'OK' };
}

function classifyFailure(error: unknown, marketplace: Marketplace): WebhookFailure {
  if (isAppError(error) && error.code === 'INVALID_SIGNATURE') {
    return { httpStatus: 401, body: { status: 'REJECTED', message: 'invalid signature' }, retryable: false };
  }

  if (isAppError(error) && (error.retryable || RETRYABLE_ERROR_CODES.includes(error.code))) {
    return {
      httpStatus: 503,
      body: { status: 'RETRY', message: 'ingress temporarily unavailable' },
      retryable: true,
    };
  }

  if (isRecord(error)) {
    const code = error['code'];
    if (typeof code === 'string' && RETRYABLE_ERROR_CODES.includes(code)) {
      return {
        httpStatus: 503,
        body: { status: 'RETRY', message: 'ingress temporarily unavailable' },
        retryable: true,
      };
    }
  }

  // Everything else: the event may already be persisted (the ingress is
  // idempotent), so acknowledge to stop retry storms and leave the replay to the
  // `webhook_events` audit trail. Never 5xx the marketplace for an app bug.
  return { httpStatus: 200, body: successBody(marketplace), retryable: false };
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

/**
 * Builds the handler for one marketplace webhook.
 *
 * The controller never parses or verifies payloads itself: it hands the exact
 * bytes + transport metadata to `IWebhookIngressService.accept`, which verifies
 * the signature in-process, claims the idempotency key and enqueues.
 */
export function createWebhookHandler(ctx: HttpRouteContext, marketplace: Marketplace): RouteHandler {
  const { services, options } = ctx;
  const log = services.logger.child({ component: 'http.webhooks', marketplace });
  const budgetMs = WEBHOOK_BUDGET_MS[marketplace];

  return async (request, reply) => {
    const startedAt = performance.now();
    const rawBody = request.rawBody ?? Buffer.alloc(0);

    const rawRequest: RawWebhookRequest = {
      method: request.method,
      url: joinBaseUrl(options.appBaseUrl, request.url),
      headers: { ...request.headers },
      query: queryToStringRecord(request.query),
      rawBody,
      receivedAt: services.clock.now(),
      remoteIp: request.ip,
    };

    try {
      const ack = await services.webhooks.accept(marketplace, rawRequest);
      const durationMs = elapsedMs(startedAt);
      reply.header(WEBHOOK_DURATION_HEADER, String(durationMs));

      if (durationMs > budgetMs) {
        log.warn('webhook.budget_exceeded', {
          durationMs,
          budgetMs,
          httpStatus: ack.httpStatus,
          eventId: ack.eventId ?? null,
          duplicate: ack.duplicate,
        });
      } else {
        log.info('webhook.handled', {
          durationMs,
          budgetMs,
          httpStatus: ack.httpStatus,
          status: ack.status,
          duplicate: ack.duplicate,
          eventId: ack.eventId ?? null,
        });
      }

      const body = Object.keys(ack.body).length > 0 ? ack.body : successBody(marketplace);
      return reply.code(ack.httpStatus).send(body);
    } catch (error) {
      const durationMs = elapsedMs(startedAt);
      reply.header(WEBHOOK_DURATION_HEADER, String(durationMs));

      const failure = classifyFailure(error, marketplace);
      log.error('webhook.failed', {
        durationMs,
        budgetMs,
        httpStatus: failure.httpStatus,
        retryable: failure.retryable,
        errorCode: isAppError(error) ? error.code : null,
        error: error instanceof Error ? error.message : 'unknown error',
      });

      return reply.code(failure.httpStatus).send(failure.body);
    }
  };
}
