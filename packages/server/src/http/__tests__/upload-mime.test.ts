import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildTestApp } from './http-test-harness';

/**
 * Attachment MIME policy at the HTTP edge.
 *
 * `POST /api/v1/files/upload` is multipart and has no JWT exemption, so the
 * suite provides a verified agent and a fake `IFileService`. The real controller
 * and the real `@fastify/multipart` parser run; only storage is faked.
 */

function multipart(
  fileName: string,
  mimeType: string,
  content: Buffer | string = 'attachment-bytes',
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----sacupload${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
    ),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    payload: body,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      authorization: 'Bearer upload-test-token',
    },
  };
}

describe('attachment upload MIME policy', () => {
  let app: FastifyInstance;
  let upload: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    upload = vi.fn(async (input: { fileName: string; mimeType: string; buffer: Buffer }) => ({
      key: `attachments/2026/11/deadbeef-${input.fileName}`,
      uri: `s3://sac-hub-attachments/attachments/2026/11/deadbeef-${input.fileName}`,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.length,
      sha256: 'a'.repeat(64),
    }));

    app = await buildTestApp({
      services: {
        agents: {
          verifyToken: async () => ({
            agentId: 'agent-1',
            email: 'op@example.test',
            name: 'Op',
            role: 'ADMIN',
            tenantId: 'tenant-1',
            isPlatformAdmin: false,
          }),
        },
        files: { upload },
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['vector.svg', 'image/svg+xml'],
    ['page.html', 'text/html'],
    ['script.js', 'application/javascript'],
    ['page.xhtml', 'application/xhtml+xml'],
    ['flash.swf', 'application/x-shockwave-flash'],
  ])('rejects %s (%s) with 422 and never touches storage', async (fileName, mimeType) => {
    upload.mockClear();

    const { payload, headers } = multipart(fileName, mimeType, '<script>alert(1)</script>');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload',
      headers,
      payload,
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Unsupported attachment mime type');
    expect(body.error.details.mimeType).toBe(mimeType);
    expect(body.error.details.reason).toContain('Active content types');
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([
    ['photo.png', 'image/png', 'image/png'],
    ['manual.pdf', 'application/pdf', 'application/pdf'],
    ['evidence.zip', 'application/zip', 'application/zip'],
    ['photo.jpg', 'image/jpg', 'image/jpeg'],
  ])('accepts %s (%s) and stores it as %s', async (fileName, declaredType, storedType) => {
    upload.mockClear();

    const { payload, headers } = multipart(fileName, declaredType, Buffer.from('binary'));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload',
      headers,
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.mimeType).toBe(storedType);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toMatchObject({ mimeType: storedType });
  });

  it('rejects a MIME outside the image/document/zip allowlist', async () => {
    upload.mockClear();

    const { payload, headers } = multipart('payload.exe', 'application/x-msdownload', 'MZ');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload',
      headers,
      payload,
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error.message).toBe('Unsupported attachment mime type');
    expect(body.error.details.reason).toContain('allowlist');
    expect(upload).not.toHaveBeenCalled();
  });

  it('keeps rejecting a non-multipart body on the upload route', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload',
      headers: {
        authorization: 'Bearer upload-test-token',
        'content-type': 'application/json',
      },
      payload: { file: 'not-multipart' },
    });

    // The content-type guard exempts the multipart route; the controller owns
    // the precise multipart error.
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toBe('Content-Type must be multipart/form-data');
  });
});
