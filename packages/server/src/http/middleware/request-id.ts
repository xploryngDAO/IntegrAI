import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ILogger } from '@sac/shared';

/**
 * ============================================================================
 * Request correlation id
 * ============================================================================
 *
 * The client may supply its own correlation id (`x-request-id`) so an edge,
 * a browser trace or a support ticket can be joined with the server logs. That
 * value ends up in log lines and response headers, so it is validated before
 * being trusted:
 *
 *  - only `[A-Za-z0-9._-]`, 8..128 characters;
 *  - anything else (spaces, CR/LF, HTML, overlong values) is DISCARDED and a
 *    fresh UUID is generated instead - never echoed back.
 *
 * The id is installed as `request.id` by Fastify's `genReqId` (see
 * `buildHttpApp`), which means `request.id` is always a safe string, including
 * on requests rejected before the first route handler runs.
 */

export const REQUEST_ID_HEADER = 'x-request-id';

/** Exactly the accepted shape: 8..128 of `A-Z a-z 0-9 . _ -`. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/** Returns the candidate id when it is safe, otherwise `null`. */
export function normalizeRequestId(value: unknown): string | null {
  // A duplicated header arrives as an array: take the first value only, the
  // same way browsers resolve it, so the log/response cannot disagree.
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** Accepted client id or a generated UUID (never throws). */
export function resolveRequestId(value: unknown): string {
  return normalizeRequestId(value) ?? randomUUID();
}

export interface RequestIdOptions {
  logger: ILogger;
}

/**
 * Sets the response header on EVERY reply (success, 4xx, 5xx, 404) and binds a
 * per-request child logger carrying `requestId`.
 *
 * Registered before every other root hook so the header survives a later
 * `onRequest` rejection (rate limit, content-type guard, auth).
 */
export function registerRequestId(app: FastifyInstance, options: RequestIdOptions): void {
  // Fastify only allows decorating request with `null`/primitive as the default.
  app.decorateRequest('logContext', null);

  app.addHook('onRequest', async (request: FastifyRequest, reply) => {
    request.logContext = options.logger.child({
      component: 'http',
      requestId: request.id,
    });
    reply.header(REQUEST_ID_HEADER, request.id);
  });
}
