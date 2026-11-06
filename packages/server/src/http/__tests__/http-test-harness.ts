import type { FastifyInstance } from 'fastify';
import type { IAppServices, ILogger } from '@sac/shared';

import { buildHttpApp } from '../app';
import type { RealtimeHub } from '../realtime-hub';
import type { HttpServerOptions } from '../types';

/**
 * Shared in-process harness for the HTTP security suites.
 *
 * No network, no database, no Redis: `buildHttpApp` is the real application
 * (same plugins/hooks/routes as production), only the service ports are faked.
 * Unknown service properties resolve to a no-op proxy so route registration does
 * not need a 60-method mock; assertions override exactly the methods they touch.
 */

export const noopLogger: ILogger = {
  child(): ILogger {
    return this;
  },
  trace(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

export function createServiceTree(overrides: Record<string, unknown> = {}): IAppServices {
  const makeNode = (bag: Record<string, unknown>): unknown => {
    let node: unknown;
    const handler: ProxyHandler<(...args: unknown[]) => void> = {
      get(_target, property) {
        if (property === 'then') return undefined;
        if (typeof property === 'string' && Object.prototype.hasOwnProperty.call(bag, property)) {
          return bag[property];
        }
        return node;
      },
      apply() {
        return node;
      },
    };
    node = new Proxy(function noop(): void {}, handler);
    return node;
  };

  return makeNode({
    logger: noopLogger,
    clock: { now: () => new Date('2026-11-05T12:00:00.000Z') },
    health: {
      health: async () => ({ status: 'ok', uptimeSeconds: 1, checks: [], channels: [] }),
    },
    status: {
      snapshot: async () => ({
        status: 'ok',
        checkedAt: '2026-11-05T12:00:00.000Z',
        services: [],
        channels: [],
      }),
    },
    webhooks: {
      accept: async () => ({
        accepted: true,
        duplicate: false,
        status: 'RECEIVED',
        httpStatus: 200,
        body: { status: 'OK' },
        eventId: null,
        durationMs: 1,
      }),
    },
    ...overrides,
  }) as IAppServices;
}

export const fakeHub = {
  attach: (): void => undefined,
  close: async (): Promise<void> => undefined,
  publish: (): void => undefined,
} as unknown as RealtimeHub;

export function createServerOptions(
  overrides: Partial<HttpServerOptions> = {},
): HttpServerOptions {
  return {
    jwtSecret: 'unit-test-secret-with-32-characters!!',
    webOrigin: 'https://app.example.test',
    appBaseUrl: 'https://api.example.test',
    logger: noopLogger,
    ...overrides,
  };
}

export interface BuildTestAppOptions {
  services?: Record<string, unknown>;
  server?: Partial<HttpServerOptions>;
  /** Register extra probes on the real app before `ready()`. */
  beforeReady?: (app: FastifyInstance) => void | Promise<void>;
}

export async function buildTestApp(options: BuildTestAppOptions = {}): Promise<FastifyInstance> {
  const app = await buildHttpApp(
    createServiceTree(options.services ?? {}),
    fakeHub,
    createServerOptions(options.server ?? {}),
  );
  if (options.beforeReady !== undefined) {
    await options.beforeReady(app);
  }
  await app.ready();
  return app;
}
