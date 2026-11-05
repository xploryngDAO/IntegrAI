import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { JOB_NAMES, QUEUE_NAMES, redactPiiForLogs } from '@sac/shared';

import { createQueueConnection } from './connection';
import type { WorkerDependencies } from './workers';

/**
 * ============================================================================
 * BullMQ schedulers
 * ============================================================================
 *
 * Cron-driven maintenance is registered with `upsertJobScheduler`, which is
 * idempotent: restarting the API/worker does not duplicate schedules.
 *
 *  - `queue.sla.scan`        -> config.cron.slaScan        (default every minute)
 *  - `queue.pii.purge`       -> config.cron.piiPurge       (every 6 hours)
 *  - `queue.shopee.lost-push`-> config.cron.shopeeLostPush (every 5 minutes)
 *  - `queue.token.refresh`   -> marketplace refresh intervals (Meli ~5h45m,
 *                               Shopee 3h30m, per CHANNEL_CONTRACTS)
 *
 * Each scheduler is registered independently so one bad expression cannot take
 * the whole maintenance plane down.
 */

export interface SchedulerResources {
  queues: Queue[];
  connection: Redis | null;
}

interface SchedulerSpec {
  schedulerId: string;
  queueName: string;
  jobName: string;
  pattern?: string;
  everyMs?: number;
  data?: Record<string, unknown>;
}

export async function registerSchedulers(deps: WorkerDependencies): Promise<SchedulerResources> {
  let connection: Redis | null = null;
  try {
    connection = createQueueConnection(deps.config.redisUrl, 'scheduler', deps.logger);
  } catch (error) {
    deps.logger.error('queue.scheduler.connection_failed', {
      error: redactPiiForLogs(error instanceof Error ? error.message : String(error)),
    });
  }

  const queues = new Map<string, Queue>();
  const getQueue = (name: string): Queue => {
    const existing = queues.get(name);
    if (existing) return existing;
    const queue = new Queue(name, {
      connection: connection ?? { url: deps.config.redisUrl },
      defaultJobOptions: {
        removeOnComplete: { count: 200, age: 24 * 3600 },
        removeOnFail: { count: 1_000, age: 7 * 24 * 3600 },
        attempts: 1,
        backoff: { type: 'fixed', delay: 5_000 },
      },
    });
    queues.set(name, queue);
    return queue;
  };

  const specs: SchedulerSpec[] = [
    {
      schedulerId: 'sac:sla-scan',
      queueName: QUEUE_NAMES.slaScan,
      jobName: JOB_NAMES.slaScan,
      pattern: deps.config.slaScanCron,
    },
    {
      schedulerId: 'sac:pii-purge',
      queueName: QUEUE_NAMES.piiPurge,
      jobName: JOB_NAMES.piiPurge,
      pattern: deps.config.piiPurgeCron,
    },
    {
      schedulerId: 'sac:shopee-lost-push',
      queueName: QUEUE_NAMES.shopeeLostPush,
      jobName: JOB_NAMES.shopeeLostPushRecover,
      pattern: deps.config.shopeeLostPushCron,
    },
    {
      schedulerId: 'sac:token-refresh:meli',
      queueName: QUEUE_NAMES.tokenRefresh,
      jobName: JOB_NAMES.tokenRefresh,
      everyMs: Math.max(60, deps.config.meliRefreshIntervalSeconds || 20_700) * 1_000,
      data: { marketplace: 'MERCADO_LIVRE' },
    },
    {
      schedulerId: 'sac:token-refresh:shopee',
      queueName: QUEUE_NAMES.tokenRefresh,
      jobName: JOB_NAMES.tokenRefresh,
      everyMs: Math.max(60, deps.config.shopeeRefreshIntervalSeconds || 12_600) * 1_000,
      data: { marketplace: 'SHOPEE' },
    },
  ];

  for (const spec of specs) {
    try {
      const queue = getQueue(spec.queueName);
      const repeat = spec.pattern ? { pattern: spec.pattern } : { every: spec.everyMs ?? 60_000 };
      await queue.upsertJobScheduler(spec.schedulerId, repeat, {
        name: spec.jobName,
        data: spec.data ?? {},
        opts: {
          removeOnComplete: { count: 200, age: 24 * 3600 },
          removeOnFail: { count: 1_000, age: 7 * 24 * 3600 },
        },
      });
      deps.logger.info('queue.scheduler.registered', {
        schedulerId: spec.schedulerId,
        queue: spec.queueName,
        schedule: spec.pattern ?? `every ${spec.everyMs}ms`,
      });
    } catch (error) {
      deps.logger.error('queue.scheduler.register_failed', {
        schedulerId: spec.schedulerId,
        queue: spec.queueName,
        error: redactPiiForLogs(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  return { queues: [...queues.values()], connection };
}
