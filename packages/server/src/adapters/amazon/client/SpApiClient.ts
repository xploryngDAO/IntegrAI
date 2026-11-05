import { isAppError, MarketplaceApiError, redactPiiForLogs } from '@sac/shared';
import type { AdapterDependencies, HttpResponse, ILogger } from '@sac/shared';
import { asRecord, isRecord, readHeaderMap, readString, uniqueStrings } from '../guards';
import type {
  AmazonOrderItemJson,
  AmazonOrderJson,
  AmazonUploadDestination,
  JsonRecord,
} from '../types';
import type { LwaAuth } from './LwaAuth';
import type { RdtService } from './RdtService';

interface CallOptions {
  accountId: string;
  method: 'GET' | 'POST';
  path: string;
  operation: string;
  bucket: 'amazon:orders' | 'amazon:messaging' | 'amazon:rdt';
  body?: unknown;
  /** Sends the RDT in `x-amz-access-token` instead of the LWA token. */
  useRdt?: boolean;
  retries?: number;
  timeoutMs?: number;
}

/**
 * Thin, auditable wrapper around the SP-API HTTP surface used by the Amazon
 * adapter. Every call: rate-limited, authorized (LWA or RDT), and mapped to a
 * `MarketplaceApiError` with status/payload so workers can decide on retries.
 */
export class SpApiClient {
  private readonly deps: AdapterDependencies;
  private readonly lwa: LwaAuth;
  private readonly rdt: RdtService;
  private readonly logger: ILogger;

  constructor(deps: AdapterDependencies, lwa: LwaAuth, rdt: RdtService) {
    this.deps = deps;
    this.lwa = lwa;
    this.rdt = rdt;
    this.logger = deps.logger.child({ component: 'amazon.spapi' });
  }

  /** `GET /orders/v0/orders/{orderId}` — business data only (LWA, no RDT). */
  async getOrder(accountId: string, orderId: string): Promise<AmazonOrderJson> {
    const response = await this.call({
      accountId,
      method: 'GET',
      path: `/orders/v0/orders/${encodeURIComponent(orderId)}`,
      operation: 'getOrder',
      bucket: 'amazon:orders',
    });
    const body = asRecord(response.body);
    if (Object.keys(body).length === 0) {
      throw new MarketplaceApiError('AMAZON', 502, 'Resposta vazia de getOrder', null, false);
    }
    return body as AmazonOrderJson;
  }

  /** `GET /orders/v0/orders/{orderId}/orderItems` — items, LWA only. */
  async getOrderItems(accountId: string, orderId: string): Promise<AmazonOrderItemJson[]> {
    const response = await this.call({
      accountId,
      method: 'GET',
      path: `/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`,
      operation: 'getOrderItems',
      bucket: 'amazon:orders',
    });
    const body = asRecord(response.body);
    const items = body.OrderItems;
    if (!Array.isArray(items)) return [];
    return items.map((item) => asRecord(item) as AmazonOrderItemJson);
  }

  /**
   * `GET /orders/v0/orders/{orderId}` with `buyerInfo,shippingAddress` — the RDT
   * replaces the LWA token in `x-amz-access-token`. A 403 means the app is not
   * authorized for restricted data; the caller degrades with a warning.
   */
  async getOrderWithRestrictedData(accountId: string, orderId: string): Promise<AmazonOrderJson> {
    const path = `/orders/v0/orders/${encodeURIComponent(orderId)}`;
    try {
      const response = await this.call({
        accountId,
        method: 'GET',
        path,
        operation: 'getOrder(restricted)',
        bucket: 'amazon:orders',
        useRdt: true,
      });
      return asRecord(response.body) as AmazonOrderJson;
    } catch (error) {
      if (
        error instanceof MarketplaceApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        await this.rdt.invalidate(accountId, path);
      }
      throw error;
    }
  }

  /**
   * `GET /messaging/v1/orders/{amazonOrderId}?marketplaceIds=<id>` (operation
   * `getMessagingActionsForOrder`; there is no `/messagingActions` path).
   * Action names come from `_links.actions[].name` and are also mirrored in
   * `_embedded.actions[].payload.name`.
   */
  async getMessagingActions(
    accountId: string,
    orderId: string,
    marketplaceId: string,
  ): Promise<string[]> {
    const response = await this.call({
      accountId,
      method: 'GET',
      path: `/messaging/v1/orders/${encodeURIComponent(
        orderId,
      )}?marketplaceIds=${encodeURIComponent(marketplaceId)}`,
      operation: 'getMessagingActionsForOrder',
      bucket: 'amazon:messaging',
    });
    const body = asRecord(response.body);

    const links = asRecord(body._links);
    const linkActions = Array.isArray(links.actions) ? links.actions : [];
    const namesFromLinks = linkActions.map((entry) =>
      isRecord(entry) ? readString(entry.name) : null,
    );

    const embedded = asRecord(body._embedded);
    const embeddedActions = Array.isArray(embedded.actions) ? embedded.actions : [];
    const namesFromEmbedded = embeddedActions.map((entry) => {
      const record = asRecord(entry);
      return (
        readString(asRecord(record.payload).name) ??
        readString(record.name) ??
        readString(record.actionName)
      );
    });

    return uniqueStrings(
      [...namesFromEmbedded, ...namesFromLinks].filter(
        (name): name is string => name !== null,
      ),
    );
  }

  /**
   * `POST /uploads/2020-11-01/uploadDestinations/{resource}` where `{resource}`
   * is the FULL messaging action path, and `marketplaceIds` + `contentMD5` are
   * required QUERY parameters (contentMD5 is not a JSON body field).
   */
  async createMessagingUploadDestination(
    accountId: string,
    marketplaceId: string,
    orderId: string,
    actionName: string,
    contentMd5: string,
  ): Promise<AmazonUploadDestination> {
    const resource = `/messaging/v1/orders/${encodeURIComponent(
      orderId,
    )}/messages/${encodeURIComponent(actionName)}`;
    const query = `marketplaceIds=${encodeURIComponent(
      marketplaceId,
    )}&contentMD5=${encodeURIComponent(contentMd5)}`;
    const response = await this.call({
      accountId,
      method: 'POST',
      path: `/uploads/2020-11-01/uploadDestinations${resource}?${query}`,
      operation: 'createUploadDestinationForResource',
      bucket: 'amazon:messaging',
      retries: 0,
    });
    const body = asRecord(response.body);
    const payload = asRecord(body.payload);
    const uploadDestinationId =
      readString(payload.uploadDestinationId) ?? readString(body.uploadDestinationId);
    const url = readString(payload.url) ?? readString(body.url);
    if (!uploadDestinationId || !url) {
      throw new MarketplaceApiError(
        'AMAZON',
        502,
        'Resposta de uploadDestination sem uploadDestinationId/url',
        { fields: Object.keys(body) },
        false,
      );
    }
    return { uploadDestinationId, url, headers: readHeaderMap(payload.headers) };
  }

  /**
   * `POST /messaging/v1/orders/{amazonOrderId}/messages/{actionName}?marketplaceIds=<id>`
   * (1 req/s bucket). Amazon answers 201 with an empty body — there is no
   * `messageId`; the adapter generates its own external id.
   */
  async sendMessagingMessage(
    accountId: string,
    marketplaceId: string,
    orderId: string,
    actionName: string,
    body: Record<string, unknown>,
  ): Promise<string | null> {
    const response = await this.call({
      accountId,
      method: 'POST',
      path: `/messaging/v1/orders/${encodeURIComponent(
        orderId,
      )}/messages/${encodeURIComponent(actionName)}?marketplaceIds=${encodeURIComponent(
        marketplaceId,
      )}`,
      operation: 'sendMessagingMessage',
      bucket: 'amazon:messaging',
      body,
      // Sending is not idempotent: never let the HTTP client retry this POST.
      retries: 0,
    });
    const responseBody = asRecord(response.body);
    return (
      readString(responseBody.messageId) ??
      readString(asRecord(responseBody.payload).messageId)
    );
  }

  private async call(options: CallOptions): Promise<HttpResponse<JsonRecord>> {
    await this.deps.rateLimiter.acquire(options.bucket);

    let accessToken: string;
    if (options.useRdt) {
      accessToken = await this.rdt.getRestrictedDataToken(options.accountId, 'GET', options.path);
    } else {
      accessToken = await this.lwa.getAccessToken(options.accountId);
    }

    let response: HttpResponse<JsonRecord>;
    try {
      response = await this.deps.http.request<JsonRecord>({
        method: options.method,
        url: `${this.spApiEndpoint()}${options.path}`,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-amz-access-token': accessToken,
        },
        body: options.body,
        timeoutMs: options.timeoutMs ?? 30_000,
        retries: options.retries ?? 2,
      });
    } catch (error) {
      if (error instanceof MarketplaceApiError) throw error;
      if (isAppError(error)) {
        // HTTP transport failures are re-shaped as marketplace errors so the
        // worker retry policy treats every SP-API failure uniformly.
        if (error.code.startsWith('HTTP_') || error.code === 'HTTP_REQUEST_FAILED') {
          throw new MarketplaceApiError(
            'AMAZON',
            0,
            `${options.operation} falhou por erro de transporte`,
            { code: error.code },
            true,
          );
        }
        throw error;
      }
      const message = error instanceof Error ? redactPiiForLogs(error.message) : 'erro de transporte';
      this.logger.warn('amazon.spapi.transport_error', {
        operation: options.operation,
        accountId: options.accountId,
        error: message,
      });
      throw new MarketplaceApiError(
        'AMAZON',
        0,
        `${options.operation} falhou por erro de transporte`,
        { error: message },
        true,
      );
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      this.logger.warn('amazon.spapi.http_error', {
        operation: options.operation,
        accountId: options.accountId,
        status: response.status,
        retryable,
      });
      if (response.status === 401) await this.lwa.invalidate(options.accountId);
      throw new MarketplaceApiError(
        'AMAZON',
        response.status,
        `${options.operation} falhou com HTTP ${response.status}`,
        response.body,
        retryable,
      );
    }

    return response;
  }

  private spApiEndpoint(): string {
    return this.deps.config.amazon.spApiEndpoint.replace(/\/+$/, '');
  }
}
