import { ValidationError } from '@sac/shared';

/**
 * Attachment MIME policy shared by the HTTP ingress (`file.controller`) and the
 * storage facade (`FileService`).
 *
 * `multipart/form-data` only carries a client-declared MIME type, so the policy
 * is an allowlist plus an explicit active-content blocklist:
 *
 * - `image/svg+xml` is blocked even though it matches `image/*`: SVG is an XML
 *   document that can carry `<script>`, so serving it inline from the
 *   attachments bucket would be stored XSS on the bucket/browser origin.
 * - HTML/JS/XHTML/Flash are blocked for the same reason (active document
 *   execution, not an attachment).
 * - Everything else must be a known image, document or archive type. An
 *   extensionless/unknown MIME (e.g. `application/octet-stream`) is rejected
 *   instead of being stored and later served back.
 *
 * The marketplace relay caps the attachment payload, so the allowlist stays
 * intentionally small; new types need an explicit entry here and in the docs
 * (`docs/SECURITY.md`).
 */

/** MIME types that execute as an active document/script in a browser. */
export const BLOCKED_UPLOAD_MIME_TYPES: readonly string[] = [
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'application/x-shockwave-flash',
];

/** Raster images only - no SVG/vector formats. */
export const ALLOWED_IMAGE_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
];

/** Documents the marketplaces accept (NF-e XML/PDF, evidence, spreadsheets). */
export const ALLOWED_DOCUMENT_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/xml',
  'application/xml',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

/** Archives are allowed as opaque blobs (never expanded server-side). */
export const ALLOWED_ARCHIVE_MIME_TYPES: readonly string[] = [
  'application/zip',
  'application/x-zip-compressed',
];

/** Full allowlist accepted by the upload endpoint. */
export const ALLOWED_UPLOAD_MIME_TYPES: readonly string[] = [
  ...ALLOWED_IMAGE_MIME_TYPES,
  ...ALLOWED_DOCUMENT_MIME_TYPES,
  ...ALLOWED_ARCHIVE_MIME_TYPES,
];

/** Normalizes the header/parser MIME: lowercase media type, no parameters. */
export function normalizeUploadMimeType(value: string): string {
  const mediaType = (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType === 'image/jpg' || mediaType === 'image/pjpeg') return 'image/jpeg';
  if (mediaType === 'image/x-png') return 'image/png';
  if (mediaType === 'image/x-ms-bmp') return 'image/bmp';
  return mediaType;
}

export function isBlockedUploadMimeType(value: string): boolean {
  return BLOCKED_UPLOAD_MIME_TYPES.includes(normalizeUploadMimeType(value));
}

export function isAllowedUploadMimeType(value: string): boolean {
  const normalized = normalizeUploadMimeType(value);
  if (BLOCKED_UPLOAD_MIME_TYPES.includes(normalized)) return false;
  return ALLOWED_UPLOAD_MIME_TYPES.includes(normalized);
}

/**
 * Validates an upload MIME and returns its normalized form.
 *
 * Throws `ValidationError` (HTTP 422) with a stable message shared by the
 * multipart controller and the service layer, so the API never stores an
 * attachment it would refuse to serve.
 */
export function assertAllowedUploadMimeType(value: string): string {
  const normalized = normalizeUploadMimeType(value);

  if (BLOCKED_UPLOAD_MIME_TYPES.includes(normalized)) {
    throw new ValidationError('Unsupported attachment mime type', {
      mimeType: normalized,
      reason: 'Active content types (SVG/HTML/JS) are not allowed as attachments',
      allowed: ALLOWED_UPLOAD_MIME_TYPES,
    });
  }

  if (!ALLOWED_UPLOAD_MIME_TYPES.includes(normalized)) {
    throw new ValidationError('Unsupported attachment mime type', {
      mimeType: normalized,
      reason: 'Mime type is not in the attachment allowlist (image, document or zip)',
      allowed: ALLOWED_UPLOAD_MIME_TYPES,
    });
  }

  return normalized;
}
