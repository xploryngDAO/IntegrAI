import type { Worker } from 'bullmq';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import type { ILogger } from '@sac/shared';

import { closeQueueConnection } from './connection';
import { registerSchedulers } from './schedulers';
import { createWorkers, type WorkerDependencies } from './workers';

/**
 * Queue runtime lifecycle.
 *
 * `index.ts` (the process bootstrap) owns the order:
 *   createInfrastructure -> createContainer -> buildHttpApp -> listen ->
 *   startWorkers -> startSchedulers -> ... -> stopWorkers on SIGINT/SIGTERM.
 *
 * The state below is process-wide because BullMQ workers hold blocking sockets
 * and must be closed exactly once.
 */

interface QueueRuntime {
  workers: Worker[];
  queues: Queue[];
  schedulerConnection: Redis | null;
  startedAt: string;
}

let runtime: QueueRuntime | null = null;

export interface StartWorkersOptions {
  /** Skip schedulers when running a dedicated worker process. */
  logger?: ILogger;
}

export function startWorkers(deps: WorkerDependencies): void {
  if (runtime && runtime.workers.length > 0) {
    deps.logger.warn('queue.workers.already_started', { count: runtime.workers.length });
    return;
  }

  const workers = createWorkers(deps);
  runtime = {
    workers,
    queues: runtime?.queues ?? [],
    schedulerConnection: runtime?.schedulerConnection ?? null,
    startedAt: deps.clock.now().toISOString(),
  };

  deps.logger.info('queue.workers.ready', {
    workers: workers.map((worker) => worker.name),
  });
}

export async function startSchedulers(deps: WorkerDependencies): Promise<void> {
  const resources = await registerSchedulers(deps);
  runtime = {
    workers: runtime?.workers ?? [],
    queues: [...(runtime?.queues ?? []), ...resources.queues],
    schedulerConnection: resources.connection,
    startedAt: runtime?.startedAt ?? deps.clock.now().toISOString(),
  };
  deps.logger.info('queue.schedulers.ready', { queues: resources.queues.map((queue) => queue.name) });
}

export async function stopWorkers(): Promise<void> {
  const current = runtime;
  runtime = null;
  if (!current) return;

  const results = await Promise.allSettled([
    ...current.workers.map(async (worker) => {
      await worker.close();
    }),
    ...current.queues.map(async (queue) => {
      await queue.close();
    }),
  ]);
  const rejected = results.filter((result) => result.status === 'rejected');
  if (rejected.length > 0) {
    // Logger is not available during shutdown; the bootstrap logs the summary.
    for (const result of rejected) {
      const reason = (result as PromiseRejectedResult).reason;
      // eslint-disable-next-line no-console
      console.error('[queue] close failed:', reason instanceof Error ? reason.message : String(reason));
    }
  }

  await closeQueueConnection(current.schedulerConnection);
}

export function activeWorkers(): Worker[] {
  return runtime?.workers ?? [];
}

export function isRunning(): boolean {
  return runtime !== null && runtime.workers.length > 0;
}

export type { WorkerDependencies };
export { createWorkers };
export { registerSchedulers };
