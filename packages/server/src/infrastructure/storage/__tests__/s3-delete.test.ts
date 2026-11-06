import { describe, expect, it, vi } from 'vitest';
import { DeleteObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';

import { S3ObjectStorage } from '../s3';

/**
 * Delete-path tests for `S3ObjectStorage` (LGPD purge).
 *
 * The AWS client is replaced by a recording fake: no SDK transport, no bucket.
 * Pinned contract:
 *  - `deleteObject` swallows NoSuchKey/NotFound (idempotent) and reports other
 *    failures as `STORAGE_DELETE_FAILED`;
 *  - `deleteObjects` routes keys by prefix to the right bucket, chunks at 1.000,
 *    counts NoSuchKey as deleted, counts real errors as failed and NEVER throws
 *    for a partial/transport failure (the DB purge must continue).
 */

function createStorage() {
  const sent: Array<{ command: unknown; bucket: string; keys: string[] }> = [];
  let handler: (command: unknown) => Promise<unknown> = async () => ({});

  const storage = new S3ObjectStorage({
    region: 'us-east-1',
    bucket: 'sac',
    attachmentsBucket: 'sac-attachments',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    forcePathStyle: true,
  });

  const client = {
    send: async (command: unknown) => {
      if (command instanceof DeleteObjectsCommand) {
        const input = command.input as { Bucket: string; Delete: { Objects: Array<{ Key: string }> } };
        sent.push({
          command,
          bucket: input.Bucket,
          keys: input.Delete.Objects.map((entry) => entry.Key),
        });
      } else if (command instanceof DeleteObjectCommand) {
        const input = command.input as { Bucket: string; Key: string };
        sent.push({ command, bucket: input.Bucket, keys: [input.Key] });
      }
      return handler(command);
    },
  } as unknown as S3Client;

  vi.spyOn(storage, 'getClient').mockReturnValue(client);

  return {
    storage,
    sent,
    onSend(next: (command: unknown) => Promise<unknown>) {
      handler = next;
    },
  };
}

function missingKeyError(): Error {
  const error = new Error('The specified key does not exist');
  error.name = 'NoSuchKey';
  return error;
}

describe('S3ObjectStorage.deleteObject', () => {
  it('deletes from the bucket selected by the key prefix', async () => {
    const h = createStorage();

    await h.storage.deleteObject('amazon/inbound/m1.eml');
    await h.storage.deleteObject('attachments/2026/11/nfe.xml');

    expect(h.sent.map((entry) => entry.bucket)).toEqual(['sac', 'sac-attachments']);
  });

  it('tolerates NoSuchKey/NotFound (already deleted)', async () => {
    const h = createStorage();
    h.onSend(async () => {
      throw missingKeyError();
    });

    await expect(h.storage.deleteObject('attachments/gone.pdf')).resolves.toBeUndefined();
  });

  it('wraps a real failure as STORAGE_DELETE_FAILED', async () => {
    const h = createStorage();
    h.onSend(async () => {
      const error = new Error('Access Denied');
      error.name = 'AccessDenied';
      throw error;
    });

    await expect(h.storage.deleteObject('attachments/secret.pdf')).rejects.toMatchObject({
      code: 'STORAGE_DELETE_FAILED',
      httpStatus: 502,
    });
  });
});

describe('S3ObjectStorage.deleteObjects', () => {
  it('sends no request for an empty/blank list', async () => {
    const h = createStorage();

    const result = await h.storage.deleteObjects(['', '   ']);

    expect(result).toEqual({ deleted: 0, failed: 0 });
    expect(h.sent).toHaveLength(0);
  });

  it('counts every key as deleted when the provider accepts the chunk', async () => {
    const h = createStorage();
    h.onSend(async () => ({ Errors: [] }));

    const result = await h.storage.deleteObjects([
      'webhooks/push.json',
      'amazon/inbound/m1.eml',
      'attachments/a.pdf',
    ]);

    expect(result).toEqual({ deleted: 3, failed: 0 });
    expect(h.sent.map((entry) => entry.bucket)).toEqual(['sac', 'sac-attachments']);
  });

  it('treats NoSuchKey as deleted and real provider errors as failed', async () => {
    const h = createStorage();
    h.onSend(async () => ({
      Errors: [
        { Key: 'attachments/missing.pdf', Code: 'NoSuchKey' },
        { Key: 'attachments/forbidden.pdf', Code: 'AccessDenied' },
      ],
    }));

    const result = await h.storage.deleteObjects([
      'attachments/missing.pdf',
      'attachments/forbidden.pdf',
      'attachments/ok.pdf',
    ]);

    expect(result).toEqual({ deleted: 2, failed: 1 });
  });

  it('keeps going and reports s3Failed when a chunk fails at transport level', async () => {
    const h = createStorage();
    h.onSend(async () => {
      throw new Error('network down');
    });

    const result = await h.storage.deleteObjects(['sac/a.pdf', 'attachments/b.pdf']);

    expect(result).toEqual({ deleted: 0, failed: 2 });
    expect(h.sent).toHaveLength(2);
  });

  it('deduplicates keys and chunks requests at 1.000 objects', async () => {
    const h = createStorage();
    h.onSend(async () => ({ Errors: [] }));
    const keys = Array.from({ length: 1_001 }, (_, index) => `webhooks/${index}.json`);

    const result = await h.storage.deleteObjects([...keys, ...keys.slice(0, 5)]);

    expect(result).toEqual({ deleted: 1_001, failed: 0 });
    expect(h.sent).toHaveLength(2);
    expect(h.sent.map((entry) => entry.keys.length)).toEqual([1_000, 1]);
  });
});
