import { isAppError } from '@sac/shared';
import type {
  SsoConnectionTestCheck,
  SsoConnectionTestCheckName,
  SsoConnectionTestResult,
  TenantSsoConnectionRecord,
} from '@sac/shared';
import type { OidcClient } from './OidcClient';
import { isUsableRsaKey } from './OidcClient';
import { assertHttpsUrl } from './validation';
import type { SsoValidationOptions } from './validation';

/**
 * ============================================================================
 * Enterprise SSO - ADMIN "test connection" probe
 * ============================================================================
 *
 * Answers the one question the settings screen must answer BEFORE an admin
 * flips `enforceSso`: "would a login against the SAVED connection actually
 * work?". It is a READ-ONLY probe of the provider metadata:
 *
 *  1. `GET <issuer>/.well-known/openid-configuration` (5 s timeout, no cache,
 *     no retries) - a stale cached document would hide a just-broken provider;
 *  2. `<jwks_uri>` - counts the usable RS256 signing keys and their `kid`s;
 *  3. the workspace allowlist (`allowed_domains`), a local value.
 *
 * It never requests an authorization code or a token and never touches the
 * client secret, so it works for public/PKCE clients too, and it cannot be used
 * to validate stolen credentials. Every failure is reported as a check with
 * `ok: false` instead of throwing: the admin must see the WHOLE picture, not
 * only the first broken field. `detail` is always secret-free (HTTP status,
 * counts, issuer names).
 */

/** Per-request budget of the probe (requirement: 5 s, not the login 10 s). */
export const SSO_TEST_TIMEOUT_MS = 5_000;

/** Caps of the values echoed from the external discovery document. */
const MAX_DETAIL_LENGTH = 512;
const MAX_LISTED_VALUES = 12;

export interface SsoConnectionProbeInput {
  connection: TenantSsoConnectionRecord;
  oidc: Pick<OidcClient, 'fetchDiscoveryDocument' | 'fetchJwksDocument'>;
  nodeEnv: SsoValidationOptions['nodeEnv'];
}

/**
 * Runs every check and returns the report. Only the repository lookup (404) and
 * the throttle (429) throw; a broken/misconfigured provider never does.
 */
export async function probeSsoConnection(
  input: SsoConnectionProbeInput,
): Promise<SsoConnectionTestResult> {
  const { connection, oidc, nodeEnv } = input;
  const configuredIssuer = normalizeIssuer(connection.issuerUrl);
  const checks: SsoConnectionTestCheck[] = [];
  const result: SsoConnectionTestResult = {
    ok: false,
    checks,
    enabled: connection.enabled,
  };

  /* ---------------------------------------------------------------- */
  /* 1. Discovery                                                      */
  /* ---------------------------------------------------------------- */

  let document: Record<string, unknown>;
  try {
    document = await oidc.fetchDiscoveryDocument(configuredIssuer, {
      timeoutMs: SSO_TEST_TIMEOUT_MS,
    });
  } catch (error) {
    // Without the document the remaining provider checks cannot be evaluated:
    // reporting them as `false` would blame fields that were never read.
    checks.push({ name: 'discovery', ok: false, detail: failureDetail(error) });
    return result;
  }
  checks.push({ name: 'discovery', ok: true, detail: 'HTTP 200' });

  /* ---------------------------------------------------------------- */
  /* 2. Document metadata                                              */
  /* ---------------------------------------------------------------- */

  const discoveredIssuer =
    typeof document.issuer === 'string' ? normalizeIssuer(document.issuer) : '';
  if (discoveredIssuer.length > 0) result.issuer = clip(discoveredIssuer);

  checks.push({
    name: 'issuer',
    ok: discoveredIssuer.length > 0 && discoveredIssuer === configuredIssuer,
    detail:
      discoveredIssuer.length === 0
        ? 'Discovery document has no issuer'
        : discoveredIssuer === configuredIssuer
          ? clip(discoveredIssuer)
          : `expected ${clip(configuredIssuer)}, got ${clip(discoveredIssuer)}`,
  });

  const authorizationEndpoint = optionalString(document.authorization_endpoint);
  if (authorizationEndpoint !== null) result.authorizationEndpoint = clip(authorizationEndpoint);
  checks.push(endpointCheck('authorization_endpoint', document.authorization_endpoint, nodeEnv));

  const tokenEndpoint = optionalString(document.token_endpoint);
  if (tokenEndpoint !== null) result.tokenEndpoint = clip(tokenEndpoint);
  checks.push(endpointCheck('token_endpoint', document.token_endpoint, nodeEnv));

  checks.push(endpointCheck('jwks_uri', document.jwks_uri, nodeEnv));

  checks.push({
    name: 'response_types',
    ok: stringArray(document.response_types_supported).includes('code'),
    detail: listDetail(document.response_types_supported, 'response_types_supported'),
  });

  checks.push({
    name: 'code_challenge_methods',
    ok: stringArray(document.code_challenge_methods_supported).includes('S256'),
    detail: listDetail(document.code_challenge_methods_supported, 'code_challenge_methods_supported'),
  });

  checks.push({
    name: 'id_token_signing_alg',
    ok: stringArray(document.id_token_signing_alg_values_supported).includes('RS256'),
    detail: listDetail(
      document.id_token_signing_alg_values_supported,
      'id_token_signing_alg_values_supported',
    ),
  });

  /* ---------------------------------------------------------------- */
  /* 3. JWKS                                                           */
  /* ---------------------------------------------------------------- */

  const jwksUri = optionalString(document.jwks_uri);
  if (jwksUri === null) {
    checks.push({ name: 'jwks', ok: false, detail: 'Discovery document has no jwks_uri' });
  } else {
    try {
      const jwks = await oidc.fetchJwksDocument(jwksUri, { timeoutMs: SSO_TEST_TIMEOUT_MS });
      const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
      // The login flow selects a key by `kid`, so a key without one is usable
      // only in the single-key fallback: report it but never count it as ready.
      const usable = keys
        .filter(isUsableRsaKey)
        .filter((key) => typeof key.kid === 'string' && key.kid.trim().length > 0);

      result.jwksKeys = usable.map((key) => key.kid as string);
      checks.push({
        name: 'jwks',
        ok: usable.length > 0,
        detail: `${keys.length} key(s), ${usable.length} usable RSA/sig key(s) with kid`,
      });
    } catch (error) {
      checks.push({ name: 'jwks', ok: false, detail: failureDetail(error) });
    }
  }

  /* ---------------------------------------------------------------- */
  /* 4. Local allowlist                                                */
  /* ---------------------------------------------------------------- */

  const allowedDomains = connection.allowedDomains.length;
  checks.push({
    name: 'allowed_domains',
    ok: allowedDomains > 0,
    detail:
      allowedDomains > 0
        ? `${allowedDomains} domain(s) allowed`
        : 'No allowed e-mail domain: every SSO login would be rejected',
  });

  result.ok = checks.every((check) => check.ok);
  return result;
}

/* ======================================================================== */
/* Helpers                                                                  */
/* ======================================================================== */

function normalizeIssuer(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Caps a value echoed back to the admin: the discovery document is supplied by
 * an external IdP, so no single field may inflate the response/log unboundedly.
 */
function clip(value: string): string {
  return value.length > MAX_DETAIL_LENGTH ? `${value.slice(0, MAX_DETAIL_LENGTH)}…` : value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function listDetail(value: unknown, label: string): string {
  const entries = stringArray(value);
  return entries.length > 0
    ? clip(entries.slice(0, MAX_LISTED_VALUES).join(', '))
    : `Discovery document has no ${label}`;
}

type EndpointCheckName = Extract<
  SsoConnectionTestCheckName,
  'authorization_endpoint' | 'token_endpoint' | 'jwks_uri'
>;

/** Same https/loopback rule used to validate and persist the tenant config. */
function endpointCheck(
  name: EndpointCheckName,
  value: unknown,
  nodeEnv: SsoValidationOptions['nodeEnv'],
): SsoConnectionTestCheck {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { name, ok: false, detail: `Discovery document is missing ${name}` };
  }
  try {
    assertHttpsUrl(value, name, { nodeEnv }, { allowQuery: true });
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, detail: failureDetail(error) };
  }
}

/**
 * Secret-free failure text. `AppError` messages are written for operators; the
 * HTTP status is appended when the transport layer provided one.
 */
function failureDetail(error: unknown): string {
  if (!isAppError(error)) return 'Provider unreachable';
  const status =
    typeof error.details === 'object' &&
    error.details !== null &&
    typeof (error.details as Record<string, unknown>).status === 'number'
      ? ((error.details as Record<string, unknown>).status as number)
      : null;
  return status === null ? error.message : `${error.message} (HTTP ${status})`;
}
