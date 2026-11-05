import { PrismaClient } from '@prisma/client';
import type { ILogger } from '@sac/shared';

/**
 * Prisma client lifecycle.
 *
 * Long-lived processes share one client per database URL (the Prisma engine
 * pools connections itself). Tests that need isolation can call
 * `disconnectPrismaClient`/`disconnectAllPrismaClients` between suites.
 */

export interface PrismaClientSettings {
  databaseUrl?: string;
  logger?: ILogger;
}

const clientsByUrl = new Map<string, PrismaClient>();

function buildClient(settings: PrismaClientSettings): PrismaClient {
  const client = new PrismaClient({
    datasourceUrl: settings.databaseUrl,
    log: [
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
  });

  client.$on('error', (event) => {
    settings.logger?.error('prisma.query_error', {
      target: event.target,
      message: event.message,
    });
  });
  client.$on('warn', (event) => {
    settings.logger?.warn('prisma.query_warning', {
      target: event.target,
      message: event.message,
    });
  });

  return client;
}

/**
 * Returns the shared `PrismaClient` for `settings.databaseUrl` (created on
 * first use). Safe to call from every module.
 */
export function getPrismaClient(settings: PrismaClientSettings = {}): PrismaClient {
  const key = settings.databaseUrl ?? 'default';
  const existing = clientsByUrl.get(key);
  if (existing) return existing;

  const client = buildClient(settings);
  clientsByUrl.set(key, client);
  return client;
}

/** Creates a dedicated client that is NOT tracked by the shared registry. */
export function createIsolatedPrismaClient(settings: PrismaClientSettings = {}): PrismaClient {
  return buildClient(settings);
}

/** Disconnects one client and removes it from the shared registry. */
export async function disconnectPrismaClient(client: PrismaClient): Promise<void> {
  for (const [url, candidate] of clientsByUrl.entries()) {
    if (candidate === client) clientsByUrl.delete(url);
  }
  await client.$disconnect();
}

/** Disconnects every shared client (graceful shutdown / tests). */
export async function disconnectAllPrismaClients(): Promise<void> {
  const clients = [...clientsByUrl.values()];
  clientsByUrl.clear();
  await Promise.allSettled(clients.map((client) => client.$disconnect()));
}
