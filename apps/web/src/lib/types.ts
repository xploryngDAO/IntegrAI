/**
 * Frontend-local contracts shared by the core shell and the workspace features.
 *
 * All DTO/enums come from `@sac/shared` as TYPE-ONLY imports: the browser bundle
 * must never pull runtime values from the shared package.
 */
import type {
  AccountDiagnosis,
  AccountStatus,
  AgentPresenceStatus,
  ChannelHealthView,
  IAgentSummary,
  Marketplace,
  PolicyEvaluation,
  SystemDiagnosis,
  TicketDetail,
  TicketListItem,
  TicketStats,
  TicketStatus,
} from '@sac/shared';

/* ==========================================================================
 * Queue filters
 * ========================================================================== */

export type QueueKey =
  | 'ALL'
  | 'SLA_CRITICAL'
  | 'CLAIMS'
  | 'PRE_SALE'
  | 'WAITING_ME'
  | 'UNASSIGNED';

export interface WorkspaceFilters {
  queueKey: QueueKey;
  marketplaces: Marketplace[];
  accountId: string | null;
  search: string;
}

export const DEFAULT_FILTERS: WorkspaceFilters = {
  queueKey: 'ALL',
  marketplaces: [],
  accountId: null,
  search: '',
};

/* ==========================================================================
 * Toasts
 * ========================================================================== */

export type ToastTone = 'ok' | 'warn' | 'danger' | 'info';

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
}

/* ==========================================================================
 * Local read/command models (not part of @sac/shared)
 * ========================================================================== */

/** Mirrors `GET /accounts` `AccountRow` (docs/API_CONTRACT.md §5). */
export interface AccountRow {
  id: string;
  marketplace: Marketplace;
  displayName: string;
  externalSellerId: string;
  marketplaceSiteId: string;
  status: AccountStatus;
  channelConfig: Record<string, unknown>;
  tokenExpiresAt: string | null;
  authExpiresAt: string | null;
}

export type ChatRecipient = 'BUYER' | 'MEDIATOR';

/** Body of `POST /tickets/:id/messages`. */
export interface SendMessageBody {
  bodyText: string;
  bodyHtml?: string | null;
  subject?: string | null;
  recipient?: ChatRecipient;
  forceImportant?: boolean;
  closeWithoutResponse?: boolean;
  attachmentS3Keys?: string[];
  meliActionGuideReasonId?: string | null;
  shopeeMessageType?: 'text' | 'image' | 'order' | 'item';
  shopeeOrderCardOrderSn?: string | null;
  shopeeItemCardItemId?: number | null;
}

export interface SendMessageResult {
  messageId: string;
  routeUsed: string;
  deliveryStatus: string;
  warnings: string[];
}

/** Body of `POST /tickets/:id/policy-check`. */
export interface PolicyCheckBody {
  bodyText: string;
  bodyHtml?: string | null;
  subject?: string | null;
  recipient?: ChatRecipient;
  attachmentCount?: number;
}

/** Body of `POST /tickets/:id/actions`. `kind` is a `ChannelActionKind`. */
export interface ActionBody {
  kind: string;
  bodyText?: string;
  attachmentS3Keys?: string[];
  lastReadMessageId?: string | null;
  payload?: Record<string, unknown>;
}

/** Body of `POST /accounts/connect`. */
export interface ConnectAccountPayload {
  marketplace: Marketplace;
  displayName: string;
  externalSellerId: string;
  marketplaceSiteId: string;
  refreshToken?: string;
  accessToken?: string;
  channelConfig?: Record<string, unknown>;
}

export interface UploadedFile {
  key: string;
  uri: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

/* ==========================================================================
 * Store shape (single zustand hook — see docs/UI_KIT.md §3)
 * ========================================================================== */

export interface WorkspaceState {
  // data
  tickets: TicketListItem[];
  totalTickets: number;
  stats: TicketStats | null;
  selectedTicketId: string | null;
  detail: TicketDetail | null;
  agents: IAgentSummary[];
  accounts: AccountRow[];
  health: ChannelHealthView[];
  filters: WorkspaceFilters;
  loadingQueue: boolean;
  loadingDetail: boolean;
  toasts: Toast[];
  presence: AgentPresenceStatus;
  sending: boolean;
  policy: PolicyEvaluation | null;
  currentAgent: IAgentSummary | null;
  /** Last live diagnostics report (infrastructure + connected accounts). */
  systemDiagnosis: SystemDiagnosis | null;
  /** Last live diagnosis per account id. */
  accountDiagnoses: Record<string, AccountDiagnosis>;
  diagnosticsLoading: boolean;
  diagnosticsError: string | null;
  diagnosingAccountId: string | null;

  // actions
  boot(): Promise<void>;
  refreshQueue(): Promise<void>;
  refreshStats(): Promise<void>;
  refreshDetail(id?: string): Promise<void>;
  selectTicket(id: string): void;
  setFilters(patch: Partial<WorkspaceFilters>): void;
  sendMessage(body: SendMessageBody): Promise<boolean>;
  checkPolicy(body: PolicyCheckBody): Promise<void>;
  runAction(body: ActionBody): Promise<void>;
  closeWithoutResponse(): Promise<void>;
  markRead(): Promise<void>;
  assignTo(agentId: string): Promise<void>;
  changeStatus(status: TicketStatus): Promise<void>;
  setPresence(presence: AgentPresenceStatus): Promise<void>;
  pushToast(t: Omit<Toast, 'id'>): void;
  dismissToast(id: string): void;
  /** Live system diagnostics (`GET /diagnostics`). Rejects on failure. */
  systemDiagnostics(): Promise<SystemDiagnosis>;
  /** Alias for `systemDiagnostics` (task-17 contract naming). */
  diagnostics(): Promise<SystemDiagnosis>;
  /** Live diagnosis for one account (`POST /accounts/:id/diagnose`). Rejects on failure. */
  diagnoseAccount(accountId: string): Promise<AccountDiagnosis>;
}

/* ==========================================================================
 * Re-exports: convenient single import path for the workspace features.
 * ========================================================================== */

export type {
  AccountDiagnosis,
  AccountStatus,
  AgentPresenceStatus,
  AgentRole,
  AttachmentView,
  AvailableActionView,
  ChannelActionResult,
  ChannelHealthView,
  ChannelRoute,
  ConnectorDescriptor,
  CrrStatusView,
  CustomerView,
  DeliveryStatus,
  DiagnosisCheck,
  DiagnosisStatus,
  IAgentSummary,
  Marketplace,
  MessageDirection,
  MessageView,
  OrderItemSnapshot,
  OrderView,
  PolicyEvaluation,
  PolicySeverity,
  PolicyViolation,
  QueueSnapshot,
  RouteDecision,
  RoutePreview,
  SlaState,
  SystemDiagnosis,
  TicketDetail,
  TicketListItem,
  TicketPriority,
  TicketStats,
  TicketStatus,
  TicketType,
  AuthResponse,
} from '@sac/shared';
