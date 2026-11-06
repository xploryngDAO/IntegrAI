import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  isJsonContentType,
  mediaTypeOf,
  UNSUPPORTED_MEDIA_TYPE_CODE,
  UNSUPPORTED_MEDIA_TYPE_MESSAGE,
} from '../middleware/content-type-guard';
import { buildTestApp } from './http-test-harness';

/**
 * Content-Type guard (`registerContentTypeGuard`).
 *
 * The real `buildHttpApp` graph is exercised with `app.inject`, so the tests
 * assert the same hook order production uses. `/api/v1/billing/webhook` is the
 * probe: it is public (HMAC-authenticated) and its fake records the parsed body,
 * which lets the suite prove that accepted requests are parsed as JSON.
 */

const WEBHOOK_RESULT = {
  type: 'subscription.activated',
  tenantId: 'tenant-1',
  duplicate: false,
  billingStatus: 'ACTIVE',
};

describe('Content-Type guard on /api/v1', () => {
  let app: FastifyInstance;
  const parsedBodies: unknown[] = [];

  beforeAll(async () => {
    app = await buildTestApp({
      services: {
        billing: {
          handleWebhook: async (input: { body?: unknown }) => {
            parsedBodies.push(input.body);
            return WEBHOOK_RESULT;
          },
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects text/plain with 415 and the stable UNSUPPORTED_MEDIA_TYPE body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ type: 'subscription.activated' }),
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({
      error: {
        code: UNSUPPORTED_MEDIA_TYPE_CODE,
        message: UNSUPPORTED_MEDIA_TYPE_MESSAGE,
        details: {
          expected: 'application/json',
          accepted: ['application/json', 'application/*+json'],
          received: 'text/plain',
        },
      },
    });
  });

  it('rejects form-urlencoded mutations', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'type=subscription.activated',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe(UNSUPPORTED_MEDIA_TYPE_CODE);
  });

  it('rejects multipart on a JSON route (no blanket multipart exemption)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'multipart/form-data; boundary=----x' },
      payload: '------x--',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe(UNSUPPORTED_MEDIA_TYPE_CODE);
  });

  it('rejects a mutation with a body but without Content-Type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      // No content-type header at all: the request still carries a body.
      payload: Buffer.from('{"type":"subscription.activated"}'),
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe(UNSUPPORTED_MEDIA_TYPE_CODE);
  });

  it('accepts application/json; charset=utf-8 and parses the body', async () => {
    parsedBodies.length = 0;

    const body = { type: 'subscription.activated', tenantId: 'tenant-1' };
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(parsedBodies).toEqual([body]);
  });

  it('accepts application/*+json and parses it with the JSON parser', async () => {
    parsedBodies.length = 0;

    const body = { type: 'subscription.activated', tenantId: 'tenant-2' };
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/vnd.api+json' },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(parsedBodies).toEqual([body]);
  });

  it.each(['PUT', 'PATCH'] as const)(
    'rejects a %s with a non-JSON body before authentication runs',
    async (method) => {
      const response = await app.inject({
        method,
        url: '/api/v1/tenants/me',
        headers: { 'content-type': 'text/plain' },
        payload: '{"name":"Acme"}',
      });

      // 415 (guard) instead of 401 (auth) proves the rejection happens in the
      // earliest hook and never reaches a handler.
      expect(response.statusCode).toBe(415);
      expect(response.json().error.code).toBe(UNSUPPORTED_MEDIA_TYPE_CODE);
    },
  );

  it('lets a bodyless POST through (nothing to parse, no parser confusion)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
    });

    expect(response.statusCode).toBe(200);
  });

  it('does not apply outside /api/v1 (marketplace webhooks keep their parsers)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/shopee',
      headers: { 'content-type': 'text/plain' },
      payload: 'raw-webhook-body',
    });

    expect(response.statusCode).toBe(200);
  });

  it('leaves OAuth callbacks alone even when posted without a body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/oauth/amazon/callback',
    });

    // No route matches POST there; the important part is that the guard did not
    // answer 415 for a callback path.
    expect(response.statusCode).not.toBe(415);
  });
});

describe('Content-Type helpers', () => {
  it('recognizes JSON media types with parameters and structured suffixes', () => {
    expect(mediaTypeOf('application/json; charset=utf-8')).toBe('application/json');
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('Application/JSON')).toBe(true);
    expect(isJsonContentType('application/vnd.api+json')).toBe(true);
    expect(isJsonContentType('application/json-patch+json; charset=utf-8')).toBe(true);
  });

  it('rejects near-miss and non-JSON media types', () => {
    expect(isJsonContentType(undefined)).toBe(false);
    expect(isJsonContentType('')).toBe(false);
    expect(isJsonContentType('text/json')).toBe(false);
    expect(isJsonContentType('application/jsonx')).toBe(false);
    expect(isJsonContentType('application/jsonp')).toBe(false);
    expect(isJsonContentType('application/xml')).toBe(false);
    expect(isJsonContentType('text/plain; charset=utf-8')).toBe(false);
  });
});
