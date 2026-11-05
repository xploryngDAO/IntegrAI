import {
  MarketplaceApiError,
  redactPiiForLogs,
  type AdapterDependencies,
  type ILogger,
} from '@sac/shared';
import type {
  ShopeeAccessToken,
  ShopeeApiEnvelope,
  ShopeeCallResult,
  ShopeeQueryValue,
  ShopeeRequestSpec,
  ShopeeTokenProvider,
} from '../types';
import { assertTimestampFresh, computeSign } from './sign';

/**
 * Low-level Shopee Open Platform v2 HTTP client.
 *
 * Responsibilities:
 *  - sign every call with `partner_id + api_path + timestamp + access_token + shop_id`;
 *  - enforce the 5 minute clock-skew window before spending a request;
 *  - throttle through `deps.rateLimiter.acquire('shopee:api')`;
 *  - map HTTP 429/5xx and Shopee business `error` codes to `MarketplaceApiError`
 *    (retryable when the marketplace says so) with `request_id` in the details;
 *  - transparently rotate the access token once when Shopee rejects it.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/** Shopee codes that mean "this access token is no longer usable". */
const INVALID_ACCESS_TOKEN_CODES = new Set([
  'invalid_acceess_token', // Shopee's historical typo, still returned in production
  'invalid_access_token',
  'invalid_token',
  'token_expired',
  'access_token_expired',
  // Shopee also reports a rejected/expired token as a generic auth error.
  'error_auth',
]);

/** Shopee codes worth retrying with backoff. */
const RETRYABLE_ERROR_CODES = new Set([
  'error_server',
  'error_internal',
  'error_rate_limit',
  'rate_limit',
  'system_error',
  'error_timeout',
  'try_again',
  'error_network',
]);

export interface ShopeePublicRequestSpec {
  apiPath: string;
  method?: ShopeeRequestSpec['method'];
  body?: Record<string, unknown>;
  extraQuery?: ShopeeRequestSpec['extraQuery'];
  formData?: FormData;
  timestamp?: number;
  timeoutMs?: number;
  /** Per-store partner override (defaults to `config.shopee.partnerId`). */
  partnerId?: string;
  /** Per-store partner key override (defaults to `config.shopee.partnerKey`). */
  partnerKey?: string;
}

export interface ShopeePrivateRequestSpec extends ShopeePublicRequestSpec {
  accountId: string;
  /** Partner-scoped endpoints (lost push) do not carry `shop_id`. */
  includeShopId?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function pickString(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** Extracts the Shopee business error code from a mapped error, when present. */
export function shopeeErrorCode(error: unknown): string | null {
  if (!(error instanceof MarketplaceApiError)) return null;
  const payload = asRecord(error.payload);
  const fromPayload = pickString(payload, ['error', 'error_code', 'code']);
  if (fromPayload) return fromPayload;
  const details = error.details;
  if (details) {
    const fromDetails = details['error'];
    if (typeof fromDetails === 'string' && fromDetails.length > 0) return fromDetails;
  }
  return null;
}

export function isInvalidAccessTokenError(error: unknown): boolean {
  const code = shopeeErrorCode(error);
  return code !== null && INVALID_ACCESS_TOKEN_CODES.has(code);
}

export function isRetryableShopeeErrorCode(code: string | null): boolean {
  return code !== null && RETRYABLE_ERROR_CODES.has(code);
}

export class ShopeeClient {  private readonly deps: AdapterDependencies;
  private readonly logger: ILogger;
  private tokenProvider: ShopeeTokenProvider | null = null;

  constructor(deps: AdapterDependencies) {
    this.deps = deps;
    this.logger = deps.logger.child({ component: 'shopee.client' });
  }

  /** Wired by the auth module after construction to avoid a circular import. */
  attachTokenProvider(provider: ShopeeTokenProvider): void {
    this.tokenProvider = provider;
  }

  get apiBase(): string {
    return this.deps.config.shopee.apiBase.replace(/\/+$/, '');
  }

  get defaultPartnerId(): string {
    return String(this.deps.config.shopee.partnerId);
  }

  get defaultPartnerKey(): string {
    return this.deps.config.shopee.partnerKey;
  }

  /** Public endpoint: signature over partner id + api path + timestamp only. */
  async publicRequest<TResponse = Record<string, unknown>>(
    spec: ShopeePublicRequestSpec,
  ): Promise<ShopeeCallResult<TResponse>> {
    return this.execute<TResponse>({ ...spec, publicCall: true }, null);
  }

  /** Private endpoint: signature also covers access token (and shop id). */
  async request<TResponse = Record<string, unknown>>(
    spec: ShopeePrivateRequestSpec,
  ): Promise<ShopeeCallResult<TResponse>> {
    const provider = this.requireTokenProvider();
    const credentials = await provider.getCredentials(spec.accountId);
    try {
      return await this.execute<TResponse>({ ...spec, publicCall: false }, credentials);
    } catch (error) {
      if (error instanceof MarketplaceApiError && isInvalidAccessTokenError(error)) {
        this.logger.warn('Shopee access token rejected by the API; forcing refresh', {
          accountId: spec.accountId,
          apiPath: spec.apiPath,
          requestId: this.requestIdOf(error),
        });
        const refreshed = await provider.forceRefresh(spec.accountId);
        return this.execute<TResponse>({ ...spec, publicCall: false }, refreshed);
      }
      throw error;
    }
  }

  private requireTokenProvider(): ShopeeTokenProvider {
    if (!this.tokenProvider) {
      throw new MarketplaceApiError(
        'SHOPEE',
        500,
        'TOKEN_PROVIDER_MISSING',
        { reason: 'ShopeeClient.attachTokenProvider was not called' },
        false,
      );
    }
    return this.tokenProvider;
  }

  private requestIdOf(error: MarketplaceApiError): string | null {
    const payload = asRecord(error.payload);
    return pickString(payload, ['request_id', 'requestId']);
  }

  private async execute<TResponse>(
    spec: ShopeeRequestSpec & { accountId?: string },
    credentials: ShopeeAccessToken | null,
  ): Promise<ShopeeCallResult<TResponse>> {
    const apiPath = spec.apiPath.startsWith('/') ? spec.apiPath : `/${spec.apiPath}`;
    const nowMs = this.deps.clock.now().getTime();
    const timestamp = spec.timestamp ?? Math.floor(nowMs / 1000);

    try {
      assertTimestampFresh(timestamp, nowMs);
    } catch (error) {
      this.logger.error('Shopee clock skew guard blocked the call', {
        apiPath,
        timestamp,
        nowSeconds: Math.floor(nowMs / 1000),
      });
      throw error;
    }

    const publicCall = spec.publicCall === true;
    const includeShopId = spec.includeShopId !== false;
    const partnerId = spec.partnerId ?? credentials?.partnerId ?? this.defaultPartnerId;
    const partnerKey = spec.partnerKey ?? credentials?.partnerKey ?? this.defaultPartnerKey;
    if (partnerKey.trim().length === 0) {
      throw new MarketplaceApiError(
        'SHOPEE',
        500,
        'PARTNER_KEY_MISSING',
        { apiPath, partnerId },
        false,
      );
    }
    if (!publicCall && !credentials) {
      throw new MarketplaceApiError(
        'SHOPEE',
        401,
        'ACCOUNT_CREDENTIALS_MISSING',
        { apiPath, accountId: spec.accountId ?? null },
        false,
      );
    }

    const accessToken = publicCall ? undefined : credentials?.accessToken;
    const shopId = publicCall || !includeShopId ? undefined : credentials?.shopId;
    const sign = computeSign({ partnerId, apiPath, timestamp, accessToken, shopId, partnerKey });

    // Shopee GET array params use repeated keys (`item_id_list=1&item_id_list=2`);
    // the generic HttpRequestOptions.query only carries scalars, so arrays are
    // baked into the URL while the signed params stay in the query object.
    const { url: callUrl, scalarQuery } = splitExtraQuery(
      `${this.apiBase}${apiPath}`,
      spec.extraQuery,
    );
    const query: Record<string, string | number | boolean | undefined | null> = {
      partner_id: partnerId,
      timestamp,
      ...(accessToken ? { access_token: accessToken } : {}),
      ...(shopId ? { shop_id: shopId } : {}),
      sign,
      ...scalarQuery,
    };

    await this.deps.rateLimiter.acquire('shopee:api');

    const response = await this.deps.http.request<ShopeeApiEnvelope<TResponse>>({
      method: spec.method ?? 'POST',
      url: callUrl,
      query,
      body: spec.formData ? undefined : spec.body,
      formData: spec.formData,
      timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    const envelope = (asRecord(response.body) as ShopeeApiEnvelope<TResponse> | null) ?? {};
    const requestId = pickString(envelope, ['request_id', 'requestId']) ?? response.requestId ?? null;
    const errorCode = pickString(envelope, ['error', 'error_code']);
    const errorMessage = pickString(envelope, ['message', 'msg']) ?? 'Shopee API error';

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw this.buildError(
        response.status,
        errorCode,
        errorMessage,
        requestId,
        envelope,
        retryable,
        apiPath,
      );
    }

    if (errorCode) {
      const retryable = isRetryableShopeeErrorCode(errorCode);
      const status = retryable ? 502 : 400;
      throw this.buildError(
        status,
        errorCode,
        errorMessage,
        requestId,
        envelope,
        retryable,
        apiPath,
      );
    }

    const unwrapped =
      envelope.response !== undefined && envelope.response !== null
        ? envelope.response
        : (envelope as unknown as TResponse);

    return {
      data: unwrapped,
      envelope: envelope as ShopeeApiEnvelope<unknown>,
      requestId,
      status: response.status,
      headers: response.headers,
    };
  }

  private buildError(
    status: number,
    errorCode: string | null,
    message: string,
    requestId: string | null,
    envelope: ShopeeApiEnvelope<unknown>,
    retryable: boolean,
    apiPath: string,
  ): MarketplaceApiError {
    const detail = `${errorCode ?? 'ERROR'}: ${message}`;
    this.logger.warn('Shopee API call failed', {
      apiPath,
      status,
      errorCode,
      requestId,
      retryable,
      message: redactPiiForLogs(detail),
    });

    const error = new MarketplaceApiError(
      'SHOPEE',
      status,
      detail,
      {
        request_id: requestId,
        error: errorCode,
        message,
        apiPath,
        response: envelope.response ?? null,
      },
      retryable,
    );

    // `request_id` must be present in `details` for every mapped failure so the
    // DLQ/worker triage can hand it back to Shopee support.
    const details = error.details;
    if (details) {
      details['request_id'] = requestId;
      details['error'] = errorCode;
      details['apiPath'] = apiPath;
    }
    return error;
  }
}

/**
 * Splits `extraQuery` into repeated URL params (arrays, e.g. `item_id_list`) and
 * scalar params that can travel through `HttpRequestOptions.query`.
 */
function splitExtraQuery(
  baseUrl: string,
  extraQuery: Record<string, ShopeeQueryValue> | undefined,
): { url: string; scalarQuery: Record<string, string | number | boolean | undefined | null> } {
  const scalarQuery: Record<string, string | number | boolean | undefined | null> = {};
  if (!extraQuery) return { url: baseUrl, scalarQuery };

  const arrays: Array<[string, string[]]> = [];
  for (const [key, value] of Object.entries(extraQuery)) {
    if (Array.isArray(value)) {
      arrays.push([key, value.map((item) => String(item))]);
    } else {
      scalarQuery[key] = value;
    }
  }
  if (arrays.length === 0) return { url: baseUrl, scalarQuery };

  const search = new URLSearchParams();
  for (const [key, values] of arrays) {
    for (const value of values) search.append(key, value);
  }
  const separator = baseUrl.includes('?') ? '&' : '?';
  return { url: `${baseUrl}${separator}${search.toString()}`, scalarQuery };
}
