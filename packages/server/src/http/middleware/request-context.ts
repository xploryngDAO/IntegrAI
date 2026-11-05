import type { FastifyInstance } from 'fastify';
import type { ILogger } from '@sac/shared';
import { stripQuery } from '../utils/query';

export interface RequestContextOptions {
  logger: ILogger;
}

/**
 * Request correlation + access logging.
 *
 * Bodies and headers are never logged: webhook bodies carry buyer MIME/PII and
 * `search` terms can contain CPF/order data. Only route template-adjacent
 * metadata (method, path, status, duration, actor) is emitted, so `/webhooks/*`
 * payloads can never reach the log sink.
 */
export function registerRequestContext(app: FastifyInstance, options: RequestContextOptions): void {
  const log = options.logger.child({ component: 'http' });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

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

    if (reply.statusCode >= 500) log.error('http.response', meta);
    else if (reply.statusCode >= 400) log.warn('http.response', meta);
    else log.info('http.response', meta);
  });
}
