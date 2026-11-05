import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ServerSideEncryption } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError } from '@sac/shared';
import type { ILogger, IObjectStorage, PutObjectInput, StoredObject } from '@sac/shared';

/**
 * Object storage (AWS S3 or MinIO) for `.eml` artifacts, NF-e and evidence.
 *
 * Bucket routing: `IObjectStorage` has no bucket parameter, so the key prefix
 * decides the physical bucket. Anything under `attachments/` goes to
 * `S3_ATTACHMENTS_BUCKET` (buyer-visible files, presigned downloads); every
 * other key (`amazon/inbound/...eml`, webhook payload dumps, ...) goes to
 * `S3_BUCKET` (immutable raw artifacts).
 */

const ATTACHMENT_KEY_PREFIX = 'attachments/';
const DEFAULT_PRESIGN_TTL_SECONDS = 600;
/** Hard ceiling for pre-signed uploads (large evidence files, slow networks). */
const PRESIGNED_UPLOAD_TIMEOUT_MS = 120_000;

export interface S3StorageConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  attachmentsBucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** e.g. `AES256` or `aws:kms`; empty in local MinIO. */
  sse?: string;
}

export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageConfigError';
    Object.setPrototypeOf(this, StorageConfigError.prototype);
  }
}

function requireSetting(value: string | undefined, name: string): string {
  if (!value || value.trim().length === 0) {
    throw new StorageConfigError(`Object storage is not configured: ${name} is required`);
  }
  return value;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class S3ObjectStorage implements IObjectStorage {
  private client: S3Client | null = null;

  constructor(
    private readonly config: S3StorageConfig,
    private readonly logger?: ILogger,
  ) {
    // Fail fast at boot: a misconfigured bucket must never reach a webhook path.
    requireSetting(config.region, 'S3_REGION');
    requireSetting(config.bucket, 'S3_BUCKET');
    requireSetting(config.attachmentsBucket, 'S3_ATTACHMENTS_BUCKET');
    requireSetting(config.accessKeyId, 'S3_ACCESS_KEY_ID');
    requireSetting(config.secretAccessKey, 'S3_SECRET_ACCESS_KEY');
  }

  /** Lazily created so importing the module never opens sockets. */
  getClient(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        region: this.config.region,
        endpoint: this.config.endpoint,
        forcePathStyle: this.config.forcePathStyle,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        },
      });
    }
    return this.client;
  }

  async putObject(input: PutObjectInput): Promise<StoredObject> {
    const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;
    const sha256 = createHash('sha256').update(body).digest('hex');
    const bucket = this.resolveBucket(input.key);

    try {
      await this.getClient().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: input.key,
          Body: body,
          ContentType: input.contentType ?? 'application/octet-stream',
          ContentLength: body.length,
          ContentMD5: input.contentMd5,
          Metadata: input.metadata,
          ServerSideEncryption: this.config.sse
            ? (this.config.sse as ServerSideEncryption)
            : undefined,
        }),
      );
    } catch (error) {
      this.logger?.error('storage.put_failed', { bucket, key: input.key, message: describeError(error) });
      throw new AppError(
        'STORAGE_PUT_FAILED',
        `Failed to store object ${input.key} in ${bucket}: ${describeError(error)}`,
        502,
        { bucket, key: input.key },
        true,
      );
    }

    return {
      key: input.key,
      uri: this.buildUri(input.key),
      size: body.length,
      sha256,
    };
  }

  async getObject(key: string): Promise<Buffer> {
    const bucket = this.resolveBucket(key);
    try {
      const output = await this.getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!output.Body) {
        throw new AppError('STORAGE_OBJECT_EMPTY', `Object ${key} has no body`, 404, { bucket, key });
      }
      const bytes = await output.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'NoSuchKey' || name === 'NotFound') {
        throw new AppError('STORAGE_OBJECT_NOT_FOUND', `Object ${key} not found in ${bucket}`, 404, {
          bucket,
          key,
        });
      }
      if (error instanceof AppError) throw error;
      this.logger?.error('storage.get_failed', { bucket, key, message: describeError(error) });
      throw new AppError(
        'STORAGE_GET_FAILED',
        `Failed to read object ${key} from ${bucket}: ${describeError(error)}`,
        502,
        { bucket, key },
        true,
      );
    }
  }

  async presignGet(key: string, expiresInSeconds = DEFAULT_PRESIGN_TTL_SECONDS): Promise<string> {
    const bucket = this.resolveBucket(key);
    const expiresIn = Math.min(604_800, Math.max(1, Math.floor(expiresInSeconds)));
    return getSignedUrl(this.getClient(), new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn,
    });
  }

  /** PUTs a buffer to an externally pre-signed S3 URL (Amazon uploadDestinations). */
  async putToPresignedUrl(url: string, body: Buffer, headers?: Record<string, string>): Promise<void> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers,
        body,
        signal: AbortSignal.timeout(PRESIGNED_UPLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new AppError(
        timedOut ? 'STORAGE_UPLOAD_TIMEOUT' : 'STORAGE_UPLOAD_FAILED',
        timedOut
          ? `Pre-signed upload timed out after ${PRESIGNED_UPLOAD_TIMEOUT_MS}ms`
          : `Failed to upload to pre-signed URL: ${describeError(error)}`,
        timedOut ? 504 : 502,
        undefined,
        true,
      );
    }

    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 500);
      } catch {
        detail = response.statusText;
      }
      throw new AppError(
        'STORAGE_UPLOAD_REJECTED',
        `Pre-signed upload rejected with HTTP ${response.status}: ${detail}`,
        502,
        { status: response.status },
        response.status >= 500 || response.status === 429,
      );
    }
  }

  buildUri(key: string): string {
    const normalized = key.replace(/^\/+/, '');
    return `s3://${this.resolveBucket(normalized)}/${normalized}`;
  }

  private resolveBucket(key: string): string {
    return key.startsWith(ATTACHMENT_KEY_PREFIX)
      ? this.config.attachmentsBucket
      : this.config.bucket;
  }
}
