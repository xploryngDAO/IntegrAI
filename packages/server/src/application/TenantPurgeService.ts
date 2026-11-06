import type {
  IClock,
  ILogger,
  IObjectStorage,
  ITenantPurgeRepository,
  ITenantPurgeService,
  ITenantRepository,
  TenantObjectKeys,
  TenantPurgeCounts,
  TenantPurgeResult,
  TenantPurgeRunOptions,
  TenantPurgeRunResult,
  TenantRecord,
} from '@sac/shared';
import {
  ConflictError,
  NotFoundError,
  TENANT_PURGE_BATCH_SIZE,
  TENANT_PURGE_RETENTION_DAYS,
} from '@sac/shared';

/**
 * ============================================================================
 * TenantPurgeService - LGPD physical deletion (Fase 4)
 * ============================================================================
 *
 * `DELETE /tenants/me` only SOFT deletes a workspace (`status='DELETED'` +
 * `deleted_at`), which keeps every row available for audit. This service is the
 * second half of the policy:
 *
 *  - `run()` (daily `queue.tenant.purge`, 03:00) selects the workspaces whose
 *    `deleted_at` is older than the grace period (30 days) and purges them in
 *    one transaction per tenant, logging the per-table counts.
 *  - `purgeTenant()` is the manual platform-admin path
 *    (`POST /platform/tenants/:id/purge`): it skips the grace period but still
 *    refuses a workspace that was never soft-deleted (409).
 *
 * Design notes:
 *  - One failed tenant never aborts the sweep: it is recorded in `failures` and
 *    the remaining candidates still run.
 *  - S3 first, database second: before opening the purge transaction the
 *    service collects the workspace's object keys and erases them through
 *    `IObjectStorage`. A storage failure is reported as `s3Failed` and never
 *    aborts the database purge (the objects become orphans, logged for manual
 *    cleanup, instead of blocking LGPD erasure of the relational data).
 *  - The retention/legal note: the job removes operational data, so a tenant
 *    purged here cannot be restored; the endpoint is platform-admin only and
 *    the cron run is bounded by `TENANT_PURGE_BATCH_SIZE`.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_BATCH_SIZE = 500;

export interface TenantPurgeServiceDependencies {
  logger: ILogger;
  clock: IClock;
  /** Object storage for the workspace artifacts (S3/MinIO). */
  storage: IObjectStorage;
  /** Grace period (days) between soft delete and physical purge. */
  retentionDays?: number;
  repos: {
    tenants: ITenantRepository;
    purge: ITenantPurgeRepository;
  };
}

export class TenantPurgeService implements ITenantPurgeService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly storage: IObjectStorage;
  private readonly tenants: ITenantRepository;
  private readonly purge: ITenantPurgeRepository;
  private readonly retentionDays: number;

  constructor(deps: TenantPurgeServiceDependencies) {
    this.logger = deps.logger.child({ component: 'TenantPurgeService' });
    this.clock = deps.clock;
    this.storage = deps.storage;
    this.tenants = deps.repos.tenants;
    this.purge = deps.repos.purge;
    this.retentionDays = normalizeRetentionDays(deps.retentionDays);
  }

  /* ==================================================================== */
  /* Scheduled sweep                                                      */
  /* ==================================================================== */

  async run(options: TenantPurgeRunOptions = {}): Promise<TenantPurgeRunResult> {
    const startedAt = this.clock.now();
    const limit = normalizeBatchSize(options.limit);
    const cutoff = new Date(startedAt.getTime() - this.retentionDays * DAY_MS);

    const candidates = await this.purge.findPurgeable(cutoff, limit);
    this.logger.info('tenant.purge.scan', {
      candidates: candidates.length,
      limit,
      retentionDays: this.retentionDays,
      cutoff: cutoff.toISOString(),
    });

    const purged: TenantPurgeResult[] = [];
    const failures: Array<{ tenantId: string; error: string }> = [];

    for (const candidate of candidates) {
      if (candidate.deletedAt === null) {
        // Defensive: `findPurgeable` already filters on `deleted_at`, but a bad
        // repository implementation must never hard-delete a live workspace.
        failures.push({ tenantId: candidate.id, error: 'TENANT_NOT_SOFT_DELETED' });
        this.logger.warn('tenant.purge.skipped', {
          tenantId: candidate.id,
          slug: candidate.slug,
          reason: 'TENANT_NOT_SOFT_DELETED',
        });
        continue;
      }

      try {
        purged.push(await this.purgeOne(candidate, false));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ tenantId: candidate.id, error: message.slice(0, 500) });
        this.logger.error('tenant.purge.failed', {
          tenantId: candidate.id,
          slug: candidate.slug,
          error: message.slice(0, 500),
        });
      }
    }

    const finishedAt = this.clock.now();
    this.logger.info('tenant.purge.completed', {
      scanned: candidates.length,
      purged: purged.length,
      failed: failures.length,
      retentionDays: this.retentionDays,
      totals: sumCounts(purged.map((result) => result.counts)),
      s3ObjectsDeleted: purged.reduce((sum, result) => sum + result.s3ObjectsDeleted, 0),
      s3Failed: purged.reduce((sum, result) => sum + result.s3Failed, 0),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    });

    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      scanned: candidates.length,
      purged,
      failures,
    };
  }

  /* ==================================================================== */
  /* Manual purge                                                         */
  /* ==================================================================== */

  async purgeTenant(tenantId: string, actorId?: string | null): Promise<TenantPurgeResult> {
    const tenant = await this.tenants.findById(tenantId);
    if (tenant === null) throw new NotFoundError('Tenant', tenantId);

    if (tenant.deletedAt === null) {
      // Purging a live workspace would bypass the LGPD double confirmation
      // (`DELETE /tenants/me` with password + slug); require the soft delete.
      throw new ConflictError('Only soft-deleted workspaces can be purged', {
        code: 'TENANT_NOT_DELETED',
        status: tenant.status,
      });
    }

    const result = await this.purgeOne(tenant, true);
    this.logger.info('tenant.purge.manual', {
      tenantId,
      slug: result.slug,
      actorId: actorId ?? null,
      counts: result.counts,
    });
    return result;
  }

  /* ==================================================================== */
  /* Internals                                                            */
  /* ==================================================================== */

  private async purgeOne(tenant: TenantRecord, manual: boolean): Promise<TenantPurgeResult> {
    // S3 BEFORE the transaction: the keys still exist in the rows, and a long
    // storage call must not hold a database transaction open. The DB purge is
    // attempted even when the storage delete fails (see `purgeStorage`).
    const storage = await this.purgeStorage(tenant);

    const counts = await this.purge.purge(tenant.id);
    const purgedAt = this.clock.now();

    this.logger.info('tenant.purge.tenant_deleted', {
      tenantId: tenant.id,
      slug: tenant.slug,
      manual,
      deletedAt: tenant.deletedAt?.toISOString() ?? null,
      purgedAt: purgedAt.toISOString(),
      counts,
      s3ObjectsDeleted: storage.deleted,
      s3Failed: storage.failed,
    });

    return {
      tenantId: tenant.id,
      slug: tenant.slug,
      deletedAt: tenant.deletedAt?.toISOString() ?? null,
      purgedAt: purgedAt.toISOString(),
      counts,
      s3ObjectsDeleted: storage.deleted,
      s3Failed: storage.failed,
      manual,
    };
  }

  /**
   * Collects and deletes the workspace's S3 artifacts.
   *
   * Failure policy: NEVER throw. The LGPD purge must remove the relational data
   * even when object storage is unavailable; the leftover objects are counted
   * in `s3Failed` and logged (without keys, which may embed buyer PII) so the
   * operator can retry or rely on the bucket lifecycle policy.
   */
  private async purgeStorage(tenant: TenantRecord): Promise<{ deleted: number; failed: number }> {
    let artifacts: TenantObjectKeys;
    try {
      artifacts = await this.purge.collectObjectKeys(tenant.id);
    } catch (error) {
      // Without the keys nothing can be deleted; the DB purge still runs. The
      // error is logged because it means the objects are now unreachable.
      this.logger.error('tenant.purge.s3_collect_failed', {
        tenantId: tenant.id,
        slug: tenant.slug,
        error: describeError(error),
      });
      return { deleted: 0, failed: 0 };
    }

    const keys = uniqueStorageKeys([
      ...artifacts.webhookPayloads,
      ...artifacts.messageBodies,
      ...artifacts.attachments,
      ...artifacts.metadataAttachments,
    ]);
    if (keys.length === 0) return { deleted: 0, failed: 0 };

    try {
      const result = await this.storage.deleteObjects(keys);
      this.logger.info('tenant.purge.s3_completed', {
        tenantId: tenant.id,
        slug: tenant.slug,
        keys: keys.length,
        deleted: result.deleted,
        failed: result.failed,
      });
      return result;
    } catch (error) {
      // Defensive: `deleteObjects` is documented to return counts instead of
      // throwing, but a custom implementation may still fail. Assume none were
      // removed (conservative) and keep the purge going.
      this.logger.error('tenant.purge.s3_failed', {
        tenantId: tenant.id,
        slug: tenant.slug,
        keys: keys.length,
        error: describeError(error),
      });
      return { deleted: 0, failed: keys.length };
    }
  }
}

function normalizeRetentionDays(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) return TENANT_PURGE_RETENTION_DAYS;
  return Math.max(1, Math.trunc(value));
}

function normalizeBatchSize(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) return TENANT_PURGE_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.trunc(value)));
}

/**
 * Normalizes the keys collected from the database: `s3://bucket/key` URIs become
 * bare keys (what `IObjectStorage` expects), blanks are dropped and duplicates
 * are removed once across all sources (the same file can be both an attachment
 * row and an outbox `attachment_keys` entry).
 */
export function uniqueStorageKeys(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const match = /^s3:\/\/[^/]+\/(.+)$/i.exec(trimmed);
    const key = match?.[1] ?? trimmed.replace(/^\/+/, '');
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

function sumCounts(counts: readonly TenantPurgeCounts[]): TenantPurgeCounts {
  const totals = emptyCounts();
  for (const entry of counts) {
    for (const key of Object.keys(totals) as Array<keyof TenantPurgeCounts>) {
      totals[key] += entry[key] ?? 0;
    }
  }
  return totals;
}

export function emptyCounts(): TenantPurgeCounts {
  return {
    sessions: 0,
    invitations: 0,
    passwordResets: 0,
    emailVerifications: 0,
    twoFactorRecoveryCodes: 0,
    buyerPiiVault: 0,
    messageAttachments: 0,
    messages: 0,
    ticketEvents: 0,
    outboundAttempts: 0,
    tickets: 0,
    orders: 0,
    webhookEvents: 0,
    slaPolicies: 0,
    accounts: 0,
    agents: 0,
    tenant: 0,
  };
}
