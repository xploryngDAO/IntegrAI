import { describe, expect, it, vi } from 'vitest';
import type {
  ChannelRuntimeConfig,
  IClock,
  ILogger,
  IObjectStorage,
  PutObjectInput,
} from '@sac/shared';
import { ValidationError } from '@sac/shared';

import { FileService } from '../FileService';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  assertAllowedUploadMimeType,
  isAllowedUploadMimeType,
  isBlockedUploadMimeType,
  normalizeUploadMimeType,
} from '../files/upload-policy';

const noopLogger: ILogger = {
  child(): ILogger {
    return this;
  },
  trace(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

const clock: IClock = { now: () => new Date('2026-11-05T12:00:00.000Z') };

const config = {
  s3: { bucket: 'sac-hub-raw', attachmentsBucket: 'sac-hub-attachments' },
} as unknown as ChannelRuntimeConfig;

function createStorage(): IObjectStorage & { putObject: ReturnType<typeof vi.fn> } {
  const putObject = vi.fn(async (input: PutObjectInput) => ({
    key: input.key,
    uri: `s3://sac-hub-attachments/${input.key}`,
    size: input.body.length,
    sha256: 'f'.repeat(64),
  }));

  return {
    putObject,
    getObject: async () => Buffer.alloc(0),
    putToPresignedUrl: async () => undefined,
    presignGet: async () => 'https://signed.example/object',
    buildUri: (key: string) => `s3://sac-hub-attachments/${key}`,
    deleteObject: async () => undefined,
    deleteObjects: async () => ({ deleted: 0, failed: 0 }),
  } as unknown as IObjectStorage & { putObject: ReturnType<typeof vi.fn> };
}

function createService(storage: IObjectStorage): FileService {
  return new FileService({ logger: noopLogger, clock, storage, config });
}

describe('upload MIME policy', () => {
  it('blocks SVG even though it is an image/* type', () => {
    expect(isBlockedUploadMimeType('image/svg+xml')).toBe(true);
    expect(isAllowedUploadMimeType('image/svg+xml')).toBe(false);
  });

  it.each([
    'text/html',
    'application/xhtml+xml',
    'application/javascript',
    'text/javascript',
    'application/x-shockwave-flash',
  ])('blocks active content type %s', (mimeType) => {
    expect(() => assertAllowedUploadMimeType(mimeType)).toThrow(ValidationError);
    expect(isAllowedUploadMimeType(mimeType)).toBe(false);
  });

  it('rejects a type outside the image/document/zip allowlist', () => {
    expect(() => assertAllowedUploadMimeType('application/x-msdownload')).toThrow(
      /Unsupported attachment mime type/,
    );
    expect(isAllowedUploadMimeType('application/octet-stream')).toBe(false);
  });

  it('accepts the allowlist and normalizes aliases', () => {
    expect(assertAllowedUploadMimeType('IMAGE/PNG; charset=binary')).toBe('image/png');
    expect(assertAllowedUploadMimeType('image/jpg')).toBe('image/jpeg');
    expect(assertAllowedUploadMimeType('application/zip')).toBe('application/zip');
    expect(normalizeUploadMimeType('application/pdf; name=x.pdf')).toBe('application/pdf');
    for (const mimeType of ALLOWED_UPLOAD_MIME_TYPES) {
      expect(isAllowedUploadMimeType(mimeType)).toBe(true);
    }
  });

  it('exposes a stable error contract for the HTTP layer', () => {
    try {
      assertAllowedUploadMimeType('image/svg+xml');
      expect.unreachable('SVG must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validation = error as ValidationError;
      expect(validation.code).toBe('VALIDATION_ERROR');
      expect(validation.httpStatus).toBe(422);
      expect(validation.message).toBe('Unsupported attachment mime type');
      expect(validation.details?.reason).toContain('Active content types');
      expect(validation.details?.mimeType).toBe('image/svg+xml');
    }
  });
});

describe('FileService.upload MIME enforcement', () => {
  it('rejects SVG/HTML before writing anything to object storage', async () => {
    const storage = createStorage();
    const service = createService(storage);

    await expect(
      service.upload({ fileName: 'vector.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') }),
    ).rejects.toThrow(/Unsupported attachment mime type/);

    await expect(
      service.upload({
        fileName: 'page.html',
        mimeType: 'text/html',
        buffer: Buffer.from('<html></html>'),
      }),
    ).rejects.toThrow(/Unsupported attachment mime type/);

    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it('stores an allowed image with the normalized MIME and a scoped key', async () => {
    const storage = createStorage();
    const service = createService(storage);

    const uploaded = await service.upload({
      fileName: 'photo.png',
      mimeType: 'image/png',
      buffer: Buffer.from('png-bytes'),
    });

    expect(uploaded.mimeType).toBe('image/png');
    expect(uploaded.key).toMatch(/^attachments\/2026\/11\/[a-f0-9]{8}-photo\.png$/);
    expect(storage.putObject).toHaveBeenCalledTimes(1);
    const input = storage.putObject.mock.calls[0]?.[0] as PutObjectInput;
    expect(input.contentType).toBe('image/png');
  });

  it('stores a zip archive and a PDF document', async () => {
    const storage = createStorage();
    const service = createService(storage);

    await expect(
      service.upload({ fileName: 'evidence.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') }),
    ).resolves.toMatchObject({ mimeType: 'application/zip' });

    await expect(
      service.upload({ fileName: 'nfe.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') }),
    ).resolves.toMatchObject({ mimeType: 'application/pdf' });

    expect(storage.putObject).toHaveBeenCalledTimes(2);
  });
});
