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
  TicketDetail,
  TicketListItem,
  TicketStats,
} from '@sac/shared';

import type {
  AcceptInvitationBody,
  AccountRow,
  ActionBody,
  ConnectAccountPayload,
  DeleteTenantBody,
  PlatformMetrics,
  PlatformTenant,
  PlatformTenantQuery,
  PlatformTenantUpdate,
  PolicyCheckBody,
  SendMessageBody,
  SignupBody,
  TenantProfile,
  UploadedFile,
  WorkspaceFilters,
} from './types';

/* ==========================================================================
 * Configuration
 * ========================================================================== */

const API_BASE: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, '') ?? '/api/v1';

const TOKEN_STORAGE_KEY = 'sac.auth.token';
const REQUEST_TIMEOUT_MS = 6000;
const PAGE_SIZE = 40;

let authToken: string | null = (() => {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
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

export function setAuthToken(token: string | null): void {
  authToken = token;
  try {
    if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode) — the in-memory token still works.
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
  timeoutMs?: number;
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

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const headers: Record<string, string> = { Accept: 'application/json', ...(options.headers ?? {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

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
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ApiClientError(
          0,
          'TIMEOUT',
          'Tempo esgotado ao falar com a API. Verifique a conexão e tente novamente.',
        );
      }
      throw new ApiClientError(
        0,
        'NETWORK_ERROR',
        'Falha de rede ao falar com a API. Verifique a conexão e tente novamente.',
      );
    }

    // 204 has no body by definition; parsing it would surface a false
    // INVALID_RESPONSE on a successful delete/logout.
    if (response.status === 204) return undefined as T;

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const errorBody = payload as
        | { error?: { code?: string; message?: string; details?: unknown } }
        | null;
      throw new ApiClientError(
        response.status,
        errorBody?.error?.code ?? 'HTTP_ERROR',
        errorBody?.error?.message ?? `Erro HTTP ${response.status}.`,
        errorBody?.error?.details,
      );
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
  login(email: string, password: string): Promise<AuthResponse>;
  me(): Promise<IAgentSummary>;
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
  /** Revokes the current session server-side (`POST /auth/logout`). */
  logout(): Promise<void>;
  /** Live infrastructure + every connected account (ADMIN). */
  diagnostics(): Promise<SystemDiagnosis>;
  /** Real marketplace token/profile checks for a single account (ADMIN). */
  diagnoseAccount(id: string): Promise<AccountDiagnosis>;
}

/* ==========================================================================
 * Real API implementation
 * ========================================================================== */

export const api: ApiClient = {
  async login(email, password) {
    const auth = await request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    // Persist the JWT before any other request runs (boot happens next).
    setAuthToken(auth.token);
    return auth;
  },

  me() {
    return request<IAgentSummary>('/auth/me');
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
    setAuthToken(auth.token);
    return auth;
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

  tenantProfile() {
    return request<TenantProfile>('/tenants/me', { timeoutMs: 8_000 });
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

  async logout() {
    // No refresh token body: the API revokes every session of this operator.
    await request<unknown>('/auth/logout', {
      method: 'POST',
      body: {},
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
  AgentPresenceStatus,
  AuthResponse,
  ChannelActionResult,
  ChannelHealthView,
  ConnectAccountPayload,
  ConnectorDescriptor,
  DiagnosisCheck,
  DiagnosisStatus,
  IAgentSummary,
  PlatformMetrics,
  PlatformTenant,
  PlatformTenantQuery,
  PlatformTenantUpdate,
  PolicyCheckBody,
  PolicyEvaluation,
  QueueSnapshot,
  RouteDecision,
  SendMessageBody,
  SystemDiagnosis,
  TicketDetail,
  TicketListItem,
  TicketStats,
  UploadedFile,
  WorkspaceFilters,
} from './types';
