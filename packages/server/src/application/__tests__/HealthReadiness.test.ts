import { describe, expect, it } from 'vitest';
import type {
  IAccountRepository,
  ICache,
  IClock,
  ILogger,
  ITicketRepository,
} from '@sac/shared';

import { HealthService, type HealthServiceDependencies } from '../HealthService';

/**
 * `HealthService.readiness()` contract:
 *  - ready only when all three dependencies answer;
 *  - a failing / hanging probe becomes data (`checks.<name> === 'error'`), never
 *    an exception and never an unbounded wait (~2 s production deadline).
 */

const noopLogger: ILogger = {
  child(): ILogger {
    return this;
  },
  trace(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

const clock: IClock = { now: () => new Date('2026-11-05T12:00:00.000Z') };

const cache = {} as unknown as ICache;

const repos = {} as unknown as {
  accounts: IAccountRepository;
  tickets: ITicketRepository;
};

function serviceWith(
  probes: HealthServiceDependencies['probes'],
  readinessTimeoutMs = 50,
): HealthService {
  return new HealthService({
    logger: noopLogger,
    clock,
    cache,
    probes,
    repos,
    readinessTimeoutMs,
  });
}

describe('HealthService.readiness', () => {
  it('is ready when every probe answers', async () => {
    const service = serviceWith({
      database: async () => undefined,
      redis: async () => undefined,
      storage: async () => undefined,
    });

    const report = await service.readiness();

    expect(report).toEqual({
      status: 'ready',
      checks: { database: 'ok', redis: 'ok', storage: 'ok' },
    });
  });

  it('maps a failing probe to an error marker without throwing', async () => {
    const service = serviceWith({
      database: async () => undefined,
      redis: async () => {
        throw new Error('redis connection refused');
      },
      storage: async () => undefined,
    });

    const report = await service.readiness();

    expect(report.status).toBe('degraded');
    expect(report.checks).toEqual({
      database: 'ok',
      redis: 'error',
      storage: 'ok',
    });
    expect(report.errors?.redis).toContain('redis connection refused');
    expect(report.errors?.database).toBeUndefined();
  });

  it('times out a hanging probe instead of waiting forever', async () => {
    const service = serviceWith(
      {
        database: () => new Promise<void>(() => undefined),
        redis: async () => undefined,
        storage: async () => undefined,
      },
      25,
    );

    const startedAt = Date.now();
    const report = await service.readiness();
    const elapsed = Date.now() - startedAt;

    expect(report.status).toBe('degraded');
    expect(report.checks.database).toBe('error');
    expect(report.checks.redis).toBe('ok');
    expect(report.errors?.database).toContain('timed out');
    expect(elapsed).toBeLessThan(1_000);
  });

  it('reports every dependency down when all probes fail', async () => {
    const failure = async (): Promise<void> => {
      throw new Error('dependency unavailable');
    };
    const service = serviceWith({
      database: failure,
      redis: failure,
      storage: failure,
    });

    const report = await service.readiness();

    expect(report.status).toBe('degraded');
    expect(report.checks).toEqual({
      database: 'error',
      redis: 'error',
      storage: 'error',
    });
    expect(Object.keys(report.errors ?? {}).sort()).toEqual([
      'database',
      'redis',
      'storage',
    ]);
  });
});
