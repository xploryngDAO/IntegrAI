/**
 * Typed HTTP client for docs/API_CONTRACT.md.
 *
 * Always talks to the real API: there is no offline/demo fallback anymore.
 * Infrastructure failures are surfaced as `ApiClientError` with status 0 so the
 * UI can show a real error state; 401 keeps its status so the app can gate the
 * session behind the login screen.
 */
import type {
  AccountDiagnosis,
  AgentPresenceStatus,
  AuthResponse,
  ChannelActionResult,
  ChannelHealthView,
  ConnectorDescriptor,
  IAgentSummary,
  Paginated,
  PolicyEvaluation,
  QueueSnapshot,
  RouteDecision,
  SignupResult,
  SystemDiagnosis,
  SystemStatusSnapshot,
  TicketDetail,
  TicketListItem,
  TicketStats,
} from '@sac/shared';

import type {
  AcceptInvitationBody,
  AccountRow,
  ActionBody,
  AdminInvitation,
  AdminInvitationsResult,
  AdminOverview,
  AdminSession,
  AdminSessionsQuery,
  AdminSessionsResult,
  AdminUser,
  AdminUserTwoFactorResetResult,
  AdminUserUpdate,
  AdminUsersExportQuery,
  AdminUsersQuery,
  AdminUsersResult,
  AuditLogEntry,
  AuditLogExportQuery,
  AuditLogPage,
  AuditLogQuery,
  ConnectAccountPayload,
  DeleteTenantBody,
  DownloadedFile,
  InviteUserBody,
  InviteUserResult,
  IntegrationSetup,
  IntegrationSetupChannel,
  PlatformAlert,
  PlatformAlertsResult,
  PlatformBillingEvent,
  PlatformBillingEventsResult,
  PlatformBillingSummary,
  PlatformCheckoutResult,
  PlatformMetrics,
  PlatformTenant,
  PlatformTenantBillingResult,
  PlatformTenantBillingUpdate,
  PlatformTenantMetrics,
  PlatformTenantQuery,
  PlatformTenantUpdate,
  PolicyCheckBody,
  RecoveryCodeCountResult,
  RegenerateRecoveryCodesBody,
  RegenerateRecoveryCodesResult,
  ResendInvitationResult,
  SendMessageBody,
  SignupBody,
  SsoDiscovery,
  TenantProfile,
  TenantSettingsUpdate,
  TenantSsoConfig,
  TenantSsoUpdate,
  TwoFactorDisableBody,
  TwoFactorDisableResult,
  TwoFactorEnrollResult,
  TwoFactorEnrollSetupResult,
  TwoFactorSetupResult,
  TwoFactorStatusResult,
  TwoFactorVerifyResult,
  UploadedFile,
  UserSession,
  WorkspaceFilters,
} from './types';

/* ==========================================================================
 * Configuration
 * ========================================================================== */

const API_BASE: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, '') ?? '/api/v1';

const TOKEN_STORAGE_KEY = 'sac.auth.token';
/**
 * Refresh token of the current device (returned by login/accept-invitation/SSO
 * exchange). It is what `POST /auth/logout { refreshToken }` names to revoke
 * *this* session instead of every session of the operator; it never leaves the
 * browser except in that request body.
 */
const REFRESH_STORAGE_KEY = 'sac.auth.refresh';
const REQUEST_TIMEOUT_MS = 6000;
const PAGE_SIZE = 40;
/** `GET /platform/billing/events` default/limit used by the console list. */
const BILLING_EVENTS_LIMIT = 50;

let authToken: string | null = (() => {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
})();

let refreshToken: string | null = (() => {
  try {
    return window.localStorage.getItem(REFRESH_STORAGE_KEY);
  } catch {
    return null;
  }
})();

/* ==========================================================================
 * Errors
 * ========================================================================== */

export class ApiClientError extends Error {
  /** HTTP status, or 0 for network/timeout/invalid-response failures. */
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Password accepted but the operator has 2FA enabled: the API issued NO session,
 * only a short-lived `challengeToken` (redeemed on `POST /auth/2fa/challenge`).
 *
 * It extends `ApiClientError` so existing `catch` blocks keep working, but the
 * login screen can tell it apart from a real credential failure and ask for the
 * code instead of showing "credenciais inválidas".
 */
export class TwoFactorRequiredError extends ApiClientError {
  readonly challengeToken: string;

  constructor(challengeToken: string, status = 401) {
    super(status, 'TWO_FACTOR_REQUIRED', 'A verificação em duas etapas é obrigatória para entrar.', {
      challengeToken,
    });
    this.name = 'TwoFactorRequiredError';
    this.challengeToken = challengeToken;
  }
}

/** 2FA login error contract: top-level `{ code, challengeToken }`, no envelope. */
function challengeTokenOf(error: ApiClientError): string | null {
  const details = error.details;
  if (typeof details !== 'object' || details === null) return null;
  const token = (details as { challengeToken?: unknown }).challengeToken;
  return typeof token === 'string' && token.trim().length > 0 ? token.trim() : null;
}

/**
 * Password accepted but the workspace policy requires TOTP and this operator
 * has none: the API answers 403 `TWO_FACTOR_SETUP_REQUIRED` (no session) with a
 * short-lived `setupToken` in `details`. The login screen redeems it on
 * `POST /auth/2fa/enroll/setup|verify`, then receives a real session.
 *
 * It extends `ApiClientError` so any generic handler still sees a 403, while
 * the gate can open the forced-enrollment step instead of showing a dead end.
 */
export class TwoFactorSetupRequiredError extends ApiClientError {
  readonly setupToken: string;

  constructor(setupToken: string, status = 403) {
    super(
      status,
      'TWO_FACTOR_SETUP_REQUIRED',
      'O workspace exige verificação em duas etapas: ative o app autenticador para entrar.',
      { setupToken },
    );
    this.name = 'TwoFactorSetupRequiredError';
    this.setupToken = setupToken;
  }
}

/**
 * Reads the enrollment `setupToken` from whatever shape the API answered.
 *
 * The documented contract is `{ error: { code, details: { setupToken } } }`,
 * which `apiErrorFrom` already flattens to `details.setupToken`. A deployment
 * may still answer the token at the top level, inside a second `details`
 * envelope or with the `setup_token` spelling; all are accepted, and anything
 * that is not a non-empty string is ignored (never a guessed token).
 */
function setupTokenOf(error: ApiClientError): string | null {
  const details = error.details;
  if (!isRecord(details)) return null;

  const nested = isRecord(details.details) ? details.details : null;
  const body = isRecord(details.body) ? details.body : null;
  const candidates: unknown[] = [
    details.setupToken,
    details.setup_token,
    nested?.setupToken,
    nested?.setup_token,
    body?.setupToken,
    body?.setup_token,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const token = candidate.trim();
    if (token.length > 0) return token;
  }
  return null;
}

interface RawErrorPayload {
  error?: { code?: string; message?: string; details?: unknown };
  /** Some flows answer at the top level (login with 2FA) instead of `{ error }`. */
  code?: string;
  message?: string;
  challengeToken?: string;
}

/**
 * Builds the typed client error from whatever the API answered.
 *
 * Most routes use `{ error: { code, message, details? } }`, but `POST /auth/login`
 * with 2FA answers a top-level `{ code: 'TWO_FACTOR_REQUIRED', challengeToken }`.
 * Both shapes are normalised here, and the whole body is kept as `details` for
 * top-level errors so `challengeToken` survives.
 */
function apiErrorFrom(status: number, payload: unknown): ApiClientError {
  const body = (payload ?? null) as RawErrorPayload | null;
  const envelope = body?.error;
  const topLevelCode =
    typeof body?.code === 'string' && body.code.length > 0 ? body.code : null;
  const message =
    envelope?.message ??
    (typeof body?.message === 'string' && body.message.length > 0
      ? body.message
      : `Erro HTTP ${status}.`);
  const details = envelope?.details ?? (topLevelCode !== null ? body : undefined);

  return new ApiClientError(status, envelope?.code ?? topLevelCode ?? 'HTTP_ERROR', message, details);
}

/* ==========================================================================
 * Controlled maintenance window (`503 MAINTENANCE`)
 *
 * The machine code and the back-off default mirror
 * `packages/shared/src/maintenance.ts` (the canonical contract). They are
 * duplicated here because `@sac/shared` is consumed by this SPA as types only:
 * the package build is CommonJS, so Vite cannot tree-shake a runtime re-export
 * through `dist/index.js`. Keeping the literals in the client also means the
 * banner works against a deployment that predates the shared constant.
 * ========================================================================== */

/** Stable code in `error.code` for a request refused by the maintenance guard. */
export const MAINTENANCE_ERROR_CODE = 'MAINTENANCE';

/** `Retry-After` used when the header is absent or unparsable (seconds). */
export const MAINTENANCE_RETRY_AFTER_SECONDS = 60;

/** Defensive fallback when the 503 body carries no usable message. */
export const DEFAULT_MAINTENANCE_MESSAGE =
  'Sistema em manutenção programada. Tente novamente em instantes.';

/**
 * Browser event emitted for every API response refused by the maintenance
 * guard (`503 { error: { code: 'MAINTENANCE', message } }` + `Retry-After`).
 *
 * It exists because the window is global state, not a page failure: the banner
 * must be the same on the public landing, the credential gate and the
 * workspace, including when the failure happens during the boot probe. The
 * event is dispatched before the `ApiClientError` is thrown so the app hears
 * about the window even when the caller re-renders a generic error state.
 */
export const MAINTENANCE_EVENT = 'sac:maintenance';

/** `detail` payload of `MAINTENANCE_EVENT`. */
export interface MaintenanceEventDetail {
  /** Operator-facing text answered by the API (`error.message`). */
  message: string;
  /** `Retry-After` header in seconds (default 60 when absent/invalid). */
  retryAfterSeconds: number;
}

/**
 * `Retry-After` is delta-seconds on this contract (the server always writes an
 * integer). An unparsable/absent header falls back to the shared default, and a
 * positive value is rounded up so the countdown never promises less than the
 * API asked for.
 */
function maintenanceRetryAfter(header: string | null): number {
  if (header !== null) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds > 0) return Math.max(1, Math.ceil(seconds));
  }
  return MAINTENANCE_RETRY_AFTER_SECONDS;
}

function announceMaintenance(message: string, retryAfterSeconds: number): void {
  try {
    window.dispatchEvent(
      new CustomEvent<MaintenanceEventDetail>(MAINTENANCE_EVENT, {
        detail: { message, retryAfterSeconds },
      }),
    );
  } catch {
    // No window (SSR/tests): the ApiClientError still reaches the caller.
  }
}

/**
 * Builds the typed client error from a failed response and announces a
 * maintenance window before throwing it.
 *
 * Every other status keeps exactly the previous behaviour: only a `503` whose
 * machine code is `MAINTENANCE` reaches the app-wide banner.
 */
function apiErrorFromResponse(response: Response, payload: unknown): ApiClientError {
  const error = apiErrorFrom(response.status, payload);
  if (error.status === 503 && error.code === MAINTENANCE_ERROR_CODE) {
    announceMaintenance(error.message, maintenanceRetryAfter(response.headers.get('retry-after')));
  }
  return error;
}

export function setAuthToken(token: string | null): void {
  authToken = token;
  // Clearing the access token also drops the paired refresh token: leaving a
  // stale refresh behind would let a later logout name a session that is gone.
  if (token === null) setRefreshToken(null);
  try {
    if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode) — the in-memory token still works.
  }
}

function setRefreshToken(token: string | null): void {
  refreshToken = token;
  try {
    if (token) window.localStorage.setItem(REFRESH_STORAGE_KEY, token);
    else window.localStorage.removeItem(REFRESH_STORAGE_KEY);
  } catch {
    // Same as above: the in-memory value is enough for this page load.
  }
}

/**
 * Persists the whole session returned by login / invitation / SSO exchange /
 * 2FA challenge / forced enrollment. Always use this instead of `setAuthToken`
 * on success so the single-device logout can name the refresh token.
 *
 * Only the two credential fields are read, so a response that carries extra
 * fields (the enroll route adds `recoveryCodes`) is accepted structurally.
 */
function persistSession(auth: { token: string; refreshToken?: string | null }): void {
  setAuthToken(auth.token);
  setRefreshToken(auth.refreshToken ?? null);
}

/** Refresh token of the session open in this browser (null when unknown). */
export function currentRefreshToken(): string | null {
  return refreshToken;
}

/** Discards every local credential (access + refresh). */
export function clearSessionTokens(): void {
  setAuthToken(null);
}

/**
 * Whether the browser holds a session token.
 *
 * Public pages that skip the `/auth/me` probe (a checkout return URL opened from
 * the payment provider) use this to offer `/platform` instead of `/login`
 * without waiting on — or depending on — the API. It is a hint only: the server
 * keeps enforcing every route.
 */
export function hasAuthToken(): boolean {
  return authToken !== null;
}

/**
 * Absolute URL of the API base (never with a trailing slash).
 *
 * `VITE_API_BASE_URL` is either absolute (API on another host) or a same-origin
 * path (`/api/v1`, the default when the SPA is served behind the API proxy).
 * Things the browser has to open by itself — the SSO start redirect and the
 * callback URI registered at the IdP — need the absolute form, so both are
 * derived here instead of being hardcoded in the pages.
 */
export function apiBaseUrl(): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(API_BASE)) return API_BASE;
  try {
    return new URL(API_BASE, window.location.origin).toString().replace(/\/+$/, '');
  } catch {
    return API_BASE;
  }
}

/* ==========================================================================
 * HTTP plumbing
 * ========================================================================== */

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  formData?: FormData;
  headers?: Record<string, string>;
  /**
   * Explicit bearer for the few public-but-tokenised routes (2FA enrollment).
   *
   * `undefined` keeps the stored session token; `null` sends no Authorization
   * header at all. The forced-enrollment calls happen before any session
   * exists, and a stale token from a previous login in the same browser must
   * never replace the short-lived `setupToken`.
   */
  bearerToken?: string | null;
  timeoutMs?: number;
  /**
   * Fetch cache mode. The public status page asks for `no-store` so the manual
   * refresh is a real check instead of a 30 s cached snapshot.
   */
  cache?: RequestCache;
  /**
   * Accepts a successful response without a JSON body (204/205/empty 2xx).
   * Logout answers 204 and a 204 must never surface as an invalid response.
   */
  allowEmpty?: boolean;
}

function unwrap<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

/** Trimmed non-empty string, or `null` (the API may serialise `''`/absent). */
function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Array of trimmed non-empty strings; anything invalid is dropped. */
function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => optionalText(entry))
    .filter((entry): entry is string => entry !== null);
}

/**
 * `GET|PUT /tenants/me/sso` read model.
 *
 * The API owns the truth; this only coerces the shape so a missing field is
 * rendered as "não configurado" instead of an invented value. The OAuth secret
 * is never part of the payload — at most the `clientSecretConfigured` flag.
 */
function normalizeTenantSsoConfig(payload: unknown): TenantSsoConfig {
  const raw =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  const groupRoleMap: Record<string, string> = {};
  if (
    raw.groupRoleMap !== null &&
    typeof raw.groupRoleMap === 'object' &&
    !Array.isArray(raw.groupRoleMap)
  ) {
    for (const [group, role] of Object.entries(raw.groupRoleMap as Record<string, unknown>)) {
      const key = group.trim();
      const value = optionalText(role);
      if (key.length > 0 && value !== null) groupRoleMap[key] = value;
    }
  }

  return {
    provider: optionalText(raw.provider) ?? '',
    issuerUrl: optionalText(raw.issuerUrl) ?? '',
    clientId: optionalText(raw.clientId) ?? '',
    clientSecretConfigured: raw.clientSecretConfigured === true,
    redirectUri: optionalText(raw.redirectUri),
    allowedDomains: textList(raw.allowedDomains).map((domain) =>
      domain.replace(/^@/, '').toLowerCase(),
    ),
    groupRoleMap,
    autoProvision: raw.autoProvision === true,
    defaultRole: optionalText(raw.defaultRole) ?? 'AGENT',
    enforceSso: raw.enforceSso === true,
    enabled: raw.enabled === true,
  };
}

function encodeQuery(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the timestamp-based key
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalises a failed `fetch` (abort or network) into a typed client error. */
function transportError(error: unknown): ApiClientError {
  if (isAbortError(error)) {
    return new ApiClientError(
      0,
      'TIMEOUT',
      'Tempo esgotado ao falar com a API. Verifique a conexão e tente novamente.',
    );
  }
  return new ApiClientError(
    0,
    'NETWORK_ERROR',
    'Falha de rede ao falar com a API. Verifique a conexão e tente novamente.',
  );
}

/**
 * Single-flight refresh: several concurrent 401s must rotate the session once,
 * not race each other (the API rotates the refresh token on every call).
 */
let refreshInFlight: Promise<boolean> | null = null;

/** Unauthenticated auth flows: a 401 there must surface, never refresh. */
const NO_REFRESH_PATHS = [
  '/auth/login',
  '/auth/refresh',
  '/auth/2fa',
  '/auth/sso',
  '/auth/verify-email',
  '/auth/accept-invitation',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/logout',
  '/auth/invitations',
] as const;

async function rotateSession(): Promise<boolean> {
  if (refreshToken === null) return false;
  if (refreshInFlight !== null) return refreshInFlight;

  const pending = (async (): Promise<boolean> => {
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) return false;
      const payload: unknown = await response.json().catch(() => null);
      if (payload === null) return false;
      const auth = unwrap<AuthResponse>(payload);
      if (typeof auth?.token !== 'string' || auth.token.length === 0) return false;
      persistSession(auth);
      return true;
    } catch {
      return false;
    }
  })();

  refreshInFlight = pending;
  try {
    return await pending;
  } finally {
    if (refreshInFlight === pending) refreshInFlight = null;
  }
}

/**
 * The refresh token is gone or revoked: drop every local credential and notify
 * the app so the router renders the login screen (never keep a dead session).
 */
function expireSession(): void {
  clearSessionTokens();
  try {
    window.dispatchEvent(new Event('sac:session-expired'));
  } catch {
    // No window (SSR/tests): clearing the tokens is still enough.
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const headers: Record<string, string> = { Accept: 'application/json', ...(options.headers ?? {}) };
  const bearer = options.bearerToken === undefined ? authToken : options.bearerToken;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  let body: BodyInit | undefined;
  if (options.formData) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  try {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body,
        cache: options.cache,
        signal: controller.signal,
      });
    } catch (error) {
      throw transportError(error);
    }

    // Access token expired mid-session: rotate the refresh token once and
    // replay the request. Only the unauthenticated auth flows are excluded so a
    // wrong password (401) never triggers a silent refresh loop; protected
    // routes such as `/auth/me` DO refresh.
    if (
      response.status === 401 &&
      authToken !== null &&
      options.bearerToken === undefined &&
      !NO_REFRESH_PATHS.some((prefix) => path.startsWith(prefix))
    ) {
      const rotated = await rotateSession();
      if (!rotated) {
        expireSession();
        throw new ApiClientError(
          401,
          'SESSION_EXPIRED',
          'Sua sessão expirou. Entre novamente para continuar.',
        );
      }
      headers.Authorization = `Bearer ${authToken ?? ''}`;
      try {
        response = await fetch(`${API_BASE}${path}`, {
          method: options.method ?? 'GET',
          headers,
          body,
          cache: options.cache,
          signal: controller.signal,
        });
      } catch (error) {
        throw transportError(error);
      }
    }

    // 204 has no body by definition; parsing it would surface a false
    // INVALID_RESPONSE on a successful delete/logout.
    if (response.status === 204) return undefined as T;

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw apiErrorFromResponse(response, payload);
    }
    if (payload === null) {
      if (options.allowEmpty) return undefined as T;
      throw new ApiClientError(
        0,
        'INVALID_RESPONSE',
        'A API respondeu sem um corpo JSON válido. Verifique o servidor.',
      );
    }
    return unwrap<T>(payload);
  } finally {
    window.clearTimeout(timeout);
  }
}

/* ==========================================================================
 * Authenticated file download (`GET /admin/audit-logs/export.csv`)
 *
 * `request()` always parses JSON, so binary/text artifacts travel through this
 * dedicated path: same bearer token, same error envelope, but the body is kept
 * as a Blob and the file name comes from `Content-Disposition` when present.
 * ========================================================================== */

/** Export of a whole trail can take longer than a page read. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Strips path separators/control chars so the server name is safe on disk. */
function sanitizeFileName(value: string): string | null {
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .trim();
  return name.length > 0 ? name : null;
}

/**
 * Reads `Content-Disposition` honoring both `filename=` and the RFC 5987
 * `filename*=UTF-8''…` form. Returns null when the header has no usable name.
 */
function fileNameFromDisposition(header: string | null): string | null {
  if (header === null || header.trim().length === 0) return null;

  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (extended !== null) {
    const value = extended[1].trim().replace(/^["']|["']$/g, '');
    // RFC 5987 shape: charset'language'percent-encoded-value.
    const parts = value.split("''");
    const raw = parts.length > 1 ? parts.slice(1).join("''") : value;
    try {
      return sanitizeFileName(decodeURIComponent(raw));
    } catch {
      return sanitizeFileName(raw);
    }
  }

  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  if (plain !== null) {
    return sanitizeFileName((plain[1] ?? plain[2] ?? '').trim());
  }
  return null;
}

async function downloadFile(
  path: string,
  options: { timeoutMs?: number } = {},
): Promise<DownloadedFile> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
  );
  // The route is authenticated like any other one: the bearer token goes in the
  // header (never in the URL) and the browser receives the bytes, so the SPA can
  // name the download from the server's `Content-Disposition`.
  const headers: Record<string, string> = {
    Accept: 'text/csv, application/octet-stream;q=0.9, */*;q=0.8',
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  try {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      throw transportError(error);
    }

    if (!response.ok) {
      // Error bodies are still the JSON envelope on the CSV route, so the real
      // `code`/`message` (403/409/…) reaches the screen. A maintenance 503 is
      // also announced on the global event (same banner as the JSON routes).
      const payload: unknown = await response.json().catch(() => null);
      throw apiErrorFromResponse(response, payload);
    }

    const contentType = response.headers.get('content-type');
    // A deployment behind the contract may answer JSON on the CSV route: saving
    // that as `.csv` would hide the problem, so it is surfaced as an error.
    if (contentType !== null && /json/i.test(contentType)) {
      throw new ApiClientError(
        0,
        'INVALID_RESPONSE',
        'A API respondeu JSON em vez do arquivo CSV. Confirme a versão do servidor e tente novamente.',
      );
    }

    // A zero-row export can legitimately be a header-only (or empty) CSV, so an
    // empty body is still a successful download — not an invented error.
    const blob = await response.blob();
    return {
      blob,
      fileName: fileNameFromDisposition(response.headers.get('content-disposition')),
      contentType,
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

/* ==========================================================================
 * Client interface (docs/UI_KIT.md §1 + `me()` used by the boot sequence)
 * ========================================================================== */

/**
 * Slugs accepted by `POST /accounts/oauth/:marketplace/start`.
 *
 * `amazon` is the Fase 2 flow (docs/PHASE2_ONBOARDING.md §2). The endpoint is
 * optional: while the server has no Amazon OAuth it answers 404/405/422 and the
 * onboarding UI degrades to "indisponível, fale com o suporte".
 */
export type OAuthMarketplaceSlug = 'mercadolivre' | 'shopee' | 'amazon';

export interface ApiClient {
  /**
   * Opens a session. When the operator has 2FA enabled the API answers
   * `TWO_FACTOR_REQUIRED` and no token: this rejects with
   * `TwoFactorRequiredError` (carrying `challengeToken`) instead of a session,
   * and the caller completes the login with `twoFactorChallenge()`.
   */
  login(email: string, password: string): Promise<AuthResponse>;
  me(): Promise<IAgentSummary>;
  /**
   * Public availability snapshot (`GET /status`) consumed by `/status`.
   * Requires no session: the page renders even when the credential gate cannot
   * reach the API.
   */
  status(): Promise<SystemStatusSnapshot>;
  /** Creates tenant + first ADMIN and mails the verification link (public). */
  signup(body: SignupBody): Promise<SignupResult>;
  /** Consumes the single-use verification token (public). */
  verifyEmail(token: string): Promise<{ verified: boolean }>;
  /** Always answers 202, whether the account exists or not (public). */
  resendVerification(email: string): Promise<{ status: string }>;
  /** Always answers 202, no account enumeration (public). */
  forgotPassword(email: string): Promise<{ status: string }>;
  /** Consumes the reset token and revokes every session of the operator (public). */
  resetPassword(token: string, password: string): Promise<{ reset: boolean }>;
  /**
   * Consumes the single-use invitation token, creates the invited operator and
   * opens a session (public) — same `AuthResponse` as `login()`.
   */
  acceptInvitation(body: AcceptInvitationBody): Promise<AuthResponse>;
  /* ---- Fase 5: SSO corporativo (Microsoft Entra ID) ---- */
  /**
   * `GET /auth/sso/discover?email=` (public) — whether the e-mail's domain uses
   * SSO. It is the gate of the "Entrar com Microsoft" button: the redirect to
   * the IdP only happens when the API says `enabled`. A `404/409
   * SSO_NOT_CONFIGURED` is normalised to `enabled: false` (an answer, not an
   * outage).
   */
  ssoDiscover(email: string): Promise<SsoDiscovery>;
  /**
   * `POST /auth/sso/exchange` (public) — redeems the single-use `code` the
   * backend appended to the SPA callback URL and opens the session (same
   * `AuthResponse` as `login()`; the JWT is persisted here).
   */
  ssoExchange(code: string): Promise<AuthResponse>;
  /** `GET /tenants/me/sso` (ADMIN) — config without the secret; null when absent. */
  tenantSso(): Promise<TenantSsoConfig | null>;
  /**
   * `PUT /tenants/me/sso` (ADMIN) — full update (omit `clientSecret` to keep the
   * stored one). Returns the saved config when the API sends it back.
   */
  updateTenantSso(body: TenantSsoUpdate): Promise<TenantSsoConfig | null>;
  /** `DELETE /tenants/me/sso` (ADMIN) — removes the tenant configuration. */
  deleteTenantSso(): Promise<void>;
  /* ---- Two-factor authentication (Fase 1: TOTP) ---- */
  /** `GET /auth/2fa/status` — whether this operator has TOTP enabled. */
  twoFactorStatus(): Promise<TwoFactorStatusResult>;
  /** `POST /auth/2fa/setup` — pending secret + `otpauth://` URL (returned once). */
  twoFactorSetup(): Promise<TwoFactorSetupResult>;
  /** `POST /auth/2fa/verify` — confirms the pending secret and enables 2FA. */
  twoFactorVerify(code: string): Promise<TwoFactorVerifyResult>;
  /** `POST /auth/2fa/disable` — requires the account password + TOTP/recovery code. */
  twoFactorDisable(body: TwoFactorDisableBody): Promise<TwoFactorDisableResult>;
  /**
   * `POST /auth/2fa/challenge` — public: exchanges the login `challengeToken`
   * plus a TOTP/recovery code for the same session `login()` would issue.
   * Persists the JWT in the client (like `login()` does).
   */
  twoFactorChallenge(challengeToken: string, code: string): Promise<AuthResponse>;
  /**
   * `POST /auth/2fa/enroll/setup` — public route authorised by the short-lived
   * `setupToken` of a `TWO_FACTOR_SETUP_REQUIRED` login (sent as the bearer).
   * Returns the pending TOTP secret + `otpauth://` URI, both shown only once.
   */
  twoFactorEnrollSetup(setupToken: string): Promise<TwoFactorEnrollSetupResult>;
  /**
   * `POST /auth/2fa/enroll/verify` — public route authorised by `setupToken`;
   * confirms the 6-digit code, **persists the issued session** (exactly like
   * `login()`) and returns the recovery codes, shown once.
   */
  twoFactorEnrollVerify(setupToken: string, code: string): Promise<TwoFactorEnrollResult>;
  /** `GET /auth/2fa/recovery-codes/count` — unused codes left for this operator. */
  recoveryCodesCount(): Promise<RecoveryCodeCountResult>;
  /**
   * `POST /auth/2fa/recovery-codes/regenerate` — replaces every recovery code.
   * Requires the account password + a valid TOTP/recovery code; the 8 new
   * codes are returned exactly once.
   */
  regenerateRecoveryCodes(
    body: RegenerateRecoveryCodesBody,
  ): Promise<RegenerateRecoveryCodesResult>;
  listTickets(
    filters: WorkspaceFilters,
    page?: number,
  ): Promise<{ items: TicketListItem[]; total: number; totalPages: number }>;
  getTicket(id: string): Promise<TicketDetail>;
  sendMessage(
    ticketId: string,
    body: SendMessageBody,
  ): Promise<{ messageId: string; routeUsed: string; deliveryStatus: string; warnings: string[] }>;
  policyCheck(ticketId: string, body: PolicyCheckBody): Promise<PolicyEvaluation>;
  resolveRoute(ticketId: string, recipient?: 'BUYER' | 'MEDIATOR'): Promise<RouteDecision>;
  runAction(ticketId: string, body: ActionBody): Promise<ChannelActionResult>;
  assignTicket(ticketId: string, agentId: string): Promise<unknown>;
  changeStatus(ticketId: string, status: TicketListItem['status']): Promise<unknown>;
  closeWithoutResponse(ticketId: string): Promise<unknown>;
  markRead(ticketId: string): Promise<unknown>;
  addNote(ticketId: string, text: string): Promise<TicketDetail['messages'][number]>;
  queueSnapshot(filters?: WorkspaceFilters): Promise<QueueSnapshot>;
  stats(): Promise<TicketStats>;
  channelHealth(): Promise<ChannelHealthView[]>;
  listAgents(): Promise<IAgentSummary[]>;
  setPresence(presence: AgentPresenceStatus): Promise<unknown>;
  listAccounts(): Promise<AccountRow[]>;
  connectors(): Promise<ConnectorDescriptor[]>;
  startOAuth(
    marketplace: OAuthMarketplaceSlug,
    displayName: string,
  ): Promise<{ authorizeUrl: string; state: string }>;
  connectAccount(payload: ConnectAccountPayload): Promise<{ accountId: string; displayName: string }>;
  disconnectAccount(id: string): Promise<void>;
  refreshAccount(id: string): Promise<{ ok: boolean; detail: string }>;
  uploadFile(file: File): Promise<UploadedFile>;
  signedUrl(key: string): Promise<{ url: string }>;
  /**
   * Marks the tenant onboarding as completed (`PATCH /tenants/me`).
   * Optional endpoint (docs/PHASE2_ONBOARDING.md §3): callers must treat 404/405
   * as "not deployed" and simply navigate.
   */
  completeOnboarding(): Promise<unknown>;
  /** Workspace profile of the authenticated tenant (`GET /tenants/me`). */
  tenantProfile(): Promise<TenantProfile>;
  /**
   * `PATCH /tenants/me` (ADMIN) — workspace security policy (`require2fa`).
   * Resolves the value the API acknowledged, or `null` when it answered 204 /
   * without the field (the caller then re-reads `tenantProfile()`).
   */
  updateTenantSettings(body: TenantSettingsUpdate): Promise<boolean | null>;
  /** Full LGPD export of the tenant (`GET /tenants/me/export`, ADMIN). */
  exportTenantData(): Promise<unknown>;
  /** LGPD workspace deletion (`DELETE /tenants/me`, ADMIN + password/slug). */
  deleteTenant(body: DeleteTenantBody): Promise<void>;
  /** Global platform counters (`GET /platform/metrics`, platform admin). */
  platformMetrics(): Promise<PlatformMetrics>;
  /** Paginated tenants of the platform console (`GET /platform/tenants`). */
  platformTenants(query: PlatformTenantQuery): Promise<Paginated<PlatformTenant>>;
  /** Plan/limits update of one tenant (`PATCH /platform/tenants/:id`). */
  updatePlatformTenant(
    id: string,
    body: PlatformTenantUpdate,
  ): Promise<PlatformTenant | null>;
  /** Per-tenant metrics of the console (`GET /platform/tenants/:id/metrics`). */
  platformTenantMetrics(id: string): Promise<PlatformTenantMetrics>;
  /** Active operational alerts (`GET /platform/alerts`). */
  platformAlerts(): Promise<PlatformAlert[]>;
  /** Platform billing summary (`GET /platform/billing/summary`). */
  platformBillingSummary(): Promise<PlatformBillingSummary>;
  /** Billing fields of one tenant (`PATCH /platform/tenants/:id/billing`). */
  updatePlatformTenantBilling(
    id: string,
    body: PlatformTenantBillingUpdate,
  ): Promise<PlatformTenantBillingResult | null>;
  /**
   * Hosted checkout URL of one tenant (`POST /platform/tenants/:id/checkout`).
   * The API only renders the URL from a template: `503 BILLING_NOT_CONFIGURED`
   * means the deployment has no `BILLING_CHECKOUT_URL_TEMPLATE`.
   */
  platformTenantCheckout(id: string): Promise<PlatformCheckoutResult>;
  /**
   * Audit trail of the billing gateway callbacks
   * (`GET /platform/billing/events?limit=`), newest first.
   */
  platformBillingEvents(limit?: number): Promise<PlatformBillingEventsResult>;
  /**
   * Public values to create the marketplace apps (`GET /platform/integration-setup`,
   * platform admin). The page renders exactly what the API returned; `missing`
   * lists the env variables the deployment still needs.
   */
  integrationSetup(): Promise<IntegrationSetup>;
  /* ---- Conta do operador (perfil + sessões) ---- */
  /**
   * `PATCH /auth/me { name }` — updates the display name and answers the
   * refreshed operator summary.
   */
  updateProfile(name: string): Promise<IAgentSummary>;
  /** `GET /auth/sessions` — refresh sessions of the authenticated operator. */
  sessions(): Promise<UserSession[]>;
  /** `DELETE /auth/sessions/:id` — revokes one session (204). */
  revokeSession(id: string): Promise<void>;
  /** `POST /auth/sessions/revoke-others` — revokes every other device. */
  revokeOtherSessions(): Promise<{ revoked: number }>;
  /* ---- Administração do workspace (ADMIN) ---- */
  /**
   * `GET /admin/overview` — the workspace counters above the `/admin` tabs
   * (users, sessions, invitations, accounts, tickets and the 24h audit count).
   *
   * Every counter is normalised before it reaches the page: an absent field is
   * `0` and a negative/invalid value is clamped to `0`. That is a deliberate
   * trade: the overview is a real snapshot of the workspace, and a metric the
   * deployment did not send must render as "zero now" instead of a blank card.
   */
  adminOverview(): Promise<AdminOverview>;
  /**
   * `GET /admin/users?search=&role=&status=&page=&perPage=` — one page of the
   * workspace operators and the total of the filtered set (server-side filters
   * and pagination; the CSV export shares the same filters).
   */
  adminUsers(query?: AdminUsersQuery): Promise<AdminUsersResult>;
  /**
   * `GET /admin/users/export.csv?search=&role=&status=` — every operator
   * matching the applied filters as an authenticated `text/csv` download.
   */
  exportAdminUsersCsv(query: AdminUsersExportQuery): Promise<DownloadedFile>;
  /** `PATCH /admin/users/:id` — role and/or active flag. */
  updateAdminUser(id: string, body: AdminUserUpdate): Promise<AdminUser>;
  /**
   * `POST /admin/users/:id/reset-2fa` — removes the target's TOTP enrollment
   * and closes every live session of that operator.
   *
   * `409 CANNOT_RESET_OWN_2FA` refuses the caller's own account (self-service
   * disable lives in `/settings`), `409 TWO_FACTOR_NOT_ENABLED` means the row
   * was stale, and `404` that the operator is unknown or belongs to another
   * tenant. All of them keep their real code/message in `ApiClientError`.
   */
  resetAdminUserTwoFactor(id: string): Promise<AdminUserTwoFactorResetResult>;
  /** `POST /admin/users/:id/revoke-sessions` — closes every session of one user. */
  revokeUserSessions(id: string): Promise<{ revoked: number }>;
  /**
   * `GET /admin/sessions?page=&perPage=` — one page of the **active sessions**
   * of the workspace, with the operator that owns each one and the `current`
   * flag of the session that issued this request.
   */
  adminSessions(query?: AdminSessionsQuery): Promise<AdminSessionsResult>;
  /**
   * `DELETE /admin/sessions/:id` (204) — revokes one operator session.
   * `404` means it is already gone and `409 CANNOT_REVOKE_CURRENT_SESSION` that
   * it is the session of the current request (the API never lets it revoke
   * itself through this administrative route).
   */
  revokeAdminSession(id: string): Promise<void>;
  /** `GET /admin/audit-logs` — filtered, paginated administrative trail. */
  auditLogs(query: AuditLogQuery): Promise<AuditLogPage>;
  /**
   * `GET /admin/audit-logs/export.csv` — the whole trail matching the filters
   * that are active in the tab, as an authenticated download (`text/csv`).
   */
  exportAuditLogsCsv(query: AuditLogExportQuery): Promise<DownloadedFile>;
  /** `GET /admin/invitations` — pending/accepted/expired invitations. */
  adminInvitations(): Promise<AdminInvitationsResult>;
  /**
   * `DELETE /admin/invitations/:id` (204) — revokes a **pending** invitation.
   * `409 INVITATION_ALREADY_ACCEPTED` means the invitee accepted meanwhile.
   */
  revokeInvitation(id: string): Promise<void>;
  /**
   * `POST /admin/invitations/:id/resend` — re-issues the single-use link and
   * mails it again. Offered for **PENDING** and **EXPIRED** rows only.
   *
   * `404` means the invitation is gone, `409 INVITATION_ALREADY_ACCEPTED` that
   * the invitee accepted meanwhile, and `502 EMAIL_SEND_FAILED` that the API
   * could not deliver the e-mail. Resolves `null` when the API confirms the
   * re-send without returning the invitation body; the caller re-reads the list.
   */
  resendInvitation(id: string): Promise<ResendInvitationResult | null>;
  /**
   * `POST /invitations` (Fase 1, ADMIN) — mails the invitation link. Used by the
   * "Convidar operador" CTA of `/admin`.
   */
  inviteUser(body: InviteUserBody): Promise<InviteUserResult>;
  /**
   * Revokes the current session server-side (`POST /auth/logout`).
   *
   * With `refreshToken` only that session is revoked; without it the API
   * performs "logout everywhere". The token is optional because an older API
   * may not have returned one.
   */
  logout(refreshToken?: string | null): Promise<void>;
  /** Live infrastructure + every connected account (ADMIN). */
  diagnostics(): Promise<SystemDiagnosis>;
  /** Real marketplace token/profile checks for a single account (ADMIN). */
  diagnoseAccount(id: string): Promise<AccountDiagnosis>;
}

/* ==========================================================================
 * Account / administration normalisation
 *
 * The routes are contracted, but a deployment can be ahead or behind this UI:
 * every collection is validated item by item so a missing field renders as
 * "—" instead of crashing the page, and an invalid row is dropped rather than
 * invented. Rows are never fabricated from absent data.
 * ========================================================================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asTextOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asIsoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

function asCounter(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
  }
  return 0;
}

/**
 * Boolean flag that may be absent on an older deployment.
 *
 * `null` is a real answer — "the API did not publish this field" — so it is
 * kept apart from `false`. `true/false` are accepted as boolean, `0/1` and the
 * `"true"/"false"` strings (a serialiser in the middle may change the type);
 * anything else is treated as absent rather than guessed.
 */
function asOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return null;
}

/** Positive integer (>= 1) from a number or numeric string, else `fallback`. */
function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.trunc(parsed);
  }
  return fallback;
}

/**
 * `PATCH /auth/me` answers the operator summary — some deployments wrap it in
 * `{ agent }`. Both shapes are accepted; `null` means the body was unusable.
 */
function normalizeAgentSummary(payload: unknown): IAgentSummary | null {
  if (!isRecord(payload)) return null;
  const source = isRecord(payload.agent) ? payload.agent : payload;
  const id = asTextOrNull(source.id);
  const name = asTextOrNull(source.name);
  if (id === null || name === null) return null;
  const presence =
    source.presence === 'ONLINE' || source.presence === 'PAUSED' || source.presence === 'OFFLINE'
      ? source.presence
      : 'OFFLINE';
  return {
    id,
    tenantId: asTextOrNull(source.tenantId),
    name,
    email: asTextOrNull(source.email) ?? '',
    role: asTextOrNull(source.role) ?? 'AGENT',
    presence,
    avatarColor: asTextOrNull(source.avatarColor) ?? '',
    activeTickets: asCounter(source.activeTickets),
  };
}

function normalizeUserSession(raw: unknown): UserSession | null {
  if (!isRecord(raw)) return null;
  const id = asTextOrNull(raw.id);
  if (id === null) return null;
  return {
    id,
    createdAt: asIsoOrNull(raw.createdAt) ?? '',
    lastUsedAt: asIsoOrNull(raw.lastUsedAt),
    userAgent: asTextOrNull(raw.userAgent),
    ip: asTextOrNull(raw.ip),
    current: raw.current === true,
  };
}

function normalizeAdminUser(raw: unknown): AdminUser | null {
  if (!isRecord(raw)) return null;
  const id = asTextOrNull(raw.id);
  if (id === null) return null;
  return {
    id,
    name: asTextOrNull(raw.name) ?? '—',
    email: asTextOrNull(raw.email) ?? '',
    role: asTextOrNull(raw.role) ?? 'AGENT',
    isActive: raw.isActive !== false,
    // Tolerant: an API that predates the admin 2FA column omits the field, and
    // the table must still render a boolean ("Desativado") instead of unknown.
    twoFactorEnabled: raw.twoFactorEnabled === true,
    lastLoginAt: asIsoOrNull(raw.lastLoginAt),
    createdAt: asIsoOrNull(raw.createdAt) ?? '',
    sessionsCount: asCounter(raw.sessionsCount),
  };
}

function normalizeAdminSession(raw: unknown): AdminSession | null {
  if (!isRecord(raw)) return null;
  const id = asTextOrNull(raw.id);
  // Without the id the row cannot be revoked, so it is dropped instead of
  // rendered with an action that would always fail.
  if (id === null) return null;
  return {
    id,
    agentId: asTextOrNull(raw.agentId),
    // A missing name/e-mail is rendered as "—"; it never hides the row.
    name: asTextOrNull(raw.name) ?? '—',
    email: asTextOrNull(raw.email) ?? '',
    // An absent role is "—" (`roleLabel('')`), never invented as AGENT.
    role: asTextOrNull(raw.role) ?? '',
    ip: asTextOrNull(raw.ip),
    userAgent: asTextOrNull(raw.userAgent),
    createdAt: asIsoOrNull(raw.createdAt) ?? '',
    lastUsedAt: asIsoOrNull(raw.lastUsedAt),
    // Only the API can say which session issued this request.
    current: raw.current === true,
  };
}

function normalizeAuditLog(raw: unknown): AuditLogEntry | null {
  if (!isRecord(raw)) return null;
  const id = asTextOrNull(raw.id);
  if (id === null) return null;
  return {
    id,
    action: asTextOrNull(raw.action) ?? '—',
    actorId: asTextOrNull(raw.actorId),
    actorEmail: asTextOrNull(raw.actorEmail),
    resourceType: asTextOrNull(raw.resourceType),
    resourceId: asTextOrNull(raw.resourceId),
    ip: asTextOrNull(raw.ip),
    userAgent: asTextOrNull(raw.userAgent),
    metadata: raw.metadata ?? null,
    createdAt: asIsoOrNull(raw.createdAt) ?? '',
  };
}

/**
 * Status of an invitation.
 *
 * The server enum wins. When a deployment answers without `status`, the obvious
 * state is derived from the timestamps the API did return (acceptedAt / expiry)
 * instead of hardcoding PENDING; an unknown status string is preserved verbatim
 * so a newer API is shown as-is rather than mislabelled.
 */
function normalizeInvitationStatus(
  raw: unknown,
  acceptedAt: string | null,
  expiresAt: string,
): AdminInvitation['status'] {
  const value = asTextOrNull(raw);
  if (value !== null) {
    const upper = value.toUpperCase();
    if (upper === 'PENDING' || upper === 'EXPIRED' || upper === 'ACCEPTED') return upper;
    return value;
  }
  if (acceptedAt !== null) return 'ACCEPTED';
  const expiry = new Date(expiresAt).getTime();
  if (Number.isFinite(expiry) && expiry < Date.now()) return 'EXPIRED';
  return 'PENDING';
}

function normalizeAdminInvitation(raw: unknown): AdminInvitation | null {
  if (!isRecord(raw)) return null;
  const id = asTextOrNull(raw.id);
  // Without the id the row cannot be revoked or re-read, so it is dropped
  // instead of rendered as an action that would always fail.
  if (id === null) return null;
  const acceptedAt = asIsoOrNull(raw.acceptedAt);
  const expiresAt = asIsoOrNull(raw.expiresAt) ?? '';
  return {
    id,
    // A missing e-mail is rendered as "—"; it is not a reason to hide the row.
    email: asTextOrNull(raw.email) ?? '',
    // An absent role is shown as "—" (roleLabel('')), never invented.
    role: asTextOrNull(raw.role) ?? '',
    createdAt: asIsoOrNull(raw.createdAt) ?? '',
    expiresAt,
    acceptedAt,
    status: normalizeInvitationStatus(raw.status, acceptedAt, expiresAt),
  };
}

/**
 * `POST /admin/invitations/:id/resend` read model.
 *
 * The route answers the refreshed invitation (`{ id, email, role, expiresAt,
 * status: 'PENDING' }`), but a deployment can omit fields — or the whole body —
 * without the re-send having failed. A bodyless 2xx is "confirmed, no details"
 * (`null`, the caller re-reads the list); the id falls back to the invitation
 * that was resent, and the remaining fields stay empty instead of being
 * invented. An omitted `status` is derived from the returned timestamps by
 * `normalizeAdminInvitation` (PENDING for a fresh re-send).
 */
function normalizeResendInvitation(
  payload: unknown,
  invitationId: string,
): ResendInvitationResult | null {
  if (!isRecord(payload)) return null;
  const invitation = normalizeAdminInvitation({
    ...payload,
    id: asTextOrNull(payload.id) ?? invitationId,
  });
  if (invitation === null) return null;
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
    status: invitation.status,
  };
}

/* ==========================================================================
 * Workspace overview (`GET /admin/overview`)
 * ========================================================================== */

/** Marketplaces whose breakdown row always exists, even when the API omits it. */
const OVERVIEW_MARKETPLACES = ['AMAZON', 'MERCADO_LIVRE', 'SHOPEE'] as const;

/** One group of the overview payload (`{ users: {...} }`) or the empty group. */
function overviewGroup(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return isRecord(value) ? value : {};
}

/**
 * `GET /admin/overview` read model.
 *
 * The overview is a snapshot, so the page renders every counter: a metric the
 * deployment omitted is `0` and an invalid one is clamped to `0` by `asCounter`
 * (never `NaN`/negative). A body that is not an object yields every group at
 * zero rather than an exception — the endpoint answered, the fields are what the
 * normalisation owns.
 *
 * `byMarketplace` starts with the three channels this UI knows (zeroed) and then
 * merges whatever the API sent: keys are trimmed/upper-cased (so `mercado_livre`
 * and `MERCADO_LIVRE` are the same channel, summed) and an extra channel is kept
 * so a newer deployment is displayed instead of hidden.
 */
function normalizeAdminOverview(payload: unknown): AdminOverview {
  const source = isRecord(payload) ? payload : {};
  const users = overviewGroup(source, 'users');
  const sessions = overviewGroup(source, 'sessions');
  const invitations = overviewGroup(source, 'invitations');
  const accounts = overviewGroup(source, 'accounts');
  const tickets = overviewGroup(source, 'tickets');
  const audit = overviewGroup(source, 'audit');

  const byMarketplace: Record<string, number> = {};
  for (const marketplace of OVERVIEW_MARKETPLACES) byMarketplace[marketplace] = 0;
  for (const [rawKey, rawValue] of Object.entries(
    isRecord(accounts.byMarketplace) ? accounts.byMarketplace : {},
  )) {
    const key = rawKey.trim().toUpperCase();
    if (key.length === 0) continue;
    byMarketplace[key] = (byMarketplace[key] ?? 0) + asCounter(rawValue);
  }

  return {
    users: {
      total: asCounter(users.total),
      active: asCounter(users.active),
      admins: asCounter(users.admins),
    },
    sessions: { active: asCounter(sessions.active) },
    invitations: { pending: asCounter(invitations.pending) },
    accounts: {
      total: asCounter(accounts.total),
      connected: asCounter(accounts.connected),
      byMarketplace,
    },
    tickets: {
      total: asCounter(tickets.total),
      unread: asCounter(tickets.unread),
      unassigned: asCounter(tickets.unassigned),
    },
    audit: { last24h: asCounter(audit.last24h) },
  };
}

/* ==========================================================================
 * 2FA forced enrollment (public routes, Bearer setupToken)
 * ========================================================================== */

/**
 * `POST /auth/2fa/enroll/setup` read model.
 *
 * The contract names the URI `otpauthUri`; `otpauthUrl` is accepted because the
 * operator enrollment route uses that spelling. A missing secret is a real
 * contract violation (there is nothing to show), while a missing URI only hides
 * the link — the secret alone is enough to add the account manually.
 */
function normalizeEnrollSetup(payload: unknown): TwoFactorEnrollSetupResult {
  const raw = isRecord(payload) ? payload : {};
  return {
    secret: asTextOrNull(raw.secret) ?? '',
    otpauthUri: asTextOrNull(raw.otpauthUri) ?? asTextOrNull(raw.otpauthUrl) ?? '',
  };
}

/**
 * `POST /auth/2fa/enroll/verify` read model: session credentials + codes.
 *
 * The documented body is `AuthResponse` plus `recoveryCodes`. A deployment may
 * wrap the session in `auth`/`session`; both are tolerated. The token is the
 * only mandatory field — without it the client cannot enter the workspace, so
 * the caller reports a real error instead of pretending the login worked.
 */
function normalizeEnrollVerify(payload: unknown): TwoFactorEnrollResult {
  const raw = isRecord(payload) ? payload : {};
  const session = isRecord(raw.auth)
    ? raw.auth
    : isRecord(raw.session)
      ? raw.session
      : raw;
  return {
    token: asTextOrNull(session.token) ?? '',
    refreshToken: asTextOrNull(session.refreshToken) ?? undefined,
    recoveryCodes: textList(raw.recoveryCodes),
  };
}

/* ==========================================================================
 * Real API implementation
 * ========================================================================== */

export const api: ApiClient = {
  async login(email, password) {
    try {
      const auth = await request<AuthResponse>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      // Persist the JWT before any other request runs (boot happens next).
      persistSession(auth);
      return auth;
    } catch (error) {
      // 2FA enabled: 401 `TWO_FACTOR_REQUIRED` + `challengeToken` and NO session.
      // Surface it as a typed error so the login screen can ask for the code.
      if (error instanceof ApiClientError && error.code === 'TWO_FACTOR_REQUIRED') {
        const challengeToken = challengeTokenOf(error);
        if (challengeToken !== null) {
          throw new TwoFactorRequiredError(challengeToken, error.status);
        }
      }
      // Policy requires TOTP and this operator has none: 403
      // `TWO_FACTOR_SETUP_REQUIRED` + `details.setupToken`, still no session.
      // The gate redeems the token on `/auth/2fa/enroll/*`.
      if (error instanceof ApiClientError && error.code === 'TWO_FACTOR_SETUP_REQUIRED') {
        const setupToken = setupTokenOf(error);
        if (setupToken !== null) {
          throw new TwoFactorSetupRequiredError(setupToken, error.status);
        }
      }
      throw error;
    }
  },

  me() {
    return request<IAgentSummary>('/auth/me');
  },

  async status() {
    // Public endpoint: no session is issued or consumed, so `/status` keeps
    // working for an anonymous visitor (and when `/auth/me` is unreachable).
    // `no-store` keeps the manual refresh honest: the API may answer with
    // `cache-control: max-age=30`, and a cached body would freeze `checkedAt`.
    const payload = await request<SystemStatusSnapshot>('/status', {
      timeoutMs: 8_000,
      cache: 'no-store',
    });
    // Normalise the public payload: a server deployed ahead of this UI must not
    // break the page, and a missing collection is rendered as empty — never as
    // invented data. An unknown `status` string is tolerated downstream by
    // `levelPresentation()` (it renders the raw value in a neutral tone).
    return {
      status: payload.status,
      checkedAt: typeof payload.checkedAt === 'string' ? payload.checkedAt : '',
      services: Array.isArray(payload.services) ? payload.services : [],
      channels: Array.isArray(payload.channels) ? payload.channels : [],
    };
  },

  twoFactorStatus() {
    return request<TwoFactorStatusResult>('/auth/2fa/status', { timeoutMs: 8_000 });
  },

  twoFactorSetup() {
    return request<TwoFactorSetupResult>('/auth/2fa/setup', {
      method: 'POST',
      timeoutMs: 10_000,
    });
  },

  twoFactorVerify(code) {
    return request<TwoFactorVerifyResult>('/auth/2fa/verify', {
      method: 'POST',
      body: { code },
      timeoutMs: 10_000,
    });
  },

  twoFactorDisable(body) {
    return request<TwoFactorDisableResult>('/auth/2fa/disable', {
      method: 'POST',
      body,
      // bcrypt of the password + code check run inside this request.
      timeoutMs: 20_000,
    });
  },

  async twoFactorChallenge(challengeToken, code) {
    const auth = await request<AuthResponse>('/auth/2fa/challenge', {
      method: 'POST',
      body: { challengeToken, code },
      timeoutMs: 15_000,
    });
    // The challenge issues a real session: persist it before boot runs.
    persistSession(auth);
    return auth;
  },

  async twoFactorEnrollSetup(setupToken) {
    // No session exists at this point: the setup token itself is the bearer.
    // `bearerToken` (instead of the stored session token) keeps a stale login
    // from another tab from overriding the token the API just issued.
    const payload = await request<unknown>('/auth/2fa/enroll/setup', {
      method: 'POST',
      bearerToken: setupToken,
      // The API derives the TOTP secret and URI; no network calls expected.
      timeoutMs: 10_000,
    });
    const result = normalizeEnrollSetup(payload);
    if (result.secret.length === 0) {
      throw new ApiClientError(
        0,
        'INVALID_RESPONSE',
        'A API respondeu a ativação sem a chave secreta. Volte ao login e tente novamente.',
      );
    }
    return result;
  },

  async twoFactorEnrollVerify(setupToken, code) {
    const payload = await request<unknown>('/auth/2fa/enroll/verify', {
      method: 'POST',
      body: { code },
      bearerToken: setupToken,
      // bcrypt/TOTP verification plus session issuance run inside this request.
      timeoutMs: 20_000,
    });
    const result = normalizeEnrollVerify(payload);
    if (result.token.length === 0) {
      throw new ApiClientError(
        0,
        'INVALID_RESPONSE',
        'A API confirmou a ativação, mas não emitiu a sessão. Entre novamente com a senha e o código do app.',
      );
    }
    // Real session: persist it before the workspace boot runs (same as login).
    persistSession(result);
    return result;
  },

  async recoveryCodesCount() {
    // The API serialises counters as numbers, but the console tolerates a
    // string-serialised count so a proxy/mapper change never hides the value.
    // No `allowEmpty`: a bodyless 2xx is a contract violation, and showing
    // "0 codes left" from missing data would be a lie.
    const payload = await request<unknown>('/auth/2fa/recovery-codes/count', {
      timeoutMs: 8_000,
    });
    const container = (payload ?? null) as { remaining?: unknown } | null;
    const raw =
      container !== null && typeof container === 'object' ? container.remaining : undefined;
    let remaining = 0;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      remaining = Math.max(0, Math.trunc(raw));
    } else if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw);
      remaining = Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
    }
    return { remaining };
  },

  async regenerateRecoveryCodes(body) {
    const payload = await request<RegenerateRecoveryCodesResult | null>(
      '/auth/2fa/recovery-codes/regenerate',
      {
        method: 'POST',
        body,
        // bcrypt of the password + TOTP check run inside this request.
        timeoutMs: 20_000,
      },
    );
    const codes =
      payload !== null && typeof payload === 'object' && Array.isArray(payload.recoveryCodes)
        ? payload.recoveryCodes.filter(
            (code): code is string => typeof code === 'string' && code.trim().length > 0,
          )
        : [];
    return { recoveryCodes: codes };
  },

  /* ------------------------------------------------------------------ */
  /* Public Fase 1 endpoints: no session is issued or consumed here.     */
  /* ------------------------------------------------------------------ */

  signup(body) {
    // bcrypt (cost 12) + tenant/user insert + SMTP send run inside this request,
    // so it needs more headroom than a plain read.
    return request<SignupResult>('/auth/signup', {
      method: 'POST',
      body,
      timeoutMs: 20_000,
    });
  },

  verifyEmail(token) {
    return request<{ verified: boolean }>('/auth/verify-email', {
      method: 'POST',
      body: { token },
      timeoutMs: 10_000,
    });
  },

  resendVerification(email) {
    return request<{ status: string }>('/auth/resend-verification', {
      method: 'POST',
      body: { email },
      timeoutMs: 15_000,
    });
  },

  forgotPassword(email) {
    return request<{ status: string }>('/auth/forgot-password', {
      method: 'POST',
      body: { email },
      timeoutMs: 15_000,
    });
  },

  resetPassword(token, password) {
    return request<{ reset: boolean }>('/auth/reset-password', {
      method: 'POST',
      body: { token, password },
      timeoutMs: 15_000,
    });
  },

  async acceptInvitation(body) {
    // The token proves the invited e-mail, so the API creates the operator
    // already verified and answers with the login `AuthResponse` (JWT +
    // refresh token + agent). The response belongs to a real session, so the
    // token is persisted before anything else runs — exactly like `login()`.
    const auth = await request<AuthResponse>('/auth/accept-invitation', {
      method: 'POST',
      body,
      // bcrypt (cost 12) + agent insert + refresh-token issue run in this request.
      timeoutMs: 20_000,
    });
    persistSession(auth);
    return auth;
  },

  /* ------------------------------------------------------------------ */
  /* Fase 5 — SSO corporativo (Microsoft Entra ID).                     */
  /* ------------------------------------------------------------------ */

  async ssoDiscover(email) {
    // Public, cache-busting read: the answer depends on the tenant
    // configuration, which an ADMIN may have changed a minute ago.
    // `no-store` also keeps a proxy from replaying an outdated `enabled`.
    try {
      const payload = await request<unknown>(`/auth/sso/discover${encodeQuery({ email })}`, {
        cache: 'no-store',
        timeoutMs: 8_000,
      });
      const raw =
        payload !== null && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {};
      // Only an explicit `true` enables the redirect; anything else is "not
      // configured" — never a guess that would send the operator to a 404.
      return { enabled: raw.enabled === true, provider: optionalText(raw.provider) };
    } catch (error) {
      // The API answers `404/409 SSO_NOT_CONFIGURED` when the domain has no
      // enabled connection (unknown domain, disabled connection or suspended
      // workspace). For the login screen that is an answer — "SSO not configured
      // for this domain" — not an outage, so it must not become an error alert.
      if (
        error instanceof ApiClientError &&
        (error.code === 'SSO_NOT_CONFIGURED' || error.status === 404 || error.status === 409)
      ) {
        return { enabled: false, provider: null };
      }
      throw error;
    }
  },

  async ssoExchange(code) {
    const auth = await request<AuthResponse>('/auth/sso/exchange', {
      method: 'POST',
      body: { code },
      // The first corporate login may create the operator (auto-provision),
      // load the IdP profile and issue the refresh token in this request.
      timeoutMs: 20_000,
    });
    // Real session: persist the JWT before anything else runs (same as login).
    persistSession(auth);
    return auth;
  },

  async tenantSso() {
    try {
      const payload = await request<unknown>('/tenants/me/sso', {
        cache: 'no-store',
        timeoutMs: 8_000,
      });
      return normalizeTenantSsoConfig(payload);
    } catch (error) {
      // A workspace that never configured SSO may answer 404 NOT_FOUND: that is
      // an empty state, not a failure of the settings page.
      if (error instanceof ApiClientError && error.status === 404) return null;
      throw error;
    }
  },

  async updateTenantSso(body) {
    const payload = await request<unknown>('/tenants/me/sso', {
      method: 'PUT',
      body,
      // The API encrypts the client secret and may validate the issuer over the
      // network, so this request gets more headroom than a plain write.
      allowEmpty: true,
      timeoutMs: 20_000,
    });
    // A 204 means "saved, no body": the caller re-reads the config.
    return payload === null || payload === undefined ? null : normalizeTenantSsoConfig(payload);
  },

  async deleteTenantSso() {
    await request<unknown>('/tenants/me/sso', {
      method: 'DELETE',
      allowEmpty: true,
      timeoutMs: 15_000,
    });
  },

  async listTickets(filters, page = 1) {
    const query = encodeQuery({
      filter: filters.queueKey,
      marketplace: filters.marketplaces.join(','),
      accountId: filters.accountId,
      search: filters.search,
      page,
      pageSize: PAGE_SIZE,
    });
    const payload = await request<Paginated<TicketListItem>>(`/tickets${query}`);
    return {
      items: payload.items,
      total: payload.total,
      totalPages: payload.totalPages,
    };
  },

  getTicket(id) {
    return request<TicketDetail>(`/tickets/${encodeURIComponent(id)}`);
  },

  sendMessage(ticketId, body) {
    return request<{ messageId: string; routeUsed: string; deliveryStatus: string; warnings: string[] }>(
      `/tickets/${encodeURIComponent(ticketId)}/messages`,
      {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': newIdempotencyKey() },
      },
    );
  },

  policyCheck(ticketId, body) {
    return request<PolicyEvaluation>(`/tickets/${encodeURIComponent(ticketId)}/policy-check`, {
      method: 'POST',
      body,
      timeoutMs: 4000,
    });
  },

  resolveRoute(ticketId, recipient) {
    const query = encodeQuery({ recipient });
    return request<RouteDecision>(`/tickets/${encodeURIComponent(ticketId)}/route${query}`);
  },

  runAction(ticketId, body) {
    return request<ChannelActionResult>(`/tickets/${encodeURIComponent(ticketId)}/actions`, {
      method: 'POST',
      body,
    });
  },

  assignTicket(ticketId, agentId) {
    return request<unknown>(`/tickets/${encodeURIComponent(ticketId)}/assign`, {
      method: 'POST',
      body: { agentId },
    });
  },

  changeStatus(ticketId, status) {
    return request<unknown>(`/tickets/${encodeURIComponent(ticketId)}/status`, {
      method: 'POST',
      body: { status },
    });
  },

  closeWithoutResponse(ticketId) {
    return request<unknown>(`/tickets/${encodeURIComponent(ticketId)}/close-without-response`, {
      method: 'POST',
    });
  },

  markRead(ticketId) {
    return request<unknown>(`/tickets/${encodeURIComponent(ticketId)}/read`, { method: 'POST' });
  },

  addNote(ticketId, text) {
    return request<TicketDetail['messages'][number]>(`/tickets/${encodeURIComponent(ticketId)}/notes`, {
      method: 'POST',
      body: { text },
    });
  },

  queueSnapshot(filters) {
    const query = encodeQuery({
      filter: filters?.queueKey,
      marketplace: filters?.marketplaces.join(','),
      accountId: filters?.accountId,
      search: filters?.search,
    });
    return request<QueueSnapshot>(`/queue/snapshot${query}`);
  },

  stats() {
    return request<TicketStats>('/stats');
  },

  channelHealth() {
    return request<ChannelHealthView[]>('/channels/health');
  },

  listAgents() {
    return request<IAgentSummary[]>('/agents');
  },

  setPresence(presence) {
    return request<unknown>('/auth/presence', { method: 'PUT', body: { presence } });
  },

  listAccounts() {
    return request<AccountRow[]>('/accounts');
  },

  connectors() {
    return request<ConnectorDescriptor[]>('/accounts/connectors');
  },

  startOAuth(marketplace, displayName) {
    return request<{ authorizeUrl: string; state: string }>(
      `/accounts/oauth/${encodeURIComponent(marketplace)}/start`,
      { method: 'POST', body: { displayName } },
    );
  },

  connectAccount(payload) {
    return request<{ accountId: string; displayName: string }>('/accounts/connect', {
      method: 'POST',
      body: payload,
    });
  },

  async disconnectAccount(id) {
    await request<unknown>(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  refreshAccount(id) {
    return request<{ ok: boolean; detail: string }>(
      `/accounts/${encodeURIComponent(id)}/refresh`,
      { method: 'POST' },
    );
  },

  uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    return request<UploadedFile>('/files/upload', {
      method: 'POST',
      formData,
      timeoutMs: 30_000,
    });
  },

  signedUrl(key) {
    return request<{ url: string }>(`/files/signed${encodeQuery({ key })}`);
  },

  completeOnboarding() {
    return request<unknown>('/tenants/me', {
      method: 'PATCH',
      body: { onboardingCompleted: true },
      // Optional endpoint: a 404/405 is answered immediately, so no extra headroom.
      timeoutMs: 10_000,
    });
  },

  async tenantProfile() {
    // `no-store`: the security policy and the onboarding flag are worth reading
    // fresh whenever `/settings` opens. The payload is normalised so an older
    // API (without `require2fa`) yields `null` — "not published", never `false`.
    const payload = await request<unknown>('/tenants/me', {
      cache: 'no-store',
      timeoutMs: 8_000,
    });
    const raw = isRecord(payload) && isRecord(payload.tenant) ? payload.tenant : payload;
    const source = isRecord(raw) ? raw : {};
    return {
      id: asTextOrNull(source.id) ?? '',
      slug: asTextOrNull(source.slug) ?? '',
      name: asTextOrNull(source.name) ?? '',
      onboardingCompletedAt: asIsoOrNull(source.onboardingCompletedAt),
      require2fa: asOptionalBoolean(source.require2fa),
    };
  },

  async updateTenantSettings(body) {
    // ADMIN-only on the API. `allowEmpty` because a deployment may answer 204
    // after persisting the policy; `null` then means "confirmed, no echo" and
    // the caller re-reads `GET /tenants/me` for the authoritative value.
    const payload = await request<unknown>('/tenants/me', {
      method: 'PATCH',
      body,
      allowEmpty: true,
      timeoutMs: 12_000,
    });
    if (payload === null || payload === undefined) return null;
    const raw = isRecord(payload) && isRecord(payload.tenant) ? payload.tenant : payload;
    return isRecord(raw) ? asOptionalBoolean(raw.require2fa) : null;
  },

  exportTenantData() {
    // Export includes tickets/messages/accounts, so it needs more headroom
    // than a plain read.
    return request<unknown>('/tenants/me/export', { timeoutMs: 60_000 });
  },

  async deleteTenant(body) {
    await request<unknown>('/tenants/me', {
      method: 'DELETE',
      body,
      allowEmpty: true,
      timeoutMs: 30_000,
    });
  },

  platformMetrics() {
    return request<PlatformMetrics>('/platform/metrics', { timeoutMs: 12_000 });
  },

  platformTenants(query) {
    const search = encodeQuery({
      page: query.page,
      pageSize: query.pageSize ?? 10,
      search: query.search,
    });
    return request<Paginated<PlatformTenant>>(`/platform/tenants${search}`, {
      timeoutMs: 12_000,
    });
  },

  updatePlatformTenant(id, body) {
    return request<PlatformTenant | null>(`/platform/tenants/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body,
      allowEmpty: true,
      timeoutMs: 15_000,
    });
  },

  platformTenantMetrics(id) {
    return request<PlatformTenantMetrics>(`/platform/tenants/${encodeURIComponent(id)}/metrics`, {
      timeoutMs: 12_000,
    });
  },

  async platformAlerts() {
    // The published API answers `{ generatedAt, total, alerts }`; the initial
    // contract was a bare array. Normalise both so the panel stays agnostic.
    const payload = await request<PlatformAlert[] | PlatformAlertsResult>('/platform/alerts', {
      timeoutMs: 12_000,
    });
    if (Array.isArray(payload)) return payload;
    if (payload !== null && typeof payload === 'object' && Array.isArray(payload.alerts)) {
      return payload.alerts;
    }
    return [];
  },

  platformBillingSummary() {
    return request<PlatformBillingSummary>('/platform/billing/summary', { timeoutMs: 12_000 });
  },

  updatePlatformTenantBilling(id, body) {
    return request<PlatformTenantBillingResult | null>(
      `/platform/tenants/${encodeURIComponent(id)}/billing`,
      {
        method: 'PATCH',
        body,
        allowEmpty: true,
        timeoutMs: 15_000,
      },
    );
  },

  async platformTenantCheckout(id) {
    const payload = await request<PlatformCheckoutResult | null>(
      `/platform/tenants/${encodeURIComponent(id)}/checkout`,
      {
        method: 'POST',
        // The API only renders the URL from a template (no gateway call), so a
        // normal timeout is enough; the caller validates the URL before leaving.
        timeoutMs: 15_000,
      },
    );
    const checkoutUrl =
      payload !== null && typeof payload === 'object' && typeof payload.checkoutUrl === 'string'
        ? payload.checkoutUrl
        : '';
    return { checkoutUrl };
  },

  async platformBillingEvents(limit = BILLING_EVENTS_LIMIT) {
    const payload = await request<PlatformBillingEventsResult | null>(
      `/platform/billing/events${encodeQuery({ limit })}`,
      { timeoutMs: 12_000 },
    );
    if (payload === null || typeof payload !== 'object') {
      return { items: [], limit };
    }
    // A server deployed ahead of this UI may omit `limit`: the effective value
    // is only a hint for the subtitle, never a reason to hide real rows.
    const effectiveLimit =
      typeof payload.limit === 'number' && Number.isFinite(payload.limit) && payload.limit > 0
        ? payload.limit
        : limit;
    return {
      items: Array.isArray(payload.items)
        ? payload.items.filter(
            (item): item is PlatformBillingEvent => typeof item === 'object' && item !== null,
          )
        : [],
      limit: effectiveLimit,
    };
  },

  async integrationSetup() {
    // The endpoint is new and owned by the platform API. Its public values are
    // rendered verbatim, so normalisation only drops invalid entries (an
    // anonymous/empty object must never become an invented card) and never
    // fills a missing value with a guessed URL.
    const payload = await request<unknown>('/platform/integration-setup', {
      timeoutMs: 12_000,
    });
    const container =
      payload !== null && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : null;

    const rawChannels =
      container !== null && Array.isArray(container.channels) ? container.channels : [];
    const channels: IntegrationSetupChannel[] = [];
    for (const entry of rawChannels) {
      if (entry === null || typeof entry !== 'object') continue;
      const raw = entry as Record<string, unknown>;
      const marketplace = optionalText(raw.marketplace);
      // Without an identifier the card cannot be labelled or matched to a
      // connected account, so it is skipped instead of rendered as "unknown".
      if (marketplace === null) continue;
      channels.push({
        marketplace,
        configured: raw.configured === true,
        missing: textList(raw.missing),
        appIdPublic: optionalText(raw.appIdPublic),
        redirectUri: optionalText(raw.redirectUri),
        webhookUrl: optionalText(raw.webhookUrl),
        oauthScopesOrTopics: textList(raw.oauthScopesOrTopics),
        portalUrl: optionalText(raw.portalUrl),
        docsUrl: optionalText(raw.docsUrl),
        steps: textList(raw.steps),
        webhookSecretEnv: optionalText(raw.webhookSecretEnv),
      });
    }

    return {
      generatedAt: optionalText(container?.generatedAt) ?? '',
      apiBaseUrl: optionalText(container?.apiBaseUrl) ?? '',
      webOrigin: optionalText(container?.webOrigin) ?? '',
      channels,
    };
  },

  async updateProfile(name) {
    const payload = await request<unknown>('/auth/me', {
      method: 'PATCH',
      body: { name },
      // The API may revalidate the display name and rewrite the JWT profile.
      timeoutMs: 10_000,
    });
    const agent = normalizeAgentSummary(payload);
    if (agent === null) {
      throw new ApiClientError(
        0,
        'INVALID_RESPONSE',
        'A API respondeu o perfil em um formato inesperado. Atualize a página e tente novamente.',
      );
    }
    return agent;
  },

  async sessions() {
    const payload = await request<unknown>('/auth/sessions', {
      cache: 'no-store',
      timeoutMs: 8_000,
    });
    const raw = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
    return raw
      .map((entry) => normalizeUserSession(entry))
      .filter((entry): entry is UserSession => entry !== null);
  },

  async revokeSession(id) {
    await request<unknown>(`/auth/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      allowEmpty: true,
      timeoutMs: 8_000,
    });
  },

  async revokeOtherSessions() {
    const payload = await request<unknown>('/auth/sessions/revoke-others', {
      method: 'POST',
      allowEmpty: true,
      timeoutMs: 10_000,
    });
    return { revoked: isRecord(payload) ? asCounter(payload.revoked) : 0 };
  },

  async adminOverview() {
    // `no-store` keeps the header "Atualizar" honest: the counters are a
    // snapshot of right now, not a cached one from the previous visit.
    const payload = await request<unknown>('/admin/overview', {
      cache: 'no-store',
      timeoutMs: 12_000,
    });
    return normalizeAdminOverview(payload);
  },

  async adminUsers(query = {}) {
    const search = encodeQuery({
      // An empty search/select is "absent", never a filter that would match
      // nothing; `encodeQuery` also drops it from the URL.
      search: query.search?.trim(),
      role: query.role,
      status: query.status,
      page: query.page,
      perPage: query.perPage,
    });
    const payload = await request<unknown>(`/admin/users${search}`, {
      cache: 'no-store',
      timeoutMs: 12_000,
    });
    const container = isRecord(payload) ? payload : {};
    const items = Array.isArray(container.items)
      ? container.items
          .map((entry) => normalizeAdminUser(entry))
          .filter((entry): entry is AdminUser => entry !== null)
      : [];
    // `total` counts the filtered set, not the page; when the API omits it the
    // visible rows are the only truth available (the old unpaginated payload).
    const total =
      container.total === undefined || container.total === null
        ? items.length
        : asCounter(container.total);
    // The contract echoes the effective pagination. A deployment still on the
    // unpaginated route returns every operator and echoes neither field: the
    // whole payload is one page, so `perPage` is its size instead of a 25-row
    // page the server would not honour.
    const echoesPagination = container.page !== undefined || container.perPage !== undefined;
    return {
      items,
      total,
      page: asPositiveInt(container.page, query.page ?? 1),
      perPage: asPositiveInt(
        container.perPage,
        echoesPagination ? (query.perPage ?? 25) : Math.max(1, items.length),
      ),
    };
  },

  exportAdminUsersCsv(query) {
    const search = encodeQuery({
      search: query.search?.trim(),
      role: query.role,
      status: query.status,
    });
    return downloadFile(`/admin/users/export.csv${search}`);
  },

  async updateAdminUser(id, body) {
    const payload = await request<unknown>(`/admin/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body,
      timeoutMs: 15_000,
    });
    const user = normalizeAdminUser(payload);
    if (user === null) {
      throw new ApiClientError(
        0,
        'INVALID_RESPONSE',
        'A API confirmou a alteração, mas não devolveu o usuário atualizado. Atualize a lista.',
      );
    }
    return user;
  },

  async resetAdminUserTwoFactor(id) {
    const payload = await request<unknown>(
      `/admin/users/${encodeURIComponent(id)}/reset-2fa`,
      // A deployment may answer 200 with no body; the reset itself already
      // happened, so an empty success must not be reported as a failure.
      { method: 'POST', allowEmpty: true, timeoutMs: 15_000 },
    );
    const result = isRecord(payload) ? payload : {};
    return {
      // The requested id is the fallback: the target was resolved by the API,
      // and a bodyless 200 must still name the operator the caller asked for.
      id: asTextOrNull(result.id) ?? id,
      // `true` only when the API explicitly says so; 409s never reach here.
      twoFactorEnabled: result.twoFactorEnabled === true,
    };
  },

  async revokeUserSessions(id) {
    const payload = await request<unknown>(
      `/admin/users/${encodeURIComponent(id)}/revoke-sessions`,
      { method: 'POST', allowEmpty: true, timeoutMs: 10_000 },
    );
    return { revoked: isRecord(payload) ? asCounter(payload.revoked) : 0 };
  },

  async adminSessions(query = {}) {
    const search = encodeQuery({
      page: query.page,
      perPage: query.perPage,
    });
    const payload = await request<unknown>(`/admin/sessions${search}`, {
      cache: 'no-store',
      timeoutMs: 12_000,
    });
    // The contract is `{ data: { items, total } }`, already unwrapped by
    // `request`. A deployment that answers the bare array is still read instead
    // of surfacing an "unexpected format" error.
    const container = isRecord(payload) ? payload : {};
    const rawItems: unknown[] = Array.isArray(payload)
      ? payload
      : Array.isArray(container.items)
        ? container.items
        : [];
    const items = rawItems
      .map((entry) => normalizeAdminSession(entry))
      .filter((entry): entry is AdminSession => entry !== null);
    // `total` counts every active session of the tenant, not only this page;
    // when the API omits it the visible rows are the only truth available.
    const total =
      container.total === undefined || container.total === null
        ? items.length
        : asCounter(container.total);
    // The contract does not echo pagination, so the requested page size is the
    // effective one — unless the deployment returned more rows than asked for
    // (unpaginated route): then the whole result set is a single page.
    return {
      items,
      total,
      page: asPositiveInt(container.page, query.page ?? 1),
      perPage: asPositiveInt(container.perPage, Math.max(query.perPage ?? 50, items.length)),
    };
  },

  async revokeAdminSession(id) {
    // 204 with no body: `request` already treats it as success. A 404/409 keeps
    // its real code (`CANNOT_REVOKE_CURRENT_SESSION`) so the tab explains it.
    await request<unknown>(`/admin/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      allowEmpty: true,
      timeoutMs: 12_000,
    });
  },

  async auditLogs(query) {
    const search = encodeQuery({
      action: query.action,
      actorId: query.actorId,
      page: query.page,
      perPage: query.perPage,
      from: query.from,
      to: query.to,
    });
    const payload = await request<unknown>(`/admin/audit-logs${search}`, {
      cache: 'no-store',
      timeoutMs: 12_000,
    });
    const container = isRecord(payload) ? payload : {};
    const items = Array.isArray(container.items)
      ? container.items
          .map((entry) => normalizeAuditLog(entry))
          .filter((entry): entry is AuditLogEntry => entry !== null)
      : [];
    return {
      items,
      page:
        typeof container.page === 'number' && Number.isFinite(container.page)
          ? Math.max(1, Math.trunc(container.page))
          : (query.page ?? 1),
      perPage:
        typeof container.perPage === 'number' && Number.isFinite(container.perPage)
          ? Math.max(1, Math.trunc(container.perPage))
          : (query.perPage ?? 25),
      total:
        typeof container.total === 'number' && Number.isFinite(container.total)
          ? Math.max(0, Math.trunc(container.total))
          : items.length,
    };
  },

  exportAuditLogsCsv(query) {
    const search = encodeQuery({
      action: query.action,
      actorId: query.actorId,
      from: query.from,
      to: query.to,
    });
    return downloadFile(`/admin/audit-logs/export.csv${search}`);
  },

  async adminInvitations() {
    const payload = await request<unknown>('/admin/invitations', {
      cache: 'no-store',
      timeoutMs: 12_000,
    });
    const container = isRecord(payload) ? payload : {};
    const items = Array.isArray(container.items)
      ? container.items
          .map((entry) => normalizeAdminInvitation(entry))
          .filter((entry): entry is AdminInvitation => entry !== null)
      : [];
    return {
      items,
      total:
        typeof container.total === 'number' && Number.isFinite(container.total)
          ? Math.max(0, Math.trunc(container.total))
          : items.length,
    };
  },

  async revokeInvitation(id) {
    // 204 with no body: `request` already treats it as success. A 409 keeps its
    // real code (`INVITATION_ALREADY_ACCEPTED`) so the UI can explain it.
    await request<unknown>(`/admin/invitations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      allowEmpty: true,
      timeoutMs: 12_000,
    });
  },

  async resendInvitation(id) {
    const payload = await request<unknown>(
      `/admin/invitations/${encodeURIComponent(id)}/resend`,
      {
        method: 'POST',
        // SMTP delivery happens inside this request (same headroom as the invite).
        // A 204/empty 2xx still means the re-send worked: null is a confirmation
        // without details, and the caller re-reads `GET /admin/invitations`.
        allowEmpty: true,
        timeoutMs: 20_000,
      },
    );
    return normalizeResendInvitation(payload, id);
  },

  async inviteUser(body) {
    const payload = await request<unknown>('/invitations', {
      method: 'POST',
      body,
      timeoutMs: 20_000,
    });
    const container = isRecord(payload) ? payload : {};
    const invitationId = asTextOrNull(container.invitationId);
    if (invitationId === null) {
      throw new ApiClientError(
        0,
        'INVALID_RESPONSE',
        'A API respondeu o convite sem o identificador. Confira a lista de convites antes de reenviar.',
      );
    }
    return {
      invitationId,
      email: asTextOrNull(container.email) ?? body.email,
      role: asTextOrNull(container.role) ?? body.role,
      expiresAt: asIsoOrNull(container.expiresAt) ?? '',
    };
  },

  async logout(refreshToken) {
    // With the refresh token the API revokes *this* session; without it the
    // call means "logout everywhere" (see docs/PHASE1_AUTH.md §Endpoints).
    const token = (refreshToken ?? '').trim();
    await request<unknown>('/auth/logout', {
      method: 'POST',
      body: token.length > 0 ? { refreshToken: token } : {},
      allowEmpty: true,
      timeoutMs: 8_000,
    });
  },

  diagnostics() {
    return request<SystemDiagnosis>('/diagnostics', { timeoutMs: 60_000 });
  },

  diagnoseAccount(id) {
    return request<AccountDiagnosis>(`/accounts/${encodeURIComponent(id)}/diagnose`, {
      method: 'POST',
      timeoutMs: 60_000,
    });
  },
};

/** Re-exported for convenience (workspace features derive request types). */
export type {
  AccountDiagnosis,
  AccountRow,
  ActionBody,
  AdminInvitation,
  AdminInvitationsResult,
  AdminOverview,
  AdminSession,
  AdminSessionsQuery,
  AdminSessionsResult,
  AdminUser,
  AdminUserTwoFactorResetResult,
  AdminUserUpdate,
  AdminUsersExportQuery,
  AdminUsersQuery,
  AdminUsersResult,
  AgentPresenceStatus,
  AuditLogEntry,
  AuditLogExportQuery,
  AuditLogPage,
  AuditLogQuery,
  AuthResponse,
  ChannelActionResult,
  ChannelHealthView,
  ConnectAccountPayload,
  ConnectorDescriptor,
  DiagnosisCheck,
  DiagnosisStatus,
  DownloadedFile,
  IAgentSummary,
  IntegrationSetup,
  IntegrationSetupChannel,
  InviteUserBody,
  InviteUserResult,
  KnownInvitationStatus,
  PlatformAlert,
  PlatformAlertsResult,
  PlatformBillingEvent,
  PlatformBillingEventsResult,
  PlatformBillingSummary,
  PlatformCheckoutResult,
  PlatformMetrics,
  PlatformTenant,
  PlatformTenantBillingResult,
  PlatformTenantBillingUpdate,
  PlatformTenantMetrics,
  PlatformTenantQuery,
  PlatformTenantUpdate,
  PolicyCheckBody,
  PolicyEvaluation,
  QueueSnapshot,
  RecoveryCodeCountResult,
  RegenerateRecoveryCodesBody,
  RegenerateRecoveryCodesResult,
  ResendInvitationResult,
  RouteDecision,
  SendMessageBody,
  SsoDiscovery,
  SystemDiagnosis,
  SystemStatusChannel,
  SystemStatusLevel,
  SystemStatusService,
  SystemStatusSnapshot,
  TenantProfile,
  TenantSettingsUpdate,
  TenantSsoConfig,
  TenantSsoUpdate,
  TicketDetail,
  TicketListItem,
  TicketStats,
  TwoFactorDisableBody,
  TwoFactorDisableResult,
  TwoFactorEnrollResult,
  TwoFactorEnrollSetupResult,
  TwoFactorSetupResult,
  TwoFactorStatusResult,
  TwoFactorVerifyResult,
  UploadedFile,
  UserSession,
  WorkspaceFilters,
} from './types';
