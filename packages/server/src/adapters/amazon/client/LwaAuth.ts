import {
  AMAZON_LWA_TTL_SECONDS,
  CACHE_KEYS,
  MarketplaceApiError,
  NotFoundError,
  TokenRefreshError,
  redactPiiForLogs,
} from '@sac/shared';
import type {
  AdapterDependencies,
  HttpResponse,
  ILogger,
  MarketplaceAccountRecord,
} from '@sac/shared';
import { asRecord, readNumber, readString } from '../guards';
import type { LwaTokenResponse } from '../types';

/**
 * Login with Amazon (LWA) token broker.
 *
 * - access token cached in Redis under `CACHE_KEYS.amazonLwaToken(accountId)`
 *   with the mandated 3300 s TTL;
 * - concurrent callers share a single in-flight refresh promise;
 * - `invalid_grant` flips the account to `TOKEN_EXPIRED` and notifies realtime.
 */
export class LwaAuth {
  private readonly deps: AdapterDependencies;
  private readonly logger: ILogger;
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(deps: AdapterDependencies) {
    this.deps = deps;
    this.logger = deps.logger.child({ component: 'amazon.lwa' });
  }

  async getAccessToken(accountId: string, options?: { forceRefresh?: boolean }): Promise<string> {
    const cacheKey = CACHE_KEYS.amazonLwaToken(accountId);
    if (!options?.forceRefresh) {
      const cached = await this.deps.cache.get<string>(cacheKey);
      if (typeof cached === 'string' && cached.length > 0) return cached;
    }

    const pending = this.inFlight.get(accountId);
    if (pending) return pending;

    const promise = this.refresh(accountId, cacheKey).finally(() => {
      this.inFlight.delete(accountId);
    });
    this.inFlight.set(accountId, promise);
    return promise;
  }

  async invalidate(accountId: string): Promise<void> {
    await this.deps.cache.del(CACHE_KEYS.amazonLwaToken(accountId));
  }

  /** Pre-warm helper used by `runMaintenance()`; returns the account on success. */
  async warm(account: MarketplaceAccountRecord): Promise<void> {
    await this.getAccessToken(account.id);
  }

  private async refresh(accountId: string, cacheKey: string): Promise<string> {
    const account = await this.deps.repos.accounts.findById(accountId);
    if (!account || account.marketplace !== 'AMAZON') {
      throw new NotFoundError('AmazonAccount', accountId);
    }
    if (!account.refreshTokenEnc) {
      throw new TokenRefreshError('AMAZON', 'Conta Amazon sem refresh token LWA configurado.', {
        accountId,
      });
    }

    let refreshToken: string;
    try {
      refreshToken = this.deps.cipher.decrypt(account.refreshTokenEnc);
    } catch (error) {
      const message = error instanceof Error ? redactPiiForLogs(error.message) : 'erro de criptografia';
      this.logger.error('amazon.lwa.decrypt_failed', { accountId, error: message });
      throw new TokenRefreshError('AMAZON', 'Falha ao descriptografar o refresh token LWA.', {
        accountId,
      });
    }
    const config = this.deps.config.amazon;
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.lwaClientId,
      client_secret: config.lwaClientSecret,
    }).toString();

    let response: HttpResponse<LwaTokenResponse>;
    try {
      // `body` is a pre-encoded form string: the HTTP client must forward it
      // verbatim (agreed with the infra contract) and must not JSON-encode it.
      response = await this.deps.http.request<LwaTokenResponse>({
        method: 'POST',
        url: config.lwaTokenUrl,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form,
        timeoutMs: 15_000,
        retries: 2,
      });
    } catch (error) {
      const message = error instanceof Error ? redactPiiForLogs(error.message) : 'erro de transporte';
      this.logger.error('amazon.lwa.transport_error', { accountId, error: message });
      throw new MarketplaceApiError(
        'AMAZON',
        0,
        'Falha de transporte ao renovar token LWA',
        { error: message },
        true,
      );
    }

    const body = asRecord(response.body);
    const errorCode = readString(body.error);

    if (!response.ok) {
      if (response.status === 400 && (errorCode === 'invalid_grant' || errorCode === 'invalid_client')) {
        await this.markTokenExpired(accountId, errorCode);
        throw new TokenRefreshError('AMAZON', `LWA recusou a renovação do token (${errorCode}).`, {
          accountId,
          status: response.status,
          error: errorCode,
        });
      }
      this.logger.warn('amazon.lwa.refresh_rejected', {
        accountId,
        status: response.status,
        error: errorCode,
      });
      throw new MarketplaceApiError(
        'AMAZON',
        response.status,
        'Falha ao renovar token LWA',
        body,
        response.status === 429 || response.status >= 500,
      );
    }

    const accessToken = readString(body.access_token);
    if (!accessToken) {
      throw new MarketplaceApiError(
        'AMAZON',
        502,
        'Resposta LWA sem access_token',
        { fields: Object.keys(body) },
        false,
      );
    }

    const expiresIn = Math.max(60, Math.floor(readNumber(body.expires_in) ?? 3_600));
    const ttl = Math.max(60, Math.min(AMAZON_LWA_TTL_SECONDS, expiresIn - 60));
    await this.deps.cache.set(cacheKey, accessToken, ttl);

    const now = this.deps.clock.now();
    try {
      await this.deps.repos.accounts.updateTokens(accountId, {
        accessTokenEnc: this.deps.cipher.encrypt(accessToken),
        tokenExpiresAt: new Date(now.getTime() + expiresIn * 1_000),
        lastTokenRefreshAt: now,
        status: 'ACTIVE',
        lastError: null,
        lastErrorAt: null,
      });
    } catch (error) {
      const message = error instanceof Error ? redactPiiForLogs(error.message) : 'erro desconhecido';
      this.logger.warn('amazon.lwa.account_update_failed', { accountId, error: message });
    }

    this.logger.info('amazon.lwa.refreshed', { accountId, expiresIn, ttl });
    return accessToken;
  }

  private async markTokenExpired(accountId: string, reason: string): Promise<void> {
    try {
      await this.deps.repos.accounts.setStatus(
        accountId,
        'TOKEN_EXPIRED',
        `LWA invalid_grant (${reason})`,
      );
    } catch (error) {
      const message = error instanceof Error ? redactPiiForLogs(error.message) : 'erro desconhecido';
      this.logger.error('amazon.lwa.status_update_failed', { accountId, error: message });
    }
    try {
      this.deps.realtime.channelHealth({
        marketplace: 'AMAZON',
        accountId,
        healthy: false,
        detail: 'LWA invalid_grant — reconecte a conta Amazon.',
        at: this.deps.clock.now().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? redactPiiForLogs(error.message) : 'erro desconhecido';
      this.logger.warn('amazon.lwa.health_emit_failed', { accountId, error: message });
    }
  }
}
