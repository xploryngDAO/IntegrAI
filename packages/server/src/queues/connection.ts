import { Redis } from 'ioredis';

import type { ILogger } from '@sac/shared';

/**
 * BullMQ needs its own Redis connections: blocking workers must run with
 * `maxRetriesPerRequest: null`, and a connection must never be shared between a
 * Worker and a Queue. The central infrastructure owns the application Redis
 * client; this module owns the queue-specific ones.
 */

export type QueueConnectionRole = 'worker' | 'queue' | 'scheduler';

export function createQueueConnection(
  redisUrl: string,
  role: QueueConnectionRole,
  logger?: ILogger,
): Redis {
  const connection = new Redis(redisUrl, {
    // BullMQ requirement: blocking commands must be allowed to wait forever.
    maxRetriesPerRequest: role === 'worker' ? null : 3,
    enableReadyCheck: true,
    lazyConnect: false,
    connectionName: `sac-hub:${role}`,
  });

  connection.on('error', (error: Error) => {
    logger?.error('queue.redis.error', {
      role,
      message: error.message,
    });
  });
  connection.on('reconnecting', () => {
    logger?.warn('queue.redis.reconnecting', { role });
  });

  return connection;
}

export async function closeQueueConnection(connection: Redis | null): Promise<void> {
  if (!connection) return;
  try {
    await connection.quit();
  } catch {
    try {
      connection.disconnect();
    } catch {
      // Already closed: nothing else to do during shutdown.
    }
  }
}
