import { describe, expect, it } from 'vitest';

import { JOB_NAMES, QUEUE_NAMES, TENANT_PURGE_BATCH_SIZE, TENANT_PURGE_RETENTION_DAYS } from '@sac/shared';

import { loadConfig } from '../../config';
import { buildSchedulerSpecs } from '../schedulers';

/**
 * Wiring contract of the LGPD purge job (Fase 4).
 *
 * `buildSchedulerSpecs` is pure, so the daily schedule can be asserted without a
 * Redis broker: queue `queue.tenant.purge`, job `tenant.purge`, cron
 * `0 3 * * *`, registered idempotently under `sac:tenant-purge`.
 */

const BASE_CONFIG = {
  redisUrl: 'redis://127.0.0.1:6379',
  slaScanCron: '*/1 * * * *',
  piiPurgeCron: '0 */6 * * *',
  shopeeLostPushCron: '*/5 * * * *',
  tenantPurgeCron: '0 3 * * *',
  meliRefreshIntervalSeconds: 20_700,
  shopeeRefreshIntervalSeconds: 12_600,
};

describe('tenant purge queue contract', () => {
  it('uses the documented queue and job names', () => {
    expect(QUEUE_NAMES.tenantPurge).toBe('queue.tenant.purge');
    expect(JOB_NAMES.tenantPurge).toBe('tenant.purge');
  });

  it('defaults to 30 days of retention and a 25-tenant batch', () => {
    expect(TENANT_PURGE_RETENTION_DAYS).toBe(30);
    expect(TENANT_PURGE_BATCH_SIZE).toBe(25);
  });
});

describe('buildSchedulerSpecs - tenant purge', () => {
  it('registers a daily 03:00 sweep on queue.tenant.purge', () => {
    const specs = buildSchedulerSpecs(BASE_CONFIG);

    expect(specs).toContainEqual({
      schedulerId: 'sac:tenant-purge',
      queueName: 'queue.tenant.purge',
      jobName: 'tenant.purge',
      pattern: '0 3 * * *',
    });
  });

  it('keeps the schedule configurable and the other crons untouched', () => {
    const specs = buildSchedulerSpecs({ ...BASE_CONFIG, tenantPurgeCron: '30 2 * * 1' });

    const purge = specs.find((spec) => spec.schedulerId === 'sac:tenant-purge');
    expect(purge?.pattern).toBe('30 2 * * 1');
    expect(specs.filter((spec) => spec.schedulerId !== 'sac:tenant-purge')).toHaveLength(5);
  });
});

describe('AppConfig - purge retention', () => {
  it('defaults TENANT_PURGE_CRON to 0 3 * * * and the retention to 30 days', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://sac:sac@localhost:5432/sac_hub?schema=public',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'unit-test-secret-with-32-characters!!',
    });

    expect(config.cron.tenantPurge).toBe('0 3 * * *');
    expect(config.tenantPurgeRetentionDays).toBe(30);
  });

  it('honors explicit environment overrides', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://sac:sac@localhost:5432/sac_hub?schema=public',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'unit-test-secret-with-32-characters!!',
      TENANT_PURGE_CRON: '15 4 * * *',
      TENANT_PURGE_RETENTION_DAYS: '45',
    });

    expect(config.cron.tenantPurge).toBe('15 4 * * *');
    expect(config.tenantPurgeRetentionDays).toBe(45);
  });
});
