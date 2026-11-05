import { describe, expect, it } from 'vitest';
import { MarketplaceApiError } from '@sac/shared';
import {
  assertTimestampFresh,
  buildSignBase,
  computeSign,
  computeWebhookSign,
  safeEqualHex,
} from '../client/sign';

/**
 * Known-vector tests: the expected digests were produced independently with
 * `openssl dgst -sha256 -hmac` semantics, so any change to the concatenation
 * order (a silent Shopee auth failure in production) breaks this test.
 */
describe('computeSign', () => {
  it('signs private calls with partner_id + path + timestamp + access_token + shop_id', () => {
    const sign = computeSign({
      partnerId: 100001,
      apiPath: '/api/v2/sellerchat/send_message',
      timestamp: 1_700_000_000,
      accessToken: 'access-token-abc',
      shopId: 987_654,
      partnerKey: 'partner-key-secret',
    });
    expect(sign).toBe(
      'c20f8e862f19cb6478f98cd8d0b96c845157476a4f0df7d81903695d32d04958',
    );
  });

  it('omits access_token/shop_id (empty segments) for public calls', () => {
    const sign = computeSign({
      partnerId: 200002,
      apiPath: '/api/v2/auth/token/get',
      timestamp: 1_712_345_678,
      partnerKey: 'shopee-partner-key',
    });
    expect(sign).toBe(
      '1f3cae2ff5eb69368fa8b792aca45b3c9f27ddf32992c85cb3db496cd53776b2',
    );
  });

  it('builds the exact base string Shopee expects', () => {
    expect(
      buildSignBase({
        partnerId: '1',
        apiPath: '/api/v2/x',
        timestamp: 1_700_000_000,
        partnerKey: 'k',
      }),
    ).toBe('1/api/v2/x1700000000');

    expect(
      buildSignBase({
        partnerId: '1',
        apiPath: '/api/v2/x',
        timestamp: 1_700_000_000,
        accessToken: 'tok',
        shopId: 42,
        partnerKey: 'k',
      }),
    ).toBe('1/api/v2/x1700000000tok42');
  });
});

describe('clock skew guard', () => {
  it('accepts timestamps inside the 300s window', () => {
    expect(() => assertTimestampFresh(1_700_000_000, 1_700_000_000_000)).not.toThrow();
    expect(() => assertTimestampFresh(1_700_000_120, 1_700_000_000_000)).not.toThrow();
  });

  it('throws MarketplaceApiError(CLOCK_SKEW) beyond 300s', () => {
    let captured: unknown = null;
    try {
      assertTimestampFresh(1_700_000_301, 1_700_000_000_000);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(MarketplaceApiError);
    const apiError = captured as MarketplaceApiError;
    expect(apiError.marketplace).toBe('SHOPEE');
    expect(apiError.status).toBe(400);
    expect(apiError.message).toContain('CLOCK_SKEW');
    const payload = apiError.payload as Record<string, unknown>;
    expect(payload['skewSeconds']).toBe(301);
  });
});

describe('webhook signing', () => {
  const webhookUrl = 'https://sac.example.com/webhooks/shopee';
  const rawBody = Buffer.from(
    '{"code":4,"shop_id":123,"timestamp":1700000000,"data":{"message_id":"m1"}}',
    'utf8',
  );

  it('uses HMAC-SHA256(fullUrl + "|" + rawBody)', () => {
    expect(computeWebhookSign(webhookUrl, rawBody, 'partner-key-secret')).toBe(
      '451f158d97cd1b9781ae917521e56393ade14da17e82f17eb425f23e009b1851',
    );
  });

  it('is sensitive to scheme/host/query of the received URL', () => {
    const withQuery = `${webhookUrl}?attempt=1`;
    expect(computeWebhookSign(withQuery, rawBody, 'partner-key-secret')).not.toBe(
      computeWebhookSign(webhookUrl, rawBody, 'partner-key-secret'),
    );
  });

  it('compares signatures in constant time and rejects size mismatches', () => {
    const expected = computeWebhookSign(webhookUrl, rawBody, 'partner-key-secret');
    expect(safeEqualHex(expected, expected.toUpperCase())).toBe(true);
    expect(safeEqualHex(expected, expected.slice(0, -2))).toBe(false);
    expect(safeEqualHex(expected, '00'.repeat(32))).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
  });
});
