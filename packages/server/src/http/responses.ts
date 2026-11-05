import type { ApiEnvelope } from '@sac/shared';

/**
 * Successful responses are always `{ "data": ... }` (optionally `{ data, meta }`).
 * Errors are produced exclusively by the global error handler.
 */
export function ok<T>(data: T, meta?: Record<string, unknown>): ApiEnvelope<T> {
  return meta === undefined ? { data } : { data, meta };
}
