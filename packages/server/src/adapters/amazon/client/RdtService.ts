import {
  AMAZON_RDT_DATA_ELEMENTS,
  AMAZON_RDT_TTL_SECONDS,
  CACHE_KEYS,
  MarketplaceApiError,
  redactPiiForLogs,
} from '@sac/shared';
import type { AdapterDependencies, HttpResponse, ILogger } from '@sac/shared';
import { asRecord, readNumber, readString, sha256Hex } from '../guards';
import type { RdtTokenResponse } from '../types';
import type { LwaAuth } from './LwaAuth';

/**
 * Amazon Restricted Data Token (RDT) broker.
 *
 * An RDT is scoped to a single resource (`method + path + dataElements`), is
 * cached per path hash for 3000 s and MUST replace the LWA token in the
 * `x-amz-access-token` header of the restricted call.
 */
export class RdtService {
  private readonly deps: AdapterDependencies;
  private readonly lwa: LwaAuth;
  private readonly logger: ILogger;
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(deps: AdapterDependencies, lwa: LwaAuth) {
    this.deps = deps;
    this.lwa = lwa;
    this.logger = deps.logger.child({ component: 'amazon.rdt' });
  }

  /** `sha256(path)` is part of the cache key contract. */
  static pathHash(path: string): string {
    return sha256Hex(path);
  }

  async getRestrictedDataToken(
    accountId: string,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    dataElements: readonly string[] = AMAZON_RDT_DATA_ELEMENTS,
  ): Promise<string> {
    const cacheKey = CACHE_KEYS.amazonRdt(accountId, RdtService.pathHash(path));
    const cached = await this.deps.cache.get<string>(cacheKey);
    if (typeof cached === 'string' && cached.length > 0) return cached;

    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;

    const promise = this.requestToken(accountId, method, path, dataElements, cacheKey).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  async invalidate(accountId: string, path: string): Promise<void> {
    await this.deps.cache.del(CACHE_KEYS.amazonRdt(accountId, RdtService.pathHash(path)));
  }

  private async requestToken(
    accountId: string,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    dataElements: readonly string[],
    cacheKey: string,
  ): Promise<string> {
    await this.deps.rateLimiter.acquire('amazon:rdt');
    const accessToken = await this.lwa.getAccessToken(accountId);

    let response: HttpResponse<RdtTokenResponse>;
    try {
      response = await this.deps.http.request<RdtTokenResponse>({
        method: 'POST',
        url: this.deps.config.amazon.rdtEndpoint,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-amz-access-token': accessToken,
        },
        body: {
          restrictedResources: [
            {
              method,
              path,
              dataElements: [...dataElements],
            },
          ],
        },
        timeoutMs: 15_000,
        retries: 2,
      });
    } catch (error) {
      const message = error instanceof Error ? redactPiiForLogs(error.message) : 'erro de transporte';
      this.logger.error('amazon.rdt.transport_error', { accountId, path, error: message });
      throw new MarketplaceApiError(
        'AMAZON',
        0,
        'Falha de transporte ao obter Restricted Data Token',
        { error: message },
        true,
      );
    }

    if (!response.ok) {
      this.logger.warn('amazon.rdt.rejected', { accountId, path, status: response.status });
      throw new MarketplaceApiError(
        'AMAZON',
        response.status,
        `Falha ao obter Restricted Data Token (HTTP ${response.status})`,
        response.body,
        response.status === 429 || response.status >= 500,
      );
    }

    const body = asRecord(response.body);
    const token = readString(body.restrictedDataToken);
    if (!token) {
      throw new MarketplaceApiError(
        'AMAZON',
        502,
        'Resposta RDT sem restrictedDataToken',
        { fields: Object.keys(body) },
        false,
      );
    }

    const expiresIn = Math.max(60, Math.floor(readNumber(body.expiresIn) ?? 3_600));
    const ttl = Math.max(60, Math.min(AMAZON_RDT_TTL_SECONDS, expiresIn - 60));
    await this.deps.cache.set(cacheKey, token, ttl);
    this.logger.info('amazon.rdt.refreshed', { accountId, path, expiresIn, ttl });
    return token;
  }
}
