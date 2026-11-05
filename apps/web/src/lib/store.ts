/**
 * Single zustand store for the operator workspace (docs/UI_KIT.md §3).
 *
 * Responsibilities: boot, queue + detail fetching with stale-response guards,
 * debounced search, optimistic send, policy checks, channel actions, presence,
 * toasts, Socket.IO realtime with a 20 s polling fallback, SLA-safe updates.
 */
import { create } from 'zustand';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type {
  AgentPresenceStatus,
  ChannelHealthSnapshot,
  ChannelRoute,
  MessageView,
  TicketDetail,
  TicketListItem,
  TicketStatus,
} from '@sac/shared';

import { api } from './api';
import { ROUTE_LABEL } from './labels';
import { DEFAULT_FILTERS } from './types';
import type {
  ActionBody,
  PolicyCheckBody,
  SendMessageBody,
  Toast,
  WorkspaceFilters,
  WorkspaceState,
} from './types';

/* ==========================================================================
 * Module-level singletons / guards
 * ========================================================================== */

let bootStarted = false;
let searchTimer: number | null = null;
let queueSeq = 0;
let detailSeq = 0;
let policySeq = 0;
let pollTimer: number | null = null;
let socket: Socket | null = null;
const toastTimers = new Map<string, number>();

const POLL_INTERVAL_MS = 20_000;
const SEARCH_DEBOUNCE_MS = 280;
const TOAST_TTL_MS = 5_000;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Erro inesperado';
}

function routeLabel(routeUsed: string): string {
  return ROUTE_LABEL[routeUsed as ChannelRoute] ?? routeUsed;
}

function readAuthToken(): string | null {
  try {
    return window.localStorage.getItem('sac.auth.token');
  } catch {
    return null;
  }
}

/* ==========================================================================
 * Realtime + polling
 * ========================================================================== */

function mergeHealthSnapshot(snapshot: ChannelHealthSnapshot): void {
  const state = useWorkspace.getState();
  const next = state.health.map((entry) =>
    entry.accountId === snapshot.accountId
      ? {
          ...entry,
          inboundHealthy: snapshot.healthy,
          outboundHealthy: snapshot.healthy,
          detail: snapshot.detail,
        }
      : entry,
  );
  useWorkspace.setState({ health: next });
}

function connectSocket(): void {
  if (socket) return;
  const token = readAuthToken();
  if (!token) return;

  const wsUrl = (import.meta.env.VITE_WS_URL as string | undefined) ?? window.location.origin;
  const connection = io(wsUrl, {
    path: '/socket.io',
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 5,
    timeout: 4000,
  });

  connection.on('connect', () => {
    connection.emit('subscribe', {});
  });

  connection.on('ticket:updated', (payload: { ticketId?: string }) => {
    const state = useWorkspace.getState();
    void state.refreshQueue();
    if (payload.ticketId && payload.ticketId === state.selectedTicketId) {
      void state.refreshDetail(payload.ticketId);
    }
  });

  connection.on('message:created', (payload: { ticketId?: string }) => {
    const state = useWorkspace.getState();
    if (payload.ticketId && payload.ticketId === state.selectedTicketId) {
      void state.refreshDetail(payload.ticketId);
    }
    void state.refreshQueue();
  });

  connection.on('queue:changed', () => {
    void useWorkspace.getState().refreshQueue();
  });

  connection.on('channel:health', (snapshot: ChannelHealthSnapshot) => {
    mergeHealthSnapshot(snapshot);
  });

  // Degrade silently: polling keeps the queue fresh when the socket dies.
  connection.on('connect_error', () => {
    // no toast spam — the 20 s polling fallback keeps telemetry fresh
  });

  socket = connection;
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = window.setInterval(() => {
    const state = useWorkspace.getState();
    void state.refreshQueue();
    void state.refreshStats();
  }, POLL_INTERVAL_MS);
}

/** Tears down realtime resources (used by tests / HMR). */
export function disposeWorkspaceRealtime(): void {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

/* ==========================================================================
 * Store
 * ========================================================================== */

export const useWorkspace = create<WorkspaceState>()((set, get) => ({
  // ---------------------------------------------------------------- data
  tickets: [],
  totalTickets: 0,
  stats: null,
  selectedTicketId: null,
  detail: null,
  agents: [],
  accounts: [],
  health: [],
  filters: { ...DEFAULT_FILTERS },
  loadingQueue: true,
  loadingDetail: false,
  toasts: [],
  presence: 'ONLINE',
  sending: false,
  policy: null,
  currentAgent: null,
  systemDiagnosis: null,
  accountDiagnoses: {},
  diagnosticsLoading: false,
  diagnosticsError: null,
  diagnosingAccountId: null,

  // ------------------------------------------------------------- actions
  async boot() {
    if (bootStarted) return;
    bootStarted = true;

    set({ loadingQueue: true });

    try {
      const [agents, accounts, health, me] = await Promise.all([
        api.listAgents(),
        api.listAccounts(),
        api.channelHealth(),
        api.me(),
      ]);
      set({
        agents,
        accounts,
        health,
        currentAgent: me,
        presence: me.presence,
      });
    } catch (error) {
      get().pushToast({
        tone: 'danger',
        title: 'Não foi possível carregar o workspace',
        description: errorMessage(error),
      });
    }

    await Promise.all([get().refreshQueue(), get().refreshStats()]);
    set({ loadingQueue: false });

    if (!get().selectedTicketId) {
      const first = get().tickets[0];
      if (first) get().selectTicket(first.id);
    }

    connectSocket();
    startPolling();
  },

  async refreshQueue() {
    const seq = ++queueSeq;
    set({ loadingQueue: get().tickets.length === 0 });
    try {
      const result = await api.listTickets(get().filters);
      if (seq !== queueSeq) return;
      set({ tickets: result.items, totalTickets: result.total, loadingQueue: false });

      // Keep the open detail's ticket header in sync with the queue row.
      const { detail } = get();
      if (detail) {
        const fresh = result.items.find((ticket) => ticket.id === detail.ticket.id);
        if (fresh) set({ detail: { ...detail, ticket: fresh } });
      }
    } catch {
      if (seq === queueSeq) set({ loadingQueue: false });
    }
  },

  async refreshStats() {
    try {
      const stats = await api.stats();
      set({ stats });
    } catch {
      // stats are decorative: never block the workspace on them
    }
  },

  async systemDiagnostics() {
    set({ diagnosticsLoading: true, diagnosticsError: null });
    try {
      const result = await api.diagnostics();
      set({ systemDiagnosis: result, diagnosticsLoading: false });
      return result;
    } catch (error) {
      set({ diagnosticsLoading: false, diagnosticsError: errorMessage(error) });
      get().pushToast({
        tone: 'danger',
        title: 'Falha no diagnóstico do sistema',
        description: errorMessage(error),
      });
      throw error;
    }
  },

  diagnostics() {
    return get().systemDiagnostics();
  },

  async diagnoseAccount(accountId) {
    set({ diagnosingAccountId: accountId, diagnosticsError: null });
    try {
      const result = await api.diagnoseAccount(accountId);
      set((state) => ({
        accountDiagnoses: { ...state.accountDiagnoses, [accountId]: result },
        diagnosingAccountId: null,
      }));
      return result;
    } catch (error) {
      set({ diagnosingAccountId: null, diagnosticsError: errorMessage(error) });
      get().pushToast({
        tone: 'danger',
        title: 'Falha no diagnóstico da conta',
        description: errorMessage(error),
      });
      throw error;
    }
  },

  async refreshDetail(id) {
    const ticketId = id ?? get().selectedTicketId;
    if (!ticketId) return;
    const seq = ++detailSeq;
    set({ loadingDetail: true });
    try {
      const detail = await api.getTicket(ticketId);
      // Ignore stale responses from a previously selected ticket.
      if (seq !== detailSeq || get().selectedTicketId !== ticketId) return;
      set({
        detail,
        loadingDetail: false,
        policy: null,
        tickets: get().tickets.map((ticket) =>
          ticket.id === detail.ticket.id ? detail.ticket : ticket,
        ),
      });
    } catch (error) {
      if (seq !== detailSeq) return;
      set({ loadingDetail: false });
      get().pushToast({
        tone: 'danger',
        title: 'Falha ao carregar o atendimento',
        description: errorMessage(error),
      });
    }
  },

  selectTicket(id) {
    if (get().selectedTicketId === id) {
      void get().refreshDetail(id);
      return;
    }
    // Keep the previous detail mounted until the new one arrives so the grid
    // does not reflow; ChatPanel renders its skeleton while loadingDetail.
    set({ selectedTicketId: id, loadingDetail: true, policy: null });
    void get().refreshDetail(id);
  },

  setFilters(patch) {
    const next: WorkspaceFilters = { ...get().filters, ...patch };
    set({ filters: next });

    if (patch.search !== undefined) {
      if (searchTimer) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        searchTimer = null;
        void get().refreshQueue();
        void get().refreshStats();
      }, SEARCH_DEBOUNCE_MS);
      return;
    }
    if (searchTimer) {
      window.clearTimeout(searchTimer);
      searchTimer = null;
    }
    void get().refreshQueue();
    void get().refreshStats();
  },

  async sendMessage(body: SendMessageBody): Promise<boolean> {
    const detail = get().detail;
    if (!detail || get().sending) return false;

    const ticketId = detail.ticket.id;
    const optimistic: MessageView = {
      id: makeId('optimistic'),
      externalMessageId: null,
      direction: 'OUTBOUND_AGENT',
      channelRouteUsed: detail.routing.route,
      messageType: body.shopeeMessageType === 'order' || body.shopeeMessageType === 'item' ? body.shopeeMessageType : 'text',
      bodyCleanText: body.bodyText,
      bodyHtml: body.bodyHtml ?? null,
      deliveryStatus: 'QUEUED',
      isInternalNote: false,
      authorAgentId: get().currentAgent?.id ?? null,
      marketplaceCreatedAt: new Date().toISOString(),
      attachments: [],
      contentPayload: {},
    };

    set((state) => {
      if (!state.detail) return { sending: true };
      return {
        sending: true,
        detail: { ...state.detail, messages: [...state.detail.messages, optimistic] },
      };
    });

    try {
      const result = await api.sendMessage(ticketId, body);
      get().pushToast({
        tone: 'ok',
        title: `Enviado via ${routeLabel(result.routeUsed)}`,
        description:
          result.warnings.length > 0 ? result.warnings.join(' · ') : 'Mensagem enfileirada no canal.',
      });
      await get().refreshDetail(ticketId);
      await Promise.all([get().refreshQueue(), get().refreshStats()]);
      return true;
    } catch (error) {
      set((state) => {
        if (!state.detail) return { sending: false };
        return {
          sending: false,
          detail: {
            ...state.detail,
            messages: state.detail.messages.filter((entry) => entry.id !== optimistic.id),
          },
        };
      });
      get().pushToast({
        tone: 'danger',
        title: 'Falha ao enviar mensagem',
        description: errorMessage(error),
      });
      return false;
    } finally {
      set({ sending: false });
    }
  },

  async checkPolicy(body: PolicyCheckBody) {
    const detail = get().detail;
    if (!detail) return;
    const ticketId = detail.ticket.id;
    const seq = ++policySeq;
    try {
      const evaluation = await api.policyCheck(ticketId, body);
      if (seq !== policySeq || get().selectedTicketId !== ticketId) return;
      set({ policy: evaluation });
    } catch {
      // Policy preview is advisory; never break the composer on a preview error.
    }
  },

  async runAction(body: ActionBody) {
    const detail = get().detail;
    if (!detail) return;
    const ticketId = detail.ticket.id;
    const action = detail.allowedActions.find((entry) => entry.kind === body.kind);
    try {
      const result = await api.runAction(ticketId, body);
      get().pushToast({
        tone: result.ok ? 'ok' : 'danger',
        title: result.ok ? (action?.label ?? 'Ação executada') : 'Ação não executada',
        description: result.message,
      });
      await Promise.all([
        get().refreshDetail(ticketId),
        get().refreshQueue(),
        get().refreshStats(),
      ]);
    } catch (error) {
      get().pushToast({
        tone: 'danger',
        title: 'Falha na ação',
        description: errorMessage(error),
      });
    }
  },

  async closeWithoutResponse() {
    const detail = get().detail;
    if (!detail) return;
    const ticketId = detail.ticket.id;
    try {
      await api.closeWithoutResponse(ticketId);
      get().pushToast({
        tone: 'ok',
        title: 'Finalizado sem resposta',
        description: 'Ticket marcado como NO_RESPONSE_NEEDED (Route 3).',
      });
      await Promise.all([
        get().refreshDetail(ticketId),
        get().refreshQueue(),
        get().refreshStats(),
      ]);
    } catch (error) {
      get().pushToast({
        tone: 'danger',
        title: 'Falha ao finalizar ticket',
        description: errorMessage(error),
      });
    }
  },

  async markRead() {
    const detail = get().detail;
    if (!detail) return;
    const ticketId = detail.ticket.id;
    const isShopee = detail.ticket.marketplace === 'SHOPEE';
    try {
      await api.markRead(ticketId);
      get().pushToast({
        tone: 'ok',
        title: 'Conversa marcada como lida',
        description: isShopee
          ? 'CRR protegido: a última interação foi registrada.'
          : 'O contador de não lidas foi zerado.',
      });
      await Promise.all([
        get().refreshDetail(ticketId),
        get().refreshQueue(),
        get().refreshStats(),
      ]);
    } catch (error) {
      get().pushToast({
        tone: 'danger',
        title: 'Falha ao marcar como lida',
        description: errorMessage(error),
      });
    }
  },

  async assignTo(agentId) {
    const detail = get().detail;
    if (!detail) return;
    const ticketId = detail.ticket.id;
    const agent = get().agents.find((entry) => entry.id === agentId);
    try {
      await api.assignTicket(ticketId, agentId);
      get().pushToast({
        tone: 'ok',
        title: 'Atendimento atribuído',
        description: agent ? `Agora com ${agent.name}.` : 'Atribuição atualizada.',
      });
      await Promise.all([
        get().refreshDetail(ticketId),
        get().refreshQueue(),
      ]);
    } catch (error) {
      get().pushToast({
        tone: 'danger',
        title: 'Falha ao atribuir',
        description: errorMessage(error),
      });
    }
  },

  async changeStatus(status: TicketStatus) {
    const detail = get().detail;
    if (!detail) return;
    const ticketId = detail.ticket.id;
    try {
      await api.changeStatus(ticketId, status);
      get().pushToast({
        tone: 'ok',
        title: 'Status atualizado',
        description: `Ticket agora está como ${status}.`,
      });
      await Promise.all([
        get().refreshDetail(ticketId),
        get().refreshQueue(),
        get().refreshStats(),
      ]);
    } catch (error) {
      get().pushToast({
        tone: 'danger',
        title: 'Falha ao mudar o status',
        description: errorMessage(error),
      });
    }
  },

  async setPresence(presence: AgentPresenceStatus) {
    const previous = get().presence;
    set({ presence });
    try {
      await api.setPresence(presence);
    } catch {
      set({ presence: previous });
      get().pushToast({
        tone: 'danger',
        title: 'Falha ao atualizar presença',
        description: 'Sua disponibilidade não foi alterada.',
      });
    }
  },

  pushToast(toast) {
    const id = makeId('toast');
    const entry: Toast = { id, ...toast };
    set((state) => ({
      // Keep the viewport light: max 4 stacked toasts.
      toasts: [...state.toasts.slice(-3), entry],
    }));
    const timer = window.setTimeout(() => get().dismissToast(id), TOAST_TTL_MS);
    toastTimers.set(id, timer);
  },

  dismissToast(id) {
    const timer = toastTimers.get(id);
    if (timer) {
      window.clearTimeout(timer);
      toastTimers.delete(id);
    }
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },
}));

/** Alias matching docs/UI_KIT.md §3 (`WorkspaceStore`). */
export interface WorkspaceStore extends WorkspaceState {}

export type { TicketDetail, TicketListItem };
