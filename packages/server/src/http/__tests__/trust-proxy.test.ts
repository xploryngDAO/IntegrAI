import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type { HttpServerOptions } from '../types';
import { buildTestApp } from './http-test-harness';

/**
 * `trustProxy` wiring.
 *
 * The probe route lives under `/webhooks/` (public, never guarded by the
 * content-type or JWT hooks) and echoes `request.ip`, so the assertions exercise
 * the real Fastify IP resolution rather than an internal option.
 */

const PROBE_PATH = '/webhooks/__test/ip';
const XFF_CLIENT = '203.0.113.7';
const PROXY_ADDRESS = '10.1.2.3';

async function buildProxyApp(trustProxy?: HttpServerOptions['trustProxy']): Promise<FastifyInstance> {
  return buildTestApp({
    server: trustProxy === undefined ? {} : { trustProxy },
    beforeReady(app) {
      app.get(PROBE_PATH, async (request) => ({ ip: request.ip }));
    },
  });
}

describe('trustProxy', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    while (apps.length > 0) {
      await apps.pop()?.close();
    }
  });

  async function appWith(trustProxy?: HttpServerOptions['trustProxy']): Promise<FastifyInstance> {
    const app = await buildProxyApp(trustProxy);
    apps.push(app);
    return app;
  }

  it('defaults to false: the proxy header is ignored', async () => {
    const app = await appWith(undefined);

    const response = await app.inject({
      method: 'GET',
      url: PROBE_PATH,
      headers: { 'x-forwarded-for': XFF_CLIENT },
      remoteAddress: PROXY_ADDRESS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ip: PROXY_ADDRESS });
  });

  it('honors X-Forwarded-For when enabled with true', async () => {
    const app = await appWith(true);

    const response = await app.inject({
      method: 'GET',
      url: PROBE_PATH,
      headers: { 'x-forwarded-for': XFF_CLIENT },
      remoteAddress: PROXY_ADDRESS,
    });

    expect(response.json()).toEqual({ ip: XFF_CLIENT });
  });

  it('honors XFF only when the socket address is in the trusted list', async () => {
    const trusted = await appWith(['10.0.0.0/8']);
    const trustedResponse = await trusted.inject({
      method: 'GET',
      url: PROBE_PATH,
      headers: { 'x-forwarded-for': XFF_CLIENT },
      remoteAddress: PROXY_ADDRESS,
    });
    expect(trustedResponse.json()).toEqual({ ip: XFF_CLIENT });

    const untrusted = await appWith(['192.168.0.0/16']);
    const untrustedResponse = await untrusted.inject({
      method: 'GET',
      url: PROBE_PATH,
      headers: { 'x-forwarded-for': XFF_CLIENT },
      remoteAddress: PROXY_ADDRESS,
    });
    expect(untrustedResponse.json()).toEqual({ ip: PROXY_ADDRESS });
  });

  it('walks a multi-hop X-Forwarded-For from the trusted edge', async () => {
    const app = await appWith(['10.0.0.0/8']);

    const response = await app.inject({
      method: 'GET',
      url: PROBE_PATH,
      headers: { 'x-forwarded-for': `${XFF_CLIENT}, 10.9.9.9` },
      remoteAddress: PROXY_ADDRESS,
    });

    expect(response.json()).toEqual({ ip: XFF_CLIENT });
  });
});
