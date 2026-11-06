import bcrypt from 'bcryptjs';
import {
  AppError,
  CACHE_KEYS,
  SSO_CODE_TTL_SECONDS,
  SSO_DEFAULT_SCOPES,
  SSO_ERROR_CODES,
  SSO_STATE_TTL_SECONDS,
} from '@sac/shared';
import type {
  AgentRecord,
  AgentRole,
  IAgentService,
  IAgentSsoRepository,
  ICache,
  IClock,
  IHttpClient,
  ILogger,
  ISecretCipher,
  ISsoAuthService,
  ITenantSsoConnectionRepository,
  LoginSuccess,
  SsoCallbackCommand,
  SsoCallbackResult,
  SsoExchangeCommand,
  SsoStartCommand,
  SsoStartResult,
  TenantSsoConnectionRecord,
} from '@sac/shared';

import { hashToken, randomToken } from './auth/access-token';
import { AUTH_RATE_LIMITS, AuthRateLimiter } from './auth/rate-limit';
import { isUniqueConstraintViolation } from './repositories/errors';
import { OidcClient } from './sso/OidcClient';
import type { OidcIdTokenClaims } from './sso/OidcClient';
import {
  createNonce,
  createOneTimeCode,
  createPkceChallenge,
  createPkceVerifier,
  createSignedState,
  verifySignedState,
} from './sso/pkce';
import {
  emailDomain,
  firstOrigin,
  isAllowedEmailDomain,
  normalizeEmail,
} from './sso/validation';

/**
 * ============================================================================
 * SsoAuthService - public OpenID Connect login (start / callback / exchange)
 * ============================================================================
 *
 * Security properties:
 *
 *  - `state` is random AND HMAC-signed, stored server-side with a 10 min TTL and
 *    consumed exactly once (marker `setNx` + delete), so a replay fails even
 *    with two concurrent requests.
 *  - `nonce` and PKCE S256 are mandatory; the verifier never leaves the server.
 *  - The ID token is validated end to end (RS256 against the issuer JWKS with a
 *    forced refetch on key rotation, `iss`, `aud`/`azp`, `exp`, `nbf`, `iat`,
 *    `nonce`) before any claim is trusted.
 *  - The e-mail comes from `email`/`preferred_username`/`upn`, must be marked
 *    verified when the IdP says so, and must belong to `allowed_domains`
 *    (deny-by-default when the list is empty).
 *  - JIT provisioning never attaches an existing e-mail from ANOTHER workspace,
 *    never re-activates a disabled operator and never demotes an ADMIN whose
 *    groups are not mapped.
 *  - The callback NEVER puts a token in the URL: it hands the SPA an opaque
 *    one-time code (60 s) that `/auth/sso/exchange` consumes once to mint the
 *    access + refresh session. Tokens are therefore never stored in Redis.
 */
export interface SsoAuthServiceDependencies {
  logger: ILogger;
  clock: IClock;
  cache: ICache;
  http: IHttpClient;
  cipher: ISecretCipher;
  /** Signs the `state` HMAC (domain separated) - same secret as the access JWT. */
  jwtSecret: string;
  /** First entry of `WEB_ORIGIN`: where the browser is sent after the callback. */
  webOrigin: string;
  nodeEnv: 'development' | 'test' | 'production';
  repos: {
    connections: ITenantSsoConnectionRepository;
    agents: IAgentSsoRepository;
  };
  /** Session issuance (access JWT + rotating refresh token + presence). */
  agents: IAgentService;
  rateLimiter?: AuthRateLimiter;
  /** Injectable for tests; built from `cache`/`http` otherwise. */
  oidc?: OidcClient;
}

interface SsoStatePayload {
  tenantId: string;
  connectionId: string;
  provider: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  emailDomain: string;
  createdAt: string;
}

interface SsoCodePayload {
  agentId: string;
  tenantId: string;
}

const ROLE_PRIORITY: Record<AgentRole, number> = { ADMIN: 3, SUPERVISOR: 2, AGENT: 1 };
const MAX_EMAIL_LENGTH = 180;
const MAX_NAME_LENGTH = 120;
const MAX_GROUP_CLAIMS = 500;

export class SsoAuthService implements ISsoAuthService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly cache: ICache;
  private readonly cipher: ISecretCipher;
  private readonly stateSecret: string;
  private readonly webOrigin: string;
  private readonly connections: ITenantSsoConnectionRepository;
  private readonly ssoAgents: IAgentSsoRepository;
  private readonly agents: IAgentService;
  private readonly rateLimiter: AuthRateLimiter;
  private readonly oidc: OidcClient;

  constructor(deps: SsoAuthServiceDependencies) {
    if (!deps.jwtSecret || deps.jwtSecret.length < 16) {
      throw new Error('SsoAuthService requires a configured JWT_SECRET (min 16 chars)');
    }

    this.logger = deps.logger.child({ component: 'SsoAuthService' });
    this.clock = deps.clock;
    this.cache = deps.cache;
    this.cipher = deps.cipher;
    this.stateSecret = deps.jwtSecret;
    this.webOrigin = firstOrigin(deps.webOrigin) ?? deps.webOrigin.replace(/\/+$/, '');
    this.connections = deps.repos.connections;
    this.ssoAgents = deps.repos.agents;
    this.agents = deps.agents;
    this.rateLimiter =
      deps.rateLimiter ??
      new AuthRateLimiter({ cache: deps.cache, clock: deps.clock, logger: deps.logger });
    this.oidc =
      deps.oidc ??
      new OidcClient({
        logger: deps.logger,
        clock: deps.clock,
        cache: deps.cache,
        http: deps.http,
        nodeEnv: deps.nodeEnv,
      });
  }

  /* ==================================================================== */
  /* Start: 302 to the IdP authorization endpoint                         */
  /* ==================================================================== */

  async start(command: SsoStartCommand): Promise<SsoStartResult> {
    await this.rateLimiter.assertAllowed(
      AUTH_RATE_LIMITS.ssoStart,
      CACHE_KEYS.ssoStartAttempts(normalizeClientIp(command.ip)),
    );

    const email = normalizeEmail(command.email);
    const domain = emailDomain(email);

    const match = await this.connections.findEnabledByDomain(domain);
    if (match === null) {
      this.logger.info('auth.sso.start.not_configured', { domain });
      throw notConfigured('No workspace has SSO enabled for this e-mail domain');
    }

    const connection = match.connection;
    if (command.provider !== undefined && command.provider !== connection.provider) {
      // Same answer as "not configured": never reveal which provider the
      // domain actually uses to a caller that guessed another one.
      this.logger.info('auth.sso.start.provider_mismatch', {
        tenantId: connection.tenantId,
        requested: command.provider,
        configured: connection.provider,
      });
      throw notConfigured('The selected provider is not enabled for this e-mail domain');
    }

    const discovery = await this.oidc.discover(connection.issuerUrl);
    const codeVerifier = createPkceVerifier();
    const nonce = createNonce();
    const state = createSignedState(this.stateSecret);

    const authorizationUrl = new URL(discovery.authorizationEndpoint);
    authorizationUrl.searchParams.set('client_id', connection.clientId);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('redirect_uri', connection.redirectUri);
    authorizationUrl.searchParams.set('scope', connection.scopes || SSO_DEFAULT_SCOPES);
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('nonce', nonce);
    authorizationUrl.searchParams.set('code_challenge', createPkceChallenge(codeVerifier));
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');

    const payload: SsoStatePayload = {
      tenantId: connection.tenantId,
      connectionId: connection.id,
      provider: connection.provider,
      nonce,
      codeVerifier,
      redirectUri: connection.redirectUri,
      emailDomain: domain,
      createdAt: this.clock.now().toISOString(),
    };

    try {
      await this.cache.set(CACHE_KEYS.ssoState(state), payload, SSO_STATE_TTL_SECONDS);
    } catch (error) {
      this.logger.error('auth.sso.start.state_store_failed', {
        tenantId: connection.tenantId,
        error: error instanceof Error ? error.name : 'unknown',
      });
      throw new AppError(
        SSO_ERROR_CODES.providerError,
        'Could not start the SSO flow right now. Try again.',
        503,
      );
    }

    this.logger.info('auth.sso.start', {
      tenantId: connection.tenantId,
      connectionId: connection.id,
      provider: connection.provider,
      domain,
    });

    return { authorizationUrl: authorizationUrl.toString() };
  }

  /* ==================================================================== */
  /* Callback: validate everything and hand off a one-time code           */
  /* ==================================================================== */

  async callback(command: SsoCallbackCommand): Promise<SsoCallbackResult> {
    await this.rateLimiter.assertAllowed(
      AUTH_RATE_LIMITS.ssoCallback,
      CACHE_KEYS.ssoCallbackAttempts(normalizeClientIp(command.ip)),
    );

    const stateValue = (command.state ?? '').trim();
    if (verifySignedState(this.stateSecret, stateValue) === null) {
      this.logger.warn('auth.sso.callback.state_invalid', { reason: 'signature' });
      throw stateInvalid();
    }

    const state = await this.consume<SsoStatePayload>(
      CACHE_KEYS.ssoState(stateValue),
      CACHE_KEYS.ssoStateUsed(stateValue),
      SSO_STATE_TTL_SECONDS,
    );
    if (state === null) {
      this.logger.warn('auth.sso.callback.state_invalid', { reason: 'unknown_or_replayed' });
      throw stateInvalid();
    }

    // The IdP may answer with `?error=access_denied` instead of a code. The
    // state is already burned above, so a cancelled attempt cannot be replayed.
    if (command.error !== undefined && command.error.trim().length > 0) {
      this.logger.info('auth.sso.callback.cancelled', {
        tenantId: state.tenantId,
        providerError: command.error.slice(0, 64),
      });
      throw new AppError(
        SSO_ERROR_CODES.cancelled,
        'Single sign-on was cancelled at the identity provider',
        400,
      );
    }

    const code = (command.code ?? '').trim();
    if (code.length === 0 || code.length > 4_096) {
      this.logger.warn('auth.sso.callback.missing_code', { tenantId: state.tenantId });
      throw new AppError(
        SSO_ERROR_CODES.tokenInvalid,
        'The identity provider did not return an authorization code',
        400,
      );
    }

    const connection = await this.connections.findById(state.connectionId);
    if (connection === null || !connection.enabled) {
      this.logger.warn('auth.sso.callback.connection_gone', {
        tenantId: state.tenantId,
        connectionId: state.connectionId,
      });
      throw notConfigured('The SSO connection was disabled or removed');
    }
    if (connection.tenantId !== state.tenantId || connection.provider !== state.provider) {
      this.logger.warn('auth.sso.callback.state_mismatch', { tenantId: state.tenantId });
      throw stateInvalid();
    }
    if (connection.redirectUri !== state.redirectUri) {
      // The registered redirect URI changed after the flow started: the code was
      // issued for another client/redirect pair and must not be redeemed.
      this.logger.warn('auth.sso.callback.redirect_changed', { tenantId: state.tenantId });
      throw stateInvalid();
    }

    const discovery = await this.oidc.discover(connection.issuerUrl);
    const clientSecret = this.decryptClientSecret(connection);

    const { idToken } = await this.oidc.exchangeCode({
      tokenEndpoint: discovery.tokenEndpoint,
      clientId: connection.clientId,
      clientSecret,
      code,
      redirectUri: state.redirectUri,
      codeVerifier: state.codeVerifier,
    });

    const claims = await this.oidc.verifyIdToken({
      idToken,
      issuer: discovery.issuer,
      clientId: connection.clientId,
      nonce: state.nonce,
      discovery,
    });

    const email = emailFromClaims(claims);
    if (email === null) {
      this.logger.warn('auth.sso.callback.missing_email', { tenantId: connection.tenantId });
      throw new AppError(
        SSO_ERROR_CODES.tokenInvalid,
        'The ID token does not contain a usable e-mail claim',
        401,
        { reason: 'missing_email' },
      );
    }

    if (claimEmailVerified(claims) === false) {
      this.logger.warn('auth.sso.callback.email_unverified', {
        tenantId: connection.tenantId,
        emailDomain: safeDomain(email),
      });
      throw new AppError(
        SSO_ERROR_CODES.emailUnverified,
        'The identity provider did not verify this e-mail address',
        403,
      );
    }

    const domain = safeDomain(email);
    if (domain === null || !isAllowedEmailDomain(domain, connection.allowedDomains)) {
      this.logger.warn('auth.sso.callback.domain_blocked', {
        tenantId: connection.tenantId,
        emailDomain: domain,
      });
      throw new AppError(
        SSO_ERROR_CODES.domainNotAllowed,
        'This e-mail domain is not allowed to sign in to this workspace',
        403,
        { domain },
      );
    }

    const now = this.clock.now();
    const name = claimName(claims, email);
    const mappedRole = resolveMappedRole(collectGroups(claims), connection.groupRoleMap);

    const provisioned = await this.provision(connection, {
      email,
      name,
      mappedRole,
      at: now,
    });

    const oneTimeCode = createOneTimeCode();
    const codeKey = CACHE_KEYS.ssoCode(hashToken(oneTimeCode));
    try {
      // Only the operator identity is stored - the session (JWT + refresh token)
      // is minted on `exchange`, so no credential is ever at rest in Redis.
      await this.cache.set<SsoCodePayload>(
        codeKey,
        { agentId: provisioned.agent.id, tenantId: connection.tenantId },
        SSO_CODE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.error('auth.sso.callback.code_store_failed', {
        tenantId: connection.tenantId,
        agentId: provisioned.agent.id,
        error: error instanceof Error ? error.name : 'unknown',
      });
      throw new AppError(
        SSO_ERROR_CODES.providerError,
        'Could not complete the SSO login right now. Try again.',
        503,
      );
    }

    this.logger.info('auth.sso.callback.succeeded', {
      tenantId: connection.tenantId,
      agentId: provisioned.agent.id,
      provider: connection.provider,
      domain,
      jit: provisioned.created,
      roleMapped: mappedRole !== null,
    });

    const redirect = new URL(`${this.webOrigin}/auth/sso/callback`);
    redirect.searchParams.set('code', oneTimeCode);

    return {
      redirectUrl: redirect.toString(),
      agentId: provisioned.agent.id,
      tenantId: connection.tenantId,
      provisioned: provisioned.created,
    };
  }

  /* ==================================================================== */
  /* Exchange: one-time code -> AuthResponse                              */
  /* ==================================================================== */

  async exchange(command: SsoExchangeCommand): Promise<LoginSuccess> {
    await this.rateLimiter.assertAllowed(
      AUTH_RATE_LIMITS.ssoExchange,
      CACHE_KEYS.ssoExchangeAttempts(normalizeClientIp(command.ip)),
    );

    const code = (command.code ?? '').trim();
    const codeHash = code.length > 0 && code.length <= 256 ? hashToken(code) : null;
    const payload =
      codeHash === null
        ? null
        : await this.consume<SsoCodePayload>(
            CACHE_KEYS.ssoCode(codeHash),
            CACHE_KEYS.ssoCodeUsed(codeHash),
            SSO_CODE_TTL_SECONDS,
          );

    if (payload === null) {
      this.logger.warn('auth.sso.exchange.failed', { reason: 'invalid_code' });
      throw new AppError(
        SSO_ERROR_CODES.invalidCode,
        'The SSO hand-off code is invalid, expired or already used',
        401,
      );
    }

    const session = await this.agents.issueSession(payload.agentId, {
      userAgent: command.userAgent ?? null,
      ip: command.ip ?? null,
    });

    this.logger.info('auth.sso.exchange.succeeded', {
      tenantId: payload.tenantId,
      agentId: payload.agentId,
    });

    return session;
  }

  /** SPA callback URL carrying only a stable error code (never provider text). */
  failureRedirect(errorCode: string): string {
    const url = new URL(`${this.webOrigin}/auth/sso/callback`);
    url.searchParams.set('error', errorCode);
    return url.toString();
  }

  /* ==================================================================== */
  /* JIT provisioning                                                     */
  /* ==================================================================== */

  private async provision(
    connection: TenantSsoConnectionRecord,
    input: { email: string; name: string; mappedRole: AgentRole | null; at: Date },
  ): Promise<{ agent: AgentRecord; created: boolean }> {
    const existing = await this.ssoAgents.findByEmail(input.email);
    if (existing !== null) {
      return {
        agent: await this.refreshExisting(connection, existing, input),
        created: false,
      };
    }

    if (!connection.autoProvision) {
      this.logger.warn('auth.sso.provisioning_disabled', {
        tenantId: connection.tenantId,
        emailDomain: safeDomain(input.email),
      });
      throw new AppError(
        SSO_ERROR_CODES.provisioningDisabled,
        'Your account is not provisioned in this workspace. Ask an administrator to invite you.',
        403,
      );
    }

    const role = input.mappedRole ?? connection.defaultRole;
    // Random 48-byte password: bcrypt-hashed so the column stays a valid hash,
    // but no one knows it, so the password path can never authenticate this
    // operator (and `mustResetPassword=false` keeps the SSO login seamless).
    const passwordHash = await bcrypt.hash(randomToken(48), 10);

    try {
      const created = await this.ssoAgents.create({
        tenantId: connection.tenantId,
        email: input.email,
        name: input.name,
        passwordHash,
        role,
        emailVerifiedAt: input.at,
      });
      this.logger.info('auth.sso.provisioned', {
        tenantId: connection.tenantId,
        agentId: created.id,
        role,
        viaGroup: input.mappedRole !== null,
      });
      return { agent: created, created: true };
    } catch (error) {
      // Two concurrent first logins: the unique e-mail index picks a winner and
      // the loser follows the normal "existing operator" path.
      if (!isUniqueConstraintViolation(error)) throw error;
      const raced = await this.ssoAgents.findByEmail(input.email);
      if (raced === null) throw error;
      return { agent: await this.refreshExisting(connection, raced, input), created: false };
    }
  }

  private async refreshExisting(
    connection: TenantSsoConnectionRecord,
    existing: AgentRecord,
    input: { email: string; name: string; mappedRole: AgentRole | null; at: Date },
  ): Promise<AgentRecord> {
    // Cross-tenant takeover guard: a global e-mail that already belongs to
    // another workspace is NEVER re-parented by an SSO login.
    if (existing.tenantId !== connection.tenantId) {
      this.logger.warn('auth.sso.account_conflict', {
        tenantId: connection.tenantId,
        agentId: existing.id,
      });
      throw new AppError(
        SSO_ERROR_CODES.accountConflict,
        'This e-mail already belongs to another workspace',
        409,
      );
    }

    // A deactivated operator stays deactivated: SSO must not silently undo an
    // administrator's suspension (provisioning is not a re-activation path).
    if (!existing.isActive) {
      this.logger.warn('auth.sso.account_disabled', {
        tenantId: connection.tenantId,
        agentId: existing.id,
      });
      throw new AppError(
        SSO_ERROR_CODES.accountDisabled,
        'This account is deactivated. Ask an administrator to reactivate it.',
        403,
      );
    }

    const role = input.mappedRole ?? undefined;
    const updated = await this.ssoAgents.updateFromSso(existing.id, {
      name: input.name,
      ...(role !== undefined ? { role } : {}),
      emailVerifiedAt: input.at,
      mustResetPassword: false,
    });

    if (role !== undefined && role !== existing.role) {
      this.logger.info('auth.sso.role_mapped', {
        tenantId: connection.tenantId,
        agentId: existing.id,
        from: existing.role,
        to: role,
      });
    }

    return updated;
  }

  /* ==================================================================== */
  /* Internals                                                            */
  /* ==================================================================== */

  /**
   * Single-use read: the value is returned only to the first caller. Two
   * concurrent callbacks both read the payload, but only one wins `setNx` on the
   * consumed marker, so a replayed state/code is rejected.
   */
  private async consume<T>(key: string, usedKey: string, ttlSeconds: number): Promise<T | null> {
    const value = await this.cache.get<T>(key);
    if (value === null) return null;

    const firstUse = await this.cache.setNx(usedKey, '1', ttlSeconds);
    if (!firstUse) return null;

    await this.cache.del(key);
    return value;
  }

  private decryptClientSecret(connection: TenantSsoConnectionRecord): string | null {
    if (connection.clientSecretEnc === null) return null;
    try {
      return this.cipher.decrypt(connection.clientSecretEnc);
    } catch (error) {
      this.logger.error('auth.sso.secret_decrypt_failed', {
        tenantId: connection.tenantId,
        connectionId: connection.id,
        error: error instanceof Error ? error.name : 'unknown',
      });
      throw new AppError(
        SSO_ERROR_CODES.notConfigured,
        'The stored client secret cannot be decrypted. Reconfigure the SSO connection.',
        409,
      );
    }
  }
}

/* ======================================================================== */
/* Claim helpers (exported for the unit tests)                              */
/* ======================================================================== */

/** `email` -> `preferred_username` -> `upn`, normalized; `null` when unusable. */
export function emailFromClaims(claims: OidcIdTokenClaims): string | null {
  for (const candidate of [claims.email, claims.preferred_username, claims.upn]) {
    if (typeof candidate !== 'string') continue;
    const value = candidate.trim();
    if (!value.includes('@') || value.length > MAX_EMAIL_LENGTH) continue;
    try {
      return normalizeEmail(value);
    } catch {
      // Try the next claim.
    }
  }
  return null;
}

/** `false` only when the IdP explicitly says the e-mail is not verified. */
export function claimEmailVerified(claims: OidcIdTokenClaims): boolean | null {
  const value = claims.email_verified;
  if (value === undefined || value === null) return null;
  if (value === true || value === 'true') return true;
  // Fail closed on anything else (false, 'false', 0, "no", objects...).
  return false;
}

export function claimName(claims: OidcIdTokenClaims, email: string): string {
  const candidate = claims.name;
  if (typeof candidate === 'string') {
    const name = candidate.trim();
    if (name.length > 0) return name.slice(0, MAX_NAME_LENGTH);
  }
  const local = email.split('@')[0] ?? 'Operador';
  return local.slice(0, MAX_NAME_LENGTH);
}

/** `groups`/`roles` claims -> unique non-empty strings (array or space-separated). */
export function collectGroups(claims: OidcIdTokenClaims): string[] {
  const groups = new Set<string>();
  for (const claim of [claims.groups, claims.roles]) {
    if (Array.isArray(claim)) {
      for (const entry of claim) {
        if (typeof entry !== 'string') continue;
        const value = entry.trim();
        if (value.length === 0) continue;
        groups.add(value);
        if (groups.size >= MAX_GROUP_CLAIMS) return Array.from(groups);
      }
      continue;
    }
    if (typeof claim === 'string') {
      for (const entry of claim.split(/\s+/)) {
        const value = entry.trim();
        if (value.length > 0) groups.add(value);
      }
    }
  }
  return Array.from(groups);
}

/** Highest-privilege mapped role, or `null` when no group matches the map. */
export function resolveMappedRole(
  groups: readonly string[],
  groupRoleMap: Record<string, AgentRole>,
): AgentRole | null {
  let best: AgentRole | null = null;
  for (const group of groups) {
    const role = groupRoleMap[group];
    if (role === undefined) continue;
    if (best === null || ROLE_PRIORITY[role] > ROLE_PRIORITY[best]) best = role;
  }
  return best;
}

/* ======================================================================== */
/* Errors                                                                   */
/* ======================================================================== */

function stateInvalid(): AppError {
  return new AppError(
    SSO_ERROR_CODES.stateInvalid,
    'The SSO state is invalid, expired or already used. Start the login again.',
    400,
  );
}

function notConfigured(message: string): AppError {
  return new AppError(SSO_ERROR_CODES.notConfigured, message, 404);
}

function safeDomain(email: string): string | null {
  try {
    return emailDomain(email);
  } catch {
    return null;
  }
}

function normalizeClientIp(value?: string | null): string {
  const ip = (value ?? '').trim();
  return ip.length > 0 ? ip : 'unknown';
}
