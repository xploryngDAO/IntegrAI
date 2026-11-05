# Web UI kit contract (frozen)

Both frontend agents code against this file. Do not change a signature here
without messaging the Lead — the other agent is compiling against it.

Root: `apps/web`. Aliases: `@/` → `src/` is **not** configured; use relative
imports (`../ui`, `../lib/api`). Type imports from `@sac/shared` only
(`import type { TicketDetail } from '@sac/shared'`).

---

## 1. Files owned by `frontend-core` (available to everyone)

### `src/lib/types.ts`
```ts
import type { TicketListItem, TicketDetail, AgentSummary, ... } from '@sac/shared';
export type WorkspaceFilters = {
  queueKey: 'ALL' | 'SLA_CRITICAL' | 'CLAIMS' | 'PRE_SALE' | 'WAITING_ME' | 'UNASSIGNED';
  marketplaces: Marketplace[];
  accountId: string | null;
  search: string;
};
export interface WorkspaceState { ... } // store shape, see §3
export interface Toast { id: string; tone: 'ok' | 'warn' | 'danger' | 'info'; title: string; description?: string }
```

### `src/lib/labels.ts` (runtime, local copies — never import runtime values from @sac/shared)
```ts
export const MARKETPLACE_LABEL: Record<Marketplace, string>;      // 'Amazon' | 'Mercado Livre' | 'Shopee'
export const MARKETPLACE_SHORT: Record<Marketplace, string>;      // 'AMZ' | 'MELI' | 'SHOPEE'
export const TICKET_TYPE_LABEL: Record<TicketType, string>;       // 'PRÉ-VENDA' | 'PÓS-VENDA' | 'RECLAMAÇÃO' | ...
export const STATUS_LABEL: Record<TicketStatus, string>;          // 'Não lido' | 'Aguardando agente' | ...
export const PRIORITY_LABEL: Record<TicketPriority, string>;
export const ROUTE_LABEL: Record<ChannelRoute, string>;           // 'Buyer-Seller Relay (SMTP)' ...
export const DIRECTION_LABEL: Record<MessageDirection, string>;   // 'ENTRADA' | 'SAÍDA' ...
export function formatSlaRemaining(deadlineIso: string): { text: string; tone: 'ok'|'warn'|'danger'; msLeft: number };
export function formatDateTime(iso: string | null): string;       // '24/11 18:30'
export function formatDate(iso: string | null): string;
export function formatCurrency(value: number, currency?: string): string;
export function initials(name: string): string;
export function marketplaceColor(m: Marketplace): string;         // tailwind class tokens
```

### `src/lib/api.ts`
```ts
export interface ApiClient {
  login(email: string, password: string): Promise<AuthResponse>;
  listTickets(filters: WorkspaceFilters, page?: number): Promise<{ items: TicketListItem[]; total: number; totalPages: number }>;
  getTicket(id: string): Promise<TicketDetail>;
  sendMessage(ticketId: string, body: SendMessageBody): Promise<{ messageId: string; routeUsed: string; deliveryStatus: string; warnings: string[] }>;
  policyCheck(ticketId: string, body: PolicyCheckBody): Promise<PolicyEvaluation>;
  resolveRoute(ticketId: string, recipient?: 'BUYER' | 'MEDIATOR'): Promise<RouteDecision>;
  runAction(ticketId: string, body: ActionBody): Promise<ChannelActionResult>;
  assignTicket(ticketId: string, agentId: string): Promise<unknown>;
  changeStatus(ticketId: string, status: TicketStatus): Promise<unknown>;
  closeWithoutResponse(ticketId: string): Promise<unknown>;
  markRead(ticketId: string): Promise<unknown>;
  addNote(ticketId: string, text: string): Promise<MessageView>;
  queueSnapshot(filters?: WorkspaceFilters): Promise<QueueSnapshot>;
  stats(): Promise<TicketStats>;
  channelHealth(): Promise<ChannelHealthView[]>;
  listAgents(): Promise<IAgentSummary[]>;
  setPresence(presence: AgentPresenceStatus): Promise<unknown>;
  listAccounts(): Promise<AccountRow[]>;
  connectors(): Promise<ConnectorDescriptor[]>;
  startOAuth(marketplace: 'mercadolivre' | 'shopee', displayName: string): Promise<{ authorizeUrl: string; state: string }>;
  connectAccount(payload: ConnectAccountPayload): Promise<{ accountId: string; displayName: string }>;
  disconnectAccount(id: string): Promise<void>;
  refreshAccount(id: string): Promise<{ ok: boolean; detail: string }>;
  uploadFile(file: File): Promise<{ key: string; uri: string; fileName: string; mimeType: string; sizeBytes: number; sha256: string }>;
  signedUrl(key: string): Promise<{ url: string }>;
}
export const api: ApiClient;
export function setAuthToken(token: string | null): void;
```
`api` fala sempre com a API real: 401 → gate de login; rede/timeout/5xx/200 não-JSON → `ApiClientError` exibido na UI (sem fallback).

### `src/lib/store.ts` — zustand store (single hook)
```ts
export interface WorkspaceStore {
  // data
  tickets: TicketListItem[];
  totalTickets: number;
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
  // actions
  boot(): Promise<void>;
  refreshQueue(): Promise<void>;
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
}
export const useWorkspace: UseBoundStore<StoreApi<WorkspaceStore>>;
```

### `src/components/ui/index.ts` — primitives (all client-only)
```tsx
<Button variant="primary|secondary|ghost|danger" size="sm|md" loading icon disabled onClick />
<IconButton label icon onClick variant="ghost|solid" />
<Pill tone="neutral|info|ok|warn|danger|accent" className>{children}</Pill>
<MarketplaceBadge marketplace compact />
<TypeBadge ticketType />
<Card title? subtitle? actions? padded? className?>{children}</Card>
<Modal open onClose title description? footer? size="sm|md|lg">{children}</Modal>
<ConfirmDialog open title description confirmLabel tone onConfirm onClose />
<Input label? error? hint? ...inputProps />
<Textarea label? error? hint? autoGrow? ...textareaProps />
<Select label? error? options={{value,label}[]} ...selectProps />
<Toggle checked onChange label description? />
<Tooltip label>{children}</Tooltip>
<Avatar name color? size={28} />
<EmptyState icon? title description? action? />
<Skeleton className />
<Kbd>{children}</Kbd>
<SegmentedControl options={{value,label,icon?}[]} value onChange size="sm|md" />
<Spinner size={16} />
```
Every component must accept `className`. `aria-*` attributes respected.

### `src/components/layout/AppShell.tsx`
```tsx
<AppShell health={ChannelHealthView[]} accounts={AccountRow[]}>{children}</AppShell>
```
renders the topbar + `<Outlet/>`; topbar contains channel dots, account and
marketplace filters (bound to the store), global SLA chip, presence control and
avatar menu linking to `/accounts`.

### `src/pages/WorkspacePage.tsx`
Renders the 3-column grid:
```tsx
<div className="grid h-full grid-cols-[360px_minmax(520px,1fr)_380px]">
  <QueueColumn />
  <ChatPanel />          {/* from '../components/chat/ChatPanel' */}
  <Cockpit />            {/* from '../components/cockpit/Cockpit' */}
</div>
```
`ChatPanel` and `Cockpit` take **no props** — they read `useWorkspace()`.

---

## 2. Files owned by `frontend-workspace` (must match these signatures)

```tsx
// src/components/chat/ChatPanel.tsx
export function ChatPanel(): JSX.Element;            // no props, reads useWorkspace()

// src/components/chat/Composer.tsx
export function Composer(): JSX.Element;

// src/components/cockpit/Cockpit.tsx
export function Cockpit(): JSX.Element;

// src/pages/AccountsPage.tsx
export function AccountsPage(): JSX.Element;

// src/components/accounts/ConnectModal.tsx
export function ConnectModal(props: { open: boolean; onClose: () => void; marketplace: Marketplace }): JSX.Element;
```
Routing (owned by `frontend-core` in `App.tsx`):
`/` → `WorkspacePage`, `/accounts` → `AccountsPage`, `*` → redirect `/`.

---

## 3. Simulação removida

Este documento descrevia fixtures de demonstração. Eles **não existem mais**:
`apps/web/src/lib/mock/**` foi removido, VITE_MOCK_MODE deixou de existir e o
cliente HTTP sempre fala com a API real (401 → login; rede/5xx → erro na UI).
Para validar uma integração use 
pm run doctor ou *Testar conexão* em
/accounts (ver docs/INTEGRATION_VALIDATION.md).
## 4. Cross-agent rules

- `frontend-core` owns every config file, `App.tsx`, `main.tsx`, `index.css`,
  `lib/**`, `components/ui/**`, `components/layout/**`, `components/queue/**`,
  `pages/WorkspacePage.tsx`.
- `frontend-workspace` owns `components/chat/**`, `components/cockpit/**`,
  `pages/AccountsPage.tsx`, `components/accounts/**`.
- Never edit a file outside your list. If you need a new primitive or store
  field, message the Lead (or the other agent) instead of editing their file.
- Both run: `npm run typecheck --workspace @sac/web` and
  `npm run build --workspace @sac/web`.
