import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import {
  AppError,
  CACHE_KEYS,
  SSO_CLOCK_SKEW_SECONDS,
  SSO_DISCOVERY_TTL_SECONDS,
  SSO_ERROR_CODES,
  SSO_JWKS_TTL_SECONDS,
} from '@sac/shared';
import type { HttpResponse, ICache, IClock, IHttpClient, ILogger } from '@sac/shared';
import { constantTimeEquals } from './pkce';
import { assertHttpsUrl } from './validation';

/**
 * ============================================================================
 * Minimal OpenID Connect client (no SDK)
 * ============================================================================
 *
 * Implements only what the login flow needs, with an explicit trust chain:
 *
 *  1. `discover(issuer)` fetches `<issuer>/.well-known/openid-configuration`,
 *     requires https endpoints and verifies that the document's `issuer` is the
 *     configured issuer (RFC 8414/OIDC Discovery).
 *  2. `exchangeCode` POSTs to the discovered token endpoint with PKCE and the
 *     optional client secret, and refuses any response without `id_token`.
 *  3. `verifyIdToken` checks RS256 signature against the discovered JWKS
 *     (kid lookup, one forced refetch on rotation), `iss`, `aud`/`azp`, `exp`,
 *     `nbf`, `iat` and `nonce`.
 *
 * Discovery and JWKS are cached in-process AND in Redis for 1 h; a Redis outage
 * only costs an extra HTTP call. Tokens, codes and verifiers are never logged.
 */

const DISCOVERY_TIMEOUT_MS = 10_000;
const TOKEN_TIMEOUT_MS = 10_000;
const MAX_TOKEN_LENGTH = 16_384;

export interface OidcDiscoveryDocument {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

export interface OidcIdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
  nonce?: unknown;
  email?: unknown;
  preferred_username?: unknown;
  upn?: unknown;
  email_verified?: unknown;
  name?: unknown;
  groups?: unknown;
  roles?: unknown;
  [claim: string]: unknown;
}

interface Jwk extends Record<string, unknown> {
  kid?: unknown;
  kty?: unknown;
  use?: unknown;
  alg?: unknown;
  n?: unknown;
  e?: unknown;
}

interface TokenEndpointPayload extends Record<string, unknown> {
  id_token?: unknown;
  access_token?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export interface OidcClientDependencies {
  logger: ILogger;
  clock: IClock;
  cache: ICache;
  http: IHttpClient;
  nodeEnv: 'development' | 'test' | 'production';
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeIssuer(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export class OidcClient {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly cache: ICache;
  private readonly http: IHttpClient;
  private readonly nodeEnv: OidcClientDependencies['nodeEnv'];
  /** In-process fallback/complement of the Redis cache (per API instance). */
  private readonly memory = new Map<string, CacheEntry>();

  constructor(deps: OidcClientDependencies) {
    this.logger = deps.logger.child({ component: 'OidcClient' });
    this.clock = deps.clock;
    this.cache = deps.cache;
    this.http = deps.http;
    this.nodeEnv = deps.nodeEnv;
  }

  /* ==================================================================== */
  /* Discovery                                                            */
  /* ==================================================================== */

  async discover(issuerUrl: string): Promise<OidcDiscoveryDocument> {
    const issuer = normalizeIssuer(issuerUrl);
    const key = CACHE_KEYS.ssoDiscovery(issuer);

    const cached = await this.readCache<OidcDiscoveryDocument>(key);
    if (cached !== null) return cached;

    const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
    const body = await this.fetchJson(discoveryUrl);
    const document = this.parseDiscovery(body, issuer);
    await this.writeCache(key, document, SSO_DISCOVERY_TTL_SECONDS);
    return document;
  }

  private parseDiscovery(body: Record<string, unknown>, expectedIssuer: string): OidcDiscoveryDocument {
    const issuer = typeof body.issuer === 'string' ? normalizeIssuer(body.issuer) : '';
    if (issuer.length === 0) {
      throw this.providerError('Discovery document has no issuer');
    }
    // RFC 8414 §3.3: the document MUST advertise the issuer used to build the
    // discovery URL. A mismatch is a redirect/IdP misconfiguration.
    if (issuer !== expectedIssuer) {
      throw this.providerError('Discovery issuer does not match the configured issuer', {
        configuredIssuer: expectedIssuer,
        discoveredIssuer: issuer,
      });
    }

    const authorizationEndpoint = this.requireHttpsEndpoint(
      body.authorization_endpoint,
      'authorization_endpoint',
    );
    const tokenEndpoint = this.requireHttpsEndpoint(body.token_endpoint, 'token_endpoint');
    const jwksUri = this.requireHttpsEndpoint(body.jwks_uri, 'jwks_uri');

    return { issuer, authorizationEndpoint, tokenEndpoint, jwksUri };
  }

  private requireHttpsEndpoint(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw this.providerError(`Discovery document is missing ${label}`);
    }
    try {
      // OIDC endpoints must be https; the loopback exception keeps local mocks
      // usable outside production (same rule as the tenant configuration).
      return assertHttpsUrl(value, label, { nodeEnv: this.nodeEnv }, { allowQuery: true });
    } catch (error) {
      throw this.providerError(
        `Discovery document has an invalid ${label}`,
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  /* ==================================================================== */
  /* Token exchange                                                       */
  /* ==================================================================== */

  /**
   * Authorization-code grant. `clientSecret` is sent only for confidential
   * clients; a public client proves possession with the PKCE verifier.
   * Retries are disabled: the authorization code is single-use, so a duplicate
   * POST could burn it before the first response is read.
   */
  async exchangeCode(input: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string | null;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<{ idToken: string }> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
    });
    if (typeof input.clientSecret === 'string' && input.clientSecret.length > 0) {
      form.set('client_secret', input.clientSecret);
    }

    let status = 0;
    let response: HttpResponse<TokenEndpointPayload>;
    try {
      response = await this.http.request<TokenEndpointPayload>({
        method: 'POST',
        url: input.tokenEndpoint,
        headers: { accept: 'application/json' },
        body: form,
        timeoutMs: TOKEN_TIMEOUT_MS,
        retries: 0,
      });
      status = response.status;
    } catch (error) {
      this.logger.warn('auth.sso.provider.token_failed', {
        reason: 'transport',
        error: error instanceof Error ? error.name : 'unknown',
      });
      throw this.providerError('Could not reach the identity provider token endpoint');
    }

    if (!response.ok || !isRecord(response.body)) {
      // Never echo `error_description` (it can contain IdP internals) and never
      // the submitted code/verifier.
      this.logger.warn('auth.sso.provider.token_rejected', {
        status,
        providerError:
          isRecord(response.body) && typeof response.body.error === 'string'
            ? response.body.error.slice(0, 64)
            : null,
      });
      throw new AppError(
        SSO_ERROR_CODES.tokenInvalid,
        'The identity provider rejected the authorization code',
        401,
        { providerStatus: status },
      );
    }

    const idToken = response.body.id_token;
    if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > MAX_TOKEN_LENGTH) {
      this.logger.warn('auth.sso.provider.token_without_id_token', { status });
      throw new AppError(
        SSO_ERROR_CODES.tokenInvalid,
        'The identity provider did not return an ID token',
        401,
        { providerStatus: status },
      );
    }

    return { idToken };
  }

  /* ==================================================================== */
  /* ID token validation                                                  */
  /* ==================================================================== */

  /**
   * Full ID-token validation. Throws `SSO_TOKEN_INVALID` (401) with a stable
   * `details.reason`; the token itself is never included.
   */
  async verifyIdToken(input: {
    idToken: string;
    issuer: string;
    clientId: string;
    nonce: string;
    discovery: OidcDiscoveryDocument;
  }): Promise<OidcIdTokenClaims> {
    const parts = input.idToken.split('.');
    if (parts.length !== 3) throw this.invalidToken('malformed');

    const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
    const header = decodeJsonSegment(rawHeader);
    if (header === null) throw this.invalidToken('malformed_header');

    if (header.alg !== 'RS256') {
      // `none`/HS256 are never accepted: the signing key must be an asymmetric
      // key published in the issuer JWKS, never a shared secret.
      throw this.invalidToken('unsupported_alg', { alg: typeof header.alg === 'string' ? header.alg : null });
    }

    const kid = typeof header.kid === 'string' ? header.kid : null;
    let keys = await this.getJwks(input.discovery.jwksUri);
    let jwk = selectKey(keys, kid);
    if (jwk === null) {
      // One forced refresh: the IdP may have rotated its signing keys.
      keys = await this.getJwks(input.discovery.jwksUri, { forceRefresh: true });
      jwk = selectKey(keys, kid);
    }
    if (jwk === null) throw this.invalidToken('unknown_kid');

    let valid = false;
    try {
      const key = importRsaJwk(jwk);
      valid = verifySignature(
        'RSA-SHA256',
        Buffer.from(`${rawHeader}.${rawPayload}`, 'ascii'),
        key,
        Buffer.from(rawSignature, 'base64url'),
      );
    } catch {
      valid = false;
    }
    if (!valid) throw this.invalidToken('signature');

    const claims = decodeJsonSegment(rawPayload);
    if (claims === null) throw this.invalidToken('malformed_claims');

    this.assertClaims(claims, input);
    return claims as OidcIdTokenClaims;
  }

  private assertClaims(
    claims: Record<string, unknown>,
    input: { issuer: string; clientId: string; nonce: string },
  ): void {
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1_000);

    if (typeof claims.iss !== 'string' || normalizeIssuer(claims.iss) !== normalizeIssuer(input.issuer)) {
      throw this.invalidToken('issuer');
    }

    const audience = claims.aud;
    const audiences = Array.isArray(audience)
      ? audience.filter((entry): entry is string => typeof entry === 'string')
      : typeof audience === 'string'
        ? [audience]
        : [];
    if (!audiences.includes(input.clientId)) throw this.invalidToken('audience');
    // OIDC Core §3.1.3.7: with multiple audiences the authorized party must be
    // this client, otherwise a token minted for another app could be replayed.
    if (audiences.length > 1 && claims.azp !== input.clientId) {
      throw this.invalidToken('authorized_party');
    }

    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
      throw this.invalidToken('missing_exp');
    }
    if (claims.exp + SSO_CLOCK_SKEW_SECONDS < nowSeconds) throw this.invalidToken('expired');

    if (claims.nbf !== undefined) {
      if (typeof claims.nbf !== 'number' || claims.nbf - SSO_CLOCK_SKEW_SECONDS > nowSeconds) {
        throw this.invalidToken('not_yet_valid');
      }
    }
    if (claims.iat !== undefined) {
      if (typeof claims.iat !== 'number' || claims.iat - SSO_CLOCK_SKEW_SECONDS > nowSeconds) {
        throw this.invalidToken('issued_in_future');
      }
    }

    if (typeof claims.nonce !== 'string' || !constantTimeEquals(claims.nonce, input.nonce)) {
      throw this.invalidToken('nonce');
    }
  }

  private invalidToken(reason: string, details?: Record<string, unknown>): AppError {
    this.logger.warn('auth.sso.id_token.rejected', { reason, ...details });
    return new AppError(SSO_ERROR_CODES.tokenInvalid, 'ID token validation failed', 401, {
      reason,
    });
  }

  /* ==================================================================== */
  /* JWKS                                                                 */
  /* ==================================================================== */

  async getJwks(jwksUri: string, options: { forceRefresh?: boolean } = {}): Promise<Jwk[]> {
    const key = CACHE_KEYS.ssoJwks(jwksUri);
    if (options.forceRefresh !== true) {
      const cached = await this.readCache<Jwk[]>(key);
      if (cached !== null) return cached;
    }

    const body = await this.fetchJson(jwksUri);
    const keys = Array.isArray(body.keys) ? body.keys.filter(isUsableRsaKey) : [];
    if (keys.length === 0) {
      throw this.providerError('JWKS has no usable RSA signing key');
    }
    await this.writeCache(key, keys, SSO_JWKS_TTL_SECONDS);
    return keys;
  }

  /* ==================================================================== */
  /* Internals                                                            */
  /* ==================================================================== */

  private async fetchJson(url: string): Promise<Record<string, unknown>> {
    try {
      const response = await this.http.request<unknown>({
        method: 'GET',
        url,
        headers: { accept: 'application/json' },
        timeoutMs: DISCOVERY_TIMEOUT_MS,
        retries: 1,
      });
      if (!response.ok || !isRecord(response.body)) {
        throw this.providerError('Identity provider document is unavailable', {
          status: response.status,
        });
      }
      return response.body;
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.logger.warn('auth.sso.provider.unreachable', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      throw this.providerError('Could not reach the identity provider');
    }
  }

  private async readCache<T>(key: string): Promise<T | null> {
    const now = this.clock.now().getTime();
    const local = this.memory.get(key);
    if (local !== undefined) {
      if (local.expiresAt > now) return local.value as T;
      this.memory.delete(key);
    }

    try {
      const value = await this.cache.get<T>(key);
      if (value !== null) {
        // Rehydrate the in-process layer so a Redis outage does not force a
        // refetch on every request of this instance.
        this.memory.set(key, { value, expiresAt: now + SSO_DISCOVERY_TTL_SECONDS * 1_000 });
        return value;
      }
    } catch {
      // Best effort: the HTTP fetch below is the source of truth.
    }
    return null;
  }

  private async writeCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.memory.set(key, {
      value,
      expiresAt: this.clock.now().getTime() + ttlSeconds * 1_000,
    });
    try {
      await this.cache.set(key, value, ttlSeconds);
    } catch {
      // A cache outage must not fail a login; the memory entry still serves.
    }
  }

  private providerError(message: string, details?: Record<string, unknown>): AppError {
    this.logger.warn('auth.sso.provider.error', { message, ...details });
    return new AppError(SSO_ERROR_CODES.providerError, message, 502, details);
  }
}

/* ======================================================================== */
/* Helpers                                                                  */
/* ======================================================================== */

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function isUsableRsaKey(value: unknown): value is Jwk {
  if (!isRecord(value)) return false;
  if (value.kty !== 'RSA') return false;
  if (value.use !== undefined && value.use !== 'sig') return false;
  if (value.alg !== undefined && value.alg !== 'RS256') return false;
  return typeof value.n === 'string' && typeof value.e === 'string';
}

function selectKey(keys: Jwk[], kid: string | null): Jwk | null {
  if (kid !== null) {
    return keys.find((entry) => entry.kid === kid) ?? null;
  }
  // Some IdPs omit `kid` on single-key JWKS; only then is the sole key usable.
  return keys.length === 1 ? (keys[0] as Jwk) : null;
}

function importRsaJwk(jwk: Jwk): KeyObject {
  return createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' });
}
