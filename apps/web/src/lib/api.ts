/**
 * Typed HTTP client for docs/API_CONTRACT.md with transparent mock fallback.
 *
 * Mock mode is ON when `VITE_MOCK_MODE === 'true'`. Otherwise the first
 * infrastructure failure (network error, timeout, 5xx, 401) switches the app to
 * a persistent in-memory mock session for the rest of the page lifetime and
 * notifies subscribers so the shell can show the demo banner.
 */
import type {
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
  TicketDetail,
  TicketListItem,
  TicketStats,
} from '@sac/shared';

import type {
  AccountRow,
  ActionBody,
  ConnectAccountPayload,
  PolicyCheckBody,
  SendMessageBody,
  UploadedFile,
  WorkspaceFilters,
} from './types';
import { mockApi } from './mock';

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

let mockActive = import.meta.env.VITE_MOCK_MODE === 'true';
let mockReason: string | null = mockActive ? 'VITE_MOCK_MODE=true' : null;

type MockModeListener = (active: boolean) => void;
const mockListeners = new Set<MockModeListener>();

/* ==========================================================================
 * Errors
 * ========================================================================== */

export class ApiClientError extends Error {
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

/** Network/5xx are engine failures; 401 means "authenticate", 4xx must reach the UI. */
function shouldFallback(error: unknown): boolean {
  if (error instanceof ApiClientError) {
    return error.status === 0 || error.status >= 500;
  }
  return true;
}

function describeError(error: unknown): string {
  if (error instanceof ApiClientError) return `HTTP ${error.status} · ${error.code}`;
  if (error instanceof DOMException && error.name === 'AbortError') return 'timeout de 6s';
  if (error instanceof Error) return error.message;
  return 'erro desconhecido';
}

function activateMock(reason: string): void {
  if (mockActive) return;
  mockActive = true;
  mockReason = reason;
  for (const listener of [...mockListeners]) listener(true);
}

/* ==========================================================================
 * Mock-mode public API
 * ========================================================================== */

export function isMockMode(): boolean {
  return mockActive;
}

/** Human-readable reason the demo fallback engaged (for the banner tooltip). */
export function mockFallbackDetail(): string | null {
  return mockReason;
}

/** Subscribe to mock-mode activation. Returns an unsubscribe function. */
export function subscribeMockMode(listener: MockModeListener): () => void {
  mockListeners.add(listener);
  return () => {
    mockListeners.delete(listener);
  };
}

/**
 * Explicitly enter the offline demo session (used by the login screen's
 * "Entrar em modo demonstração" action and by the e2e smoke checks).
 */
export function enableMockMode(reason = 'manual'): void {
  activateMock(reason);
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
    const response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const errorBody = payload as
        | { error?: { code?: string; message?: string; details?: unknown } }
        | null;
      const hasApiEnvelope = Boolean(errorBody && typeof errorBody === 'object' && errorBody.error);
      // A non-JSON 404/405 means we hit something that is not the SAC Hub API
      // (wrong port, SPA fallback, proxy miss). Treat it as infrastructure
      // failure so the demo fallback engages instead of showing a broken queue.
      const endpointMissing = !hasApiEnvelope && (response.status === 404 || response.status === 405);
      throw new ApiClientError(
        endpointMissing ? 0 : response.status,
        endpointMissing ? 'ENDPOINT_NOT_FOUND' : (errorBody?.error?.code ?? 'HTTP_ERROR'),
        errorBody?.error?.message ?? `Erro HTTP ${response.status}`,
        errorBody?.error?.details,
      );
    }
    return unwrap<T>(payload);
  } finally {
    window.clearTimeout(timeout);
  }
}

async function withFallback<T>(real: () => Promise<T>, mock: () => Promise<T>): Promise<T> {
  if (mockActive) return mock();
  try {
    return await real();
  } catch (error) {
    if (shouldFallback(error)) {
      activateMock(describeError(error));
      return mock();
    }
    throw error;
  }
}

/* ==========================================================================
 * Client interface (docs/UI_KIT.md §1 + `me()` used by the boot sequence)
 * ========================================================================== */

export interface ApiClient {
  login(email: string, password: string): Promise<AuthResponse>;
  me(): Promise<IAgentSummary>;
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
    marketplace: 'mercadolivre' | 'shopee',
    displayName: string,
  ): Promise<{ authorizeUrl: string; state: string }>;
  connectAccount(payload: ConnectAccountPayload): Promise<{ accountId: string; displayName: string }>;
  disconnectAccount(id: string): Promise<void>;
  refreshAccount(id: string): Promise<{ ok: boolean; detail: string }>;
  uploadFile(file: File): Promise<UploadedFile>;
  signedUrl(key: string): Promise<{ url: string }>;
}

/* ==========================================================================
 * Implementation
 * ========================================================================== */

export const api: ApiClient = {
  login(email, password) {
    return withFallback(
      async () => {
        const auth = await request<AuthResponse>('/auth/login', {
          method: 'POST',
          body: { email, password },
        });
        // Persist the JWT before any other request runs (boot happens next).
        setAuthToken(auth.token);
        return auth;
      },
      () => mockApi.login(email, password),
    );
  },

  me() {
    return withFallback(
      () => request<IAgentSummary>('/auth/me'),
      () => mockApi.me() as Promise<IAgentSummary>,
    );
  },

  listTickets(filters, page = 1) {
    const query = encodeQuery({
      filter: filters.queueKey,
      marketplace: filters.marketplaces.join(','),
      accountId: filters.accountId,
      search: filters.search,
      page,
      pageSize: PAGE_SIZE,
    });
    return withFallback(
      async () => {
        const payload = await request<Paginated<TicketListItem>>(`/tickets${query}`);
        return {
          items: payload.items,
          total: payload.total,
          totalPages: payload.totalPages,
        };
      },
      () => mockApi.listTickets(filters, page),
    );
  },

  getTicket(id) {
    return withFallback(
      () => request<TicketDetail>(`/tickets/${encodeURIComponent(id)}`),
      () => mockApi.getTicket(id),
    );
  },

  sendMessage(ticketId, body) {
    return withFallback(
      () =>
        request<{ messageId: string; routeUsed: string; deliveryStatus: string; warnings: string[] }>(
          `/tickets/${encodeURIComponent(ticketId)}/messages`,
          {
            method: 'POST',
            body,
            headers: { 'Idempotency-Key': newIdempotencyKey() },
          },
        ),
      () => mockApi.sendMessage(ticketId, body),
    );
  },

  policyCheck(ticketId, body) {
    return withFallback(
      () =>
        request<PolicyEvaluation>(`/tickets/${encodeURIComponent(ticketId)}/policy-check`, {
          method: 'POST',
          body,
          timeoutMs: 4000,
        }),
      () => mockApi.policyCheck(ticketId, body),
    );
  },

  resolveRoute(ticketId, recipient) {
    const query = encodeQuery({ recipient });
    return withFallback(
      () =>
        request<RouteDecision>(`/tickets/${encodeURIComponent(ticketId)}/route${query}`),
      () => mockApi.resolveRoute(ticketId, recipient),
    );
  },

  runAction(ticketId, body) {
    return withFallback(
      () =>
        request<ChannelActionResult>(`/tickets/${encodeURIComponent(ticketId)}/actions`, {
          method: 'POST',
          body,
        }),
      () => mockApi.runAction(ticketId, body),
    );
  },

  assignTicket(ticketId, agentId) {
    return withFallback(
      () =>
        request<unknown>(`/tickets/${encodeURIComponent(ticketId)}/assign`, {
          method: 'POST',
          body: { agentId },
        }),
      () => mockApi.assignTicket(ticketId, agentId),
    );
  },

  changeStatus(ticketId, status) {
    return withFallback(
      () =>
        request<unknown>(`/tickets/${encodeURIComponent(ticketId)}/status`, {
          method: 'POST',
          body: { status },
        }),
      () => mockApi.changeStatus(ticketId, status),
    );
  },

  closeWithoutResponse(ticketId) {
    return withFallback(
      () =>
        request<unknown>(`/tickets/${encodeURIComponent(ticketId)}/close-without-response`, {
          method: 'POST',
        }),
      () => mockApi.closeWithoutResponse(ticketId),
    );
  },

  markRead(ticketId) {
    return withFallback(
      () => request<unknown>(`/tickets/${encodeURIComponent(ticketId)}/read`, { method: 'POST' }),
      () => mockApi.markRead(ticketId),
    );
  },

  addNote(ticketId, text) {
    return withFallback(
      () =>
        request<TicketDetail['messages'][number]>(`/tickets/${encodeURIComponent(ticketId)}/notes`, {
          method: 'POST',
          body: { text },
        }),
      () => mockApi.addNote(ticketId, text),
    );
  },

  queueSnapshot(filters) {
    const query = encodeQuery({
      filter: filters?.queueKey,
      marketplace: filters?.marketplaces.join(','),
      accountId: filters?.accountId,
      search: filters?.search,
    });
    return withFallback(
      () => request<QueueSnapshot>(`/queue/snapshot${query}`),
      () => mockApi.queueSnapshot(filters),
    );
  },

  stats() {
    return withFallback(
      () => request<TicketStats>('/stats'),
      () => mockApi.stats(),
    );
  },

  channelHealth() {
    return withFallback(
      () => request<ChannelHealthView[]>('/channels/health'),
      () => mockApi.channelHealth(),
    );
  },

  listAgents() {
    return withFallback(
      () => request<IAgentSummary[]>('/agents'),
      () => mockApi.listAgents(),
    );
  },

  setPresence(presence) {
    return withFallback(
      () => request<unknown>('/auth/presence', { method: 'PUT', body: { presence } }),
      () => mockApi.setPresence(presence),
    );
  },

  listAccounts() {
    return withFallback(
      () => request<AccountRow[]>('/accounts'),
      () => mockApi.listAccounts(),
    );
  },

  connectors() {
    return withFallback(
      () => request<ConnectorDescriptor[]>('/accounts/connectors'),
      () => mockApi.connectors(),
    );
  },

  startOAuth(marketplace, displayName) {
    return withFallback(
      () =>
        request<{ authorizeUrl: string; state: string }>(
          `/accounts/oauth/${encodeURIComponent(marketplace)}/start`,
          { method: 'POST', body: { displayName } },
        ),
      () => mockApi.startOAuth(marketplace, displayName),
    );
  },

  connectAccount(payload) {
    return withFallback(
      () =>
        request<{ accountId: string; displayName: string }>('/accounts/connect', {
          method: 'POST',
          body: payload,
        }),
      () => mockApi.connectAccount(payload),
    );
  },

  disconnectAccount(id) {
    return withFallback(
      async () => {
        await request<unknown>(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      },
      () => mockApi.disconnectAccount(id),
    );
  },

  refreshAccount(id) {
    return withFallback(
      () =>
        request<{ ok: boolean; detail: string }>(`/accounts/${encodeURIComponent(id)}/refresh`, {
          method: 'POST',
        }),
      () => mockApi.refreshAccount(id),
    );
  },

  uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    return withFallback(
      () =>
        request<UploadedFile>('/files/upload', {
          method: 'POST',
          formData,
          timeoutMs: 30_000,
        }),
      () => mockApi.uploadFile(file),
    );
  },

  signedUrl(key) {
    return withFallback(
      () => request<{ url: string }>(`/files/signed${encodeQuery({ key })}`),
      () => mockApi.signedUrl(key),
    );
  },
};

/** Re-exported for convenience (workspace features derive request types). */
export type {
  AccountRow,
  ActionBody,
  AgentPresenceStatus,
  AuthResponse,
  ChannelActionResult,
  ChannelHealthView,
  ConnectAccountPayload,
  ConnectorDescriptor,
  IAgentSummary,
  PolicyCheckBody,
  PolicyEvaluation,
  QueueSnapshot,
  RouteDecision,
  SendMessageBody,
  TicketDetail,
  TicketListItem,
  TicketStats,
  UploadedFile,
  WorkspaceFilters,
};
