import type { Job } from 'bullmq';

import { redactPiiForLogs } from '@sac/shared';
import type { ILogger, IQueuePublisher } from '@sac/shared';

/**
 * Dead-letter helpers.
 *
 * A job is only moved to the DLQ after its last BullMQ attempt. The DLQ payload
 * keeps the original queue, job name, payload and a PII-redacted error so an
 * operator can replay it safely (`queue.dlq`).
 */

export interface DeadLetterPayload {
  originalQueue: string;
  jobName: string;
  jobId: string | undefined;
  attemptsMade: number;
  payload: unknown;
  error: {
    name: string;
    message: string;
    code?: string;
    retryable?: boolean;
    stack?: string;
  };
  failedAt: string;
}

export function isFinalAttempt(job: Job | undefined): boolean {
  if (!job) return false;
  const configured = job.opts?.attempts ?? 1;
  // `attemptsMade` is incremented before the failed handler runs.
  return job.attemptsMade >= configured;
}

export function buildDeadLetterPayload(
  job: Job | undefined,
  originalQueue: string,
  error: unknown,
  failedAt: string,
): DeadLetterPayload {
  const err = toErrorInfo(error);
  return {
    originalQueue,
    jobName: job?.name ?? 'unknown',
    jobId: job?.id,
    attemptsMade: job?.attemptsMade ?? 0,
    payload: job?.data ?? null,
    error: err,
    failedAt,
  };
}

export async function publishToDlq(
  publisher: IQueuePublisher,
  job: Job | undefined,
  originalQueue: string,
  error: unknown,
  logger: ILogger,
  failedAt: string,
): Promise<void> {
  const payload = buildDeadLetterPayload(job, originalQueue, error, failedAt);
  try {
    await publisher.publishToDlq(originalQueue, payload, error);
    logger.warn('queue.dlq.published', {
      originalQueue,
      jobName: payload.jobName,
      jobId: payload.jobId,
      attemptsMade: payload.attemptsMade,
      errorCode: payload.error.code ?? null,
    });
  } catch (dlqError) {
    logger.error('queue.dlq.publish_failed', {
      originalQueue,
      jobName: payload.jobName,
      jobId: payload.jobId,
      error: redactPiiForLogs(dlqError instanceof Error ? dlqError.message : String(dlqError)),
    });
  }
}

function toErrorInfo(error: unknown): DeadLetterPayload['error'] {
  if (error instanceof Error) {
    const typed = error as Error & { code?: unknown; retryable?: unknown };
    return {
      name: error.name,
      message: redactPiiForLogs(error.message).slice(0, 2_000),
      ...(typeof typed.code === 'string' ? { code: typed.code } : {}),
      ...(typeof typed.retryable === 'boolean' ? { retryable: typed.retryable } : {}),
      ...(error.stack ? { stack: redactPiiForLogs(error.stack).slice(0, 4_000) } : {}),
    };
  }
  return { name: 'UnknownError', message: redactPiiForLogs(String(error)).slice(0, 2_000) };
}
