import { describe, expect, it } from 'vitest';

import type {
  DeleteObjectsResult,
  IObjectStorage,
  ITenantPurgeRepository,
  PutObjectInput,
  StoredObject,
  TenantObjectKeys,
  TenantPurgeCounts,
  TenantRecord,
} from '@sac/shared';

import { TenantPurgeService, emptyCounts, uniqueStorageKeys } from '../TenantPurgeService';
import { FrozenClock, silentLogger } from './accountFakes';
import { InMemoryTenantRepository, makeTenant } from './platformFakes';

/**
 * LGPD purge policy tests (Fase 4).
 *
 * The Prisma repository is covered separately; here an in-memory purge port
 * proves the retention rules:
 *  - only workspaces soft-deleted BEFORE the cutoff are candidates;
 *  - one failing tenant never aborts the sweep;
 *  - S3 artifacts are erased BEFORE the DB transaction, missing keys are fine
 *    and a storage failure never aborts the database purge;
 *  - the manual endpoint skips the grace period but never purges a live one.
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;

const EMPTY_OBJECT_KEYS: TenantObjectKeys = {
  webhookPayloads: [],
  messageBodies: [],
  attachments: [],
  metadataAttachments: [],
};

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** Full `IObjectStorage` fake: only the delete path is exercised here. */
class FakeObjectStorage implements IObjectStorage {
  readonly deletedKeys: string[] = [];
  /** Shared sequence so a test can prove S3 runs before the DB transaction. */
  readonly events: string[];
  failWith: Error | null = null;
  /** Simulates keys the provider refused to delete (partial failure). */
  failedKeys = 0;

  constructor(events: string[]) {
    this.events = events;
  }

  async deleteObjects(keys: string[]): Promise<DeleteObjectsResult> {
    this.events.push('s3');
    this.deletedKeys.push(...keys);
    if (this.failWith !== null) throw this.failWith;
    return { deleted: keys.length - this.failedKeys, failed: this.failedKeys };
  }

  async deleteObject(key: string): Promise<void> {
    this.events.push('s3');
    if (this.failWith !== null) throw this.failWith;
    this.deletedKeys.push(key);
  }

  async putObject(_input: PutObjectInput): Promise<StoredObject> {
    throw new Error('storage.putObject is not used by the purge');
  }

  async getObject(): Promise<Buffer> {
    throw new Error('storage.getObject is not used by the purge');
  }

  async putToPresignedUrl(): Promise<void> {
    throw new Error('storage.putToPresignedUrl is not used by the purge');
  }

  async presignGet(): Promise<string> {
    throw new Error('storage.presignGet is not used by the purge');
  }

  buildUri(key: string): string {
    return `s3://sac/${key}`;
  }
}

class InMemoryPurgeRepository implements ITenantPurgeRepository {
  readonly candidates: TenantRecord[] = [];
  /** Candidates forced into the result regardless of `deleted_at` (bad repo). */
  readonly forced: TenantRecord[] = [];
  readonly purged: string[] = [];
  readonly failFor = new Set<string>();
  readonly failCollectFor = new Set<string>();
  readonly events: string[] = [];
  objectKeys: TenantObjectKeys = EMPTY_OBJECT_KEYS;
  lastQuery: { cutoff: Date; limit: number } | null = null;

  async findPurgeable(cutoff: Date, limit: number): Promise<TenantRecord[]> {
    this.lastQuery = { cutoff, limit };
    const eligible = this.candidates
      .filter(
        (tenant) =>
          tenant.status === 'DELETED' &&
          tenant.deletedAt !== null &&
          tenant.deletedAt.getTime() <= cutoff.getTime(),
      )
      .sort((a, b) => (a.deletedAt?.getTime() ?? 0) - (b.deletedAt?.getTime() ?? 0));
    return [...eligible, ...this.forced].slice(0, limit);
  }

  async collectObjectKeys(tenantId: string): Promise<TenantObjectKeys> {
    this.events.push('collect');
    if (this.failCollectFor.has(tenantId)) throw new Error('object key query failed');
    return this.objectKeys;
  }

  async purge(tenantId: string): Promise<TenantPurgeCounts> {
    this.events.push('db');
    if (this.failFor.has(tenantId)) throw new Error('database unavailable');
    this.purged.push(tenantId);
    return { ...emptyCounts(), sessions: 2, tickets: 3, tenant: 1 };
  }
}

function createHarness(options: { retentionDays?: number } = {}) {
  const clock = new FrozenClock(NOW);
  const tenants = new InMemoryTenantRepository(() => clock.now());
  const purge = new InMemoryPurgeRepository();
  // One sequence shared by the repository and the storage fake: order matters.
  const storage = new FakeObjectStorage(purge.events);
  const service = new TenantPurgeService({
    logger: silentLogger,
    clock,
    storage,
    ...(options.retentionDays !== undefined ? { retentionDays: options.retentionDays } : {}),
    repos: { tenants, purge },
  });

  const seedCandidate = (id: string, deletedAt: Date, overrides: Partial<TenantRecord> = {}) => {
    const tenant = tenants.seed({
      id,
      slug: id,
      status: 'DELETED',
      deletedAt,
      ...overrides,
    });
    purge.candidates.push(tenant);
    return tenant;
  };

  return { clock, tenants, purge, storage, service, seedCandidate };
}

describe('TenantPurgeService.run', () => {
  it('purges only workspaces soft-deleted beyond the 30-day grace period', async () => {
    const h = createHarness();
    h.seedCandidate('old', daysAgo(31));
    h.seedCandidate('recent', daysAgo(29));
    const live = h.tenants.seed(makeTenant({ id: 'live', slug: 'live' }));
    h.purge.candidates.push(live);

    const result = await h.service.run();

    expect(result.scanned).toBe(1);
    expect(result.purged.map((entry) => entry.tenantId)).toEqual(['old']);
    expect(result.purged[0]).toMatchObject({
      tenantId: 'old',
      slug: 'old',
      manual: false,
      counts: { sessions: 2, tickets: 3, tenant: 1 },
    });
    expect(result.purged[0].deletedAt).toBe(daysAgo(31).toISOString());
    expect(result.purged[0].purgedAt).toBe(NOW.toISOString());
    expect(result.failures).toEqual([]);
    expect(h.purge.purged).toEqual(['old']);
  });

  it('erases the workspace S3 artifacts BEFORE the database transaction', async () => {
    const h = createHarness();
    h.seedCandidate('old', daysAgo(31));
    h.purge.objectKeys = {
      webhookPayloads: ['s3://sac/webhooks/2026/11/push.json'],
      messageBodies: ['s3://sac/amazon/inbound/2026/11/m1.eml'],
      attachments: ['s3://sac-attachments/attachments/2026/11/nfe.xml'],
      metadataAttachments: ['attachments/2026/11/nfe.xml', '  '],
    };

    const result = await h.service.run();

    // URIs become keys, blanks are dropped and the duplicate is removed once.
    expect(h.storage.deletedKeys).toEqual([
      'webhooks/2026/11/push.json',
      'amazon/inbound/2026/11/m1.eml',
      'attachments/2026/11/nfe.xml',
    ]);
    // The keys are read before storage, and storage runs before the DB delete.
    expect(h.purge.events).toEqual(['collect', 's3', 'db']);
    expect(result.purged[0]).toMatchObject({
      tenantId: 'old',
      s3ObjectsDeleted: 3,
      s3Failed: 0,
    });
    expect(result.failures).toEqual([]);
  });

  it('continues the DB purge and reports s3Failed when storage throws', async () => {
    const h = createHarness();
    h.seedCandidate('old', daysAgo(31));
    h.purge.objectKeys = {
      ...EMPTY_OBJECT_KEYS,
      attachments: ['attachments/a.pdf', 'attachments/b.pdf'],
    };
    h.storage.failWith = new Error('s3 unavailable');

    const result = await h.service.run();

    expect(h.purge.purged).toEqual(['old']);
    expect(result.purged[0]).toMatchObject({ s3ObjectsDeleted: 0, s3Failed: 2 });
    // A storage outage is NOT a purge failure: the workspace is gone from the DB.
    expect(result.failures).toEqual([]);
  });

  it('reports a partial storage failure without aborting the purge', async () => {
    const h = createHarness();
    h.seedCandidate('old', daysAgo(31));
    h.purge.objectKeys = {
      ...EMPTY_OBJECT_KEYS,
      attachments: ['attachments/a.pdf', 'attachments/b.pdf', 'attachments/c.pdf'],
    };
    h.storage.failedKeys = 1;

    const result = await h.service.run();

    expect(h.purge.purged).toEqual(['old']);
    expect(result.purged[0]).toMatchObject({ s3ObjectsDeleted: 2, s3Failed: 1 });
  });

  it('still purges the DB when collecting the S3 keys fails', async () => {
    const h = createHarness();
    h.seedCandidate('old', daysAgo(31));
    h.purge.failCollectFor.add('old');

    const result = await h.service.run();

    expect(result.purged.map((entry) => entry.tenantId)).toEqual(['old']);
    expect(result.purged[0]).toMatchObject({ s3ObjectsDeleted: 0, s3Failed: 0 });
    expect(h.storage.deletedKeys).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('does not touch storage when the workspace has no artifacts', async () => {
    const h = createHarness();
    h.seedCandidate('old', daysAgo(31));

    const result = await h.service.run();

    expect(h.purge.events).toEqual(['collect', 'db']);
    expect(h.storage.deletedKeys).toEqual([]);
    expect(result.purged[0]).toMatchObject({ s3ObjectsDeleted: 0, s3Failed: 0 });
  });

  it('uses the configured retention window and cutoff', async () => {
    const h = createHarness({ retentionDays: 7 });
    h.seedCandidate('eight-days', daysAgo(8));
    h.seedCandidate('six-days', daysAgo(6));

    const result = await h.service.run({ limit: 10 });

    expect(result.purged.map((entry) => entry.tenantId)).toEqual(['eight-days']);
    expect(h.purge.lastQuery?.cutoff).toEqual(new Date(NOW.getTime() - 7 * DAY_MS));
    expect(h.purge.lastQuery?.limit).toBe(10);
  });

  it('drains the backlog oldest-first, bounded by the batch size', async () => {
    const h = createHarness();
    h.seedCandidate('third', daysAgo(31));
    h.seedCandidate('first', daysAgo(90));
    h.seedCandidate('second', daysAgo(60));

    const result = await h.service.run({ limit: 2 });

    expect(h.purge.lastQuery?.limit).toBe(2);
    expect(result.purged.map((entry) => entry.tenantId)).toEqual(['first', 'second']);
    expect(result.purged.map((entry) => entry.manual)).toEqual([false, false]);
  });

  it('keeps sweeping when one workspace fails and reports it', async () => {
    const h = createHarness();
    h.seedCandidate('broken', daysAgo(60));
    h.seedCandidate('healthy', daysAgo(40));
    h.purge.failFor.add('broken');

    const result = await h.service.run();

    expect(result.scanned).toBe(2);
    expect(result.purged.map((entry) => entry.tenantId)).toEqual(['healthy']);
    expect(result.failures).toEqual([
      { tenantId: 'broken', error: 'database unavailable' },
    ]);
  });

  it('never hard-deletes a candidate that is not soft-deleted (defensive)', async () => {
    const h = createHarness();
    const live = h.tenants.seed(
      makeTenant({ id: 'sneaky', slug: 'sneaky', status: 'DELETED', deletedAt: null }),
    );
    h.purge.forced.push(live);

    const result = await h.service.run();

    expect(result.purged).toEqual([]);
    expect(result.failures).toEqual([
      { tenantId: 'sneaky', error: 'TENANT_NOT_SOFT_DELETED' },
    ]);
    expect(h.purge.purged).toEqual([]);
  });

  it('defaults the batch size to the shared constant', async () => {
    const h = createHarness();

    await h.service.run();

    expect(h.purge.lastQuery?.limit).toBe(25);
  });
});

describe('TenantPurgeService.purgeTenant (manual platform endpoint)', () => {
  it('purges a soft-deleted workspace without waiting for the grace period', async () => {
    const h = createHarness();
    h.tenants.seed(
      makeTenant({
        id: 'tenant-1',
        slug: 'acme',
        status: 'DELETED',
        deletedAt: daysAgo(1),
      }),
    );
    h.purge.objectKeys = {
      ...EMPTY_OBJECT_KEYS,
      webhookPayloads: ['s3://sac/webhooks/push.json'],
    };

    const result = await h.service.purgeTenant('tenant-1', 'agent-platform');

    expect(result).toMatchObject({
      tenantId: 'tenant-1',
      slug: 'acme',
      manual: true,
      counts: { sessions: 2, tickets: 3, tenant: 1 },
      s3ObjectsDeleted: 1,
      s3Failed: 0,
    });
    expect(h.purge.purged).toEqual(['tenant-1']);
    expect(h.storage.deletedKeys).toEqual(['webhooks/push.json']);
  });

  it('refuses a workspace that was never soft-deleted (409 TENANT_NOT_DELETED)', async () => {
    const h = createHarness();
    h.tenants.seed(makeTenant({ id: 'tenant-1', slug: 'acme' }));

    await expect(h.service.purgeTenant('tenant-1', 'agent-platform')).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
      details: { code: 'TENANT_NOT_DELETED' },
    });
    expect(h.purge.purged).toEqual([]);
  });

  it('answers 404 for an unknown workspace', async () => {
    const h = createHarness();

    await expect(h.service.purgeTenant('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('propagates a repository failure (the caller sees the error)', async () => {
    const h = createHarness();
    h.tenants.seed(
      makeTenant({
        id: 'tenant-1',
        slug: 'acme',
        status: 'DELETED',
        deletedAt: daysAgo(2),
      }),
    );
    h.purge.failFor.add('tenant-1');

    await expect(h.service.purgeTenant('tenant-1')).rejects.toThrow('database unavailable');
  });
});

describe('uniqueStorageKeys', () => {
  it('normalizes s3:// URIs to keys and removes duplicates across sources', () => {
    expect(
      uniqueStorageKeys([
        's3://bucket-a/attachments/2026/11/file.pdf',
        'attachments/2026/11/file.pdf',
        '  s3://bucket-b/webhooks/push.json  ',
        '',
        '   ',
      ]),
    ).toEqual(['attachments/2026/11/file.pdf', 'webhooks/push.json']);
  });

  it('keeps bare keys and strips a leading slash', () => {
    expect(uniqueStorageKeys(['/attachments/a.png', 'attachments/a.png'])).toEqual([
      'attachments/a.png',
    ]);
  });

  it('ignores values that are not strings (defensive JSON input)', () => {
    expect(uniqueStorageKeys([null as unknown as string, 42 as unknown as string])).toEqual([]);
  });
});
