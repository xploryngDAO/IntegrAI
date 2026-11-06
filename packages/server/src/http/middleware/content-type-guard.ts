import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '@sac/shared';

import { API_PREFIX } from '../constants';
import { readHeader, stripQuery } from '../utils/query';

/**
 * Content-Type guard for the authenticated JSON surface.
 *
 * Every browser-facing mutation under `/api/v1` is JSON (the SPA always sends
 * `Content-Type: application/json`), so accepting `text/plain`,
 * `application/x-www-form-urlencoded`, `multipart/form-data` or an arbitrary
 * vendor type only widens parser-confusion / CSRF-simple-request surface. The
 * guard rejects those with `415 UNSUPPORTED_MEDIA_TYPE` before the body is
 * buffered.
 *
 * Deliberate exemptions:
 *
 * - `/api/v1/files/upload` is the only multipart route; `file.controller` owns
 *   its content-type error (`422`, with the field name) and the 10 MiB limit.
 * - OAuth/OIDC callbacks are GET redirects. They are listed defensively so a
 *   future provider that posts the authorization code back without a body is
 *   not broken by this guard.
 * - Requests with no body are left alone: a bodyless `POST` (e.g. an action
 *   endpoint) cannot be a parser-confusion vector, and requiring a header the
 *   client has no reason to send would be a gratuitous breaking change.
 * - Webhooks (`/webhooks/*`), `/health`, `/status`, `/socket.io` and everything
 *   else outside `/api/v1` keep their own parsers and are never touched.
 *
 * `application/json; charset=utf-8` and structured-suffix types
 * (`application/*+json`, e.g. `application/vnd.api+json`) are accepted; the
 * matching parser is registered in `registerBodyParsers`.
 */

const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

/** Routes under `/api/v1` that intentionally consume a non-JSON body. */
const MULTIPART_PATHS: readonly RegExp[] = [/^\/api\/v1\/files\/upload$/];

/** Callback paths that may answer a provider POST without a body. */
const BODYLESS_CALLBACK_PATHS: readonly RegExp[] = [
  /^\/api\/v1\/accounts\/oauth\/[^/]+\/callback$/,
  /^\/api\/v1\/auth\/sso\/callback$/,
];

/** `application/foo+json` (RFC 6839 structured syntax suffix). */
const JSON_SUFFIX_MEDIA_TYPE = /^application\/[a-z0-9!#$&^_.+-]+\+json$/;

export const UNSUPPORTED_MEDIA_TYPE_CODE = 'UNSUPPORTED_MEDIA_TYPE';
export const UNSUPPORTED_MEDIA_TYPE_MESSAGE = 'Content-Type must be application/json';

/** Returns the bare media type: lowercase, parameters (`;charset=...`) removed. */
export function mediaTypeOf(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** True for `application/json` and `application/*+json`, with or without params. */
export function isJsonContentType(contentType: string | undefined): boolean {
  const mediaType = mediaTypeOf(contentType);
  return mediaType === 'application/json' || JSON_SUFFIX_MEDIA_TYPE.test(mediaType);
}

/** True for any `multipart/*` body (only the upload route may receive one). */
export function isMultipartContentType(contentType: string | undefined): boolean {
  return mediaTypeOf(contentType).startsWith('multipart/');
}

function hasRequestBody(request: FastifyRequest): boolean {
  const transferEncoding = readHeader(request, 'transfer-encoding');
  if (transferEncoding !== undefined) return true;
  const contentLength = readHeader(request, 'content-length');
  if (contentLength === undefined) return false;
  const parsed = Number(contentLength);
  return !Number.isFinite(parsed) || parsed > 0;
}

function isExemptPath(path: string): boolean {
  return (
    MULTIPART_PATHS.some((pattern) => pattern.test(path)) ||
    BODYLESS_CALLBACK_PATHS.some((pattern) => pattern.test(path))
  );
}

export interface ContentTypeGuardOptions {
  /** Defaults to `API_PREFIX` (`/api/v1`). */
  apiPrefix?: string;
}

/**
 * Registers the `onRequest` guard. It runs before body parsing, so a rejected
 * request never allocates a body buffer (the 415 is answered from headers only).
 */
export function registerContentTypeGuard(
  app: FastifyInstance,
  options: ContentTypeGuardOptions = {},
): void {
  const apiPrefix = options.apiPrefix ?? API_PREFIX;

  app.addHook('onRequest', async (request) => {
    if (!BODY_METHODS.has(request.method.toUpperCase())) return;

    const path = stripQuery(request.url);
    if (path !== apiPrefix && !path.startsWith(`${apiPrefix}/`)) return;
    if (isExemptPath(path)) return;
    if (!hasRequestBody(request)) return;

    const contentType = readHeader(request, 'content-type');
    if (isJsonContentType(contentType)) return;

    throw new AppError(
      UNSUPPORTED_MEDIA_TYPE_CODE,
      UNSUPPORTED_MEDIA_TYPE_MESSAGE,
      415,
      {
        expected: 'application/json',
        accepted: ['application/json', 'application/*+json'],
        received: contentType ?? null,
      },
    );
  });
}
