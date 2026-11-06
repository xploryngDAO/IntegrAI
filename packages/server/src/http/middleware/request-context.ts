import type { FastifyInstance } from 'fastify';
import type { ILogger } from '@sac/shared';
import { stripQuery } from '../utils/query';

export interface RequestContextOptions {
  logger: ILogger;
}

/**
 * Request access logging.
 *
 * The correlation id itself (`x-request-id` header + `request.id`) is owned by
 * `middleware/request-id.ts`, which runs earlier and also binds the per-request
 * child logger (`request.logContext`). This module only emits the access line.
 *
 * Bodies and headers are never logged: webhook bodies carry buyer MIME/PII and
 * `search` terms can contain CPF/order data. Only route template-adjacent
 * metadata (method, path, status, duration, actor) is emitted, so `/webhooks/*`
 * payloads can never reach the log sink.
 */
export function registerRequestContext(app: FastifyInstance, options: RequestContextOptions): void {
  const log = options.logger.child({ component: 'http' });

  app.addHook('onResponse', async (request, reply) => {
    const path = stripQuery(request.url);
    const meta: Record<string, unknown> = {
      requestId: request.id,
      method: request.method,
      path,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
      agentId: request.agent?.id ?? null,
      remoteIp: request.ip,
    };

    // The per-request child already binds `requestId`; keeping it in the meta
    // as well makes the access line self-contained for log-only consumers.
    const line = request.logContext ?? log;

    if (reply.statusCode >= 500) line.error('http.response', meta);
    else if (reply.statusCode >= 400) line.warn('http.response', meta);
    else line.info('http.response', meta);
  });
}
