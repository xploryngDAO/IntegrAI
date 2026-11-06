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
import { AdminUserService } from './application/AdminUserService';
import { AgentService } from './application/AgentService';
import { AuditService } from './application/AuditService';
import { AuthService } from './application/AuthService';
import { AuthSessionService } from './application/AuthSessionService';
import { BillingService } from './application/BillingService';
import { DiagnosticsService } from './application/DiagnosticsService';
import { FileService } from './application/FileService';
import { HealthService } from './application/HealthService';
import { IntegrationSetupService } from './application/IntegrationSetupService';
import { InvitationService } from './application/InvitationService';
import {
  OutboundRouterService,
  type IOutboundAttemptRecorder,
  type OutboundAttemptRecordInput,
} from './application/OutboundRouterService';
import { PlanLimitService } from './application/PlanLimitService';
import { PlatformService } from './application/PlatformService';
import { SlaEngine } from './application/sla/SlaEngine';
import { SsoAuthService } from './application/SsoAuthService';
import { StatusService } from './application/StatusService';
import { TenantBackupService } from './application/TenantBackupService';
import { TenantPrivacyService } from './application/TenantPrivacyService';
import { TenantPurgeService } from './application/TenantPurgeService';
import { TenantService } from './application/TenantService';
import { TenantSsoService } from './application/TenantSsoService';
import { TicketQueryService } from './application/TicketQueryService';
import { TwoFactorService } from './application/TwoFactorService';
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

  // --- 0. Audit trail (leaf: no dependency on the other services) ----------
  // Best-effort writer shared by auth, 2FA, invitations, SSO and billing. The
  // administrative service that backs `/admin/*` reads the same repository.
  const audit = new AuditService({
    logger: infra.logger,
    clock: infra.clock,
    repo: infra.auditEvents,
  });

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
  // Fase 4: single quota gate shared by accounts and invitations.
  const planLimits = new PlanLimitService({
    logger: infra.logger,
    clock: infra.clock,
    repos: {
      tenants: infra.tenants,
      platform: infra.platform,
      invitations: infra.invitations,
    },
  });

  const accounts = new AccountService({
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    cipher: infra.cipher,
    http: infra.http,
    config: channelConfig,
    adapters,
    realtime,
    planLimits,
    repos: { accounts: infra.repos.accounts },
  });

  const tenants = new TenantService({
    logger: infra.logger,
    clock: infra.clock,
    repos: { tenants: infra.tenants },
  });

  const tenantPrivacy = new TenantPrivacyService({
    logger: infra.logger,
    clock: infra.clock,
    repos: {
      tenants: infra.tenants,
      tenantAdmin: infra.platformTenants,
      agents: infra.agents,
      tenantData: infra.tenantData,
    },
  });

  const platform = new PlatformService({
    logger: infra.logger,
    clock: infra.clock,
    repos: {
      agents: infra.agents,
      tenants: infra.tenants,
      platformTenants: infra.platformTenants,
      platform: infra.platform,
    },
  });

  // Fase 2 onboarding: read-only guide to CREATE the app in each marketplace
  // portal. Pure config introspection (no marketplace call, no secret read).
  const integrationSetup = new IntegrationSetupService({
    clock: infra.clock,
    config: channelConfig,
    webOrigin: config.webOrigin,
  });

  // Fase 4: provider-agnostic payment gateway contract. No SDK/adapter is
  // loaded: the webhook is authenticated by HMAC and checkout is a local
  // template, so the API never calls a payment provider.
  const billing = new BillingService({
    logger: infra.logger,
    clock: infra.clock,
    billing: config.billing,
    audit,
    repos: {
      tenants: infra.tenants,
      platformTenants: infra.platformTenants,
      billingEvents: infra.billingEvents,
    },
  });

  // Fase 4: backup/restore por workspace. The artifact lives in the raw bucket;
  // `tenant_backups` only indexes it. Restore always creates a NEW tenant.
  const tenantBackup = new TenantBackupService({
    logger: infra.logger,
    clock: infra.clock,
    storage: infra.storage,
    repos: {
      tenants: infra.tenants,
      backups: infra.tenantBackups,
      restore: infra.tenantRestore,
    },
  });

  // Fase 4/LGPD: physical purge of workspaces soft-deleted 30+ days ago. The
  // same service backs the daily `queue.tenant.purge` job and the manual
  // platform-admin endpoint, so the retention policy exists in one place.
  const tenantPurge = new TenantPurgeService({
    logger: infra.logger,
    clock: infra.clock,
    // LGPD: artifacts are removed through the same storage used for uploads
    // BEFORE the transactional delete (missing keys are tolerated).
    storage: infra.storage,
    retentionDays: config.tenantPurgeRetentionDays,
    repos: {
      tenants: infra.tenants,
      purge: infra.tenantPurge,
    },
  });

  const sessions = new AuthSessionService({
    logger: infra.logger,
    clock: infra.clock,
    jwtSecret: config.jwtSecret,
    jwtExpiresIn: config.jwtExpiresIn,
    repos: {
      agents: infra.agents,
      sessions: infra.sessions,
    },
  });

  // Fase 6: workspace team administration (`/admin/users`). The last-admin and
  // self-change guards live in the service; mutations go through `audit` and an
  // effective role/active change e-mails the affected operator (best effort).
  const adminUsers = new AdminUserService({
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    audit,
    email: infra.email,
    tenants: infra.tenants,
    repos: {
      adminUsers: infra.adminUsers,
      sessions: infra.sessions,
    },
  });

  // Fase 5: workspace IdP configuration + `enforce_sso` password gate. Built
  // BEFORE AgentService (the login gate depends on it) and reused by the public
  // SSO flow below.
  const tenantSso = new TenantSsoService({
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    cipher: infra.cipher,
    repo: infra.ssoConnections,
    appBaseUrl: config.appBaseUrl,
    nodeEnv: config.nodeEnv,
  });

  const agents = new AgentService({
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    realtime,
    jwtSecret: config.jwtSecret,
    jwtExpiresIn: config.jwtExpiresIn,
    presenceTtlSeconds: config.agentPresenceTtlSeconds,
    sessions,
    tenants: infra.tenants,
    sso: tenantSso,
    audit,
    // Security: new-device login alert (`auth.login.new_device`). The e-mail is
    // best effort and the session repository is read directly for the exact
    // fingerprint lookup (before the new session row is created).
    email: infra.email,
    sessionRepository: infra.sessions,
    repos: {
      agents: infra.agents,
      tickets: infra.repos.tickets,
    },
  });

  // Fase 5: public OIDC flow (start/callback/exchange). Session issuance goes
  // through `agents.issueSession`, so SSO and password logins share the exact
  // same token/presence/refresh-token bookkeeping.
  const sso = new SsoAuthService({
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    http: infra.http,
    cipher: infra.cipher,
    jwtSecret: config.jwtSecret,
    webOrigin: config.webOrigin,
    nodeEnv: config.nodeEnv,
    repos: {
      connections: infra.ssoConnections,
      agents: infra.ssoAgents,
    },
    agents,
  });

  const twoFactor = new TwoFactorService({
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    cipher: infra.cipher,
    jwtSecret: config.jwtSecret,
    agentsService: agents,
    audit,
    repos: {
      agents: infra.agents,
      twoFactor: infra.twoFactor,
    },
  });

  const auth = new AuthService({
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    email: infra.email,
    audit,
    config: {
      webOrigin: config.webOrigin,
      appBaseUrl: config.appBaseUrl,
    },
    repos: {
      agents: infra.agents,
      tenants: infra.tenants,
      emailVerifications: infra.emailVerifications,
      passwordResets: infra.passwordResets,
      sessions: infra.sessions,
    },
  });

  const invitations = new InvitationService({
    logger: infra.logger,
    clock: infra.clock,
    email: infra.email,
    jwtSecret: config.jwtSecret,
    jwtExpiresIn: config.jwtExpiresIn,
    config: {
      webOrigin: config.webOrigin,
      appBaseUrl: config.appBaseUrl,
    },
    sessions,
    planLimits,
    audit,
    repos: {
      invitations: infra.invitations,
      agents: infra.agents,
      tenants: infra.tenants,
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

  // Shared infrastructure probes. The public status page deliberately reuses
  // the SAME probes as health/diagnostics: no adapter call, therefore no paid
  // marketplace quota is spent by `GET /status`.
  const probeDatabase = async (): Promise<void> => {
    await infra.prisma.$queryRawUnsafe('SELECT 1');
  };
  const probeRedis = async (): Promise<void> => {
    const pong = await infra.redis.ping();
    if (pong !== 'PONG') throw new Error(`Unexpected Redis PING reply: ${pong}`);
  };
  const probeStoragePresign = async (): Promise<void> => {
    // Best effort: presigning validates the bucket/credentials locally and
    // fails fast when the storage client is misconfigured.
    await infra.storage.presignGet('attachments/health/probe.txt', 60);
  };
  const probeStorageBucket = async (): Promise<void> => {
    await probeStorage(infra.storage);
  };

  const health = new HealthService({
    logger: infra.logger,
    clock: infra.clock,
    cache: infra.cache,
    realtime,
    probes: {
      database: probeDatabase,
      redis: probeRedis,
      storage: probeStoragePresign,
    },
    repos: {
      accounts: infra.repos.accounts,
      tickets: infra.repos.tickets,
    },
  });

  // Public status page: infra probes + aggregated account counters only. It
  // never calls an adapter/marketplace, so it is safe to expose anonymously.
  const status = new StatusService({
    logger: infra.logger,
    clock: infra.clock,
    probes: {
      database: probeDatabase,
      redis: probeRedis,
      storage: probeStorageBucket,
    },
    repos: { accounts: infra.repos.accounts },
  });

  const diagnostics = new DiagnosticsService({
    logger: infra.logger,
    clock: infra.clock,
    adapters,
    repos: { accounts: infra.repos.accounts },
    probes: {
      database: probeDatabase,
      redis: probeRedis,
      storage: probeStorageBucket,
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
    tenants,
    tenantPrivacy,
    tenantPurge,
    tenantBackup,
    planLimits,
    platform,
    integrationSetup,
    billing,
    tickets,
    ticketCommands,
    outbound,
    agents,
    auth,
    tenantSso,
    sso,
    twoFactor,
    sessions,
    invitations,
    audit,
    adminUsers,
    webhooks,
    health,
    status,
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
    tenantPurgeCron: config.cron.tenantPurge,
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
    const code =
      typeof (error as { code?: unknown }).code === 'string'
        ? String((error as { code?: unknown }).code)
        : '';
    const combined = `${name} ${code} ${message}`;
    // A missing sentinel object proves the bucket exists and the credentials are
    // accepted (this is the HeadBucket signal, without needing ListBucket).
    if (/NoSuchKey|NotFound|not found|not exist|STORAGE_OBJECT_NOT_FOUND|404/i.test(combined)) {
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
