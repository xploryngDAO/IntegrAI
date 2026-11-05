import {
  MarketplaceApiError,
  type AdapterDependencies,
  type HttpRequestOptions,
  type HttpResponse,
  type ILogger,
} from '@sac/shared';
import { describeHttpFailure, errorMessage } from '../mappers';
import type { MeliAuth } from './MeliAuth';

/** Central Meli token bucket shared by every outbound HTTP call. */
const MELI_RATE_BUCKET = 'meli:api';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface MeliRequestOptions {
  query?: HttpRequestOptions['query'];
  body?: unknown;
  formData?: FormData;
  timeoutMs?: number;
}

/**
 * Thin authenticated HTTP client for `https://api.mercadolibre.com`.
 *
 * - every call is throttled through the `meli:api` token bucket;
 * - a 401 triggers exactly one forced refresh + retry (rotating tokens);
 * - 429/5xx become retryable `MarketplaceApiError`s, other 4xx include the
 *   marketplace payload and are not retryable.
 */
export class MeliClient {
  private readonly logger: ILogger;

  constructor(
    private readonly deps: AdapterDependencies,
    private readonly auth: MeliAuth,
  ) {
    this.logger = deps.logger.child({ adapter: 'mercadolivre', component: 'client' });
  }

  async get<T>(
    accountId: string,
    path: string,
    query?: HttpRequestOptions['query'],
  ): Promise<T> {
    return this.request<T>(accountId, 'GET', path, { query });
  }

  async post<T>(
    accountId: string,
    path: string,
    body?: unknown,
    query?: HttpRequestOptions['query'],
  ): Promise<T> {
    return this.request<T>(accountId, 'POST', path, { body, query });
  }

  async postMultipart<T>(
    accountId: string,
    path: string,
    formData: FormData,
    query?: HttpRequestOptions['query'],
  ): Promise<T> {
    return this.request<T>(accountId, 'POST', path, { formData, query });
  }

  private async request<T>(
    accountId: string,
    method: HttpRequestOptions['method'],
    path: string,
    options: MeliRequestOptions,
  ): Promise<T> {
    let token = await this.auth.getAccessToken(accountId);
    let response = await this.execute<T>(method, path, token, options);

    if (response.status === 401) {
      this.logger.warn('meli.http.unauthorized_retry', { accountId, method, path });
      await this.auth.invalidate(accountId);
      token = await this.auth.refreshAccessToken(accountId, { force: true, reason: 'http-401' });
      response = await this.execute<T>(method, path, token, options);
    }

    if (response.status >= 200 && response.status < 300) {
      return response.body;
    }

    const detail = describeHttpFailure(response.body);
    const retryable = response.status === 429 || response.status >= 500;
    throw new MarketplaceApiError(
      'MERCADO_LIVRE',
      response.status,
      `${method} ${path} -> HTTP ${response.status}: ${detail}`,
      response.body,
      retryable,
    );
  }

  private async execute<T>(
    method: HttpRequestOptions['method'],
    path: string,
    token: string,
    options: MeliRequestOptions,
  ): Promise<HttpResponse<T>> {
    await this.deps.rateLimiter.acquire(MELI_RATE_BUCKET);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (!options.formData && options.body !== undefined && typeof options.body !== 'string') {
      headers['Content-Type'] = 'application/json';
    }
    try {
      return await this.deps.http.request<T>({
        method,
        url: `${this.apiBase}${path.startsWith('/') ? path : `/${path}`}`,
        headers,
        query: options.query,
        body: options.body,
        formData: options.formData,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      throw new MarketplaceApiError(
        'MERCADO_LIVRE',
        0,
        `${method} ${path} falhou: ${errorMessage(error)}`,
        undefined,
        true,
      );
    }
  }

  private get apiBase(): string {
    return this.deps.config.meli.apiBase.replace(/\/+$/, '');
  }
}
