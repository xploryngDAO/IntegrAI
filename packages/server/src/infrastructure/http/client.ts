import { randomUUID } from 'node:crypto';
import { AppError } from '@sac/shared';
import type { HttpRequestOptions, HttpResponse, IHttpClient, ILogger } from '@sac/shared';

/**
 * Global-fetch HTTP client used by every marketplace adapter.
 *
 * Features: per-request timeout (AbortController), request id propagation,
 * retry with exponential backoff + jitter on 429/5xx (honouring `Retry-After`),
 * retry of network failures for idempotent methods only, and body parsing that
 * is driven by the response `Content-Type`.
 */

/** 429/5xx (plus 408/425) are worth another attempt. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Only these methods are retried on transport errors (POST may duplicate). */
const IDEMPOTENT_METHODS = new Set(['GET', 'PUT', 'DELETE']);

/** Response headers that carry a provider request id. */
const REQUEST_ID_HEADERS = [
  'x-request-id',
  'x-amzn-requestid',
  'x-amz-request-id',
  'x-shopee-request-id',
  'x-meli-request-id',
  'request-id',
];

export interface HttpClientSettings {
  /** Default per-request timeout. Default 30s. */
  defaultTimeoutMs?: number;
  /** Default retry count after the first attempt. Default 2. */
  defaultRetries?: number;
  /** Exponential base delay. Default 300ms. */
  retryBaseDelayMs?: number;
  /** Exponential delay cap. Default 10s. */
  maxRetryDelayMs?: number;
  /** `Retry-After` cap. Default 30s. */
  maxRetryAfterMs?: number;
  logger?: ILogger;
}

const DEFAULTS = {
  timeoutMs: 30_000,
  retries: 2,
  baseDelayMs: 300,
  maxDelayMs: 10_000,
  maxRetryAfterMs: 30_000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildUrl(base: string, query?: HttpRequestOptions['query']): string {
  if (!query) return base;
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function pickRequestId(headers: Record<string, string>, fallback: string): string {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers[name];
    if (value && value.length > 0) return value;
  }
  return fallback;
}

/** Parses `Retry-After` (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) return Math.max(0, Math.round(asNumber * 1_000));

  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());

  return null;
}

function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'AbortError' || error.name === 'TimeoutError' || /timed?\s*out|aborted/i.test(error.message)
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toHttpError(error: unknown, method: string, url: string, attempts: number): AppError {
  if (error instanceof AppError) return error;
  const code = isAbortLike(error) ? 'HTTP_TIMEOUT' : 'HTTP_REQUEST_FAILED';
  return new AppError(
    code,
    `${method} ${url} failed after ${attempts} attempt(s): ${describeError(error)}`,
    502,
    { method, url, attempts },
    true,
  );
}

async function parseJsonOrText<T>(response: Response): Promise<T> {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const text = await response.text();

  if (contentType.includes('json')) {
    if (text.length === 0) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
  return text as unknown as T;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Draining is best-effort; the retry must not fail because of it.
  }
}

export class FetchHttpClient implements IHttpClient {
  private readonly defaultTimeoutMs: number;
  private readonly defaultRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly logger?: ILogger;

  constructor(settings: HttpClientSettings = {}) {
    this.defaultTimeoutMs = Math.max(1, settings.defaultTimeoutMs ?? DEFAULTS.timeoutMs);
    this.defaultRetries = Math.max(0, settings.defaultRetries ?? DEFAULTS.retries);
    this.retryBaseDelayMs = Math.max(1, settings.retryBaseDelayMs ?? DEFAULTS.baseDelayMs);
    this.maxRetryDelayMs = Math.max(this.retryBaseDelayMs, settings.maxRetryDelayMs ?? DEFAULTS.maxDelayMs);
    this.maxRetryAfterMs = Math.max(0, settings.maxRetryAfterMs ?? DEFAULTS.maxRetryAfterMs);
    this.logger = settings.logger;
  }

  async request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    return this.execute<T>(options, 'json');
  }

  async requestBinary(options: HttpRequestOptions): Promise<HttpResponse<Buffer>> {
    return this.execute<Buffer>(options, 'binary');
  }

  private async execute<T>(options: HttpRequestOptions, mode: 'json' | 'binary'): Promise<HttpResponse<T>> {
    const url = buildUrl(options.url, options.query);
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.defaultTimeoutMs);
    const maxRetries = Math.max(0, options.retries ?? this.defaultRetries);
    const requestId = randomUUID();

    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (!hasHeader(headers, 'accept')) {
      headers.accept = mode === 'binary' ? 'application/octet-stream' : 'application/json';
    }
    if (!hasHeader(headers, 'x-sac-request-id')) headers['x-sac-request-id'] = requestId;

    // Body shapes are intentionally explicit:
    //  - FormData        -> multipart, content-type is set by undici (boundary)
    //  - URLSearchParams -> form urlencoded (LWA / Meli token endpoints)
    //  - string          -> verbatim (XML, pre-signed payloads, raw JSON text)
    //  - anything else   -> JSON.stringify
    let body: RequestInit['body'];
    if (options.formData) {
      body = options.formData;
    } else if (options.body instanceof URLSearchParams) {
      body = options.body;
      if (!hasHeader(headers, 'content-type')) {
        headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
      }
    } else if (typeof options.body === 'string') {
      body = options.body;
      if (!hasHeader(headers, 'content-type')) {
        headers['content-type'] = 'text/plain; charset=utf-8';
      }
    } else if (options.body !== undefined && options.body !== null) {
      body = JSON.stringify(options.body);
      if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
    }

    for (let attempt = 1; ; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;

      try {
        const response = await fetch(url, { method: options.method, headers, body, signal });
        const durationMs = Date.now() - startedAt;
        const responseHeaders = headersToRecord(response.headers);
        const effectiveRequestId = pickRequestId(responseHeaders, requestId);

        if (RETRYABLE_STATUS.has(response.status) && attempt <= maxRetries) {
          const delayMs = this.retryDelay(attempt, response.headers.get('retry-after'));
          this.logger?.warn('http.retry', {
            method: options.method,
            url,
            status: response.status,
            attempt,
            delayMs,
          });
          await discardBody(response);
          await sleep(delayMs);
          continue;
        }

        const parsed =
          mode === 'binary'
            ? (Buffer.from(await response.arrayBuffer()) as unknown as T)
            : await parseJsonOrText<T>(response);

        return {
          status: response.status,
          ok: response.ok,
          headers: responseHeaders,
          body: parsed,
          durationMs,
          requestId: effectiveRequestId,
        };
      } catch (error) {
        if (options.signal?.aborted) {
          throw new AppError(
            'HTTP_REQUEST_ABORTED',
            `${options.method} ${url} aborted by caller`,
            499,
            { method: options.method, url },
          );
        }

        const canRetryTransport =
          IDEMPOTENT_METHODS.has(options.method) && attempt <= maxRetries;
        if (canRetryTransport) {
          const delayMs = this.retryDelay(attempt);
          this.logger?.warn('http.retry', {
            method: options.method,
            url,
            attempt,
            delayMs,
            message: describeError(error),
          });
          await sleep(delayMs);
          continue;
        }

        throw toHttpError(error, options.method, url, attempt);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private retryDelay(attempt: number, retryAfterHeader?: string | null): number {
    const retryAfterMs = parseRetryAfter(retryAfterHeader);
    if (retryAfterMs !== null) return Math.min(retryAfterMs, this.maxRetryAfterMs);

    const exponential = Math.min(this.retryBaseDelayMs * 2 ** (attempt - 1), this.maxRetryDelayMs);
    return Math.max(1, Math.round(exponential * (0.5 + Math.random() * 0.5)));
  }
}
