import { createHash } from 'node:crypto';
import type { RawHeaderValue } from '@sac/shared';
import type { JsonRecord } from './types';

/** Persisted text is truncated to 200k chars (architecture error-handling rule). */
export const MAX_PERSISTED_TEXT_CHARS = 200_000;
/** Amazon Buyer-Seller relay rejects messages with more than 10 MB of attachments. */
export const MAX_RELAY_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Inbound attachments above this are skipped (SES caps at 40 MB including MIME overhead). */
export const MAX_INBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** `simpleParser` buffers the whole message; larger payloads use the streaming parser. */
export const MAX_IN_MEMORY_MIME_BYTES = 5 * 1024 * 1024;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

/** Trimmed non-empty string or `null`. */
export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function readStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[;,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => entry !== null);
}

export function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

export function readDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = readString(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function uniqueStrings(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (value.length === 0) continue;
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

/** Case-insensitive header lookup for `RawWebhookRequest.headers`. */
export function readRawHeader(headers: Record<string, RawHeaderValue>, name: string): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    return normalizeRawHeaderValue(value);
  }
  return null;
}

function normalizeRawHeaderValue(value: RawHeaderValue): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim().length > 0) return entry.trim();
    }
    return null;
  }
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Normalizes the relay JSON `headers` member (case-insensitive string map). */
export function readHeaderMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isRecord(value)) return result;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.toLowerCase();
    const normalized = headerMapValue(rawValue);
    if (normalized !== null) result[key] = normalized;
  }
  return result;
}

function headerMapValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : null;
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === 'string');
    return parts.length > 0 ? parts.join(', ') : null;
  }
  return null;
}

/** Lowercased bare domain (`https://www.Shop.com/x` -> `shop.com`). */
export function normalizeDomain(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;
  const candidate = raw
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^@/, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0]
    ?.replace(/\.$/, '');
  if (!candidate) return null;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(candidate)
    ? candidate
    : null;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
