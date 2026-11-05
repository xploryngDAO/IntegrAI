import { AppError, ValidationError } from '@sac/shared';
import type { UploadedFile } from '@sac/shared';
import type { HttpRouteContext, RouteHandler } from '../types';
import { parseInput, signedUrlQuerySchema } from '../schemas';
import { ok } from '../responses';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  ATTACHMENTS_KEY_PREFIX,
  DEFAULT_MAX_UPLOAD_BYTES,
  SIGNED_URL_TTL_SECONDS,
} from '../constants';
import { isSafeAttachmentKey } from '../utils/storage-key';
import { sanitizeFileName } from '../utils/text';

export interface FileControllers {
  upload: RouteHandler;
  signed: RouteHandler;
}

/** Attachments: `image/*`, PDF and plain/XML text only (marketplace caps). */
export function isAllowedUploadMime(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized.startsWith('image/')) return true;
  return ALLOWED_UPLOAD_MIME_TYPES.includes(normalized);
}

export function createFileControllers(ctx: HttpRouteContext): FileControllers {
  const { services, options } = ctx;
  const log = services.logger.child({ component: 'http.files' });
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  return {
    /** `POST /files/upload` (multipart/form-data, field `file`). */
    async upload(request) {
      if (!request.isMultipart()) {
        throw new ValidationError('Content-Type must be multipart/form-data', {
          field: 'file',
          contentType: request.headers['content-type'] ?? null,
        });
      }

      const file = await request.file();
      if (file === undefined) {
        throw new ValidationError('Multipart field "file" is required', { field: 'file' });
      }
      if (file.fieldname !== 'file') {
        throw new ValidationError('Unexpected multipart field', {
          expected: 'file',
          received: file.fieldname,
        });
      }

      const mimeType = file.mimetype.trim().toLowerCase();
      if (!isAllowedUploadMime(mimeType)) {
        throw new ValidationError('Unsupported attachment mime type', {
          mimeType,
          allowed: ['image/*', ...ALLOWED_UPLOAD_MIME_TYPES],
        });
      }

      const buffer = await file.toBuffer();
      if (buffer.length === 0) {
        throw new ValidationError('Uploaded file is empty', { field: 'file' });
      }
      if (buffer.length > maxUploadBytes) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Uploaded file exceeds the ${maxUploadBytes} byte limit`,
          413,
          { maxBytes: maxUploadBytes, sizeBytes: buffer.length },
        );
      }

      const uploaded: UploadedFile = await services.files.upload({
        fileName: sanitizeFileName(file.filename),
        mimeType,
        buffer,
      });

      log.info('file.uploaded', {
        requestId: request.id,
        key: uploaded.key,
        mimeType: uploaded.mimeType,
        sizeBytes: uploaded.sizeBytes,
      });

      return ok(uploaded);
    },

    /** `GET /files/signed?key=` - presigned GET for the attachments bucket. */
    async signed(request) {
      const query = parseInput(signedUrlQuerySchema, request.query, 'query');
      const key = query.key.trim();

      if (!key.startsWith(ATTACHMENTS_KEY_PREFIX) || !isSafeAttachmentKey(key)) {
        throw new ValidationError('Invalid attachment storage key', {
          key,
          expectedPrefix: ATTACHMENTS_KEY_PREFIX,
        });
      }

      const url = await services.files.signedUrl(key, SIGNED_URL_TTL_SECONDS);
      return ok({ url });
    },
  };
}
