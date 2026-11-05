import { createHmac, timingSafeEqual } from 'node:crypto';
import { MarketplaceApiError } from '@sac/shared';

/**
 * Shopee Open Platform v2 signing.
 *
 * Shopee signs the concatenation
 *   `partner_id + api_path + timestamp + access_token + shop_id`
 * with HMAC-SHA256 using the partner key and sends the lowercase hex digest as
 * the `sign` query parameter. `api_path` is the path only (no scheme/host, no
 * query string) and `timestamp` is unix **seconds**.
 *
 * Public endpoints (`/api/v2/auth/token/get`, `/api/v2/shop/auth_partner`)
 * omit `access_token` and `shop_id` - they are replaced by empty strings, which
 * is why the builder below always concatenates the optional segments.
 *
 * This module is deliberately pure (only node:crypto) so the exact byte
 * sequence can be locked down by a deterministic unit test.
 */

export interface ComputeSignInput {
  partnerId: number | string;
  apiPath: string;
  timestamp: number;
  accessToken?: string | null;
  shopId?: number | string | null;
  partnerKey: string;
}

export const CLOCK_SKEW_TOLERANCE_SECONDS = 300;

/** The exact HMAC message Shopee expects (exported for debugging/tests). */
export function buildSignBase(input: ComputeSignInput): string {
  return `${input.partnerId}${input.apiPath}${input.timestamp}${
    input.accessToken ?? ''
  }${input.shopId ?? ''}`;
}

/** `HMAC-SHA256(base, partnerKey)` as lowercase hex. */
export function computeSign(input: ComputeSignInput): string {
  return createHmac('sha256', input.partnerKey)
    .update(buildSignBase(input), 'utf8')
    .digest('hex')
    .toLowerCase();
}

/** Absolute difference, in seconds, between the official timestamp and now. */
export function clockSkewSeconds(timestamp: number, nowMs: number): number {
  return Math.abs(Math.floor(nowMs / 1000) - timestamp);
}

/**
 * Fails fast when a call would carry a timestamp outside Shopee's 5 minute
 * window (the API rejects it as `error_auth`/`invalid_timestamp`, which is
 * expensive because it can also flag the partner as abusive).
 */
export function assertTimestampFresh(
  timestamp: number,
  nowMs: number,
  toleranceSeconds = CLOCK_SKEW_TOLERANCE_SECONDS,
): void {
  if (!Number.isFinite(timestamp)) {
    throw new MarketplaceApiError(
      'SHOPEE',
      400,
      'CLOCK_SKEW',
      { timestamp, reason: 'NON_NUMERIC_TIMESTAMP' },
      false,
    );
  }
  const skew = clockSkewSeconds(timestamp, nowMs);
  if (skew > toleranceSeconds) {
    throw new MarketplaceApiError(
      'SHOPEE',
      400,
      'CLOCK_SKEW',
      {
        timestamp,
        nowSeconds: Math.floor(nowMs / 1000),
        skewSeconds: skew,
        toleranceSeconds,
      },
      false,
    );
  }
}

/**
 * Webhook signing: Shopee pushes are authenticated with
 * `HMAC-SHA256(webhookFullUrl + "|" + rawBody, partnerKey)`.
 *
 * `webhookFullUrl` MUST be the URL exactly as received (scheme, host, path and
 * query string) and `rawBody` the exact bytes - never a re-serialized JSON.
 */
export function computeWebhookSign(
  webhookFullUrl: string,
  rawBody: Buffer | string,
  partnerKey: string,
): string {
  const hmac = createHmac('sha256', partnerKey);
  hmac.update(webhookFullUrl, 'utf8');
  hmac.update('|', 'utf8');
  hmac.update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody);
  return hmac.digest('hex').toLowerCase();
}

/** Constant-time hex comparison with an explicit length check first. */
export function safeEqualHex(expectedHex: string, receivedHex: string): boolean {
  const expected = Buffer.from(expectedHex.toLowerCase(), 'utf8');
  const received = Buffer.from(receivedHex.toLowerCase(), 'utf8');
  if (expected.length === 0 || expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
