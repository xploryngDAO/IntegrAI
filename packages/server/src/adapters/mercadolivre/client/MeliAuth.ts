import {
  CACHE_KEYS,
  MELI_TOKEN_TTL_SECONDS,
  TokenRefreshError,
  type AdapterDependencies,
  type ILogger,
  type MarketplaceAccountRecord,
} from '@sac/shared';
import { asNumber, asString, describeHttpFailure, errorMessage, isRecord } from '../mappers';
import type { MeliTokenResponse } from '../types';

/** Central Meli token bucket (10 req/s per the architecture blueprint). */
const MELI_RATE_BUCKET = 'meli:api';
/** Refresh lock TTL: the OAuth round-trip must never outlive this. */
const REFRESH_LOCK_TTL_MS = 30_000;
/** Cache the access token 2 minutes before the marketplace expiry. */
const TOKEN_SAFETY_SECONDS = 120;
/** Treat a token expiring within 30s as unusable. */
const TOKEN_MIN_VALIDITY_MS = 30_000;

export interface RefreshOptions {
  force?: boolean;
  reason?: string;
}

/**
 * Mercado Livre OAuth token manager.
 *
 * Mercado Livre rotates refresh tokens: a refresh consumes the previous token,
 * so two concurrent workers must never refresh with the same pair. Refreshes are
 * therefore serialized with the Redlock key `lock:meli:refresh:<accountId>` and,
 * once inside the lock, the account row is re-read. When another worker already
 * persisted a newer pair we reuse it instead of burning the rotated token twice.
 */
export class MeliAuth {
  private readonly logger: ILogger;

  constructor(private readonly deps: AdapterDependencies) {
    this.logger = deps.logger.child({ adapter: 'mercadolivre', component: 'auth' });
  }

  /** Cached access token, or a locked refresh when the cache is cold. */
  async getAccessToken(accountId: string): Promise<string> {
    const cacheKey = CACHE_KEYS.meliToken(accountId);
    const cached = await this.deps.cache.get<string>(cacheKey);
    if (cached) return cached;
    return this.refreshAccessToken(accountId, { reason: 'cache-miss' });
  }

  /** Drops the cached access token (used before a forced 401 refresh). */
  async invalidate(accountId: string): Promise<void> {
    await this.deps.cache.del(CACHE_KEYS.meliToken(accountId));
  }

  /**
   * Refreshes the rotating token pair under the distributed lock. The account is
   * captured before the lock and re-read inside it to detect a concurrent
   * refresh; when that happened the persisted pair is reused.
   */
  async refreshAccessToken(accountId: string, options: RefreshOptions = {}): Promise<string> {
    const observed = await this.deps.repos.accounts.findById(accountId);
    if (!observed) {
      throw new TokenRefreshError('MERCADO_LIVRE', `Conta ${accountId} não encontrada`);
    }

    const lockKey = CACHE_KEYS.meliRefreshLock(accountId);
    return this.deps.lock.withLock([lockKey], REFRESH_LOCK_TTL_MS, async () => {
      const now = this.deps.clock.now();
      const account = await this.deps.repos.accounts.findById(accountId);
      if (!account) {
        throw new TokenRefreshError('MERCADO_LIVRE', `Conta ${accountId} não encontrada`);
      }

      const cacheKey = CACHE_KEYS.meliToken(accountId);
      const cached = await this.deps.cache.get<string>(cacheKey);
      const force = options.force === true;
      const rotatedElsewhere = this.refreshedAfter(observed, account);

      // Another worker refreshed while we waited for the lock: reuse its pair.
      if (rotatedElsewhere && this.tokenUsable(account, now)) {
        const reusable =
          cached ?? (account.accessTokenEnc ? this.deps.cipher.decrypt(account.accessTokenEnc) : null);
        if (reusable) {
          await this.cacheToken(accountId, reusable, account, now);
          this.logger.info('meli.token.reused_after_lock', {
            accountId,
            reason: options.reason ?? 'lock-wait',
          });
          return reusable;
        }
      }

      if (!force) {
        if (cached && this.tokenUsable(account, now)) return cached;
        if (this.tokenUsable(account, now) && account.accessTokenEnc) {
          const token = this.deps.cipher.decrypt(account.accessTokenEnc);
          await this.cacheToken(accountId, token, account, now);
          return token;
        }
      }

      return this.performRefresh(account, now, options.reason ?? 'scheduled');
    });
  }

  /** Network call + persistence; always called while holding the refresh lock. */
  private async performRefresh(
    account: MarketplaceAccountRecord,
    now: Date,
    reason: string,
  ): Promise<string> {
    try {
      const refreshToken = account.refreshTokenEnc
        ? this.deps.cipher.decrypt(account.refreshTokenEnc)
        : null;
      if (!refreshToken) {
        throw new Error('refresh token ausente na conta; reconecte a conta Mercado Livre');
      }

      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.deps.config.meli.clientId,
        client_secret: this.deps.config.meli.clientSecret,
        refresh_token: refreshToken,
      }).toString();

      await this.deps.rateLimiter.acquire(MELI_RATE_BUCKET);

      let response;
      try {
        response = await this.deps.http.request<unknown>({
          method: 'POST',
          url: `${this.apiBase}/oauth/token`,
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form,
          timeoutMs: 20_000,
        });
      } catch (error) {
        throw new Error(`falha de rede ao renovar token: ${errorMessage(error)}`);
      }

      if (!response.ok) {
        throw new Error(
          `oauth/token respondeu HTTP ${response.status}: ${describeHttpFailure(response.body)}`,
        );
      }

      const payload: MeliTokenResponse = isRecord(response.body) ? response.body : {};
      const accessToken = asString(payload.access_token);
      if (!accessToken) throw new Error('oauth/token não retornou access_token');

      const rotatedRefreshToken = asString(payload.refresh_token) ?? refreshToken;
      const expiresIn = asNumber(payload.expires_in) ?? MELI_TOKEN_TTL_SECONDS;
      const tokenExpiresAt = new Date(now.getTime() + Math.max(60, expiresIn) * 1000);

      await this.deps.repos.accounts.updateTokens(account.id, {
        accessTokenEnc: this.deps.cipher.encrypt(accessToken),
        refreshTokenEnc: this.deps.cipher.encrypt(rotatedRefreshToken),
        tokenExpiresAt,
        lastTokenRefreshAt: now,
        status: 'ACTIVE',
      });
      await this.deps.cache.set(
        CACHE_KEYS.meliToken(account.id),
        accessToken,
        this.ttlSeconds(expiresIn),
      );

      this.logger.info('meli.token.refreshed', {
        accountId: account.id,
        reason,
        expiresIn,
      });
      return accessToken;
    } catch (error) {
      const message = errorMessage(error);
      await this.markTokenFailure(account.id, message);
      throw new TokenRefreshError('MERCADO_LIVRE', `Falha ao renovar token: ${message}`, {
        accountId: account.id,
        reason,
      });
    }
  }

  private refreshedAfter(
    observed: MarketplaceAccountRecord,
    current: MarketplaceAccountRecord,
  ): boolean {
    const observedAt = observed.lastTokenRefreshAt?.getTime() ?? null;
    const currentAt = current.lastTokenRefreshAt?.getTime() ?? null;
    if (currentAt === null) return false;
    // `null -> timestamp` means the row was refreshed after we read it.
    if (observedAt === null) return true;
    return currentAt > observedAt;
  }

  private tokenUsable(account: MarketplaceAccountRecord, now: Date): boolean {
    if (!account.accessTokenEnc || !account.tokenExpiresAt) return false;
    return account.tokenExpiresAt.getTime() > now.getTime() + TOKEN_MIN_VALIDITY_MS;
  }

  private async cacheToken(
    accountId: string,
    token: string,
    account: MarketplaceAccountRecord,
    now: Date,
  ): Promise<void> {
    const expiresAt = account.tokenExpiresAt;
    const ttl = expiresAt
      ? Math.max(30, Math.floor((expiresAt.getTime() - now.getTime()) / 1000) - TOKEN_SAFETY_SECONDS)
      : MELI_TOKEN_TTL_SECONDS;
    await this.deps.cache.set(CACHE_KEYS.meliToken(accountId), token, ttl);
  }

  private ttlSeconds(expiresIn: number): number {
    return Math.max(30, Math.floor(expiresIn) - TOKEN_SAFETY_SECONDS);
  }

  /** Marks the account as TOKEN_EXPIRED and emits channel health (best effort). */
  private async markTokenFailure(accountId: string, message: string): Promise<void> {
    try {
      await this.deps.repos.accounts.setStatus(accountId, 'TOKEN_EXPIRED', message);
    } catch (error) {
      this.logger.error('meli.token.status_update_failed', {
        accountId,
        error: errorMessage(error),
      });
    }
    try {
      this.deps.realtime.channelHealth({
        marketplace: 'MERCADO_LIVRE',
        accountId,
        healthy: false,
        detail: message,
        at: this.deps.clock.now().toISOString(),
      });
    } catch (error) {
      this.logger.warn('meli.token.health_publish_failed', {
        accountId,
        error: errorMessage(error),
      });
    }
    this.logger.error('meli.token.refresh_failed', { accountId, error: message });
  }

  private get apiBase(): string {
    return this.deps.config.meli.apiBase.replace(/\/+$/, '');
  }
}
