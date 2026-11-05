import type { Prisma, PrismaClient } from '@prisma/client';

import type {
  ChannelRuntimeConfig,
  DeliveryStatus,
  IAppServices,
  IObjectStorage,
  IRealtimePublisher,
} from '@sac/shared';

import { createAdapterRegistry } from './adapters/registry';
import type { AppConfig } from './config';
import type { InfrastructureBundle } from './infrastructure';
import { createInfrastructure } from './infrastructure';

import { AccountService } from './application/AccountService';
import { AgentService } from './application/AgentService';
import { DiagnosticsService } from './application/DiagnosticsService';
import { FileService } from './application/FileService';
import { HealthService } from './application/HealthService';
import {
  OutboundRouterService,
  type IOutboundAttemptRecorder,
  type OutboundAttemptRecordInput,
} from './application/OutboundRouterService';
import { SlaEngine } from './application/sla/SlaEngine';
import { TicketQueryService } from './application/TicketQueryService';
import { UnifiedTicketService } from './application/UnifiedTicketService';
import { WebhookIngressService } from './application/WebhookIngressService';
import type {
  QueueRuntimeConfig,
  WorkerDependencies,
  WorkerRepositories,
} from './queues/workers';

/**
 * ============================================================================
 * Composition root
 * ============================================================================
 *
 * Builds the whole dependency graph exactly once:
 *
 *   AppConfig + InfrastructureBundle + IRealtimePublisher
 *        -> Channel adapters (registry)
 *        -> Application services (write side + read side + ops)
 *        -> IAppServices (the only object the HTTP layer sees)
 *
 * The worker dependencies are exposed through `getWorkerDependencies()` so the
 * process bootstrap can create the BullMQ workers without leaking repositories
 * into the HTTP layer.
 */

export interface ContainerArgs {
  config: AppConfig;
  infra: InfrastructureBundle;
  realtime: IRealtimePublisher;
}

interface ContainerState {
  services: IAppServices;
  workerDependencies: WorkerDependencies;
}

let state: ContainerState | null = null;

export function createContainer(args: ContainerArgs): IAppServices {
  const { config, infra, realtime } = args;

  // AppConfig extends ChannelRuntimeConfig; keep the narrow type for adapters.
  const channelConfig: ChannelRuntimeConfig = config;

  const logger = infra.logger.child({ component: 'container' });

  // --- 1. Channel adapters ------------------------------------------------
  const adapters = createAdapterRegistry({
    logger: infra.logger,
    clock: infra.clock,
    config: channelConfig,
    repos: infra.repos,
    cache: infra.cache,
    lock: infra.lock,
    rateLimiter: infra.rateLimiter,
    storage: infra.storage,
    cipher: infra.cipher,
    realtime,
    http: infra.http,
    queue: infra.queue,
  });

  // --- 2. Leaf services ---------------------------------------------------
  const files = new FileService({
    logger: infra.logger,
    clock: infra.clock,
    storage: infra.storage,
    config: channelConfig,
  });

  const slaEngine = new SlaEngine({
    clock: infra.clock,
    logger: infra.logger,
    realtime,
    tickets: infra.repos.tickets,
    slaPolicies: infra.slaPolicies,
    cache: infra.cache,
  });

  // --- 3. Ticket write side ----------------------------------------------
  const ticketCommands = new UnifiedTicketService({
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    queue: infra.queue,
    realtime,
    config: channelConfig,
    storage: infra.storage,
    http: infra.http,
    slaEngine,
    adapters,
    repos: {
      accounts: infra.repos.accounts,
      agents: infra.agents,
      tickets: infra.repos.tickets,
      messages: infra.repos.messages,
      orders: infra.repos.orders,
      attachments: infra.repos.attachments,
      piiVault: infra.repos.piiVault,
      ticketEvents: infra.repos.ticketEvents,
      slaPolicies: infra.slaPolicies,
    },
  });

  const outbound = new OutboundRouterService({
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    queue: infra.queue,
    realtime,
    config: channelConfig,
    adapters,
    files,
    ticketCommands,
    attempts: createOutboundAttemptRecorder(infra.prisma),
    repos: {
      accounts: infra.repos.accounts,
      tickets: infra.repos.tickets,
      messages: infra.repos.messages,
      orders: infra.repos.orders,
      attachments: infra.repos.attachments,
      ticketEvents: infra.repos.ticketEvents,
    },
  });

  // --- 4. Query side ------------------------------------------------------
  const tickets = new TicketQueryService({
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    adapters,
    repos: {
      accounts: infra.repos.accounts,
      agents: infra.agents,
      tickets: infra.repos.tickets,
      messages: infra.repos.messages,
      attachments: infra.repos.attachments,
      orders: infra.repos.orders,
      piiVault: infra.repos.piiVault,
      ticketEvents: infra.repos.ticketEvents,
    },
  });

  // --- 5. Onboarding + auth + ingress + ops -------------------------------
  const accounts = new AccountService({
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    cipher: infra.cipher,
    http: infra.http,
    config: channelConfig,
    adapters,
    realtime,
    repos: { accounts: infra.repos.accounts },
  });

  const agents = new AgentService({
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    realtime,
    jwtSecret: config.jwtSecret,
    jwtExpiresIn: config.jwtExpiresIn,
    presenceTtlSeconds: config.agentPresenceTtlSeconds,
    repos: {
      agents: infra.agents,
      tickets: infra.repos.tickets,
    },
  });

  const webhooks = new WebhookIngressService({
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    queue: infra.queue,
    adapters,
    repos: {
      webhookEvents: infra.repos.webhookEvents,
      accounts: infra.repos.accounts,
    },
  });

  const health = new HealthService({
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    realtime,
    probes: {
      database: async () => {
        await infra.prisma.$queryRawUnsafe('SELECT 1');
      },
      redis: async () => {
        const pong = await infra.redis.ping();
        if (pong !== 'PONG') throw new Error(`Unexpected Redis PING reply: ${pong}`);
      },
      storage: async () => {
        // Best effort: presigning validates the bucket/credentials locally and
        // fails fast when the storage client is misconfigured.
        await infra.storage.presignGet('attachments/health/probe.txt', 60);
      },
    },
    repos: {
      accounts: infra.repos.accounts,
      tickets: infra.repos.tickets,
    },
  });

  const diagnostics = new DiagnosticsService({
    logger: infra.logger,
    clock: infra.clock,
    adapters,
    repos: { accounts: infra.repos.accounts },
    probes: {
      database: async () => {
        await infra.prisma.$queryRawUnsafe('SELECT 1');
      },
      redis: async () => {
        const pong = await infra.redis.ping();
        if (pong !== 'PONG') throw new Error(`Unexpected Redis PING reply: ${pong}`);
      },
      storage: async () => {
        await probeStorage(infra.storage);
      },
      storageConfigured: Boolean(
        config.s3.bucket &&
          config.s3.region &&
          config.s3.accessKeyId &&
          config.s3.secretAccessKey,
      ),
    },
  });

  const services: IAppServices = {
    config: channelConfig,
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    queue: infra.queue,
    realtime,
    adapters,
    accounts,
    tickets,
    ticketCommands,
    outbound,
    agents,
    webhooks,
    health,
    files,
    diagnostics,
  };

  // --- 6. Worker dependencies --------------------------------------------
  const workerRepositories: WorkerRepositories = {
    accounts: infra.repos.accounts,
    tickets: infra.repos.tickets,
    messages: infra.repos.messages,
    orders: infra.repos.orders,
    webhookEvents: infra.repos.webhookEvents,
    piiVault: infra.repos.piiVault,
    ticketEvents: infra.repos.ticketEvents,
    agents: infra.agents,
  };

  const queueConfig: QueueRuntimeConfig = {
    redisUrl: config.redisUrl,
    slaScanCron: config.cron.slaScan,
    piiPurgeCron: config.cron.piiPurge,
    shopeeLostPushCron: config.cron.shopeeLostPush,
    meliRefreshIntervalSeconds: config.meli.refreshIntervalSeconds,
    shopeeRefreshIntervalSeconds: config.shopee.refreshIntervalSeconds,
  };

  const workerDependencies: WorkerDependencies = {
    config: queueConfig,
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    queue: infra.queue,
    services,
    repos: workerRepositories,
    slaEngine,
    outbound,
  };

  state = { services, workerDependencies };

  logger.info('container.ready', {
    marketplaces: ['AMAZON', 'MERCADO_LIVRE', 'SHOPEE'],
    piiRetentionDays: config.piiRetentionDays,
  });

  return services;
}

export function getWorkerDependencies(): WorkerDependencies {
  if (!state) {
    throw new Error('Container has not been initialised; call createContainer() first');
  }
  return state.workerDependencies;
}

export function getSlaEngine(): SlaEngine {
  if (!state) {
    throw new Error('Container has not been initialised; call createContainer() first');
  }
  return state.workerDependencies.slaEngine;
}

export async function disposeContainer(): Promise<void> {
  state = null;
}

export function getDiagnosticsService(): import('@sac/shared').IDiagnosticsService {
  if (!state) {
    throw new Error('Container has not been initialised; call createContainer() first');
  }
  return state.services.diagnostics;
}

/* ======================================================================== */
/* Diagnostics storage probe                                                */
/* ======================================================================== */

/**
 * REAL S3 probe.
 *
 * Prefers a dedicated `headBucket()` when the storage implementation exposes one
 * (the production client does) and otherwise performs a GET on a sentinel key:
 * `NoSuchKey` proves the bucket exists and the credentials are accepted, which is
 * exactly what a HeadBucket would have proven.
 */
async function probeStorage(storage: IObjectStorage): Promise<void> {
  const candidate = storage as IObjectStorage & { headBucket?: () => Promise<void> };
  if (typeof candidate.headBucket === 'function') {
    await candidate.headBucket();
    return;
  }

  try {
    await storage.getObject('attachments/.doctor-probe');
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    const combined = `${name} ${message}`;
    if (/NoSuchKey|NotFound|not exist|404/i.test(combined)) {
      return;
    }
    throw error;
  }
}

/* ======================================================================== */
/* Infrastructure adapter: outbound_attempts audit recorder                  */
/* ======================================================================== */

/**
 * @sac/shared has no repository port for `outbound_attempts` (it is an
 * operations-only audit table), so the composition root adapts Prisma directly.
 * The router still depends on the narrow `IOutboundAttemptRecorder` interface.
 */
function createOutboundAttemptRecorder(prisma: PrismaClient): IOutboundAttemptRecorder {
  return {
    async record(input: OutboundAttemptRecordInput): Promise<void> {
      await prisma.outboundAttempt.create({
        data: {
          ticketId: input.ticketId,
          messageId: input.messageId ?? null,
          channelRoute: input.channelRoute,
          status: input.status as DeliveryStatus,
          requestPayload: toJson(input.requestPayload),
          responsePayload: toJson(input.responsePayload),
          httpStatus: input.httpStatus ?? null,
          attempt: input.attempt,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          durationMs: input.durationMs ?? null,
        },
      });
    },
  };
}

function toJson(value: Record<string, unknown> | null | undefined): Prisma.InputJsonValue {
  if (!value) return {};
  return value as Prisma.InputJsonValue;
}

/**
 * Kept for completeness: `createInfrastructure` is synchronous and returns the
 * bundle; re-exporting it here means tooling that imports the container has a
 * single entry point for the whole server graph.
 */
export { createInfrastructure };
export { DiagnosticsService } from './application/DiagnosticsService';
export type { AppConfig, InfrastructureBundle };
