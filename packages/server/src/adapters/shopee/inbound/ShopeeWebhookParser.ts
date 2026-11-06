import {
  type AccountLookup,
  type AdapterDependencies,
  type ILogger,
  type RawHeaderValue,
  type RawWebhookRequest,
  type WebhookVerification,
} from '@sac/shared';
import { computeWebhookSign, safeEqualHex } from '../client/sign';
import { normalizeEventId, parseShopeePushBody, pickString } from '../mappers';
import type { ShopeePushPayload } from '../types';

/**
 * Shopee push webhook verification.
 *
 * Shopee signs the **full webhook URL + "|" + raw body** with the partner key
 * and sends the hex HMAC in the `Authorization` header. The comparison is
 * constant-time and the payload timestamp is rejected outside the tolerance
 * window (default 300 s) to block replay attacks.
 *
 * This stage is intentionally network-free except for the single account lookup
 * (required to route the event), keeping the webhook budget under 100 ms.
 */

const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export const SHOPEE_WEBHOOK_REASONS = {
  ok: 'OK',
  secretMissing: 'WEBHOOK_SECRET_NOT_CONFIGURED',
  invalidSignature: 'INVALID_SIGNATURE',
  missingSignature: 'AUTH_HEADER_MISSING',
  unparseable: 'PAYLOAD_UNPARSEABLE',
  timestampOutOfRange: 'TIMESTAMP_OUT_OF_RANGE',
  timestampMissing: 'TIMESTAMP_MISSING',
  shopIdMissing: 'SHOP_ID_MISSING',
  accountNotFound: 'ACCOUNT_NOT_FOUND',
} as const;

function readHeader(headers: Record<string, RawHeaderValue>, name: string): string | null {
  for (const [key, raw] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** Accepts the raw hex signature plus common prefixes/quotes. */
export function normalizeSignatureHeader(raw: string | null): string | null {
  if (!raw) return null;
  let value = raw.trim();
  value = value.replace(/^bearer\s+/i, '').replace(/^sha256=/i, '');
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  value = value.trim().toLowerCase();
  return value.length > 0 ? value : null;
}

export class ShopeeWebhookParser {
  private readonly deps: AdapterDependencies;
  private readonly logger: ILogger;

  constructor(deps: AdapterDependencies) {
    this.deps = deps;
    this.logger = deps.logger.child({ component: 'shopee.webhook' });
  }

  async verify(request: RawWebhookRequest): Promise<WebhookVerification> {
    const baseLookup: AccountLookup = { marketplace: 'SHOPEE' };
    const payload = parseShopeePushBody(request.rawBody.toString('utf8'));

    if (!payload) {
      this.logger.warn('Shopee webhook rejected: unparseable payload', {
        url: request.url,
        remoteIp: request.remoteIp ?? null,
      });
      return this.invalid(SHOPEE_WEBHOOK_REASONS.unparseable, baseLookup, {});
    }

    const normalizedPayload = toQueuePayload(payload);
    const topic = String(payload.code);
    const resource = resourceOf(payload);
    const eventId = normalizeEventId(payload.code, payload.data);
    const payloadShape = { ...normalizedPayload };

    const signature = normalizeSignatureHeader(readHeader(request.headers, 'authorization'));
    if (!signature) {
      this.logger.warn('Shopee webhook rejected: missing Authorization header', { topic });
      return this.invalid(
        SHOPEE_WEBHOOK_REASONS.missingSignature,
        baseLookup,
        payloadShape,
        eventId,
        topic,
        resource,
      );
    }

    const partnerKey = this.deps.config.shopee.partnerKey;
    if (partnerKey.trim().length === 0) {
      // An empty HMAC key is publicly derivable, so a "valid" signature over it
      // proves nothing. Reject instead of accepting forgeable webhooks (the
      // production config also refuses to boot without the partner key).
      this.logger.error('Shopee webhook rejected: partner key not configured', { topic, eventId });
      return this.invalid(
        SHOPEE_WEBHOOK_REASONS.secretMissing,
        baseLookup,
        payloadShape,
        eventId,
        topic,
        resource,
      );
    }
    const expected = computeWebhookSign(request.url, request.rawBody, partnerKey);
    if (!safeEqualHex(expected, signature)) {
      this.logger.warn('Shopee webhook rejected: signature mismatch', { topic, eventId });
      return this.invalid(
        SHOPEE_WEBHOOK_REASONS.invalidSignature,
        baseLookup,
        payloadShape,
        eventId,
        topic,
        resource,
      );
    }

    const nowSeconds = Math.floor(this.deps.clock.now().getTime() / 1000);
    if (payload.timestamp === null) {
      this.logger.warn('Shopee webhook rejected: missing timestamp', { topic, eventId });
      return this.invalid(
        SHOPEE_WEBHOOK_REASONS.timestampMissing,
        baseLookup,
        payloadShape,
        eventId,
        topic,
        resource,
      );
    }
    const tolerance = this.webhookToleranceSeconds();
    if (Math.abs(nowSeconds - payload.timestamp) > tolerance) {
      this.logger.warn('Shopee webhook rejected: timestamp out of range', {
        topic,
        eventId,
        skewSeconds: Math.abs(nowSeconds - payload.timestamp),
        toleranceSeconds: tolerance,
      });
      return this.invalid(
        SHOPEE_WEBHOOK_REASONS.timestampOutOfRange,
        baseLookup,
        payloadShape,
        eventId,
        topic,
        resource,
      );
    }

    if (payload.shop_id === null) {
      return this.invalid(
        SHOPEE_WEBHOOK_REASONS.shopIdMissing,
        baseLookup,
        payloadShape,
        eventId,
        topic,
        resource,
      );
    }

    const shopId = String(payload.shop_id);
    const account = await this.deps.repos.accounts.findByExternalSeller('SHOPEE', shopId);
    if (!account) {
      this.logger.warn('Shopee webhook rejected: no connected account for shop', {
        shopId,
        topic,
        eventId,
      });
      return this.invalid(
        SHOPEE_WEBHOOK_REASONS.accountNotFound,
        { marketplace: 'SHOPEE', externalSellerId: shopId },
        payloadShape,
        eventId,
        topic,
        resource,
      );
    }

    return {
      valid: true,
      reason: SHOPEE_WEBHOOK_REASONS.ok,
      eventId,
      topic,
      resource,
      accountLookup: {
        marketplace: 'SHOPEE',
        accountId: account.id,
        externalSellerId: shopId,
        marketplaceSiteId: account.marketplaceSiteId,
      },
      payload: payloadShape,
    };
  }

  private webhookToleranceSeconds(): number {
    const configured = this.deps.config.shopee.webhookToleranceSeconds;
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  }

  private invalid(
    reason: string,
    accountLookup: AccountLookup,
    payload: Record<string, unknown>,
    eventId: string | null = null,
    topic: string | null = null,
    resource: string | null = null,
  ): WebhookVerification {
    return {
      valid: false,
      reason,
      eventId,
      topic,
      resource,
      accountLookup,
      payload,
    };
  }
}

function toQueuePayload(payload: ShopeePushPayload): Record<string, unknown> {
  return {
    code: payload.code,
    shop_id: payload.shop_id,
    timestamp: payload.timestamp,
    data: payload.data,
  };
}

function resourceOf(payload: ShopeePushPayload): string | null {
  return pickString(payload.data, [
    'ordersn',
    'order_sn',
    'return_sn',
    'conversation_id',
    'item_id',
  ]);
}
