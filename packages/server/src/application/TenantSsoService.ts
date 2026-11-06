import {
  AppError,
  CACHE_KEYS,
  SSO_DEFAULT_SCOPES,
  SSO_ERROR_CODES,
  ValidationError,
} from '@sac/shared';
import type {
  AgentRole,
  ICache,
  IClock,
  ILogger,
  ISecretCipher,
  ISsoPasswordGuard,
  ITenantSsoConnectionRepository,
  ITenantSsoService,
  SsoConnectionView,
  SsoDiscoveryResult,
  SsoPasswordLoginSubject,
  TenantSsoConnectionRecord,
  UpdateSsoConnectionCommand,
} from '@sac/shared';

import { AUTH_RATE_LIMITS, AuthRateLimiter } from './auth/rate-limit';
import {
  defaultRedirectUri,
  emailDomain,
  normalizeAllowedDomains,
  normalizeDomain,
  normalizeEmail,
  normalizeGroupRoleMapInput,
  normalizeIssuerUrl,
  normalizeRedirectUri,
} from './sso/validation';

/**
 * ============================================================================
 * TenantSsoService - workspace IdP configuration + password-login gate
 * ============================================================================
 *
 *  - `get`/`update`/`remove`: ADMIN-only at the HTTP layer, always scoped by the
 *    tenant id from the JWT. The client secret is write-only: it is encrypted
 *    with `SecretCipher` on the way in and NEVER returned (`clientSecretConfigured`
 *    is the only signal the API exposes).
 *  - `discover`: public routing by e-mail domain (`enabled = true` +
 *    `allowed_domains` + ACTIVE workspace), throttled per IP because it is an
 *    unauthenticated oracle.
 *  - `assertPasswordLoginAllowed`: the `enforce_sso` break-glass rule. Called by
 *    `AgentService.login` only AFTER the password was validated, so a wrong
 *    password still answers 401 (no enumeration) and the policy is only
 *    revealed to someone who already proved the credential.
 *
 * Break-glass decision (documented in `docs/ENTERPRISE_SSO.md`): only
 * `agents.is_platform_admin = true` is exempt, never a tenant ADMIN. A locked
 * workspace is recovered by the IntegrAI platform operator (or by disabling the
 * connection), not by a second password path for every customer admin.
 */
export interface TenantSsoServiceDependencies {
  logger: ILogger;
  clock: IClock;
  cache: ICache;
  cipher: ISecretCipher;
  repo: ITenantSsoConnectionRepository;
  /** Public API base used when the workspace does not pin a redirect URI. */
  appBaseUrl: string;
  nodeEnv: 'development' | 'test' | 'production';
  /** Login throttle; built from `cache`/`clock` when omitted. */
  rateLimiter?: AuthRateLimiter;
}

const MAX_ISSUER_LENGTH = 512;
const MAX_REDIRECT_LENGTH = 512;
const MAX_CLIENT_ID_LENGTH = 255;
const MIN_SECRET_LENGTH = 8;
const MAX_SECRET_LENGTH = 512;

const AGENT_ROLES: readonly AgentRole[] = ['ADMIN', 'SUPERVISOR', 'AGENT'];

export class TenantSsoService implements ITenantSsoService, ISsoPasswordGuard {
  private readonly logger: ILogger;
  private readonly cipher: ISecretCipher;
  private readonly repo: ITenantSsoConnectionRepository;
  private readonly appBaseUrl: string;
  private readonly nodeEnv: TenantSsoServiceDependencies['nodeEnv'];
  private readonly rateLimiter: AuthRateLimiter;

  constructor(deps: TenantSsoServiceDependencies) {
    this.logger = deps.logger.child({ component: 'TenantSsoService' });
    this.cipher = deps.cipher;
    this.repo = deps.repo;
    this.appBaseUrl = deps.appBaseUrl;
    this.nodeEnv = deps.nodeEnv;
    this.rateLimiter =
      deps.rateLimiter ??
      new AuthRateLimiter({ cache: deps.cache, clock: deps.clock, logger: deps.logger });
  }

  /* ==================================================================== */
  /* Tenant configuration (ADMIN)                                         */
  /* ==================================================================== */

  async get(tenantId: string): Promise<SsoConnectionView> {
    const record = await this.repo.findByTenantId(tenantId);
    if (record === null) throw notConfigured('This workspace has no SSO connection');
    return toView(record);
  }

  async update(tenantId: string, command: UpdateSsoConnectionCommand): Promise<SsoConnectionView> {
    const existing = await this.repo.findByTenantId(tenantId);
    const options = { nodeEnv: this.nodeEnv };

    const issuerUrl = normalizeIssuerUrl(command.issuerUrl, options);
    if (issuerUrl.length > MAX_ISSUER_LENGTH) {
      throw new ValidationError(`issuerUrl must be at most ${MAX_ISSUER_LENGTH} characters`);
    }

    const clientId = (command.clientId ?? '').trim();
    if (clientId.length === 0) throw new ValidationError('clientId is required');
    if (clientId.length > MAX_CLIENT_ID_LENGTH) {
      throw new ValidationError(`clientId must be at most ${MAX_CLIENT_ID_LENGTH} characters`);
    }

    const redirectUri =
      command.redirectUri !== undefined
        ? normalizeRedirectUri(command.redirectUri, options)
        : (existing?.redirectUri ?? defaultRedirectUri(this.appBaseUrl));
    if (redirectUri.length > MAX_REDIRECT_LENGTH) {
      throw new ValidationError(`redirectUri must be at most ${MAX_REDIRECT_LENGTH} characters`);
    }

    const allowedDomains =
      command.allowedDomains !== undefined
        ? normalizeAllowedDomains(command.allowedDomains)
        : (existing?.allowedDomains ?? []);

    const groupRoleMap =
      command.groupRoleMap !== undefined
        ? (normalizeGroupRoleMapInput(command.groupRoleMap) ?? {})
        : (existing?.groupRoleMap ?? {});

    const defaultRole = command.defaultRole ?? existing?.defaultRole ?? 'AGENT';
    if (!AGENT_ROLES.includes(defaultRole)) {
      throw new ValidationError(`Unsupported defaultRole: ${String(defaultRole)}`);
    }

    const autoProvision = command.autoProvision ?? existing?.autoProvision ?? true;
    const enforceSso = command.enforceSso ?? existing?.enforceSso ?? false;
    const enabled = command.enabled ?? existing?.enabled ?? true;

    // Enforcing SSO with an empty allowlist would block every member (and the
    // only break-glass path would be the platform admin): reject it up front.
    if (enforceSso && allowedDomains.length === 0) {
      throw new ValidationError('enforceSso requires at least one allowed e-mail domain');
    }

    const clientSecretEnc =
      command.clientSecret !== undefined
        ? this.encryptSecret(command.clientSecret)
        : (existing?.clientSecretEnc ?? null);

    const record = await this.repo.upsert({
      tenantId,
      provider: command.provider,
      issuerUrl,
      clientId,
      clientSecretEnc,
      redirectUri,
      scopes: existing?.scopes ?? SSO_DEFAULT_SCOPES,
      allowedDomains,
      groupRoleMap,
      autoProvision,
      defaultRole,
      enforceSso,
      enabled,
    });

    this.logger.info('auth.sso.config.updated', {
      tenantId,
      provider: record.provider,
      issuerUrl: record.issuerUrl,
      clientId: record.clientId,
      enabled: record.enabled,
      enforceSso: record.enforceSso,
      autoProvision: record.autoProvision,
      defaultRole: record.defaultRole,
      allowedDomains: record.allowedDomains.length,
      groupMappings: Object.keys(record.groupRoleMap).length,
      // Never the secret itself, not even a hash: only whether it rotated.
      secretRotated: command.clientSecret !== undefined,
      clientSecretConfigured: record.clientSecretEnc !== null,
    });

    return toView(record);
  }

  async remove(tenantId: string): Promise<void> {
    const deleted = await this.repo.deleteByTenantId(tenantId);
    if (!deleted) throw notConfigured('This workspace has no SSO connection');
    // Pending states/codes expire by TTL; the callback re-reads the connection
    // by id and answers SSO_NOT_CONFIGURED, so a deleted config cannot log in.
    this.logger.info('auth.sso.config.deleted', { tenantId });
  }

  /* ==================================================================== */
  /* Public discovery                                                     */
  /* ==================================================================== */

  async discover(query: {
    email?: string;
    domain?: string;
    ip?: string | null;
  }): Promise<SsoDiscoveryResult> {
    await this.rateLimiter.assertAllowed(
      AUTH_RATE_LIMITS.ssoDiscover,
      CACHE_KEYS.ssoDiscoverAttempts(normalizeClientIp(query.ip)),
    );

    const domain =
      query.email !== undefined
        ? emailDomain(normalizeEmail(query.email))
        : query.domain !== undefined
          ? normalizeDomain(query.domain)
          : null;
    if (domain === null) {
      throw new ValidationError('Either email or domain is required');
    }

    const match = await this.repo.findEnabledByDomain(domain);
    if (match === null) {
      this.logger.info('auth.sso.discover.not_found', { domain });
      throw notConfigured('No workspace has SSO enabled for this e-mail domain');
    }

    this.logger.info('auth.sso.discover.matched', {
      tenantId: match.connection.tenantId,
      provider: match.connection.provider,
      domain,
    });

    return {
      enabled: true,
      provider: match.connection.provider,
      tenantSlug: match.tenantSlug,
    };
  }

  /* ==================================================================== */
  /* Password-login gate (enforce_sso)                                    */
  /* ==================================================================== */

  async assertPasswordLoginAllowed(subject: SsoPasswordLoginSubject): Promise<void> {
    // Break-glass: platform administrators can ALWAYS use the password path,
    // even if their own workspace enforces SSO. This is the documented escape
    // hatch for a misconfigured/decommissioned IdP.
    if (subject.isPlatformAdmin) return;
    if (subject.tenantId === null || subject.tenantId.length === 0) return;

    const connection = await this.repo.findByTenantId(subject.tenantId);
    if (connection === null || !connection.enabled || !connection.enforceSso) return;

    this.logger.warn('auth.sso.password_blocked', {
      tenantId: subject.tenantId,
      provider: connection.provider,
    });
    throw new AppError(
      SSO_ERROR_CODES.required,
      'This workspace requires single sign-on. Use "Entrar com SSO" instead of a password.',
      403,
      { provider: connection.provider },
    );
  }

  /* ==================================================================== */
  /* Internals                                                            */
  /* ==================================================================== */

  private encryptSecret(value: string): string {
    const secret = (value ?? '').trim();
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new ValidationError(`clientSecret must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    if (secret.length > MAX_SECRET_LENGTH) {
      throw new ValidationError(`clientSecret must be at most ${MAX_SECRET_LENGTH} characters`);
    }
    return this.cipher.encrypt(secret);
  }
}

/* ======================================================================== */
/* Helpers                                                                  */
/* ======================================================================== */

/** Safe projection: the encrypted secret never crosses the API boundary. */
export function toView(record: TenantSsoConnectionRecord): SsoConnectionView {
  return {
    tenantId: record.tenantId,
    provider: record.provider,
    issuerUrl: record.issuerUrl,
    clientId: record.clientId,
    clientSecretConfigured: record.clientSecretEnc !== null,
    redirectUri: record.redirectUri,
    scopes: record.scopes,
    allowedDomains: record.allowedDomains,
    groupRoleMap: record.groupRoleMap,
    autoProvision: record.autoProvision,
    defaultRole: record.defaultRole,
    enforceSso: record.enforceSso,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function notConfigured(message: string): AppError {
  return new AppError(SSO_ERROR_CODES.notConfigured, message, 404);
}

function normalizeClientIp(value?: string | null): string {
  const ip = (value ?? '').trim();
  return ip.length > 0 ? ip : 'unknown';
}
