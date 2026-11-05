import {
  CACHE_KEYS,
  MarketplaceApiError,
  NotFoundError,
  SHOPEE_REFRESH_INTERVAL_SECONDS,
  SHOPEE_TOKEN_TTL_SECONDS,
  TokenRefreshError,
  ValidationError,
  redactPiiForLogs,
  type AccountTokenPatch,
  type AdapterDependencies,
  type ILogger,
  type MarketplaceAccountRecord,
} from '@sac/shared';
import { ShopeeClient, shopeeErrorCode } from './ShopeeClient';
import { computeSign } from './sign';
import {
  SHOPEE_API_PATHS,
  type ShopeeAccessToken,
  type ShopeeCallResult,
  type ShopeeTokenSet,
} from '../types';
import { asRecord, pickNumber, pickString, toShopeeId } from '../mappers';

/**
 * Shopee authentication.
 *
 * The refresh token is **single-use**: Shopee rotates it on every
 * `/api/v2/auth/token/get` call and immediately invalidates the previous value.
 * Losing a race here permanently disconnects the store, so every refresh runs
 * inside a Redlock (`CACHE_KEYS.shopeeRefreshLock`), re-reads the account inside
 * the lock, reuses a token another worker just rotated and only then rotates.
 */

const REFRESH_LOCK_TTL_MS = 60_000;

/** Loads and validates a connected Shopee account (shared by every collaborator). */
export async function loadShopeeAccount(
  deps: AdapterDependencies,
  accountId: string,
): Promise<MarketplaceAccountRecord> {
  const account = await deps.repos.accounts.findById(accountId);
  if (!account) throw new NotFoundError('MarketplaceAccount', accountId);
  if (account.marketplace !== 'SHOPEE') {
    throw new ValidationError(
      `Account ${accountId} belongs to ${account.marketplace}; Shopee adapter cannot use it`,
      { accountId, marketplace: account.marketplace },
    );
  }
  return account;
}

/** shop_id used in signatures/requests: `channel_config.shop_id` wins. */
export function shopIdOf(account: MarketplaceAccountRecord): string {
  const configured = pickString(account.channelConfig, ['shop_id', 'shopId']);
  return configured ?? account.externalSellerId;
}

function partnerIdOf(
  deps: AdapterDependencies,
  account: MarketplaceAccountRecord | null | undefined,
): string {
  const configured = account ? pickNumber(account.channelConfig, ['partner_id', 'partnerId']) : null;
  return String(configured ?? deps.config.shopee.partnerId);
}

function partnerKeyOf(
  deps: AdapterDependencies,
  account: MarketplaceAccountRecord | null | undefined,
): string {
  const config = account?.channelConfig ?? null;
  const encrypted = config ? pickString(config, ['partner_key_enc', 'partnerKeyEnc']) : null;
  if (encrypted) return deps.cipher.decrypt(encrypted);
  const plain = config ? pickString(config, ['partner_key', 'partnerKey']) : null;
  return plain ?? deps.config.shopee.partnerKey;
}

export interface ShopeeAuthOptions {
  /**
   * Bypass the refresh gate reuse shortcut (still lock-protected and still
   * reuses a token rotated by another worker meanwhile).
   */
  force?: boolean;
}

export interface ShopeeAuthorizationCodeInput {
  code: string;
  shopId: string | number;
  partnerId: string | number;
}

/** Exactly the shape the core `AccountService` consumes. */
export interface ShopeeAuthorizationCodeExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export class ShopeeAuth {
  private readonly deps: AdapterDependencies;
  private readonly client: ShopeeClient;
  private readonly logger: ILogger;

  constructor(deps: AdapterDependencies, client: ShopeeClient) {
    this.deps = deps;
    this.client = client;
    this.logger = deps.logger.child({ component: 'shopee.auth' });
  }

  /** Store authorization hand-off URL built from the runtime config. */
  buildAuthorizeUrl(redirectUri?: string): string {
    const redirect = redirectUri ?? this.deps.config.shopee.redirectUri;
    return buildShopeeAuthorizeUrl(
      this.deps.config.shopee.partnerId,
      this.deps.config.shopee.partnerKey,
      redirect,
      this.deps.config.shopee.apiBase,
    );
  }

  /** Cached credentials, transparently refreshed when expired. */
  async getCredentials(accountId: string): Promise<ShopeeAccessToken> {
    const account = await loadShopeeAccount(this.deps, accountId);
    if (account.status === 'DISCONNECTED') {
      throw new MarketplaceApiError(
        'SHOPEE',
        400,
        'ACCOUNT_DISCONNECTED',
        { accountId },
        false,
      );
    }

    const tokenKey = CACHE_KEYS.shopeeToken(accountId);
    const cached = await this.deps.cache.get<string>(tokenKey);
    if (cached && cached.trim().length > 0) {
      return this.credentialsOf(account, cached);
    }

    const persisted = this.tryDecrypt(account.accessTokenEnc);
    const nowMs = this.deps.clock.now().getTime();
    const expiresAtMs = account.tokenExpiresAt ? account.tokenExpiresAt.getTime() : null;
    if (persisted && expiresAtMs !== null && expiresAtMs > nowMs + 60_000) {
      const ttl = Math.max(60, Math.floor((expiresAtMs - nowMs) / 1000) - 120);
      await this.deps.cache.set(tokenKey, persisted, ttl);
      return this.credentialsOf(account, persisted);
    }

    return this.refreshAccessToken(account);
  }

  /** Called by the client after Shopee rejects an access token. */
  async forceRefreshCredentials(accountId: string): Promise<ShopeeAccessToken> {
    const account = await loadShopeeAccount(this.deps, accountId);
    return this.refreshAccessToken(account, { force: true });
  }

  /**
   * Rotates the single-use refresh token.
   *
   * Sequence (all inside the distributed lock):
   *  1. re-read the account;
   *  2. if another worker rotated after our snapshot, reuse its access token;
   *  3. honour the `shopeeRefreshGate` interval guard;
   *  4. exchange, persist BOTH encrypted tokens, cache the access token.
   */
  async refreshAccessToken(
    account: MarketplaceAccountRecord,
    options: ShopeeAuthOptions = {},
  ): Promise<ShopeeAccessToken> {
    return this.deps.lock.withLock(
      [CACHE_KEYS.shopeeRefreshLock(account.id)],
      REFRESH_LOCK_TTL_MS,
      async () => {
        const fresh = await loadShopeeAccount(this.deps, account.id);
        const startedAtMs = account.lastTokenRefreshAt?.getTime() ?? null;
        const freshAtMs = fresh.lastTokenRefreshAt?.getTime() ?? null;

        if (freshAtMs !== null && (startedAtMs === null || freshAtMs > startedAtMs)) {
          const reused = await this.reuseValidToken(fresh);
          if (reused) {
            this.logger.info('Shopee token already rotated by another worker; reusing it', {
              accountId: fresh.id,
              lastTokenRefreshAt: fresh.lastTokenRefreshAt?.toISOString() ?? null,
            });
            return reused;
          }
        }

        const gateKey = CACHE_KEYS.shopeeRefreshGate(fresh.id);
        const gateValue = this.deps.clock.now().toISOString();
        const refreshInterval = this.refreshIntervalSeconds();
        const gateAcquired = await this.deps.cache.setNx(gateKey, gateValue, refreshInterval);
        if (!gateAcquired && !options.force) {
          const reused = await this.reuseValidToken(fresh);
          if (reused) {
            this.logger.debug('Shopee refresh skipped: gate from a previous run is still open', {
              accountId: fresh.id,
            });
            return reused;
          }
          this.logger.warn('Shopee refresh gate is open but no valid access token is available; rotating', {
            accountId: fresh.id,
          });
        }

        return this.performRefresh(fresh, gateKey);
      },
    );
  }

  /** Authorization-code exchange used by the account onboarding flow. */
  async exchangeCode(input: ShopeeAuthorizationCodeInput): Promise<ShopeeTokenSet> {
    const shopId = String(input.shopId);
    const partnerId = String(input.partnerId);
    const result = await this.client.publicRequest<Record<string, unknown>>({
      apiPath: SHOPEE_API_PATHS.tokenGet,
      method: 'POST',
      body: {
        code: input.code,
        shop_id: toShopeeId(shopId),
        partner_id: toShopeeId(partnerId),
      },
      partnerId,
      partnerKey: this.deps.config.shopee.partnerKey,
    });
    return this.parseTokenResult(result);
  }

  private refreshIntervalSeconds(): number {
    const configured = this.deps.config.shopee.refreshIntervalSeconds;
    return configured > 0 ? configured : SHOPEE_REFRESH_INTERVAL_SECONDS;
  }

  private async performRefresh(
    account: MarketplaceAccountRecord,
    gateKey: string,
  ): Promise<ShopeeAccessToken> {
    const refreshToken = this.tryDecrypt(account.refreshTokenEnc);
    if (!refreshToken) {
      await this.markTokenExpired(account.id, 'refresh token ausente/indecifrável');
      throw new TokenRefreshError('SHOPEE', 'refresh token ausente ou indecifrável', {
        accountId: account.id,
      });
    }

    const shopId = shopIdOf(account);
    const partnerId = partnerIdOf(this.deps, account);
    const partnerKey = partnerKeyOf(this.deps, account);

    try {
      const result = await this.client.publicRequest<Record<string, unknown>>({
        apiPath: SHOPEE_API_PATHS.tokenGet,
        method: 'POST',
        body: {
          refresh_token: refreshToken,
          shop_id: toShopeeId(shopId),
          partner_id: toShopeeId(partnerId),
        },
        partnerId,
        partnerKey,
        // token exchange must fail fast on skew: no retrying with a stale clock
        timestamp: Math.floor(this.deps.clock.now().getTime() / 1000),
      });
      const tokenSet = this.parseTokenResult(result);
      return await this.persistTokenSet(account, tokenSet, gateKey);
    } catch (error) {
      await this.handleRefreshFailure(account, gateKey, error);
      throw error;
    }
  }

  private async persistTokenSet(
    account: MarketplaceAccountRecord,
    tokenSet: ShopeeTokenSet,
    gateKey: string,
  ): Promise<ShopeeAccessToken> {
    const now = this.deps.clock.now();
    const tokenExpiresAt = new Date(now.getTime() + tokenSet.expiresIn * 1000);
    const patch: AccountTokenPatch = {
      accessTokenEnc: this.deps.cipher.encrypt(tokenSet.accessToken),
      refreshTokenEnc: this.deps.cipher.encrypt(tokenSet.refreshToken),
      tokenExpiresAt,
      lastTokenRefreshAt: now,
      status: 'ACTIVE',
      lastError: null,
      lastErrorAt: null,
    };
    if (tokenSet.authExpiresIn !== null) {
      patch.authExpiresAt = new Date(now.getTime() + tokenSet.authExpiresIn * 1000);
    }

    const updated = await this.persistTokensWithRetry(account.id, patch);
    const ttlSeconds = Math.max(60, Math.floor(tokenSet.expiresIn) - 120);
    await this.deps.cache.set(
      CACHE_KEYS.shopeeToken(account.id),
      tokenSet.accessToken,
      ttlSeconds,
    );
    // Reset the gate TTL to a full interval after a successful rotation.
    await this.deps.cache.set(gateKey, now.toISOString(), this.refreshIntervalSeconds());

    this.deps.realtime.channelHealth({
      marketplace: 'SHOPEE',
      accountId: account.id,
      healthy: true,
      detail: `Token renovado (expira em ${Math.round(tokenSet.expiresIn / 60)} min)`,
      at: now.toISOString(),
    });
    this.logger.info('Shopee access token rotated', {
      accountId: account.id,
      requestId: tokenSet.requestId,
      expiresInSeconds: tokenSet.expiresIn,
    });

    return this.credentialsOf(updated, tokenSet.accessToken);
  }

  /**
   * Persisting the rotated pair is the most dangerous step: once Shopee answered
   * the single-use refresh token is already burned, so a DB failure here means
   * the store must be reconnected. Retry once before declaring the account
   * TOKEN_EXPIRED (never pretend the rotation succeeded).
   */
  private async persistTokensWithRetry(
    accountId: string,
    patch: AccountTokenPatch,
  ): Promise<MarketplaceAccountRecord> {
    try {
      return await this.deps.repos.accounts.updateTokens(accountId, patch);
    } catch (firstError) {
      this.logger.warn('Shopee token persistence failed; retrying once', {
        accountId,
        error: redactPiiForLogs(firstError instanceof Error ? firstError.message : String(firstError)),
      });
      try {
        return await this.deps.repos.accounts.updateTokens(accountId, patch);
      } catch (secondError) {
        await this.markTokenExpired(accountId, 'falha ao persistir tokens rotacionados');
        throw new TokenRefreshError(
          'SHOPEE',
          'tokens rotacionados não puderam ser persistidos; reconecte a loja',
          {
            accountId,
            error:
              secondError instanceof Error
                ? redactPiiForLogs(secondError.message)
                : String(secondError),
          },
        );
      }
    }
  }

  private async handleRefreshFailure(
    account: MarketplaceAccountRecord,
    gateKey: string,
    error: unknown,
  ): Promise<void> {
    const now = this.deps.clock.now();
    const errorCode = shopeeErrorCode(error);
    const invalidRefreshToken = errorCode === 'invalid_refresh_token';
    const message = error instanceof Error ? error.message : String(error);

    await this.safeDelete(gateKey);
    await this.safeDelete(CACHE_KEYS.shopeeToken(account.id));

    if (invalidRefreshToken) {
      await this.markTokenExpired(account.id, 'invalid_refresh_token');
      throw new TokenRefreshError(
        'SHOPEE',
        'invalid_refresh_token: a loja precisa reconectar o aplicativo Shopee',
        {
          accountId: account.id,
          request_id: this.requestIdFrom(error),
          error: errorCode,
        },
      );
    }

    await this.deps.repos.accounts
      .updateTokens(account.id, {
        lastError: redactPiiForLogs(message).slice(0, 500),
        lastErrorAt: now,
      })
      .catch(() => undefined);

    this.deps.realtime.channelHealth({
      marketplace: 'SHOPEE',
      accountId: account.id,
      healthy: false,
      detail: `Falha ao renovar token: ${errorCode ?? 'erro desconhecido'}`,
      at: now.toISOString(),
    });
    this.logger.error('Shopee token refresh failed', {
      accountId: account.id,
      errorCode,
      requestId: this.requestIdFrom(error),
      retryable: error instanceof MarketplaceApiError ? error.retryable : false,
    });
  }

  private async markTokenExpired(accountId: string, reason: string): Promise<void> {
    await this.deps.repos.accounts.setStatus(accountId, 'TOKEN_EXPIRED', reason).catch(() => undefined);
    this.deps.realtime.channelHealth({
      marketplace: 'SHOPEE',
      accountId,
      healthy: false,
      detail: reason,
      at: this.deps.clock.now().toISOString(),
    });
  }

  /** Reuse a token another worker already rotated (cache first, then DB). */
  private async reuseValidToken(account: MarketplaceAccountRecord): Promise<ShopeeAccessToken | null> {
    const tokenKey = CACHE_KEYS.shopeeToken(account.id);
    const cached = await this.deps.cache.get<string>(tokenKey);
    if (cached && cached.trim().length > 0) {
      return this.credentialsOf(account, cached);
    }
    const persisted = this.tryDecrypt(account.accessTokenEnc);
    const nowMs = this.deps.clock.now().getTime();
    const expiresAtMs = account.tokenExpiresAt ? account.tokenExpiresAt.getTime() : null;
    if (persisted && expiresAtMs !== null && expiresAtMs > nowMs + 60_000) {
      const ttl = Math.max(60, Math.floor((expiresAtMs - nowMs) / 1000) - 120);
      await this.deps.cache.set(tokenKey, persisted, ttl);
      return this.credentialsOf(account, persisted);
    }
    return null;
  }

  private credentialsOf(
    account: MarketplaceAccountRecord,
    accessToken: string,
  ): ShopeeAccessToken {
    return {
      accountId: account.id,
      shopId: shopIdOf(account),
      partnerId: partnerIdOf(this.deps, account),
      partnerKey: partnerKeyOf(this.deps, account),
      accessToken,
    };
  }

  private parseTokenResult(result: ShopeeCallResult<Record<string, unknown>>): ShopeeTokenSet {
    const data = asRecord(result.data) ?? {};
    const nested = asRecord(data['response']) ?? {};
    const readString = (keys: readonly string[]): string | null =>
      pickString(nested, keys) ?? pickString(data, keys);
    const readNumber = (keys: readonly string[]): number | null =>
      pickNumber(nested, keys) ?? pickNumber(data, keys);

    const accessToken = readString(['access_token', 'accessToken']);
    if (!accessToken) {
      throw new TokenRefreshError('SHOPEE', 'resposta de token sem access_token', {
        request_id: result.requestId,
      });
    }
    // Single-use: the response MUST carry the rotated refresh token. Persisting
    // the previous one would guarantee the next refresh fails.
    const refreshToken = readString(['refresh_token', 'refreshToken']);
    if (!refreshToken) {
      throw new TokenRefreshError('SHOPEE', 'resposta de token sem refresh_token rotacionado', {
        request_id: result.requestId,
      });
    }

    const expiresIn =
      readNumber(['expire_in', 'expires_in', 'expireIn', 'expiresIn']) ?? SHOPEE_TOKEN_TTL_SECONDS;
    const authExpiresIn = readNumber(['auth_expire_in', 'authExpiresIn']);
    const shopId = readString(['shop_id', 'shopId']);

    return {
      accessToken,
      refreshToken,
      expiresIn: Math.max(60, Math.floor(expiresIn)),
      authExpiresIn: authExpiresIn !== null ? Math.max(0, Math.floor(authExpiresIn)) : null,
      shopId,
      requestId: result.requestId,
    };
  }

  private requestIdFrom(error: unknown): string | null {
    if (!(error instanceof MarketplaceApiError)) return null;
    const payload = asRecord(error.payload);
    const fromPayload = pickString(payload, ['request_id', 'requestId']);
    if (fromPayload) return fromPayload;
    const details = error.details;
    if (!details) return null;
    const value = details['request_id'];
    return typeof value === 'string' ? value : null;
  }

  private tryDecrypt(value: string | null): string | null {
    if (!value) return null;
    try {
      const plaintext = this.deps.cipher.decrypt(value);
      return plaintext.length > 0 ? plaintext : null;
    } catch {
      return null;
    }
  }

  private async safeDelete(key: string): Promise<void> {
    try {
      await this.deps.cache.del(key);
    } catch {
      // best effort only - a stale cache entry never blocks a retry
    }
  }
}

/**
 * `GET {apiBase}/api/v2/shop/auth_partner` builder.
 *
 * The redirect URI is signed exactly as provided and URL-encoded only when
 * placed in the query string.
 */
export function buildShopeeAuthorizeUrl(
  partnerId: number | string,
  partnerKey: string,
  redirectUri: string,
  apiBase: string,
): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const apiPath = SHOPEE_API_PATHS.authPartner;
  const sign = computeSign({ partnerId, apiPath, timestamp, partnerKey });
  const base = apiBase.replace(/\/+$/, '');
  return (
    `${base}${apiPath}?partner_id=${encodeURIComponent(String(partnerId))}` +
    `&redirect=${encodeURIComponent(redirectUri)}` +
    `&timestamp=${timestamp}&sign=${sign}`
  );
}

/**
 * Standalone authorization-code exchange exported from the adapter entry point.
 * The core `AccountService` calls this and persists the returned pair itself.
 */
export async function exchangeAuthorizationCode(
  deps: AdapterDependencies,
  input: ShopeeAuthorizationCodeInput,
): Promise<ShopeeAuthorizationCodeExchangeResult> {
  const client = new ShopeeClient(deps);
  const auth = new ShopeeAuth(deps, client);
  const tokenSet = await auth.exchangeCode(input);
  return {
    accessToken: tokenSet.accessToken,
    refreshToken: tokenSet.refreshToken,
    expiresIn: tokenSet.expiresIn,
  };
}
