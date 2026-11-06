import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DataTable, Pagination } from '@xploryng/convergencia';
import { api, ApiClientError } from '../../lib/api';
import {
  ADMIN_USERS_PAGE_SIZES,
  ADMIN_USER_STATUS_OPTIONS,
  ROLE_OPTIONS,
  adminErrorMessage,
  adminUsersExportName,
  adminUsersRangeLabel,
  resetUserTwoFactorErrorMessage,
  roleLabel,
  roleTone,
} from '../../lib/admin';
import { formatDateTime } from '../../lib/labels';
import type { AdminUser, AdminUserStatus } from '../../lib/types';
import {
  Alert,
  Avatar,
  Button,
  Card,
  ConfirmActionDialog,
  EmptyState,
  Pill,
  SearchField,
  Select,
  Skeleton,
  type SelectOption,
} from '../ui';
import { InviteUserDialog } from './InviteUserDialog';
import { UserRoleDialog } from './UserRoleDialog';

/** Debounce of the name/e-mail search; `Enter` applies it immediately. */
const SEARCH_DEBOUNCE_MS = 350;
/** Default `perPage` of the API — the select offers 25/50/100. */
const DEFAULT_PER_PAGE = 25;

const ROLE_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'Todos os papéis' },
  ...ROLE_OPTIONS.map(({ value, label }) => ({ value, label })),
];

const STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'Todos os status' },
  ...ADMIN_USER_STATUS_OPTIONS.map(({ value, label }) => ({ value, label })),
];

const PER_PAGE_OPTIONS: SelectOption[] = ADMIN_USERS_PAGE_SIZES.map((size) => ({
  value: String(size),
  label: String(size),
}));

/** Filters applied to `GET /admin/users` (empty string = filter absent). */
interface AppliedUsersFilters {
  search: string;
  role: string;
  status: string;
}

const EMPTY_FILTERS: AppliedUsersFilters = { search: '', role: '', status: '' };

/** The select only ever sends the two statuses the API documents. */
function asStatusFilter(value: string): AdminUserStatus | undefined {
  return value === 'ACTIVE' || value === 'INACTIVE' ? value : undefined;
}

export interface AdminUsersTabProps {
  /** Id of the signed-in operator; their own row cannot be edited here. */
  currentAgentId: string | null;
  /** Page-level refresh counter (the header "Atualizar" reloads this list). */
  refreshKey?: number;
  /** A 403 anywhere turns the whole `/admin` page into "Acesso restrito". */
  onForbidden: () => void;
  /**
   * Reports the list's loading state so the page header can show its busy
   * indicator. The callback must be stable (a `useState` setter).
   */
  onBusyChange?: (busy: boolean) => void;
  /**
   * Called after a write that changes a workspace counter (role, activation,
   * revoked sessions, sent invitation) so `Visão geral` re-reads
   * `GET /admin/overview`. Never called for a failed write.
   */
  onMutated?: () => void;
}

/**
 * "Usuários" tab of `/admin`.
 *
 * Table of the workspace operators with the four administrative actions the
 * API exposes: change role, activate/deactivate, revoke every session of one
 * operator and reset another operator's 2FA. The CTA sends a real invitation
 * (Fase 1 `/invitations`).
 *
 * The **2FA** column renders the operator's TOTP state as a pill
 * (`twoFactorEnabled`, tolerant: an API that predates the field reads as
 * `false`). "Redefinir 2FA" (`POST /admin/users/:id/reset-2fa`) is offered only
 * for a row with 2FA on that is not the caller's own — the API refuses both
 * cases with `409`, so the UI never leads the operator into a predictable error.
 * The confirmation spells out the consequences (the operator loses the 2FA
 * enrollment and every live session is closed until they reconfigure), the
 * request is loading per row, and a failed reset keeps the API's real
 * `409`/`404` message on screen while the list is re-read.
 *
 * Filtering and pagination are **server-side** (`GET /admin/users?search=&role=
 * &status=&page=&perPage=`): the name/e-mail search is debounced by 350ms (and
 * applied at once on `Enter`), the role/status selects apply immediately, and
 * any filter change returns to page 1. After a successful write the current
 * page is re-read — never an optimistic guess — so a row that no longer matches
 * the active filters disappears exactly like the API says.
 *
 * "Exportar CSV" downloads `GET /admin/users/export.csv` with the **applied**
 * filters (all pages of the result, not just the visible one) through the
 * authenticated blob path, so the JWT never travels in the URL.
 *
 * Guards: the API answers 403/404/409/422 with a real message, which is always
 * shown; the operator cannot change their own role/active flag from this table
 * (an ADMIN locking themselves out is a support incident, not a workflow), and
 * the own row never offers a 2FA reset either — self-service disable lives in
 * `/settings`, guarded by password + code.
 */
export function AdminUsersTab({
  currentAgentId,
  refreshKey = 0,
  onForbidden,
  onBusyChange,
  onMutated,
}: AdminUsersTabProps): JSX.Element {
  const [draftSearch, setDraftSearch] = useState('');
  const [filters, setFilters] = useState<AppliedUsersFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(DEFAULT_PER_PAGE);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [roleTarget, setRoleTarget] = useState<AdminUser | null>(null);
  const [statusTarget, setStatusTarget] = useState<AdminUser | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AdminUser | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  /** Id of the row whose reset is running (per-row loading, not a global one). */
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const hasFilters =
    filters.search.length > 0 || filters.role.length > 0 || filters.status.length > 0;
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, perPage)));
  const currentPage = Math.min(page, totalPages);

  // Debounced search: typing narrows the server-side result after a pause. The
  // effect depends on `filters.search` too, so committing the search with
  // `Enter` re-runs it and cancels the pending timer.
  useEffect(() => {
    const next = draftSearch.trim();
    if (next === filters.search) return;
    const timer = window.setTimeout(() => {
      setFilters((current) => (current.search === next ? current : { ...current, search: next }));
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draftSearch, filters.search]);

  useEffect(() => {
    let active = true;

    async function loadUsers(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const result = await api.adminUsers({
          search: filters.search.length > 0 ? filters.search : undefined,
          role: filters.role.length > 0 ? filters.role : undefined,
          status: asStatusFilter(filters.status),
          page,
          perPage,
        });
        if (!active) return;
        setUsers(result.items);
        setTotal(result.total);
      } catch (failure) {
        if (!active) return;
        if (failure instanceof ApiClientError && failure.status === 403) {
          onForbidden();
          return;
        }
        setUsers([]);
        setTotal(0);
        setError(adminErrorMessage(failure));
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadUsers();
    return () => {
      active = false;
    };
  }, [filters, onForbidden, page, perPage, refreshKey, reloadKey]);

  // A page that no longer exists (filter narrowed the set, or the last row of
  // the page was deactivated and left the filter) must not stay on screen.
  useEffect(() => {
    if (!loading && page > totalPages) setPage(totalPages);
  }, [loading, page, totalPages]);

  useEffect(() => {
    onBusyChange?.(loading);
  }, [loading, onBusyChange]);

  // The tab unmounts when another `/admin` tab is selected; the header must not
  // stay spinning because of a list that is no longer mounted.
  useEffect(() => {
    return () => onBusyChange?.(false);
  }, [onBusyChange]);

  function reload(): void {
    setReloadKey((key) => key + 1);
  }

  function applyFilters(patch: Partial<AppliedUsersFilters>): void {
    const next = { ...filters, ...patch };
    if (
      next.search === filters.search &&
      next.role === filters.role &&
      next.status === filters.status
    ) {
      return;
    }
    setFilters(next);
    setPage(1);
    setExportError(null);
    setExportNotice(null);
  }

  function commitSearchNow(): void {
    applyFilters({ search: draftSearch.trim() });
  }

  function clearFilters(): void {
    setDraftSearch('');
    setExportError(null);
    setExportNotice(null);
    if (!hasFilters) {
      // Nothing was applied yet: only the draft needed clearing (no refetch).
      return;
    }
    setFilters(EMPTY_FILTERS);
    setPage(1);
  }

  function handleFailure(failure: unknown): void {
    // A revoked permission on any write must flip the page to the 403 state.
    if (
      typeof failure === 'object' &&
      failure !== null &&
      'status' in failure &&
      (failure as { status?: unknown }).status === 403
    ) {
      onForbidden();
      return;
    }
    setNotice({ tone: 'danger', text: adminErrorMessage(failure) });
  }

  async function handleStatusChange(): Promise<void> {
    if (statusTarget === null || statusSaving) return;
    setStatusSaving(true);
    setStatusError(null);
    try {
      const updated = await api.updateAdminUser(statusTarget.id, {
        isActive: !statusTarget.isActive,
      });
      setStatusTarget(null);
      setNotice({
        tone: 'success',
        text: `${updated.name} ${updated.isActive ? 'reativado' : 'desativado'}.${
          updated.isActive ? '' : ' Revogue as sessões ativas para encerrar o acesso imediatamente.'
        }`,
      });
      reload();
      onMutated?.();
    } catch (failure) {
      setStatusError(adminErrorMessage(failure));
    } finally {
      setStatusSaving(false);
    }
  }

  async function handleRevokeSessions(): Promise<void> {
    if (revokeTarget === null || revoking) return;
    const target = revokeTarget;
    setRevoking(true);
    try {
      const result = await api.revokeUserSessions(target.id);
      setRevokeTarget(null);
      setNotice({
        tone: 'success',
        text: `${result.revoked} sessão(ões) de ${target.name} revogada(s).`,
      });
      reload();
      onMutated?.();
    } catch (failure) {
      setRevokeTarget(null);
      handleFailure(failure);
    } finally {
      setRevoking(false);
    }
  }

  /**
   * `POST /admin/users/:id/reset-2fa` — an ADMIN removes another operator's TOTP.
   *
   * The action is only offered for a row that reports `twoFactorEnabled` and is
   * not the caller's own (self-service disable lives in `/settings`, and the API
   * answers `409 CANNOT_RESET_OWN_2FA`). The dialog stays open on failure so the
   * API's real 409/404 message is not lost; the list is re-read either way, so a
   * stale row (2FA already off, operator removed) stops lying immediately.
   */
  async function handleResetTwoFactor(): Promise<void> {
    if (resetTarget === null || resettingId !== null) return;
    const target = resetTarget;
    setResettingId(target.id);
    setResetError(null);
    try {
      const result = await api.resetAdminUserTwoFactor(target.id);
      setResetTarget(null);
      if (result.twoFactorEnabled) {
        // A 200 that still reports 2FA on means the reset did not take effect:
        // never claim success; the reload below shows the server's state.
        setNotice({
          tone: 'danger',
          text: `A API respondeu 200, mas ainda reporta a verificação em duas etapas de ${target.name} como ativa. Atualize a lista; se persistir, tente novamente.`,
        });
      } else {
        setNotice({
          tone: 'success',
          text: `2FA de ${target.name} redefinido. O operador perdeu a configuração e as sessões ativas foram encerradas; ele só volta a usar o 2FA configurando o app autenticador de novo no próximo login.`,
        });
      }
      reload();
    } catch (failure) {
      if (failure instanceof ApiClientError && failure.status === 403) {
        setResetTarget(null);
        onForbidden();
        return;
      }
      setResetError(resetUserTwoFactorErrorMessage(failure));
      // Re-read: TWO_FACTOR_NOT_ENABLED / 404 mean the row is stale.
      reload();
    } finally {
      setResettingId(null);
    }
  }

  /**
   * Downloads the CSV of the **applied** filters (all pages of the result).
   *
   * The file is fetched with the bearer token and saved from a Blob, so the
   * authenticated route works without putting the JWT in the URL. The name comes
   * from `Content-Disposition` when the API sends it, else `usuarios-YYYY-MM-DD.csv`.
   */
  async function handleExport(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    setExportNotice(null);
    try {
      const file = await api.exportAdminUsersCsv({
        search: filters.search.length > 0 ? filters.search : undefined,
        role: filters.role.length > 0 ? filters.role : undefined,
        status: asStatusFilter(filters.status),
      });
      const url = URL.createObjectURL(file.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.fileName ?? adminUsersExportName();
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setExportNotice(
        `Download iniciado: ${anchor.download}. ${
          hasFilters
            ? 'O arquivo respeita os filtros aplicados (todos os operadores do resultado, não só esta página).'
            : 'Sem filtros: a equipe completa do workspace foi solicitada.'
        }`,
      );
    } catch (failure) {
      if (failure instanceof ApiClientError && failure.status === 403) {
        onForbidden();
        return;
      }
      setExportError(adminErrorMessage(failure));
    } finally {
      setExporting(false);
    }
  }

  const columns = [
    { key: 'user', label: 'Usuário' },
    { key: 'email', label: 'E-mail' },
    { key: 'role', label: 'Papel' },
    { key: 'status', label: 'Status' },
    { key: 'twoFactor', label: '2FA' },
    { key: 'lastLogin', label: 'Último login' },
    { key: 'sessions', label: 'Sessões' },
    { key: 'actions', label: 'Ações' },
  ];

  const rows = useMemo<Record<string, ReactNode>[]>(
    () =>
      users.map((user) => {
        const self = user.id === currentAgentId;
        return {
          user: (
            <span className="sac-admin-user">
              <Avatar name={user.name} size="sm" />
              <span className="sac-admin-user__text">
                <strong className="sac-admin-user__name" title={user.name}>
                  {user.name}
                </strong>
                {self ? <span className="sac-admin-user__self">você</span> : null}
              </span>
            </span>
          ),
          email: (
            <span className="sac-admin-email" title={user.email || undefined}>
              {user.email.length > 0 ? user.email : '—'}
            </span>
          ),
          role: <Pill tone={roleTone(user.role)}>{roleLabel(user.role)}</Pill>,
          status: (
            <Pill tone={user.isActive ? 'ok' : 'danger'}>
              {user.isActive ? 'Ativo' : 'Inativo'}
            </Pill>
          ),
          twoFactor: (
            <Pill
              tone={user.twoFactorEnabled ? 'ok' : 'neutral'}
              title={
                user.twoFactorEnabled
                  ? 'Verificação em duas etapas ativada (app autenticador).'
                  : 'Verificação em duas etapas desativada.'
              }
            >
              {user.twoFactorEnabled ? 'Ativado' : 'Desativado'}
            </Pill>
          ),
          lastLogin: (
            <span className="sac-num">{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}</span>
          ),
          sessions: (
            <span className="sac-admin-sessions">
              <span className="sac-num">{user.sessionsCount}</span>
              {user.sessionsCount > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="close"
                  onClick={() => {
                    setNotice(null);
                    setRevokeTarget(user);
                  }}
                  aria-label={`Revogar as sessões de ${user.name}`}
                >
                  Revogar
                </Button>
              ) : null}
            </span>
          ),
          actions: (
            <span className="sac-admin-actions">
              <Button
                size="sm"
                variant="ghost"
                icon="sliders"
                disabled={self}
                title={self ? 'Sua própria conta não pode ser alterada aqui.' : undefined}
                onClick={() => {
                  setNotice(null);
                  setRoleTarget(user);
                }}
              >
                Papel
              </Button>
              <Button
                size="sm"
                variant={user.isActive ? 'ghost' : 'secondary'}
                icon={user.isActive ? 'lock' : 'check'}
                disabled={self}
                title={self ? 'Sua própria conta não pode ser alterada aqui.' : undefined}
                onClick={() => {
                  setNotice(null);
                  setStatusError(null);
                  setStatusTarget(user);
                }}
              >
                {user.isActive ? 'Desativar' : 'Ativar'}
              </Button>
              {/*
                Only a row that actually has 2FA and is not the caller offers the
                reset: the API refuses both cases (409), so the UI never leads the
                operator into an error it can predict.
              */}
              {user.twoFactorEnabled && !self ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="tool"
                  loading={resettingId === user.id}
                  disabled={resettingId !== null && resettingId !== user.id}
                  title="Remove a configuração de 2FA e encerra as sessões ativas deste operador."
                  aria-label={`Redefinir 2FA de ${user.name}`}
                  onClick={() => {
                    setNotice(null);
                    setResetError(null);
                    setResetTarget(user);
                  }}
                >
                  Redefinir 2FA
                </Button>
              ) : null}
            </span>
          ),
        };
      }),
    [currentAgentId, resettingId, users],
  );

  return (
    <Card
      title="Equipe do workspace"
      subtitle={
        loading
          ? 'Consultando a equipe do workspace…'
          : `${total} operador(es)${
              hasFilters ? ' nos filtros aplicados' : ' no workspace'
            }. O papel define o que cada um pode ver e fazer.`
      }
    >
      <div className="flex flex-col gap-4">
        <div className="sac-admin-filters">
          <SearchField
            label="Buscar por nome ou e-mail"
            value={draftSearch}
            placeholder="Nome ou e-mail"
            onChange={setDraftSearch}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              // `Enter` applies the search now instead of waiting for the debounce.
              event.preventDefault();
              commitSearchNow();
            }}
          />
          <Select
            label="Papel"
            value={filters.role}
            options={ROLE_FILTER_OPTIONS}
            onChange={(event) => applyFilters({ role: event.target.value })}
          />
          <Select
            label="Status"
            value={filters.status}
            options={STATUS_FILTER_OPTIONS}
            onChange={(event) => applyFilters({ status: event.target.value })}
          />
        </div>

        <div className="sac-admin-toolbar">
          <div className="sac-admin-toolbar__actions">
            <Button
              variant="ghost"
              disabled={!hasFilters && draftSearch.trim().length === 0}
              onClick={clearFilters}
            >
              Limpar
            </Button>
            <Button
              variant="secondary"
              icon="file"
              loading={exporting}
              title="Baixa o CSV de todos os operadores que correspondem aos filtros aplicados."
              onClick={() => void handleExport()}
            >
              Exportar CSV
            </Button>
          </div>
          <div className="sac-admin-toolbar__actions">
            <Button variant="primary" icon="plus" onClick={() => setInviteOpen(true)}>
              Convidar operador
            </Button>
          </div>
        </div>

        {notice !== null ? (
          <Alert title={notice.tone === 'success' ? 'Equipe atualizada' : 'Ação não concluída'} tone={notice.tone}>
            {notice.text}
          </Alert>
        ) : null}

        {exportError !== null ? (
          <Alert title="Não foi possível exportar o CSV" tone="danger">
            <div className="flex flex-col gap-2">
              <span>{exportError}</span>
              <div>
                <Button size="sm" icon="file" loading={exporting} onClick={() => void handleExport()}>
                  Tentar novamente
                </Button>
              </div>
            </div>
          </Alert>
        ) : null}

        {exportNotice !== null ? (
          <Alert title="Exportação iniciada" tone="success">
            {exportNotice}
          </Alert>
        ) : null}

        {loading ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : error !== null ? (
          <Alert title="Não foi possível carregar a equipe" tone="danger">
            <div className="flex flex-col gap-2">
              <span>{error}</span>
              <div>
                <Button size="sm" icon="pulse" onClick={reload}>
                  Tentar novamente
                </Button>
              </div>
            </div>
          </Alert>
        ) : users.length === 0 ? (
          <EmptyState
            icon={hasFilters ? 'search' : 'users'}
            title={hasFilters ? 'Nenhum operador encontrado' : 'Nenhum operador cadastrado'}
            description={
              hasFilters
                ? 'Nenhum operador corresponde aos filtros aplicados. Ajuste a busca, o papel ou o status — ou limpe os filtros.'
                : 'Convide o primeiro operador para começar a atender em equipe. O convite chega por e-mail.'
            }
            action={
              hasFilters ? (
                <Button variant="secondary" onClick={clearFilters}>
                  Limpar filtros
                </Button>
              ) : (
                <Button variant="primary" icon="plus" onClick={() => setInviteOpen(true)}>
                  Convidar operador
                </Button>
              )
            }
          />
        ) : (
          <>
            <p className="sac-admin-scroll-hint">
              Deslize a tabela para ver papel, status, 2FA, sessões e ações.
            </p>
            <DataTable
              caption={`Equipe do workspace — ${users.length} de ${total} operador(es)`}
              columns={columns}
              rows={rows}
            />

            <div className="sac-admin-pagination">
              <span className="sac-admin-pagination__summary">
                {adminUsersRangeLabel(currentPage, perPage, total, users.length)} operador(es) ·
                página {currentPage} de {totalPages}
              </span>
              <div className="sac-admin-pagination__controls">
                <div className="sac-admin-perpage">
                  <Select
                    label="Itens por página"
                    value={String(perPage)}
                    options={PER_PAGE_OPTIONS}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (!Number.isFinite(next) || next < 1) return;
                      setPerPage(next);
                      setPage(1);
                    }}
                  />
                </div>
                <Pagination
                  page={currentPage}
                  total={totalPages}
                  onPageChange={(next) => setPage(Math.min(Math.max(1, next), totalPages))}
                />
              </div>
            </div>
          </>
        )}

        <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
          Chamadas: <span className="sac-num">GET /admin/users?search=&amp;role=&amp;status=&amp;page=&amp;perPage=</span>{' '}
          · <span className="sac-num">GET /admin/users/export.csv?search=&amp;role=&amp;status=</span>{' '}
          (download autenticado) · <span className="sac-num">PATCH /admin/users/:id</span> ·{' '}
          <span className="sac-num">POST /admin/users/:id/reset-2fa</span> ·{' '}
          <span className="sac-num">POST /admin/users/:id/revoke-sessions</span>
        </p>
      </div>

      {inviteOpen ? (
        <InviteUserDialog
          onClose={() => setInviteOpen(false)}
          onInvited={(result) => {
            setNotice({
              tone: 'success',
              text: `Convite enviado para ${result.email} como ${roleLabel(result.role)}. O link expira em ${
                result.expiresAt ? formatDateTime(result.expiresAt) : '7 dias'
              }.`,
            });
            // A new pending invitation changes the overview counter.
            onMutated?.();
          }}
        />
      ) : null}

      {roleTarget !== null ? (
        <UserRoleDialog
          key={roleTarget.id}
          user={roleTarget}
          onClose={() => setRoleTarget(null)}
          onSaved={(updated) => {
            setNotice({ tone: 'success', text: `${updated.name} agora é ${roleLabel(updated.role)}.` });
            reload();
            onMutated?.();
          }}
        />
      ) : null}

      <ConfirmActionDialog
        open={statusTarget !== null}
        title={
          statusTarget?.isActive === true
            ? `Desativar ${statusTarget.name}?`
            : `Reativar ${statusTarget?.name ?? 'operador'}?`
        }
        description={
          statusTarget?.isActive === true
            ? 'O operador perde o acesso ao workspace imediatamente.'
            : 'O operador volta a poder entrar com as credenciais dele.'
        }
        confirmLabel={statusTarget?.isActive === true ? 'Desativar usuário' : 'Reativar usuário'}
        tone={statusTarget?.isActive === true ? 'danger' : 'primary'}
        loading={statusSaving}
        onConfirm={() => void handleStatusChange()}
        onClose={() => {
          if (!statusSaving) {
            setStatusTarget(null);
            setStatusError(null);
          }
        }}
      >
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            {statusTarget?.isActive === true
              ? 'As sessões já abertas continuam válidas até expirar; use "Revogar" na coluna Sessões para encerrá-las agora.'
              : 'A reativação não revoga sessões antigas nem altera o papel do operador.'}
          </p>
          {statusError !== null ? (
            <Alert title="Não foi possível atualizar o usuário" tone="danger">
              {statusError}
            </Alert>
          ) : null}
        </div>
      </ConfirmActionDialog>

      <ConfirmActionDialog
        open={revokeTarget !== null}
        title={`Revogar as sessões de ${revokeTarget?.name ?? 'operador'}?`}
        description="Todos os dispositivos deste operador precisarão entrar novamente."
        confirmLabel="Revogar sessões"
        tone="danger"
        loading={revoking}
        onConfirm={() => void handleRevokeSessions()}
        onClose={() => {
          if (!revoking) setRevokeTarget(null);
        }}
      >
        <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
          A API fecha {revokeTarget?.sessionsCount ?? 0} sessão(ões) — o operador continua ativo no
          workspace, mas perde o acesso imediato em todos os navegadores.
        </p>
      </ConfirmActionDialog>

      <ConfirmActionDialog
        open={resetTarget !== null}
        title={`Redefinir a verificação em duas etapas de ${resetTarget?.name ?? 'operador'}?`}
        description="O operador perde o 2FA atual e todas as sessões ativas são encerradas; ele só volta a usar o 2FA configurando o app autenticador de novo."
        confirmLabel="Redefinir 2FA"
        tone="danger"
        loading={resetTarget !== null && resettingId === resetTarget.id}
        onConfirm={() => void handleResetTwoFactor()}
        onClose={() => {
          if (resettingId === null) {
            setResetTarget(null);
            setResetError(null);
          }
        }}
      >
        <div className="flex flex-col gap-3">
          <Alert title="O operador perde acesso ao 2FA até reconfigurar" tone="warning">
            A configuração atual (secret e códigos de recuperação) deixa de existir. As sessões
            abertas em todos os dispositivos são encerradas, então o acesso atual cai na hora — o
            próximo login pede novamente a configuração do app autenticador quando a política do
            workspace exigir 2FA.
          </Alert>
          <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            {resetTarget !== null && resetTarget.isActive
              ? 'O operador continua ativo no workspace; apenas o 2FA é removido. Avise-o antes de redefinir, para que ele não seja surpreendido pelo encerramento das sessões.'
              : 'O operador está desativado: as sessões já abertas também são encerradas e ele continua sem poder entrar até ser reativado.'}
          </p>
          {resetTarget !== null && resetTarget.id === currentAgentId ? (
            <Alert title="Esta é a sua própria conta" tone="danger">
              Um ADMIN não redefine o próprio 2FA por aqui; use Configurações → Segurança.
            </Alert>
          ) : null}
          {resetError !== null ? (
            <Alert title="Não foi possível redefinir o 2FA" tone="danger">
              {resetError}
            </Alert>
          ) : null}
        </div>
      </ConfirmActionDialog>
    </Card>
  );
}
