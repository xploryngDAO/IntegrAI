import { Worker } from 'bullmq';
import type { Job } from 'bullmq';

import {
  CACHE_KEYS,
  JOB_NAMES,
  MARKETPLACE_INBOUND_QUEUE,
  QUEUE_NAMES,
  RETRY_POLICY,
  redactPiiForLogs,
} from '@sac/shared';
import type {
  ChannelRuntimeConfig,
  DeliveryStatus,
  EnrichmentJobPayload,
  IAccountRepository,
  IAgentRepository,
  IAppServices,
  ICache,
  IClock,
  ILogger,
  IMessageRepository,
  IOrderRepository,
  IPiiVaultRepository,
  IQueuePublisher,
  ITicketEventRepository,
  ITicketRepository,
  IWebhookEventRepository,
  InboundEnvelope,
  InboundJobPayload,
  IngestOutcome,
  Marketplace,
  OutboundJobPayload,
} from '@sac/shared';

import { createQueueConnection } from './connection';
import { isFinalAttempt, publishToDlq } from './dlq';
import type { BuyerPiiSnapshot } from '@sac/shared';
import type { SlaEngine } from '../application/sla/SlaEngine';
import type { OutboundRouterService } from '../application/OutboundRouterService';

/**
 * ============================================================================
 * BullMQ worker factory
 * ============================================================================
 *
 * One Worker per queue. Every processor is idempotent (the underlying services
 * are), applies bounded retries via the queue's job options, and on the final
 * failure publishes the payload to `queue.dlq` with PII-redacted error context.
 *
 * Queues:
 *  - queue.inbound.{amazon,meli,shopee}: adapter.hydrate -> ticketCommands.ingest
 *  - queue.spapi.enrichment: adapter.enrichOrder -> orders_cache + PII vault
 *  - queue.outbound.dispatch: re-send a queued outbox message
 *  - queue.sla.scan: SlaEngine.sweep
 *  - queue.pii.purge: purge expired buyer PII
 *  - queue.token.refresh: adapter.runMaintenance (tokens)
 *  - queue.shopee.lost-push: adapter.runMaintenance (lost pushes)
 */

export type WorkerKind = 'inbound' | 'enrichment' | 'outbound' | 'sla' | 'pii' | 'token' | 'lostPush';

export interface QueueRuntimeConfig {
  redisUrl: string;
  slaScanCron: string;
  piiPurgeCron: string;
  shopeeLostPushCron: string;
  meliRefreshIntervalSeconds: number;
  shopeeRefreshIntervalSeconds: number;
  concurrency?: Partial<Record<WorkerKind, number>>;
}

export interface WorkerRepositories {
  accounts: IAccountRepository;
  tickets: ITicketRepository;
  messages: IMessageRepository;
  orders: IOrderRepository;
  webhookEvents: IWebhookEventRepository;
  piiVault: IPiiVaultRepository;
  ticketEvents: ITicketEventRepository;
  agents: IAgentRepository;
}

export interface WorkerDependencies {
  config: QueueRuntimeConfig;
  logger: ILogger;
  clock: IClock;
  cache: ICache;
  queue: IQueuePublisher;
  services: IAppServices;
  repos: WorkerRepositories;
  slaEngine: SlaEngine;
  /** Concrete service: exposes `resendQueued`, which is not part of the port. */
  outbound: OutboundRouterService;
}

const DEFAULT_CONCURRENCY: Record<WorkerKind, number> = {
  inbound: 5,
  enrichment: 4,
  outbound: 3,
  sla: 1,
  pii: 1,
  token: 1,
  lostPush: 1,
};

const JOB_ATTEMPTS: Record<string, number> = {
  [QUEUE_NAMES.amazonInbound]: RETRY_POLICY.webhookIngest.attempts,
  [QUEUE_NAMES.meliInbound]: RETRY_POLICY.webhookIngest.attempts,
  [QUEUE_NAMES.shopeeInbound]: RETRY_POLICY.webhookIngest.attempts,
  [QUEUE_NAMES.spapiEnrichment]: RETRY_POLICY.default.attempts,
  [QUEUE_NAMES.outboundDispatch]: RETRY_POLICY.outbound.attempts,
  [QUEUE_NAMES.tokenRefresh]: RETRY_POLICY.tokenRefresh.attempts,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/* ======================================================================== */
/* Worker factory                                                           */
/* ======================================================================== */

export function createWorkers(deps: WorkerDependencies): Worker[] {
  const inboundQueues = new Set<string>([
    QUEUE_NAMES.amazonInbound,
    QUEUE_NAMES.meliInbound,
    QUEUE_NAMES.shopeeInbound,
  ]);

  const workers: Worker[] = [];

  for (const queueName of inboundQueues) {
    workers.push(
      buildWorker(deps, queueName, 'inbound', async (job) => processInbound(deps, job)),
    );
  }

  workers.push(
    buildWorker(deps, QUEUE_NAMES.spapiEnrichment, 'enrichment', async (job) =>
      processEnrichment(deps, job),
    ),
  );
  workers.push(
    buildWorker(deps, QUEUE_NAMES.outboundDispatch, 'outbound', async (job) =>
      processOutbound(deps, job),
    ),
  );
  workers.push(
    buildWorker(deps, QUEUE_NAMES.slaScan, 'sla', async () => {
      const result = await deps.slaEngine.sweep({ limit: 500 });
      return { ...result };
    }),
  );
  workers.push(
    buildWorker(deps, QUEUE_NAMES.piiPurge, 'pii', async () => processPiiPurge(deps)),
  );
  workers.push(
    buildWorker(deps, QUEUE_NAMES.tokenRefresh, 'token', async (job) =>
      processTokenRefresh(deps, job),
    ),
  );
  workers.push(
    buildWorker(deps, QUEUE_NAMES.shopeeLostPush, 'lostPush', async (job) =>
      processLostPush(deps, job),
    ),
  );

  return workers;
}

function buildWorker(
  deps: WorkerDependencies,
  queueName: string,
  kind: WorkerKind,
  processor: (job: Job) => Promise<unknown>,
): Worker {
  const concurrency =
    deps.config.concurrency?.[kind] ?? DEFAULT_CONCURRENCY[kind] ?? 1;
  const connection = createQueueConnection(deps.config.redisUrl, 'worker', deps.logger);

  const worker = new Worker(queueName, processor, {
    connection,
    concurrency,
    maxStalledCount: 2,
    stalledInterval: 30_000,
    lockDuration: 60_000,
  });

  worker.on('completed', (job: Job, result: unknown) => {
    deps.logger.debug('queue.job.completed', {
      queue: queueName,
      jobName: job.name,
      jobId: job.id,
      attemptsMade: job.attemptsMade,
      result: summarizeResult(result),
    });
  });

  worker.on('failed', (job: Job | undefined, error: Error) => {
    void handleFailed(deps, queueName, job, error);
  });

  worker.on('error', (error: Error) => {
    deps.logger.error('queue.worker.error', {
      queue: queueName,
      error: redactPiiForLogs(error.message),
    });
  });

  deps.logger.info('queue.worker.started', { queue: queueName, concurrency });
  return worker;
}

/* ======================================================================== */
/* Processors                                                               */
/* ======================================================================== */

async function processInbound(deps: WorkerDependencies, job: Job): Promise<Record<string, unknown>> {
  const payload = job.data as InboundJobPayload;
  const marketplace = payload.marketplace;
  if (!marketplace) throw new Error('Inbound job is missing marketplace');

  const envelope: InboundEnvelope = {
    marketplace,
    accountId: payload.accountId,
    payload: payload.payload ?? {},
    rawS3Uri: payload.rawS3Uri ?? null,
    receivedAt: payload.receivedAt ? new Date(payload.receivedAt) : deps.clock.now(),
    topic: payload.topic ?? null,
    resource: payload.resource ?? null,
    eventId: payload.eventId ?? null,
    attempt: job.attemptsMade + 1,
  };

  const adapter = deps.services.adapters.get(marketplace);
  const messages = await adapter.hydrate(envelope);

  const outcomes: IngestOutcome[] = [];
  for (const message of messages) {
    const normalized = message.accountId
      ? message
      : { ...message, accountId: payload.accountId };
    try {
      outcomes.push(await deps.services.ticketCommands.ingest(normalized));
    } catch (error) {
      deps.logger.error('queue.inbound.ingest_failed', {
        marketplace,
        accountId: payload.accountId,
        eventId: payload.eventId ?? null,
        error: redactPiiForLogs(errorMessage(error)),
      });
      throw error;
    }
  }

  if (payload.webhookEventId) {
    try {
      await deps.repos.webhookEvents.markStatus(payload.webhookEventId, 'PROCESSED', {
        processedAt: deps.clock.now(),
      });
    } catch (error) {
      deps.logger.warn('queue.inbound.mark_processed_failed', {
        webhookEventId: payload.webhookEventId,
        error: redactPiiForLogs(errorMessage(error)),
      });
    }
  }

  const created = outcomes.filter((outcome) => outcome.created).length;
  const duplicates = outcomes.filter((outcome) => outcome.duplicate).length;

  deps.logger.info('queue.inbound.processed', {
    marketplace,
    eventId: payload.eventId ?? null,
    hydrated: messages.length,
    created,
    duplicates,
    attempt: job.attemptsMade + 1,
  });

  return {
    marketplace,
    hydrated: messages.length,
    created,
    duplicates,
    ticketIds: outcomes.slice(0, 20).map((outcome) => outcome.ticketId),
  };
}

async function processEnrichment(
  deps: WorkerDependencies,
  job: Job,
): Promise<Record<string, unknown>> {
  const payload = job.data as EnrichmentJobPayload;
  const ticket = await deps.repos.tickets.findById(payload.ticketId);
  if (!ticket) {
    deps.logger.warn('queue.enrichment.ticket_missing', { ticketId: payload.ticketId });
    return { skipped: true, reason: 'TICKET_NOT_FOUND' };
  }

  const externalOrderId = payload.externalOrderId ?? ticket.externalOrderId;
  if (!externalOrderId) {
    deps.logger.debug('queue.enrichment.no_order_id', { ticketId: ticket.id });
    return { skipped: true, reason: 'NO_ORDER_ID' };
  }

  const adapter = deps.services.adapters.get(ticket.marketplace);
  if (typeof adapter.enrichOrder !== 'function') {
    return { skipped: true, reason: 'ADAPTER_HAS_NO_ENRICHMENT' };
  }

  const enriched = await adapter.enrichOrder({
    accountId: payload.accountId,
    externalOrderId,
    ticketId: ticket.id,
  });
  if (!enriched) {
    deps.logger.info('queue.enrichment.empty', {
      ticketId: ticket.id,
      externalOrderId,
    });
    return { skipped: true, reason: 'NO_DATA' };
  }

  const order = await deps.repos.orders.upsert({
    accountId: payload.accountId,
    marketplace: ticket.marketplace,
    externalOrderId: enriched.order.externalOrderId,
    packId: enriched.order.packId ?? null,
    buyerExternalId: enriched.order.buyerExternalId ?? null,
    buyerNameOrNick: enriched.order.buyerNameOrNick ?? null,
    buyerAnonymizedEmail: enriched.order.buyerAnonymizedEmail ?? null,
    orderStatus: enriched.order.orderStatus,
    fulfillmentType: enriched.order.fulfillmentType ?? null,
    totalAmount: enriched.order.totalAmount,
    currency: enriched.order.currency ?? 'BRL',
    trackingNumber: enriched.order.trackingNumber ?? null,
    carrierName: enriched.order.carrierName ?? null,
    itemsSnapshot: enriched.order.items ?? [],
    allowedActionsCache: enriched.order.allowedActions ?? {},
    shippingSnapshot: enriched.order.shipping ?? {},
    estimatedDeliveryAt: enriched.order.estimatedDeliveryAt ?? null,
    shippedAt: enriched.order.shippedAt ?? null,
    deliveredAt: enriched.order.deliveredAt ?? null,
  });

  await deps.repos.tickets.update(ticket.id, {
    orderCacheId: order.id,
    externalOrderId: order.externalOrderId,
  });

  if (enriched.buyerPii) {
    await persistEnrichedPii(deps, ticket.id, ticket.marketplace, enriched.buyerPii);
  }

  await safeAppendEvent(deps, ticket.id, 'ORDER_ENRICHED', 'system', {
    externalOrderId: order.externalOrderId,
    orderCacheId: order.id,
    hasPii: Boolean(enriched.buyerPii),
  });

  deps.services.realtime.queueChanged({
    reason: 'order_enriched',
    ticketId: ticket.id,
    at: deps.clock.now().toISOString(),
  });

  return {
    ticketId: ticket.id,
    orderCacheId: order.id,
    externalOrderId: order.externalOrderId,
    hasPii: Boolean(enriched.buyerPii),
  };
}

async function processOutbound(deps: WorkerDependencies, job: Job): Promise<Record<string, unknown>> {
  const payload = job.data as OutboundJobPayload;
  // BullMQ reuses the same job payload on retries; fold the worker attempt into
  // the runtime attempt so the outbound audit rows never repeat the same number.
  const attempt = (Number.isFinite(payload.attempt) ? payload.attempt : 0) + job.attemptsMade;
  const outcome = await deps.outbound.resendQueued({ ...payload, attempt });
  deps.logger.info('queue.outbound.dispatched', {
    ticketId: payload.ticketId,
    messageId: payload.messageId,
    deliveryStatus: outcome.deliveryStatus,
    routeUsed: outcome.routeUsed,
    attempt: job.attemptsMade + 1,
  });
  return {
    messageId: outcome.message.id,
    deliveryStatus: outcome.deliveryStatus,
    routeUsed: outcome.routeUsed,
    asyncRetryScheduled: outcome.asyncRetryScheduled,
  };
}

async function processPiiPurge(deps: WorkerDependencies): Promise<Record<string, unknown>> {
  const now = deps.clock.now();
  const purged = await deps.repos.piiVault.purgeExpired(now);
  if (purged > 0) {
    deps.logger.info('queue.pii.purged', { purged, at: now.toISOString() });
  }
  return { purged, at: now.toISOString() };
}

async function processTokenRefresh(
  deps: WorkerDependencies,
  job: Job,
): Promise<Record<string, unknown>> {
  const requested = readMarketplace(job.data);
  const accounts = await deps.repos.accounts.list({ status: 'ACTIVE' });
  const targets = requested ? accounts.filter((account) => account.marketplace === requested) : accounts;
  const results: Array<{ accountId: string; marketplace: Marketplace; ok: boolean; detail: string }> = [];

  for (const account of targets) {
    const adapter = deps.services.adapters.get(account.marketplace);
    if (typeof adapter.runMaintenance !== 'function') {
      results.push({
        accountId: account.id,
        marketplace: account.marketplace,
        ok: true,
        detail: 'adapter has no maintenance routine',
      });
      continue;
    }
    try {
      const tasks = await adapter.runMaintenance();
      const failed = tasks.filter((task) => !task.ok);
      const ok = failed.length === 0;
      if (!ok) {
        await deps.repos.accounts.setStatus(
          account.id,
          'TOKEN_EXPIRED',
          failed.map((task) => task.detail).join('; ').slice(0, 500),
        );
      }
      results.push({
        accountId: account.id,
        marketplace: account.marketplace,
        ok,
        detail: tasks.map((task) => `${task.task}:${task.ok ? 'ok' : 'fail'}`).join(','),
      });
      deps.services.realtime.channelHealth({
        marketplace: account.marketplace,
        accountId: account.id,
        healthy: ok,
        detail: detailOf(tasks),
        at: deps.clock.now().toISOString(),
      });
    } catch (error) {
      await deps.repos.accounts.setStatus(
        account.id,
        'TOKEN_EXPIRED',
        redactPiiForLogs(errorMessage(error)).slice(0, 500),
      );
      results.push({
        accountId: account.id,
        marketplace: account.marketplace,
        ok: false,
        detail: redactPiiForLogs(errorMessage(error)).slice(0, 300),
      });
      deps.services.realtime.channelHealth({
        marketplace: account.marketplace,
        accountId: account.id,
        healthy: false,
        detail: redactPiiForLogs(errorMessage(error)).slice(0, 300),
        at: deps.clock.now().toISOString(),
      });
    }
  }

  const failedCount = results.filter((entry) => !entry.ok).length;
  if (failedCount > 0) {
    deps.logger.warn('queue.token_refresh.partial_failure', {
      total: results.length,
      failed: failedCount,
    });
  }
  return { refreshed: results.length - failedCount, failed: failedCount };
}

async function processLostPush(
  deps: WorkerDependencies,
  job: Job,
): Promise<Record<string, unknown>> {
  const requestedAccountId = readAccountId(job.data);
  const accounts = await deps.repos.accounts.list({ marketplace: 'SHOPEE', status: 'ACTIVE' });
  const targets = requestedAccountId
    ? accounts.filter((account) => account.id === requestedAccountId)
    : accounts;

  let recovered = 0;
  let failed = 0;
  for (const account of targets) {
    try {
      const adapter = deps.services.adapters.get('SHOPEE');
      if (typeof adapter.runMaintenance !== 'function') continue;
      const tasks = await adapter.runMaintenance();
      recovered += tasks.filter((task) => task.ok).length;
      failed += tasks.filter((task) => !task.ok).length;
      deps.services.realtime.channelHealth({
        marketplace: 'SHOPEE',
        accountId: account.id,
        healthy: tasks.every((task) => task.ok),
        detail: detailOf(tasks),
        at: deps.clock.now().toISOString(),
      });
    } catch (error) {
      failed += 1;
      deps.logger.warn('queue.lost_push.failed', {
        accountId: account.id,
        error: redactPiiForLogs(errorMessage(error)),
      });
    }
  }

  return { accounts: targets.length, recovered, failed };
}

/* ======================================================================== */
/* Failure handling                                                         */
/* ======================================================================== */

async function handleFailed(
  deps: WorkerDependencies,
  queueName: string,
  job: Job | undefined,
  error: Error,
): Promise<void> {
  const final = isFinalAttempt(job);
  deps.logger[final ? 'error' : 'warn']('queue.job.failed', {
    queue: queueName,
    jobName: job?.name ?? 'unknown',
    jobId: job?.id,
    attemptsMade: job?.attemptsMade ?? 0,
    final,
    error: redactPiiForLogs(error.message),
  });

  // Inbound: keep webhook_events in sync with the queue lifecycle.
  if (queueName === MARKETPLACE_INBOUND_QUEUE.AMAZON ||
      queueName === MARKETPLACE_INBOUND_QUEUE.MERCADO_LIVRE ||
      queueName === MARKETPLACE_INBOUND_QUEUE.SHOPEE) {
    await syncInboundWebhookEvent(deps, job, error, final);
  }

  // Outbound: mark the outbox message failed once the retry budget is gone.
  if (queueName === QUEUE_NAMES.outboundDispatch) {
    await syncOutboundMessage(deps, job, error, final);
  }

  if (final) {
    await publishToDlq(
      deps.queue,
      job,
      queueName,
      error,
      deps.logger,
      deps.clock.now().toISOString(),
    );
  }
}

async function syncInboundWebhookEvent(
  deps: WorkerDependencies,
  job: Job | undefined,
  error: Error,
  final: boolean,
): Promise<void> {
  const payload = (job?.data ?? {}) as Partial<InboundJobPayload>;
  const webhookEventId = typeof payload.webhookEventId === 'string' ? payload.webhookEventId : null;
  if (!webhookEventId) return;
  try {
    await deps.repos.webhookEvents.incrementAttempts(webhookEventId);
    if (final) {
      await deps.repos.webhookEvents.markStatus(webhookEventId, 'DEAD_LETTER', {
        error: redactPiiForLogs(error.message).slice(0, 1_000),
        processedAt: deps.clock.now(),
      });
    } else {
      await deps.repos.webhookEvents.markStatus(webhookEventId, 'FAILED', {
        error: redactPiiForLogs(error.message).slice(0, 1_000),
      });
    }
  } catch (updateError) {
    deps.logger.warn('queue.inbound.webhook_status_failed', {
      webhookEventId,
      error: redactPiiForLogs(errorMessage(updateError)),
    });
  }
}

async function syncOutboundMessage(
  deps: WorkerDependencies,
  job: Job | undefined,
  error: Error,
  final: boolean,
): Promise<void> {
  const payload = (job?.data ?? {}) as Partial<OutboundJobPayload>;
  if (typeof payload.messageId !== 'string') return;
  try {
    const status: DeliveryStatus = final ? 'FAILED' : 'QUEUED';
    await deps.repos.messages.updateDeliveryStatus(payload.messageId, status, {
      errorDetail: redactPiiForLogs(error.message).slice(0, 1_000),
    });
    if (final && typeof payload.ticketId === 'string') {
      await safeAppendEvent(deps, payload.ticketId, 'OUTBOUND_FAILED', 'system', {
        messageId: payload.messageId,
        reason: 'DLQ',
        error: redactPiiForLogs(error.message).slice(0, 300),
      });
    }
  } catch (updateError) {
    deps.logger.warn('queue.outbound.status_update_failed', {
      messageId: payload.messageId,
      error: redactPiiForLogs(errorMessage(updateError)),
    });
  }
}

/* ======================================================================== */
/* Helpers                                                                  */
/* ======================================================================== */

async function persistEnrichedPii(
  deps: WorkerDependencies,
  ticketId: string,
  marketplace: Marketplace,
  pii: BuyerPiiSnapshot,
): Promise<void> {
  try {
    if (!pii) return;
    const existing = await deps.repos.piiVault.findByTicketId(ticketId);
    const retentionDays = (deps.services.config as ChannelRuntimeConfig).piiRetentionDays || 30;
    const candidate = new Date(deps.clock.now().getTime() + retentionDays * DAY_MS);
    const expiresAt =
      existing && existing.expiresAt.getTime() < candidate.getTime()
        ? existing.expiresAt
        : candidate;

    await deps.repos.piiVault.upsert({
      ticketId,
      marketplace,
      buyerName: pii.name ?? existing?.buyerName ?? null,
      buyerEmail: pii.email ?? existing?.buyerEmail ?? null,
      buyerDocument: pii.document ?? existing?.buyerDocument ?? null,
      buyerPhone: pii.phone ?? existing?.buyerPhone ?? null,
      shippingAddress: pii.shippingAddress ?? existing?.shippingAddress ?? {},
      sourceEndpoints: mergeStrings(existing?.sourceEndpoints, pii.sourceEndpoints),
      expiresAt,
    });

    await deps.cache.set(
      CACHE_KEYS.piiTicket(ticketId),
      {
        name: pii.name ?? null,
        email: pii.email ?? null,
        document: pii.document ?? null,
        phone: pii.phone ?? null,
        shippingAddress: pii.shippingAddress ?? {},
        expiresAt: expiresAt.toISOString(),
      },
      900,
    );
  } catch (error) {
    deps.logger.warn('queue.enrichment.pii_failed', {
      ticketId,
      error: redactPiiForLogs(errorMessage(error)),
    });
  }
}

async function safeAppendEvent(
  deps: WorkerDependencies,
  ticketId: string,
  eventType: string,
  actorLabel: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.repos.ticketEvents.append({
      ticketId,
      eventType,
      actorAgentId: null,
      actorLabel,
      payload,
    });
  } catch (error) {
    deps.logger.warn('queue.ticket_event_failed', {
      ticketId,
      eventType,
      error: redactPiiForLogs(errorMessage(error)),
    });
  }
}

function readMarketplace(data: unknown): Marketplace | null {
  if (data && typeof data === 'object') {
    const value = (data as Record<string, unknown>).marketplace;
    if (value === 'AMAZON' || value === 'MERCADO_LIVRE' || value === 'SHOPEE') return value;
  }
  return null;
}

function readAccountId(data: unknown): string | null {
  if (data && typeof data === 'object') {
    const value = (data as Record<string, unknown>).accountId;
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function detailOf(tasks: Array<{ task: string; ok: boolean; detail: string }>): string {
  const summary = tasks.map((task) => `${task.task}:${task.ok ? 'ok' : 'fail'}`).join(', ');
  const failure = tasks.find((task) => !task.ok);
  return (failure ? `${summary} — ${failure.detail}` : summary).slice(0, 300);
}

function summarizeResult(result: unknown): unknown {
  if (result === null || result === undefined) return null;
  if (typeof result === 'object') {
    const record = result as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    for (const key of ['marketplace', 'hydrated', 'created', 'duplicates', 'messageId', 'deliveryStatus', 'purged', 'refreshed', 'failed', 'skipped', 'reason']) {
      if (record[key] !== undefined) summary[key] = record[key];
    }
    return summary;
  }
  return result;
}

function mergeStrings(a: string[] | undefined | null, b: string[] | undefined | null): string[] {
  const merged = new Set<string>();
  for (const value of a ?? []) merged.add(value);
  for (const value of b ?? []) merged.add(value);
  return [...merged];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Jobs names re-exported for tests/replays. */
export const WORKER_JOB_NAMES = JOB_NAMES;
