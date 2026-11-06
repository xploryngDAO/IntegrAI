import { describe, expect, it } from 'vitest';

import {
  JOB_NAMES,
  QUEUE_NAMES,
  TENANT_BACKUP_PURGE_BATCH_SIZE,
  TENANT_BACKUP_RETENTION_DAYS,
} from '@sac/shared';

import { ConfigError, loadConfig } from '../../config';
import { buildSchedulerSpecs } from '../schedulers';

/**
 * Wiring contract of the LGPD Art. 15/16 backup-expiry job.
 *
 * `buildSchedulerSpecs` is pure, so the daily schedule is asserted without a
 * Redis broker: queue `queue.tenant.backup.purge`, job `tenant.backup.purge`,
 * cron `0 4 * * *`, registered idempotently under `sac:tenant-backup-purge`.
 * With `BACKUP_RETENTION_DAYS=0` the feature is disabled and NO scheduler is
 * registered at all (the worker also no-ops defensively).
 */

const BASE_CONFIG = {
  redisUrl: 'redis://127.0.0.1:6379',
  slaScanCron: '*/1 * * * *',
  piiPurgeCron: '0 */6 * * *',
  shopeeLostPushCron: '*/5 * * * *',
  tenantPurgeCron: '0 3 * * *',
  backupPurgeCron: '0 4 * * *',
  backupRetentionDays: 90,
  meliRefreshIntervalSeconds: 20_700,
  shopeeRefreshIntervalSeconds: 12_600,
};

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://sac:sac@localhost:5432/sac_hub?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'unit-test-secret-with-32-characters!!',
};

describe('tenant backup purge queue contract', () => {
  it('uses the documented queue and job names', () => {
    expect(QUEUE_NAMES.tenantBackupPurge).toBe('queue.tenant.backup.purge');
    expect(JOB_NAMES.tenantBackupPurge).toBe('tenant.backup.purge');
    expect(TENANT_BACKUP_RETENTION_DAYS).toBe(90);
    expect(TENANT_BACKUP_PURGE_BATCH_SIZE).toBe(100);
  });
});

describe('buildSchedulerSpecs - tenant backup purge', () => {
  it('registers a daily 04:00 sweep on queue.tenant.backup.purge', () => {
    const specs = buildSchedulerSpecs(BASE_CONFIG);

    expect(specs).toContainEqual({
      schedulerId: 'sac:tenant-backup-purge',
      queueName: 'queue.tenant.backup.purge',
      jobName: 'tenant.backup.purge',
      pattern: '0 4 * * *',
    });
  });

  it('keeps the schedule configurable', () => {
    const specs = buildSchedulerSpecs({ ...BASE_CONFIG, backupPurgeCron: '30 5 * * 1' });

    const purge = specs.find((spec) => spec.schedulerId === 'sac:tenant-backup-purge');
    expect(purge?.pattern).toBe('30 5 * * 1');
  });

  it('does not register the scheduler when retention is 0 (feature disabled)', () => {
    const specs = buildSchedulerSpecs({ ...BASE_CONFIG, backupRetentionDays: 0 });

    expect(specs.map((spec) => spec.schedulerId)).not.toContain('sac:tenant-backup-purge');
    // The other maintenance schedules remain untouched.
    expect(specs).toHaveLength(6);
  });
});

describe('AppConfig - backup retention', () => {
  it('defaults BACKUP_RETENTION_DAYS to 90 and BACKUP_PURGE_CRON to 0 4 * * *', () => {
    const config = loadConfig(BASE_ENV);

    expect(config.backupRetentionDays).toBe(90);
    expect(config.backupPurgeCron).toBe('0 4 * * *');
  });

  it('honors explicit environment overrides, including 0 = disabled', () => {
    const config = loadConfig({
      ...BASE_ENV,
      BACKUP_RETENTION_DAYS: '0',
      BACKUP_PURGE_CRON: '15 4 * * *',
    });

    expect(config.backupRetentionDays).toBe(0);
    expect(config.backupPurgeCron).toBe('15 4 * * *');
  });

  it('rejects a negative retention window instead of silently disabling it', () => {
    expect(() => loadConfig({ ...BASE_ENV, BACKUP_RETENTION_DAYS: '-1' })).toThrow(ConfigError);
  });
});
