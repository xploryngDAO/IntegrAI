import { describe, expect, it } from 'vitest';

import type {
  DeleteObjectsResult,
  IObjectStorage,
  ITenantBackupRepository,
  ITenantRepository,
  ITenantRestoreRepository,
  PutObjectInput,
  RecordTenantBackupInput,
  StoredObject,
  TenantBackupRecord,
  TenantBackupSnapshot,
} from '@sac/shared';
import { TENANT_BACKUP_PURGE_BATCH_SIZE } from '@sac/shared';

import { TenantBackupService } from '../TenantBackupService';
import { FrozenClock, silentLogger } from './accountFakes';

/**
 * LGPD Art. 15/16 - tenant backup expiry (storage limitation).
 *
 * The service owns the retention rules; these tests use in-memory ports to
 * prove:
 *  - only rows with `created_at < cutoff` are selected (strict, oldest first);
 *  - the per-run batch defaults to 100 and is bounded;
 *  - the S3 object is removed BEFORE the index row;
 *  - a storage failure KEEPS the row so the next run can retry and the object
 *    is never orphaned (deleting the pointer would lose the only trail);
 *  - `retentionDays <= 0` is a pure no-op (feature disabled);
 *  - the sweep is idempotent (second run, or a row already removed).
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** Full `IObjectStorage` fake; only `deleteObject` is exercised here. */
class FakeObjectStorage implements IObjectStorage {
  readonly deletedKeys: string[] = [];
  readonly failWith = new Map<string, Error>();
  /** Shared sequence with the repository: proves S3-before-DB ordering. */
  readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  async deleteObject(key: string): Promise<void> {
    this.events.push(`s3:${key}`);
    const failure = this.failWith.get(key);
    if (failure !== undefined) throw failure;
    this.deletedKeys.push(key);
  }

  async deleteObjects(): Promise<DeleteObjectsResult> {
    throw new Error('storage.deleteObjects is not used by the backup expiry');
  }

  async putObject(_input: PutObjectInput): Promise<StoredObject> {
    throw new Error('storage.putObject is not used by the backup expiry');
  }

  async getObject(): Promise<Buffer> {
    throw new Error('storage.getObject is not used by the backup expiry');
  }

  async putToPresignedUrl(): Promise<void> {
    throw new Error('storage.putToPresignedUrl is not used by the backup expiry');
  }

  async presignGet(): Promise<string> {
    throw new Error('storage.presignGet is not used by the backup expiry');
  }

  buildUri(key: string): string {
    return `s3://sac/${key}`;
  }
}

class InMemoryBackupRepository implements ITenantBackupRepository {
  readonly records: TenantBackupRecord[] = [];
  readonly events: string[];
  /** Rows whose DB delete lost a concurrent race (already removed). */
  readonly alreadyRemoved = new Set<string>();
  /** Rows whose DB delete fails (simulates a database outage per item). */
  readonly failDeleteFor = new Set<string>();
  readonly listCalls: Array<{ cutoff: Date; limit: number }> = [];

  constructor(events: string[]) {
    this.events = events;
  }

  async listExpired(cutoff: Date, limit: number): Promise<TenantBackupRecord[]> {
    this.listCalls.push({ cutoff, limit });
    return this.records
      .filter((row) => row.createdAt.getTime() < cutoff.getTime())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  async deleteById(id: string): Promise<boolean> {
    this.events.push(`db:${id}`);
    if (this.failDeleteFor.has(id)) throw new Error('database unavailable');
    if (this.alreadyRemoved.has(id)) return false;
    const index = this.records.findIndex((row) => row.id === id);
    if (index < 0) return false;
    this.records.splice(index, 1);
    return true;
  }

  async snapshot(): Promise<TenantBackupSnapshot> {
    throw new Error('repository.snapshot is not used by the backup expiry');
  }

  async record(_input: RecordTenantBackupInput): Promise<TenantBackupRecord> {
    throw new Error('repository.record is not used by the backup expiry');
  }

  async listByTenant(): Promise<TenantBackupRecord[]> {
    throw new Error('repository.listByTenant is not used by the backup expiry');
  }
}

function makeBackup(id: string, createdAt: Date, tenantId = 'tenant-1'): TenantBackupRecord {
  return {
    id,
    tenantId,
    backupKey: `backups/acme/${id}.json`,
    sizeBytes: 1_024,
    counts: {
      agents: 0,
      accounts: 0,
      tickets: 0,
      messages: 0,
      attachments: 0,
      events: 0,
      outboundAttempts: 0,
      orders: 0,
      slaPolicies: 0,
      webhookEvents: 0,
    },
    createdBy: 'platform-admin',
    createdAt,
  };
}

function createHarness() {
  const clock = new FrozenClock(NOW);
  const repo = new InMemoryBackupRepository([]);
  const storage = new FakeObjectStorage(repo.events);
  const service = new TenantBackupService({
    logger: silentLogger,
    clock,
    storage,
    repos: {
      // Not used by purgeExpired; the expiry only touches storage + index rows.
      tenants: {} as ITenantRepository,
      backups: repo,
      restore: {} as ITenantRestoreRepository,
    },
  });

  const seed = (id: string, createdAt: Date, tenantId?: string) => {
    const row = makeBackup(id, createdAt, tenantId);
    repo.records.push(row);
    return row;
  };

  return { clock, repo, storage, service, seed };
}

describe('TenantBackupService.purgeExpired - selection', () => {
  it('selects only rows strictly older than the cutoff (oldest first)', async () => {
    const h = createHarness();
    h.seed('days-120', daysAgo(120));
    h.seed('days-91', daysAgo(91));
    h.seed('days-90-boundary', daysAgo(90));
    h.seed('days-89', daysAgo(89));
    h.seed('days-10', daysAgo(10));

    const result = await h.service.purgeExpired({ retentionDays: 90, at: NOW });

    expect(h.repo.listCalls[0]).toEqual({ cutoff: daysAgo(90), limit: TENANT_BACKUP_PURGE_BATCH_SIZE });
    expect(result).toEqual({ scanned: 2, deleted: 2, objectsDeleted: 2, failures: 0 });
    expect(h.storage.deletedKeys).toEqual([
      'backups/acme/days-120.json',
      'backups/acme/days-91.json',
    ]);
    // `created_at === cutoff` is still inside the window; the recent row too.
    expect(h.repo.records.map((row) => row.id).sort()).toEqual([
      'days-10',
      'days-89',
      'days-90-boundary',
    ]);
  });

  it('uses the clock when no `at` override is given', async () => {
    const h = createHarness();
    h.seed('old', new Date(NOW.getTime() - 30 * DAY_MS - 1));
    h.seed('recent', new Date(NOW.getTime() - 30 * DAY_MS));

    const result = await h.service.purgeExpired({ retentionDays: 30 });

    expect(result.scanned).toBe(1);
    expect(h.repo.listCalls[0]?.cutoff).toEqual(new Date(NOW.getTime() - 30 * DAY_MS));
  });

  it('bounds each run by the batch size and leaves the backlog for the next run', async () => {
    const h = createHarness();
    h.seed('a', daysAgo(100));
    h.seed('b', daysAgo(99));
    h.seed('c', daysAgo(98));

    const first = await h.service.purgeExpired({ retentionDays: 90, batchSize: 2, at: NOW });
    expect(first).toEqual({ scanned: 2, deleted: 2, objectsDeleted: 2, failures: 0 });
    expect(h.repo.listCalls[0]?.limit).toBe(2);
    expect(h.repo.records.map((row) => row.id)).toEqual(['c']);

    const second = await h.service.purgeExpired({ retentionDays: 90, batchSize: 2, at: NOW });
    expect(second).toEqual({ scanned: 1, deleted: 1, objectsDeleted: 1, failures: 0 });
    expect(h.repo.records).toEqual([]);
  });

  it('uses the default batch of 100 when no limit is provided', async () => {
    const h = createHarness();
    h.seed('old', daysAgo(100));

    await h.service.purgeExpired({ retentionDays: 90, at: NOW });

    expect(TENANT_BACKUP_PURGE_BATCH_SIZE).toBe(100);
    expect(h.repo.listCalls[0]?.limit).toBe(100);
  });
});

describe('TenantBackupService.purgeExpired - ordering and failures', () => {
  it('deletes the S3 object BEFORE the database row', async () => {
    const h = createHarness();
    h.seed('old', daysAgo(100));

    await h.service.purgeExpired({ retentionDays: 90, at: NOW });

    expect(h.repo.events).toEqual(['s3:backups/acme/old.json', 'db:old']);
  });

  it('KEEPS the row when the S3 delete fails and still processes the rest', async () => {
    const h = createHarness();
    h.seed('old-a', daysAgo(100));
    h.seed('old-b', daysAgo(99));
    h.storage.failWith.set(
      'backups/acme/old-a.json',
      new Error('s3 delete denied'),
    );

    const result = await h.service.purgeExpired({ retentionDays: 90, at: NOW });

    expect(result).toEqual({ scanned: 2, deleted: 1, objectsDeleted: 1, failures: 1 });
    // The failed object's only pointer is preserved for the next retry.
    expect(h.repo.records.map((row) => row.id)).toEqual(['old-a']);
    expect(h.storage.deletedKeys).toEqual(['backups/acme/old-b.json']);
    expect(h.repo.events).toEqual([
      's3:backups/acme/old-a.json',
      's3:backups/acme/old-b.json',
      'db:old-b',
    ]);
  });

  it('never throws when the database delete fails after the object is gone', async () => {
    const h = createHarness();
    h.seed('old', daysAgo(100));
    h.repo.failDeleteFor.add('old');

    const result = await h.service.purgeExpired({ retentionDays: 90, at: NOW });

    expect(result).toEqual({ scanned: 1, deleted: 0, objectsDeleted: 1, failures: 1 });
    expect(h.repo.records.map((row) => row.id)).toEqual(['old']);
  });

  it('is idempotent: a second run finds nothing and does not re-delete objects', async () => {
    const h = createHarness();
    h.seed('old', daysAgo(100));

    const first = await h.service.purgeExpired({ retentionDays: 90, at: NOW });
    const second = await h.service.purgeExpired({ retentionDays: 90, at: NOW });

    expect(first).toEqual({ scanned: 1, deleted: 1, objectsDeleted: 1, failures: 0 });
    expect(second).toEqual({ scanned: 0, deleted: 0, objectsDeleted: 0, failures: 0 });
    expect(h.storage.deletedKeys).toEqual(['backups/acme/old.json']);
    expect(h.repo.listCalls).toHaveLength(2);
  });

  it('is idempotent when the row was already removed by a concurrent sweep', async () => {
    const h = createHarness();
    h.seed('old', daysAgo(100));
    h.repo.alreadyRemoved.add('old');

    const result = await h.service.purgeExpired({ retentionDays: 90, at: NOW });

    // The object is gone (idempotent S3 delete) and the missing row is not a failure.
    expect(result).toEqual({ scanned: 1, deleted: 0, objectsDeleted: 1, failures: 0 });
    expect(h.repo.events).toEqual(['s3:backups/acme/old.json', 'db:old']);
  });
});

describe('TenantBackupService.purgeExpired - disabled window', () => {
  it('is a pure no-op when retentionDays is 0 (BACKUP_RETENTION_DAYS=0)', async () => {
    const h = createHarness();
    h.seed('old', daysAgo(10_000));

    const result = await h.service.purgeExpired({ retentionDays: 0, at: NOW });

    expect(result).toEqual({ scanned: 0, deleted: 0, objectsDeleted: 0, failures: 0 });
    expect(h.repo.listCalls).toEqual([]);
    expect(h.storage.deletedKeys).toEqual([]);
    expect(h.repo.records).toHaveLength(1);
  });

  it('treats a negative window as disabled instead of clamping it to one day', async () => {
    const h = createHarness();
    h.seed('old', daysAgo(10_000));

    const result = await h.service.purgeExpired({ retentionDays: -30, at: NOW });

    expect(result).toEqual({ scanned: 0, deleted: 0, objectsDeleted: 0, failures: 0 });
    expect(h.repo.listCalls).toEqual([]);
  });
});
