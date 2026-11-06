import type { FastifyRequest } from 'fastify';
import { isRecord } from './guards';

/** Path part of a request URL (logs and public-route matching never need the query). */
export function stripQuery(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

/**
 * Flatten Fastify's parsed query object into the `Record<string, string>` shape
 * the raw webhook contract expects. Arrays keep their first string value.
 *
 * The query keys are attacker-controlled, so the accumulator has a null
 * prototype and the prototype-pollution keys are dropped (CodeQL
 * `js/remote-property-injection`): writing `__proto__`/`constructor` into a
 * plain object can mutate the object graph.
 */
const BLOCKED_QUERY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function queryToStringRecord(query: unknown): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!isRecord(query)) return result;
  for (const [key, value] of Object.entries(query)) {
    if (BLOCKED_QUERY_KEYS.has(key)) continue;
    if (typeof value === 'string') {
      result[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = String(value);
    } else if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === 'string');
      if (typeof first === 'string') result[key] = first;
    }
  }
  return result;
}

/** Read a single-valued request header regardless of Node's array union. */
export function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
    return first?.trim();
  }
  return undefined;
}

/** Join `APP_BASE_URL` with a raw request target (webhook signature inputs). */
export function joinBaseUrl(baseUrl: string, requestTarget: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${requestTarget.startsWith('/') ? requestTarget : `/${requestTarget}`}`;
}
