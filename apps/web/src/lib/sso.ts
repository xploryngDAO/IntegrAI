/**
 * Fase 5 — SSO corporativo (Microsoft Entra ID): helpers shared by `/login`,
 * `/auth/sso/callback` and the `/settings` card.
 *
 * The API answers stable error codes (`INVALID_SSO_CODE`, `SSO_REQUIRED`,
 * `SSO_DOMAIN_NOT_ALLOWED`, …), so the UI maps them to recovery-oriented
 * messages instead of leaking a raw "invalid grant". Form helpers (domains,
 * issuer, role) also live here so both screens agree on the same rules.
 */
import { ApiClientError, apiBaseUrl } from './api';
import type { TenantSsoConfig } from './types';

/** Provider slug the API speaks; kept as a fallback for a new configuration. */
export const SSO_PROVIDER_MICROSOFT = 'microsoft';

/** The request being executed — only changes how a shared code is explained. */
export type SsoOperation = 'discover' | 'exchange' | 'read' | 'save' | 'delete';

/** Roles a provisioned operator can receive (`AgentRole` in `@sac/shared`). */
export const SSO_ROLE_OPTIONS = [
  { value: 'AGENT', label: 'Atendente' },
  { value: 'SUPERVISOR', label: 'Supervisor' },
  { value: 'ADMIN', label: 'Administrador' },
] as const;

/** `Select` options of the default role (mutable array for the DS primitive). */
export const SSO_ROLE_SELECT: { value: string; label: string }[] = SSO_ROLE_OPTIONS.map(
  (role) => ({ value: role.value, label: role.label }),
);

/** PT-BR label of a provider slug (`microsoft` → "Microsoft Entra ID"). */
export function ssoProviderLabel(provider: string | null | undefined): string {
  const value = (provider ?? '').trim();
  if (value.length === 0) return 'Microsoft Entra ID';
  switch (value.toLowerCase().replace(/[\s_-]+/g, '')) {
    case 'microsoft':
    case 'microsoftentra':
    case 'microsoftentraid':
    case 'entra':
    case 'entraid':
    case 'azuread':
    case 'azure':
      return 'Microsoft Entra ID';
    default:
      // An unknown provider is shown raw: the operator needs the exact slug.
      return value;
  }
}

/**
 * Public start URL that redirects (302) to the IdP.
 *
 * The browser must leave the SPA, so this is a full navigation — not a fetch —
 * and it has to be absolute when the API lives on another origin.
 */
export function ssoStartUrl(email: string): string {
  return `${apiBaseUrl()}/auth/sso/start?email=${encodeURIComponent(email.trim())}`;
}

/**
 * Callback URL the app registration must register (read-only in `/settings`).
 * Derived from the same base as the API client, so a deployment that points the
 * SPA at another host still shows the URL the backend actually serves.
 */
export function ssoRedirectUri(): string {
  return `${apiBaseUrl()}/auth/sso/callback`;
}

/**
 * Whether the tenant has a usable configuration.
 *
 * A configured workspace has the three OIDC identifiers plus a stored secret;
 * `enabled` is a separate switch (configured but turned off is a valid state).
 */
export function hasSsoConfiguration(config: TenantSsoConfig | null): boolean {
  if (config === null) return false;
  return (
    config.clientSecretConfigured &&
    config.provider.trim().length > 0 &&
    config.issuerUrl.trim().length > 0 &&
    config.clientId.trim().length > 0
  );
}

/* ==========================================================================
 * Form helpers (`/settings` → "Autenticação corporativa")
 * ========================================================================== */

/** One domain per line, or comma/semicolon separated. */
export function formatAllowedDomains(domains: readonly string[]): string {
  return domains.join('\n');
}

export interface ParsedDomains {
  /** Normalised (`empresa.com.br`), deduplicated, in input order. */
  domains: string[];
  /** Entries that are not a plausible domain (reported on the field). */
  invalid: string[];
}

const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Parses the "domínios permitidos" textarea.
 *
 * Accepts the shapes an operator actually pastes (`@empresa.com.br`,
 * `Empresa.com.br.`, lists separated by comma) and keeps the API's view: the
 * list is lower-cased and deduplicated, and anything invalid is reported
 * instead of silently dropped.
 */
export function parseAllowedDomains(value: string): ParsedDomains {
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const raw of value.split(/[\s,;]+/)) {
    const domain = raw
      .trim()
      .replace(/^@+/, '')
      .replace(/\.+$/, '')
      .toLowerCase();
    if (domain.length === 0) continue;
    if (!DOMAIN_PATTERN.test(domain)) {
      if (!invalid.includes(raw.trim())) invalid.push(raw.trim());
      continue;
    }
    if (!domains.includes(domain)) domains.push(domain);
  }
  return { domains, invalid };
}

/** Absolute http(s) issuer; the Entra ID issuer is always HTTPS. */
export function isValidIssuerUrl(value: string): boolean {
  const candidate = value.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(candidate)) return false;
  try {
    const parsed = new URL(candidate);
    return parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Server contract: `PUT /tenants/me/sso` requires a secret of 8..512 chars. */
export const SSO_SECRET_MIN_LENGTH = 8;

/** Server contract: at most 50 e-mail domains per connection. */
export const SSO_MAX_ALLOWED_DOMAINS = 50;

export interface ParsedGroupRoleMap {
  /** Normalised map (`{"<group-id>": "ADMIN"}`), ready for the API. */
  map: Record<string, string>;
  /** Operator-facing problem, or null when the value is valid. */
  error: string | null;
}

/**
 * Parses the optional "grupos → papel" JSON of the settings form.
 *
 * The API stores one map per connection and validates every value against
 * `ADMIN | SUPERVISOR | AGENT`; parsing here turns a typo into a field error
 * instead of a 422 round-trip. An empty value clears the map.
 */
export function parseGroupRoleMap(value: string): ParsedGroupRoleMap {
  const raw = value.trim();
  if (raw.length === 0) return { map: {}, error: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { map: {}, error: 'JSON inválido. Use {"<id-do-grupo>": "ADMIN"}.' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { map: {}, error: 'Use um objeto JSON: {"<id-do-grupo>": "ADMIN"}.' };
  }

  const map: Record<string, string> = {};
  for (const [group, role] of Object.entries(parsed as Record<string, unknown>)) {
    const key = group.trim();
    if (key.length === 0) continue;
    const normalizedRole = typeof role === 'string' ? role.trim().toUpperCase() : '';
    if (!SSO_ROLE_OPTIONS.some((option) => option.value === normalizedRole)) {
      return {
        map: {},
        error: `Papel inválido para o grupo "${key}": use ADMIN, SUPERVISOR ou AGENT.`,
      };
    }
    map[key] = normalizedRole;
  }
  return { map, error: null };
}

/** Pretty-printed JSON of the saved map (empty string when there is none). */
export function formatGroupRoleMap(map: Record<string, string>): string {
  const entries = Object.entries(map);
  if (entries.length === 0) return '';
  return JSON.stringify(map, null, 2);
}

/** `details.retryAfterMs` of a `429 RATE_LIMITED`, when the API sends it. */
function retryAfterHint(error: ApiClientError): string {
  const details = error.details;
  if (typeof details !== 'object' || details === null) return '';
  const raw = (details as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return '';
  const seconds = Math.max(1, Math.ceil(raw / 1_000));
  return ` Tente novamente em ~${seconds}s.`;
}

/**
 * Operator-facing text of the stable SSO error codes
 * (`SSO_ERROR_CODES` in `@sac/shared`) plus the OAuth `error` values an IdP
 * appends to the callback URL.
 *
 * The callback endpoint redirects failures to the SPA as `?error=<code>`, so
 * this table is the only place where a code becomes a sentence — both the
 * callback page and the API error mapping use it.
 */
const SSO_CODE_MESSAGE: Record<string, string> = {
  SSO_NOT_CONFIGURED:
    'SSO não configurado para este domínio. Entre com e-mail e senha ou peça a um ADMIN para habilitar o login corporativo.',
  SSO_STATE_INVALID:
    'A autorização do provedor expirou ou já foi usada. Inicie o login corporativo novamente pelo botão "Entrar com Microsoft".',
  SSO_TOKEN_INVALID:
    'O provedor recusou a validação da identidade (assinatura, emissor ou validade do token). Tente novamente; se persistir, confira a Issuer URL em /settings.',
  SSO_DOMAIN_NOT_ALLOWED:
    'O domínio deste e-mail não está na lista de domínios permitidos do SSO. Peça a um ADMIN para incluir o domínio.',
  SSO_EMAIL_UNVERIFIED:
    'O provedor não confirmou o e-mail desta conta (email_verified). Confirme o e-mail no Entra ID e tente novamente.',
  SSO_REQUIRED:
    'Este workspace exige login corporativo: a autenticação por senha está desabilitada. Entre com a Microsoft.',
  SSO_PROVIDER_ERROR:
    'O provedor de identidade não respondeu corretamente. Confira a Issuer URL e a conectividade da API e tente novamente.',
  SSO_ACCOUNT_CONFLICT:
    'Este e-mail já pertence a outro workspace. Peça a um ADMIN para revisar o cadastro antes de entrar por SSO.',
  SSO_ACCOUNT_DISABLED:
    'Seu acesso foi desativado por um administrador do workspace. Peça a reativação para entrar.',
  SSO_PROVISIONING_DISABLED:
    'Não existe operador com este e-mail neste workspace e o provisionamento automático está desligado. Peça a um ADMIN para convidar você.',
  INVALID_SSO_CODE:
    'O código do login corporativo expirou, já foi usado ou não pertence a este workspace. Inicie o login novamente pelo botão "Entrar com Microsoft".',
  SSO_CANCELLED: 'O login corporativo foi cancelado no provedor. Você pode tentar novamente quando quiser.',
  // OAuth 2.0 errors an IdP may append to the callback URL (`?error=`).
  access_denied: 'O provedor recusou o acesso ou você cancelou o login.',
  login_required: 'O provedor exige uma nova autenticação. Tente novamente.',
  interaction_required: 'O provedor exige uma interação adicional (consentimento ou MFA). Tente novamente.',
  consent_required: 'O provedor exige consentimento para os escopos solicitados (openid profile email).',
  invalid_scope: 'O provedor não aceita os escopos solicitados (openid profile email).',
  temporarily_unavailable: 'O provedor está temporariamente indisponível. Tente novamente em instantes.',
};

/**
 * Message of a stable SSO code, or `null` when the code is unknown (the caller
 * then shows the server text / the raw code instead of inventing a meaning).
 */
export function ssoCodeMessage(code: string | null | undefined): string | null {
  const value = (code ?? '').trim();
  if (value.length === 0) return null;
  return SSO_CODE_MESSAGE[value] ?? SSO_CODE_MESSAGE[value.toUpperCase()] ?? null;
}

/**
 * Operator-facing message for a real failure of an SSO request.
 *
 * A stable code is always translated; otherwise the server text is preserved
 * and 403/422 of the ADMIN endpoints stay visible (they are the real answer of
 * the API, not a generic "algo deu errado").
 */
export function ssoErrorMessage(error: unknown, operation: SsoOperation): string {
  if (!(error instanceof ApiClientError)) {
    return error instanceof Error && error.message
      ? error.message
      : 'Não foi possível falar com a API. Verifique a conexão e tente novamente.';
  }

  const known = ssoCodeMessage(error.code);
  if (known !== null) return known;
  if (error.code === 'RATE_LIMITED') {
    return `Muitas tentativas em pouco tempo (HTTP 429).${retryAfterHint(error)} Aguarde antes de tentar novamente.`;
  }

  if (error.status === 0) return error.message;
  if (error.status === 404 || error.status === 405 || error.status === 501) {
    return operation === 'discover'
      ? `A descoberta de SSO não está publicada nesta API (HTTP ${error.status}).`
      : `O SSO corporativo não está publicado nesta API (HTTP ${error.status}).`;
  }
  if (error.status === 401) {
    return operation === 'exchange'
      ? error.message
      : 'Sessão expirada ou credenciais inválidas. Entre novamente e repita a operação.';
  }
  if (error.status === 403) {
    return operation === 'read'
      ? 'Sua conta não tem permissão para ler a autenticação corporativa (HTTP 403 — apenas ADMIN do workspace).'
      : 'Sua conta não tem permissão para alterar a autenticação corporativa (HTTP 403 — apenas ADMIN do workspace).';
  }
  if (error.status === 409) {
    return `${error.message} (HTTP 409). O estado do SSO mudou em outra sessão; recarregue a configuração e tente novamente.`;
  }
  if (error.status === 422) {
    return `A API recusou a configuração (HTTP 422): ${error.message}`;
  }
  if (error.status === 429) {
    return `Muitas tentativas em pouco tempo (HTTP 429).${retryAfterHint(error)} Aguarde antes de tentar novamente.`;
  }

  return `${error.message} (HTTP ${error.status})`;
}
