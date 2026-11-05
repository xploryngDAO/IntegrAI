import { Queue } from 'bullmq';
import type { DefaultJobOptions, JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { AppError, QUEUE_NAMES } from '@sac/shared';
import type { ILogger, IQueuePublisher, PublishOptions } from '@sac/shared';
import { closeRedisConnection, createBullMqConnection } from '../redis/connection';

/**
 * BullMQ producer.
 *
 * One `Queue` per name, lazily created and cached; all of them share a single
 * BullMQ-safe Redis connection (BullMQ duplicates it internally for blocking
 * commands). Defaults encode the project retry policy: 6 attempts, exponential
 * backoff starting at 1s, bounded retention of completed/failed jobs.
 */

type JobData = Record<string, unknown>;

/** Sensible defaults for every queue - overridable per publish call. */
const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 3_600, count: 5_000 },
  removeOnFail: { age: 604_800, count: 5_000 },
};

const DEFAULT_ATTEMPTS = 6;
/** BullMQ rejects custom job ids containing `:`. */
const INVALID_JOB_ID_CHARS = /:/g;

export interface QueuePublisherSettings {
  logger?: ILogger;
  /** BullMQ key prefix (defaults to BullMQ's `bull`). */
  prefix?: string;
  defaultAttempts?: number;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    };
  }
  return { name: 'UnknownError', message: String(error) };
}

/** Derives the BullMQ job name from the payload, falling back to the queue name. */
function resolveJobName(queue: string, payload: object): string {
  const record = payload as Record<string, unknown>;
  for (const field of ['jobName', 'job', 'eventType']) {
    const candidate = record[field];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return queue;
}

function sanitizeJobId(raw: string): string | undefined {
  const sanitized = raw.replace(INVALID_JOB_ID_CHARS, '-').trim();
  if (sanitized.length === 0) return undefined;
  return sanitized.slice(0, 200);
}

export class BullMqQueuePublisher implements IQueuePublisher {
  private readonly queues = new Map<string, Queue<JobData, unknown, string>>();
  private readonly connection: Redis;
  private readonly logger?: ILogger;
  private readonly prefix?: string;
  private readonly defaultAttempts: number;

  constructor(redisUrl: string, settings: QueuePublisherSettings = {}) {
    this.logger = settings.logger;
    this.prefix = settings.prefix;
    this.defaultAttempts = Math.max(1, settings.defaultAttempts ?? DEFAULT_ATTEMPTS);
    this.connection = createBullMqConnection(redisUrl, {
      logger: settings.logger,
      connectionName: 'sac-hub-producer',
    });
  }

  /** Cached Queue accessor (exported surface for schedulers/tests). */
  getQueue<TPayload extends object = JobData>(name: string): Queue<TPayload, unknown, string> {
    const existing = this.queues.get(name);
    if (existing) return existing as unknown as Queue<TPayload, unknown, string>;

    const queue = new Queue<JobData, unknown, string>(name, {
      connection: this.connection,
      prefix: this.prefix,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    this.queues.set(name, queue);
    return queue as unknown as Queue<TPayload, unknown, string>;
  }

  async publish<TPayload extends object>(
    queue: string,
    payload: TPayload,
    options: PublishOptions = {},
  ): Promise<string> {
    const target = this.getQueue(queue);
    const jobId = this.resolveJobId(options);

    const jobOptions: JobsOptions = {
      jobId,
      delay: options.delayMs !== undefined ? Math.max(0, Math.floor(options.delayMs)) : undefined,
      priority: options.priority,
      attempts: options.attempts !== undefined ? Math.max(1, options.attempts) : this.defaultAttempts,
    };

    try {
      const job = await target.add(resolveJobName(queue, payload), payload as unknown as JobData, jobOptions);
      if (job.id === undefined || job.id === null) {
        throw new AppError('QUEUE_JOB_ID_MISSING', `BullMQ did not return a job id for queue ${queue}`, 500, {
          queue,
        });
      }
      this.logger?.debug('queue.published', { queue, jobId: job.id });
      return String(job.id);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'QUEUE_PUBLISH_FAILED',
        `Failed to publish job to ${queue}: ${error instanceof Error ? error.message : String(error)}`,
        502,
        { queue },
        true,
      );
    }
  }

  /** Moves a permanently failed payload to the dead-letter queue with context. */
  async publishToDlq(originalQueue: string, payload: object, error: unknown): Promise<void> {
    await this.publish(
      QUEUE_NAMES.deadLetter,
      {
        originalQueue,
        failedAt: new Date().toISOString(),
        error: serializeError(error),
        payload,
      },
      { attempts: 1 },
    );
  }

  /** Closes every cached queue then the shared connection. */
  async close(): Promise<void> {
    const queues = [...this.queues.values()];
    this.queues.clear();
    await Promise.allSettled(queues.map((queue) => queue.close()));
    await closeRedisConnection(this.connection);
  }

  private resolveJobId(options: PublishOptions): string | undefined {
    if (options.dedupeKey && options.dedupeKey.length > 0) {
      return sanitizeJobId(`dedupe-${options.dedupeKey}`);
    }
    if (options.jobId && options.jobId.length > 0) {
      return sanitizeJobId(options.jobId);
    }
    return undefined;
  }
}
