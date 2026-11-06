import { SSO_CALLBACK_PATH, ValidationError } from '@sac/shared';
import type { AgentRole } from '@sac/shared';

/**
 * ============================================================================
 * Enterprise SSO - input normalization / validation
 * ============================================================================
 *
 * Every value persisted in `tenant_sso_connections` goes through here, so the
 * database only ever holds canonical data:
 *
 *  - issuer: absolute https URL, no query/fragment/userinfo, no trailing slash;
 *  - redirect URI: absolute https URL (exact match at the IdP), no fragment;
 *  - allowed domains: lowercase ASCII, `example.com` form, deduplicated;
 *  - e-mail: trimmed/lowercased, the domain is what discovery matches on;
 *  - group -> role map: only `ADMIN | SUPERVISOR | AGENT`, bounded size.
 *
 * Local development is the ONLY place where `http://localhost` (or a loopback
 * IP) is accepted: production requires https everywhere. That exception keeps
 * `npm run dev` usable with a local mock IdP without weakening prod.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** RFC 1035-ish domain (ASCII/punycode), at least two labels. */
const DOMAIN_REGEX = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const MAX_DOMAINS = 50;
const MAX_GROUP_MAPPINGS = 200;
const MAX_GROUP_NAME_LENGTH = 256;

const VALID_ROLES: readonly AgentRole[] = ['ADMIN', 'SUPERVISOR', 'AGENT'];

export interface SsoValidationOptions {
  nodeEnv: 'development' | 'test' | 'production';
}

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function parseAbsoluteUrl(value: string, label: string): URL {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) throw new ValidationError(`${label} is required`);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ValidationError(`${label} must be an absolute URL`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new ValidationError(`${label} must not embed credentials`);
  }
  if (url.hash.length > 0) {
    throw new ValidationError(`${label} must not contain a fragment`);
  }
  return url;
}

/**
 * Validates an https endpoint (issuer, redirect URI, OIDC discovery endpoints).
 * Loopback http is accepted only outside production, for local development.
 */
export function assertHttpsUrl(
  value: string,
  label: string,
  options: SsoValidationOptions,
  opts: { allowQuery?: boolean } = {},
): string {
  const url = parseAbsoluteUrl(value, label);
  const isHttps = url.protocol === 'https:';
  const isDevLoopback =
    url.protocol === 'http:' && options.nodeEnv !== 'production' && isLoopback(url.hostname);

  if (!isHttps && !isDevLoopback) {
    throw new ValidationError(`${label} must use https`);
  }
  if (opts.allowQuery !== true && url.search.length > 0) {
    throw new ValidationError(`${label} must not contain a query string`);
  }
  return url.toString();
}

/** Canonical issuer: https, no trailing slash (discovery appends `/.well-known/...`). */
export function normalizeIssuerUrl(value: string, options: SsoValidationOptions): string {
  const normalized = assertHttpsUrl(value, 'issuerUrl', options);
  return normalized.replace(/\/+$/, '');
}

/** Canonical redirect URI: https (loopback http in dev), fragment-free. */
export function normalizeRedirectUri(value: string, options: SsoValidationOptions): string {
  return assertHttpsUrl(value, 'redirectUri', options, { allowQuery: true });
}

/** Lowercase ASCII domain, without a leading `@` or a trailing dot. */
export function normalizeDomain(value: string): string {
  const domain = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/\.+$/, '');
  if (!DOMAIN_REGEX.test(domain)) {
    throw new ValidationError(`Invalid e-mail domain: ${value ?? ''}`);
  }
  return domain;
}

/** Normalizes + deduplicates the e-mail domain allowlist. */
export function normalizeAllowedDomains(values: readonly string[]): string[] {
  if (!Array.isArray(values)) throw new ValidationError('allowedDomains must be an array');
  if (values.length > MAX_DOMAINS) {
    throw new ValidationError(`allowedDomains accepts at most ${MAX_DOMAINS} domains`);
  }
  // Preserve the caller order (the UI renders it) but drop duplicates.
  return Array.from(new Set(values.map((value) => normalizeDomain(value))));
}

/** Lowercase/trimmed e-mail (the local part is only used for logging-free lookups). */
export function normalizeEmail(value: string): string {
  const email = (value ?? '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) {
    throw new ValidationError('Invalid e-mail address');
  }
  return email;
}

/** Domain part of a normalized e-mail. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) throw new ValidationError('Invalid e-mail address');
  return normalizeDomain(email.slice(at + 1));
}

/** `true` when `domain` is in the normalized allowlist (case-insensitive). */
export function isAllowedEmailDomain(domain: string, allowedDomains: readonly string[]): boolean {
  const normalized = (domain ?? '').trim().toLowerCase();
  return allowedDomains.some((allowed) => allowed === normalized);
}

/**
 * Normalizes the `groupRoleMap` body.
 *
 * Entra ID groups/app roles travel as opaque ids (GUIDs are valid keys); the
 * mapping is case-preserving because IdPs compare group names exactly.
 */
export function normalizeGroupRoleMapInput(
  value: Record<string, string> | undefined,
): Record<string, AgentRole> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('groupRoleMap must be an object');
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_GROUP_MAPPINGS) {
    throw new ValidationError(`groupRoleMap accepts at most ${MAX_GROUP_MAPPINGS} groups`);
  }

  const map: Record<string, AgentRole> = {};
  for (const [rawKey, rawRole] of entries) {
    const key = String(rawKey).trim();
    if (key.length === 0) throw new ValidationError('groupRoleMap keys must not be empty');
    if (key.length > MAX_GROUP_NAME_LENGTH) {
      throw new ValidationError(
        `groupRoleMap keys must be at most ${MAX_GROUP_NAME_LENGTH} characters`,
      );
    }
    const role = String(rawRole).trim().toUpperCase() as AgentRole;
    if (!VALID_ROLES.includes(role)) {
      throw new ValidationError(`Unsupported role for group "${key}": ${String(rawRole)}`);
    }
    map[key] = role;
  }
  return map;
}

/** First entry of the comma-separated `WEB_ORIGIN` (the SPA origin). */
export function firstOrigin(value: string): string | null {
  const origin = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return origin === undefined ? null : origin.replace(/\/+$/, '');
}

/** Default callback registered at the IdP: `<APP_BASE_URL>/api/v1/auth/sso/callback`. */
export function defaultRedirectUri(appBaseUrl: string): string {
  return `${appBaseUrl.replace(/\/+$/, '')}${SSO_CALLBACK_PATH}`;
}
