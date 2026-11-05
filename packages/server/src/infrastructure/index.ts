import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type {
  AdapterRepositories,
  IAgentRepository,
  ICache,
  IClock,
  IDistributedLock,
  IHttpClient,
  ILogger,
  IObjectStorage,
  IQueuePublisher,
  IRateLimiter,
  ISlaPolicyRepository,
  ISecretCipher,
} from '@sac/shared';
import type { AppConfig } from '../config';
import { createRepositories, createAgentRepository, createSlaPolicyRepository } from '../application/repositories';
import { SecretCipher } from './crypto/cipher';
import { FetchHttpClient } from './http/client';
import { Redlock } from './lock/redlock';
import { createLogger } from './logger';
import { getPrismaClient, disconnectPrismaClient } from './prisma/client';
import { BullMqQueuePublisher } from './queue/publisher';
import { TokenBucketRateLimiter } from './ratelimit/token-bucket';
import { RedisCache } from './redis/cache';
import { closeRedisConnection, createRedisConnection } from './redis/connection';
import { S3ObjectStorage } from './storage/s3';

/**
 * Everything a service/worker/HTTP handler needs, wired exactly once at
 * bootstrap. Kept intentionally flat so tests can substitute one member.
 */
export interface InfrastructureBundle {
  config: AppConfig;
  logger: ILogger;
  clock: IClock;
  prisma: PrismaClient;
  redis: Redis;
  cache: ICache;
  lock: IDistributedLock;
  rateLimiter: IRateLimiter;
  storage: IObjectStorage;
  cipher: ISecretCipher;
  http: IHttpClient;
  queue: IQueuePublisher;
  repos: AdapterRepositories;
  agents: IAgentRepository;
  slaPolicies: ISlaPolicyRepository;
}

/** Wall-clock `IClock`; services take `IClock` so tests can freeze time. */
export class SystemClock implements IClock {
  now(): Date {
    return new Date();
  }
}

/**
 * Builds the infrastructure graph. Synchronous by contract: the only work done
 * here is object construction; Prisma/Redis/S3 connect lazily on first use
 * (S3 config is still validated eagerly so a bad bucket fails the boot).
 */
export function createInfrastructure(config: AppConfig): InfrastructureBundle {
  const logger = createLogger({
    nodeEnv: config.nodeEnv,
    level: config.logLevel,
    name: 'sac-hub',
  });

  const clock: IClock = new SystemClock();

  const prisma = getPrismaClient({ databaseUrl: config.databaseUrl, logger });

  const redis = createRedisConnection(config.redisUrl, {
    logger,
    connectionName: 'sac-hub-api',
  });

  const cache = new RedisCache(redis);
  const lock = new Redlock([redis], { logger });
  const rateLimiter = new TokenBucketRateLimiter(redis, config.rateLimits);

  const storage = new S3ObjectStorage(
    {
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      bucket: config.s3.bucket,
      attachmentsBucket: config.s3.attachmentsBucket,
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
      forcePathStyle: config.s3.forcePathStyle,
      sse: config.s3.sse,
    },
    logger,
  );

  const cipher = new SecretCipher({
    masterKey: config.encryptionMasterKey,
    keyId: config.encryptionKeyId,
  });

  const http = new FetchHttpClient({ logger });
  const queue = new BullMqQueuePublisher(config.redisUrl, {
    logger,
    defaultAttempts: 6,
  });

  const repos = createRepositories(prisma);
  const agents = createAgentRepository(prisma);
  const slaPolicies = createSlaPolicyRepository(prisma);

  return {
    config,
    logger,
    clock,
    prisma,
    redis,
    cache,
    lock,
    rateLimiter,
    storage,
    cipher,
    http,
    queue,
    repos,
    agents,
    slaPolicies,
  };
}

/**
 * Graceful shutdown. Never throws: a failing component must not prevent the
 * remaining ones from closing (the process is going down either way).
 */
export async function disposeInfrastructure(bundle: InfrastructureBundle): Promise<void> {
  if (bundle.queue instanceof BullMqQueuePublisher) {
    try {
      await bundle.queue.close();
    } catch (error) {
      bundle.logger.warn('infrastructure.dispose.queue_failed', { message: describe(error) });
    }
  }

  try {
    await closeRedisConnection(bundle.redis);
  } catch (error) {
    bundle.logger.warn('infrastructure.dispose.redis_failed', { message: describe(error) });
  }

  try {
    await disconnectPrismaClient(bundle.prisma);
  } catch (error) {
    bundle.logger.warn('infrastructure.dispose.prisma_failed', { message: describe(error) });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
