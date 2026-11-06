import { createHash } from 'node:crypto';

import type {
  ChannelRuntimeConfig,
  IClock,
  IFileService,
  ILogger,
  IObjectStorage,
  OutboundAttachmentInput,
  UploadedFile,
} from '@sac/shared';
import { ValidationError } from '@sac/shared';

import { sanitizeFileName } from './UnifiedTicketService';
import {
  assertAllowedUploadMimeType,
  normalizeUploadMimeType,
} from './files/upload-policy';

export { ALLOWED_UPLOAD_MIME_TYPES } from './files/upload-policy';

/**
 * ============================================================================
 * FileService
 * ============================================================================
 *
 * Attachment facade: uploads land in `s3://<attachmentsBucket>/attachments/...`
 * (the storage implementation routes by the `attachments/` key prefix), are
 * content-addressed with sha256, capped at the Amazon 10 MB MIME limit and
 * restricted to the MIME types the marketplaces accept.
 *
 * `resolveAttachmentInputs` is the bridge between the UI's S3 keys and the
 * adapters' `OutboundAttachmentInput` (base64 payload + hash + size).
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface FileServiceDependencies {
  logger: ILogger;
  clock: IClock;
  storage: IObjectStorage;
  config: ChannelRuntimeConfig;
}

export class FileService implements IFileService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly storage: IObjectStorage;
  private readonly config: ChannelRuntimeConfig;

  constructor(deps: FileServiceDependencies) {
    this.logger = deps.logger.child({ component: 'FileService' });
    this.clock = deps.clock;
    this.storage = deps.storage;
    this.config = deps.config;
  }

  async upload(input: { fileName: string; mimeType: string; buffer: Buffer }): Promise<UploadedFile> {
    const { buffer } = input;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new ValidationError('Empty file');
    }
    if (buffer.length > MAX_UPLOAD_BYTES) {
      throw new ValidationError(
        `File exceeds the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB attachment limit`,
        { sizeBytes: buffer.length },
      );
    }

    // Central policy (also enforced by the multipart controller): blocks
    // SVG/HTML/JS (stored XSS) and anything outside the image/document/zip
    // allowlist before a single byte reaches object storage.
    const mimeType = assertAllowedUploadMimeType(input.mimeType);

    const fileName = sanitizeFileName(input.fileName);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const key = this.buildKey(fileName, sha256);

    const stored = await this.storage.putObject({
      key,
      body: buffer,
      contentType: mimeType,
      metadata: {
        sha256,
        original_name: fileName,
        uploaded_at: this.clock.now().toISOString(),
      },
    });

    this.logger.info('file.uploaded', {
      key,
      mimeType,
      sizeBytes: stored.size,
      sha256: stored.sha256,
    });

    return {
      key,
      uri: stored.uri || this.storage.buildUri(key),
      fileName,
      mimeType,
      sizeBytes: stored.size || buffer.length,
      sha256: stored.sha256 || sha256,
    };
  }

  async signedUrl(key: string, expiresInSeconds = 300): Promise<string> {
    const normalizedKey = this.normalizeKey(key);
    if (!normalizedKey) {
      throw new ValidationError('A valid attachment key is required');
    }
    const ttl = Number.isFinite(expiresInSeconds)
      ? Math.min(Math.max(30, Math.floor(expiresInSeconds)), 3600)
      : 300;
    return this.storage.presignGet(normalizedKey, ttl);
  }

  async resolveAttachmentInputs(keys: string[]): Promise<OutboundAttachmentInput[]> {
    if (!Array.isArray(keys) || keys.length === 0) return [];

    const resolved: OutboundAttachmentInput[] = [];
    let totalBytes = 0;

    for (const rawKey of keys) {
      const key = this.normalizeKey(rawKey);
      if (!key) {
        throw new ValidationError(`Invalid attachment key: ${String(rawKey)}`);
      }
      let buffer: Buffer;
      try {
        buffer = await this.storage.getObject(key);
      } catch (error) {
        throw new ValidationError(`Attachment not found in storage: ${key}`, {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      if (!buffer || buffer.length === 0) {
        throw new ValidationError(`Attachment is empty: ${key}`);
      }

      totalBytes += buffer.length;
      if (totalBytes > MAX_UPLOAD_BYTES) {
        throw new ValidationError(
          `Attachments exceed the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB total limit`,
          { totalBytes },
        );
      }

      const fileName = key.split('/').pop() ?? 'attachment';
      resolved.push({
        fileName: stripHashPrefix(fileName),
        mimeType: mimeTypeFromFileName(fileName),
        s3Key: key,
        sizeBytes: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        contentBase64: buffer.toString('base64'),
      });
    }

    return resolved;
  }

  /* ==================================================================== */
  /* Helpers                                                              */
  /* ==================================================================== */

  private buildKey(fileName: string, sha256: string): string {
    const now = this.clock.now();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `attachments/${year}/${month}/${sha256.slice(0, 8)}-${fileName}`;
  }

  /**
   * Accepts either a bare key (`attachments/...`) or a full `s3://bucket/key`
   * URI returned by the upload endpoint. Rejects anything outside the attachment
   * namespace to keep the service from reading arbitrary buckets.
   */
  private normalizeKey(key: string): string | null {
    if (typeof key !== 'string') return null;
    let normalized = key.trim();
    if (normalized === '') return null;

    if (normalized.startsWith('s3://')) {
      const withoutScheme = normalized.slice('s3://'.length);
      const slash = withoutScheme.indexOf('/');
      if (slash === -1) return null;
      normalized = withoutScheme.slice(slash + 1);
    }
    normalized = normalized.replace(/^\/+/, '');
    if (!normalized.startsWith('attachments/')) return null;
    return normalized;
  }

  /** Exposed for the HTTP layer so it can reject oversized bodies early. */
  get maxUploadBytes(): number {
    return MAX_UPLOAD_BYTES;
  }

  get attachmentsBucket(): string {
    return this.config.s3.attachmentsBucket;
  }
}

/* ---------------------------------------------------------------------- */
/* MIME helpers                                                           */
/* ---------------------------------------------------------------------- */

const EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  xml: 'application/xml',
  nfe: 'application/xml',
};

/** @deprecated Use `normalizeUploadMimeType` from `./files/upload-policy`. */
export function normalizeMimeType(value: string): string {
  return normalizeUploadMimeType(value);
}

export function mimeTypeFromFileName(fileName: string): string {
  const extension = (fileName.split('.').pop() ?? '').toLowerCase();
  return EXTENSION_MIME[extension] ?? 'application/octet-stream';
}

function stripHashPrefix(fileName: string): string {
  // Keys are `<sha8>-<original-name>`; restore the downloadable file name.
  return /^[a-f0-9]{8}-(.+)$/i.exec(fileName)?.[1] ?? fileName;
}
