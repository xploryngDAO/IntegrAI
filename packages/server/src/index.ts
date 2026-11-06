import { MARKETPLACES, MARKETPLACE_LABEL, redactPiiForLogs } from '@sac/shared';
import type { ChannelHealthView, IAppServices, ILogger } from '@sac/shared';

import { loadConfig, type AppConfig } from './config';
import { createInfrastructure, disposeInfrastructure, type InfrastructureBundle } from './infrastructure';
import { buildHttpApp, createRealtimeHub } from './http';
import { createContainer, disposeContainer, getWorkerDependencies } from './container';
import { startSchedulers, startWorkers, stopWorkers } from './queues';

/**
 * ============================================================================
 * SAC Hub server bootstrap
 * ============================================================================
 *
 * Order matters:
 *   config -> infrastructure (Postgres/Redis/S3) -> Socket.IO hub -> container
 *   -> Fastify app -> listen -> BullMQ workers + schedulers.
 *
 * Shutdown is idempotent and bounded: HTTP stops accepting, the realtime hub and
 * workers close, then Prisma/Redis/S3 are disposed. A 20s force-exit timer makes
 * sure a stuck socket cannot keep a rolling deploy alive forever.
 */

const SHUTDOWN_TIMEOUT_MS = 20_000;

let shuttingDown = false;

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const infra = createInfrastructure(config);
  const logger = infra.logger.child({ component: 'bootstrap' });

  let services: IAppServices | null = null;
  let app: Awaited<ReturnType<typeof buildHttpApp>> | null = null;
  let hub: ReturnType<typeof createRealtimeHub> | null = null;

  try {
    logger.info('sachub.starting', {
      nodeEnv: config.nodeEnv,
      port: config.port,
      version: process.env.npm_package_version ?? '1.0.0',
    });

    // --- Realtime hub + HTTP -------------------------------------------
    hub = createRealtimeHub({
      logger: infra.logger,
      clock: infra.clock,
      jwtSecret: config.jwtSecret,
      webOrigin: config.webOrigin,
      cache: infra.cache,
    });

    services = createContainer({ config, infra, realtime: hub.publisher });

    app = await buildHttpApp(services, hub, {
      jwtSecret: config.jwtSecret,
      webOrigin: config.webOrigin,
      appBaseUrl: config.appBaseUrl,
      logger: infra.logger,
    });

    hub.attach(app.server);

    // --- Queue plane ----------------------------------------------------
    const workerDependencies = getWorkerDependencies();
    startWorkers(workerDependencies);
    await startSchedulers(workerDependencies);

    // --- Listen ---------------------------------------------------------
    await app.listen({ port: config.port, host: '0.0.0.0' });

    await logStartupBanner(services, config, logger);

    // --- Signal handling ------------------------------------------------
    const shutdown = (signal: string): void => {
      void gracefulShutdown(signal, {
        logger,
        app,
        hub,
        infra,
      });
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    process.on('unhandledRejection', (reason) => {
      logger.error('process.unhandled_rejection', {
        error: redactPiiForLogs(reason instanceof Error ? reason.message : String(reason)),
      });
    });
    process.on('uncaughtException', (error) => {
      logger.error('process.uncaught_exception', {
        error: redactPiiForLogs(error.message),
        stack: error.stack ? redactPiiForLogs(error.stack).slice(0, 2_000) : undefined,
      });
      void gracefulShutdown('uncaughtException', { logger, app, hub, infra });
    });
  } catch (error) {
    logger.error('sachub.startup_failed', {
      error: redactPiiForLogs(error instanceof Error ? error.message : String(error)),
      stack: error instanceof Error ? redactPiiForLogs(error.stack ?? '').slice(0, 4_000) : undefined,
    });

    // Best-effort cleanup of whatever was already created.
    try {
      if (app) await app.close();
    } catch {
      // ignore
    }
    try {
      if (hub) await hub.close();
    } catch {
      // ignore
    }
    await disposeContainer().catch(() => undefined);
    await disposeInfrastructure(infra).catch(() => undefined);
    process.exitCode = 1;
    throw error;
  }
}

interface ShutdownContext {
  logger: ILogger;
  app: Awaited<ReturnType<typeof buildHttpApp>> | null;
  hub: ReturnType<typeof createRealtimeHub> | null;
  infra: InfrastructureBundle;
}

async function gracefulShutdown(signal: string, context: ShutdownContext): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const { logger, app, hub, infra } = context;
  logger.info('sachub.shutdown.started', { signal });

  const forceExit = setTimeout(() => {
    logger.error('sachub.shutdown.force_exit', { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  const step = async (name: string, action: () => Promise<void>): Promise<void> => {
    const started = Date.now();
    try {
      await action();
      logger.info('sachub.shutdown.step', { step: name, durationMs: Date.now() - started });
    } catch (error) {
      logger.error('sachub.shutdown.step_failed', {
        step: name,
        error: redactPiiForLogs(error instanceof Error ? error.message : String(error)),
      });
    }
  };

  // 1. Stop accepting new HTTP traffic.
  await step('http.close', async () => {
    if (app) await app.close();
  });

  // 2. Stop the realtime hub.
  await step('realtime.close', async () => {
    if (hub) await hub.close();
  });

  // 3. Stop BullMQ workers/schedulers (finishes in-flight jobs).
  await step('queues.stop', async () => {
    await stopWorkers();
  });

  // 4. Drop the container graph.
  await step('container.dispose', async () => {
    await disposeContainer();
  });

  // 5. Close Prisma/Redis/S3/BullMQ publisher.
  await step('infrastructure.dispose', async () => {
    await disposeInfrastructure(infra);
  });

  clearTimeout(forceExit);
  logger.info('sachub.shutdown.complete', { signal });
  process.exit(0);
}

async function logStartupBanner(
  services: IAppServices,
  config: AppConfig,
  logger: ILogger,
): Promise<void> {
  const accounts = await services.accounts.listAccounts().catch(() => []);
  const activeByMarketplace = new Set(
    accounts.filter((account) => account.status === 'ACTIVE').map((account) => account.marketplace),
  );

  const readiness = MARKETPLACES.map((marketplace) => {
    const label = MARKETPLACE_LABEL[marketplace];
    return `${label}: ${activeByMarketplace.has(marketplace) ? 'CONECTADO' : 'sem conta ativa'}`;
  });

  let channels: ChannelHealthView[] = [];
  try {
    channels = await services.health.channels();
  } catch (error) {
    logger.warn('sachub.startup.health_unavailable', {
      error: redactPiiForLogs(error instanceof Error ? error.message : String(error)),
    });
  }
  const unhealthy = channels.filter((channel) => !channel.inboundHealthy || !channel.outboundHealthy);

  logger.info('==============================================================');
  logger.info('  SAC HUB API — omnichannel support hub');
  logger.info('==============================================================');
  logger.info(`  env        : ${config.nodeEnv}`);
  logger.info(`  listening  : http://0.0.0.0:${config.port}`);
  logger.info(`  api base   : ${config.appBaseUrl}/api/v1`);
  logger.info(`  web origin : ${config.webOrigin}`);
  logger.info(`  queues     : 10 (inbound x3, enrichment, outbound, sla, pii, token, lost-push, dlq)`);
  logger.info('  canais     :');
  for (const line of readiness) logger.info(`    - ${line}`);
  if (unhealthy.length > 0) {
    logger.warn('  atenção    : canais com restrição', {
      channels: unhealthy.map((channel) => `${channel.marketplace}:${channel.accountDisplayName}`),
    });
  }
  logger.info('==============================================================');
}

/* CommonJS entrypoint: only bootstrap when executed directly (not when imported
 * by tests or by the worker-only entrypoint). */
if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    // The logger may not exist if config/infrastructure failed to load.
    // eslint-disable-next-line no-console
    console.error(
      '[sac-hub] fatal startup error:',
      redactPiiForLogs(error instanceof Error ? error.message : String(error)),
    );
    process.exit(1);
  });
}

export { bootstrap, gracefulShutdown };
