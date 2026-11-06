import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { isAppError, type ApiErrorBody, type ILogger } from '@sac/shared';
import { ZodError } from 'zod';
import { describeZodIssues } from '../schemas/common';
import { isRecord } from '../utils/guards';
import { stripQuery } from '../utils/query';

export interface ErrorHandlerOptions {
  logger: ILogger;
  /** False in production: unknown 5xx messages are replaced by a generic text. */
  exposeDetails: boolean;
}

interface HttpFailure {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
}

const CODE_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'VALIDATION_ERROR',
  401: 'AUTHENTICATION_ERROR',
  403: 'AUTHORIZATION_ERROR',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'VALIDATION_ERROR',
  415: 'VALIDATION_ERROR',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
};

function codeForStatus(statusCode: number): string {
  return CODE_BY_STATUS[statusCode] ?? 'VALIDATION_ERROR';
}

function readStatusCode(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const value = error['statusCode'];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Reads `details.retryAfterMs` from a `RateLimitError` payload, if present. */
function readRetryAfterMs(details: unknown): number | null {
  if (!isRecord(details)) return null;
  const value = details['retryAfterMs'];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function describeClientError(error: unknown, statusCode: number): string {
  if (statusCode === 413) return 'Request payload exceeds the allowed size limit';
  if (statusCode === 415) return 'Unsupported content type';
  if (error instanceof Error && error.message.length > 0 && error.message.length <= 300) {
    return error.message;
  }
  return 'Request rejected';
}

/**
 * Map any thrown value to the contract error body:
 * `{ error: { code, message, details? } }`.
 */
function mapError(error: unknown, exposeDetails: boolean): HttpFailure {
  if (isAppError(error)) {
    return {
      statusCode: error.httpStatus,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'Invalid request payload',
      details: { issues: describeZodIssues(error) },
    };
  }

  const statusCode = readStatusCode(error);
  if (statusCode !== null && statusCode >= 400 && statusCode < 500) {
    return {
      statusCode,
      code: codeForStatus(statusCode),
      message: describeClientError(error, statusCode),
    };
  }

  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: exposeDetails && error instanceof Error ? error.message : 'Internal server error',
  };
}

/**
 * Installs the global error + not-found handlers.
 *
 * Stack traces never cross the wire: they are logged with the request id, and the
 * body only exposes the request id so an operator can correlate the incident.
 */
export function registerErrorHandler(app: FastifyInstance, options: ErrorHandlerOptions): void {
  app.setErrorHandler((error: FastifyError, request, reply: FastifyReply) => {
    const thrown: unknown = error;
    const failure = mapError(thrown, options.exposeDetails);

    const meta: Record<string, unknown> = {
      requestId: request.id,
      method: request.method,
      path: stripQuery(request.url),
      statusCode: failure.statusCode,
      code: failure.code,
      agentId: request.agent?.id ?? null,
    };

    if (failure.statusCode >= 500) {
      options.logger.error('http.error', {
        ...meta,
        error: error instanceof Error ? error.message : String(thrown),
        stack: error instanceof Error ? (error.stack ?? null) : null,
      });
    } else {
      options.logger.warn('http.rejected', meta);
    }

    // Rate limiting is only useful to a well-behaved client if it can back
    // off: expose the window as `Retry-After` (seconds, RFC 9110) derived from
    // the same `retryAfterMs` the limiter already returns.
    if (failure.statusCode === 429) {
      const retryAfterMs = readRetryAfterMs(failure.details);
      if (retryAfterMs !== null) {
        reply.header('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      }
    }

    const body: ApiErrorBody = {
      error: {
        code: failure.code,
        message: failure.message,
        details: failure.details,
        requestId: failure.statusCode >= 500 ? request.id : undefined,
      },
    };

    reply.code(failure.statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ApiErrorBody = {
      error: {
        code: 'NOT_FOUND',
        message: `Route not found: ${request.method} ${stripQuery(request.url)}`,
      },
    };
    reply.code(404).send(body);
  });
}
