import { JOB_NAMES, MARKETPLACE_INBOUND_QUEUE, QUEUE_NAMES, RETRY_POLICY } from '@sac/shared';
import type {
  EnrichmentJobPayload,
  IQueuePublisher,
  InboundJobPayload,
  Marketplace,
  OutboundJobPayload,
} from '@sac/shared';

/**
 * Typed producers.
 *
 * Every enqueue goes through this module so job names, queue names, attempts and
 * dedupe keys stay consistent between the HTTP ingress, the application services
 * and the workers. Importing only `@sac/shared` keeps this module free of any
 * application/worker import cycle.
 */

export interface EnqueueOptions {
  /** Deterministic id so a webhook replay does not create a duplicate job. */
  jobId?: string;
  delayMs?: number;
  attempts?: number;
}

export async function enqueueInbound(
  queue: IQueuePublisher,
  marketplace: Marketplace,
  payload: InboundJobPayload,
  options: EnqueueOptions = {},
): Promise<string> {
  const queueName = MARKETPLACE_INBOUND_QUEUE[marketplace];
  const jobId =
    options.jobId ??
    (payload.eventId
      ? `${JOB_NAMES.inboundHydrate}:${marketplace}:${payload.eventId}`
      : `${JOB_NAMES.inboundHydrate}:${marketplace}:${payload.accountId}:${payload.receivedAt}`);

  return queue.publish(queueName, payload, {
    jobId,
    dedupeKey: payload.eventId ? `${marketplace}:${payload.eventId}` : undefined,
    attempts: options.attempts ?? RETRY_POLICY.webhookIngest.attempts,
    delayMs: options.delayMs,
  });
}

export async function enqueueEnrichment(
  queue: IQueuePublisher,
  payload: EnrichmentJobPayload,
  options: EnqueueOptions = {},
): Promise<string> {
  const jobId = options.jobId ?? `${JOB_NAMES.spapiEnrichOrder}:${payload.ticketId}`;
  return queue.publish(QUEUE_NAMES.spapiEnrichment, payload, {
    jobId,
    dedupeKey: `${payload.ticketId}:${payload.externalOrderId ?? 'none'}:${payload.reason}`,
    attempts: options.attempts ?? RETRY_POLICY.default.attempts,
    delayMs: options.delayMs,
  });
}

export async function enqueueOutboundRetry(
  queue: IQueuePublisher,
  payload: OutboundJobPayload,
  options: EnqueueOptions = {},
): Promise<string> {
  const jobId = options.jobId ?? `${JOB_NAMES.outboundSend}:${payload.messageId}:${payload.attempt}`;
  return queue.publish(QUEUE_NAMES.outboundDispatch, payload, {
    jobId,
    dedupeKey: `${payload.messageId}:${payload.attempt}`,
    attempts: options.attempts ?? RETRY_POLICY.outbound.attempts,
    delayMs: options.delayMs,
  });
}

export interface ManualReplayJob {
  queue: string;
  name: string;
  data: Record<string, unknown>;
}

/**
 * Maps a persisted webhook event back to the queue job used for manual replays
 * from the operations UI (`POST /webhooks/:id/replay`).
 */
export function buildInboundReplayJob(payload: InboundJobPayload): ManualReplayJob {
  return {
    queue: MARKETPLACE_INBOUND_QUEUE[payload.marketplace],
    name: JOB_NAMES.inboundHydrate,
    data: { ...payload },
  };
}
