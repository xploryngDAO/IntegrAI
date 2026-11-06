import { PrismaPg } from '@prisma/adapter-pg';
import type { ILogger } from '@sac/shared';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * Prisma client lifecycle.
 *
 * Prisma ORM 7 has no bundled query engine: every client is created with a
 * driver adapter (`@prisma/adapter-pg` over `pg`). Long-lived processes share
 * one client per database URL (the adapter's pool handles connections).
 * Tests that need isolation can call `disconnectPrismaClient`/
 * `disconnectAllPrismaClients` between suites.
 */

export interface PrismaClientSettings {
  databaseUrl?: string;
  logger?: ILogger;
}

const clientsByUrl = new Map<string, PrismaClient>();

interface DriverSettings {
  connectionString: string;
  schema?: string;
  /** Prisma v6 honoured `?connection_limit=`; `pg` uses `max` instead. */
  max?: number;
}

/**
 * Translates the Prisma connection URL into `pg` pool settings.
 * Prisma-only query params (`schema`, `connection_limit`) are understood by
 * the CLI but ignored by `pg`, so they are mapped explicitly here.
 */
function resolveDriverSettings(settings: PrismaClientSettings): DriverSettings {
  const connectionString = settings.databaseUrl ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to create a PrismaClient');
  }

  let schema: string | undefined;
  let max: number | undefined;
  try {
    const parsed = new URL(connectionString);
    schema = parsed.searchParams.get('schema') ?? undefined;
    const limit = Number(parsed.searchParams.get('connection_limit'));
    if (Number.isFinite(limit) && limit > 0) max = limit;
  } catch {
    // Non-URL connection strings are passed through untouched; `pg` validates.
  }

  return { connectionString, schema, max };
}

function buildClient(settings: PrismaClientSettings): PrismaClient {
  const { connectionString, schema, max } = resolveDriverSettings(settings);

  const adapter = new PrismaPg(
    {
      connectionString,
      ...(max ? { max } : {}),
      // Prisma v6 defaulted to a 5s connect timeout; `pg` defaults to none.
      connectionTimeoutMillis: 5_000,
    },
    { schema: schema ?? 'public' },
  );

  const client = new PrismaClient({
    adapter,
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
