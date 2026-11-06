import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DataTable, Pagination } from '@xploryng/convergencia';
import { api, ApiClientError } from '../../lib/api';
import {
  ADMIN_USERS_PAGE_SIZES,
  adminErrorMessage,
  adminSessionErrorMessage,
  adminUsersRangeLabel,
  roleLabel,
  roleTone,
} from '../../lib/admin';
import { formatDateTime } from '../../lib/labels';
import { describeDevice } from '../../lib/session';
import type { AdminSession } from '../../lib/types';
import {
  Alert,
  Avatar,
  Button,
  Card,
  ConfirmActionDialog,
  EmptyState,
  Pill,
  Select,
  Skeleton,
  type SelectOption,
} from '../ui';

/**
 * Default `perPage` — mirrors `ADMIN_SESSIONS_DEFAULT_PER_PAGE` in the API. The
 * select offers 25/50/100; the API rejects `perPage` above 100 with 422.
 */
const DEFAULT_PER_PAGE = 50;

const PER_PAGE_OPTIONS: SelectOption[] = ADMIN_USERS_PAGE_SIZES.map((size) => ({
  value: String(size),
  label: String(size),
}));

/** Human label of the operator that owns a session (never an empty cell). */
function operatorLabel(session: AdminSession): string {
  if (session.name.trim().length > 0) return session.name;
  if (session.email.trim().length > 0) return session.email;
  return 'operador sem identificação';
}

export interface AdminSessionsTabProps {
  /** A 403 anywhere turns the whole `/admin` page into "Acesso restrito". */
  onForbidden: () => void;
  /** Page-level refresh counter (the header "Atualizar" reloads this list). */
  refreshKey?: number;
  /**
   * Reports the list's loading state so the page header can show its busy
   * indicator. The callback must be stable (a `useState` setter).
   */
  onBusyChange?: (busy: boolean) => void;
}

/**
 * "Sessões" tab of `/admin`: every active session of the workspace.
 *
 * The administrative view of `GET /admin/sessions?page=&perPage=` — one row per
 * refresh token, with the operator that owns it (`name`/`email`/`role`), the
 * device (the raw user-agent rendered through `describeDevice`), the IP, when
 * the session started and its last refresh.
 *
 * The API is the only source of the `current` flag: the row of the session that
 * issued this request is badged and its "Revogar" is disabled — ending it is the
 * "Sair" action, not an administrative one. Should a stale list offer it, the
 * API answers `409 CANNOT_REVOKE_CURRENT_SESSION` and the real message is shown.
 *
 * Writes: `DELETE /admin/sessions/:id` (204). After success — and after a
 * 404/409, so the table stops showing a session that no longer exists — the
 * current page is re-read from the server; the list is never patched locally.
 * A 403 on either read or write flips the whole page to "Acesso restrito".
 */
export function AdminSessionsTab({
  onForbidden,
  refreshKey = 0,
  onBusyChange,
}: AdminSessionsTabProps): JSX.Element {
  const [items, setItems] = useState<AdminSession[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(DEFAULT_PER_PAGE);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [revokeTarget, setRevokeTarget] = useState<AdminSession | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, perPage)));
  const currentPage = Math.min(page, totalPages);

  useEffect(() => {
    let active = true;

    async function loadSessions(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const result = await api.adminSessions({ page, perPage });
        if (!active) return;
        setItems(result.items);
        setTotal(result.total);
      } catch (failure) {
        if (!active) return;
        if (failure instanceof ApiClientError && failure.status === 403) {
          onForbidden();
          return;
        }
        setItems([]);
        setTotal(0);
        setError(adminErrorMessage(failure));
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadSessions();
    return () => {
      active = false;
    };
  }, [onForbidden, page, perPage, refreshKey, reloadKey]);

  // A page that no longer exists (the last session of the page was revoked)
  // must not stay on screen: the clamp re-reads the previous page.
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

  async function handleRevoke(): Promise<void> {
    if (revokeTarget === null || revoking) return;
    const target = revokeTarget;
    setRevoking(true);
    setRevokeError(null);
    try {
      await api.revokeAdminSession(target.id);
      setRevokeTarget(null);
      setNotice(
        `Sessão de ${operatorLabel(target)} em ${describeDevice(
          target.userAgent,
        )} revogada. Esse dispositivo precisará entrar novamente.`,
      );
      reload();
    } catch (failure) {
      if (failure instanceof ApiClientError && failure.status === 403) {
        setRevokeTarget(null);
        onForbidden();
        return;
      }
      // Keep the dialog open with the API's real message (409 current session,
      // 404 already gone…) and re-read the list so the row stops lying.
      setRevokeError(adminSessionErrorMessage(failure));
      if (
        failure instanceof ApiClientError &&
        (failure.status === 404 || failure.status === 409)
      ) {
        reload();
      }
    } finally {
      setRevoking(false);
    }
  }

  const columns = [
    { key: 'operator', label: 'Operador' },
    { key: 'role', label: 'Papel' },
    { key: 'device', label: 'Dispositivo' },
    { key: 'ip', label: 'IP' },
    { key: 'createdAt', label: 'Início' },
    { key: 'lastUsedAt', label: 'Última atividade' },
    { key: 'actions', label: 'Ações' },
  ];

  const rows = useMemo<Record<string, ReactNode>[]>(
    () =>
      items.map((session) => ({
        operator: (
          <span className="sac-admin-user sac-admin-session-operator">
            <Avatar name={session.name} size="sm" />
            <span className="sac-admin-user__text">
              <strong className="sac-admin-user__name" title={session.name}>
                {session.name}
              </strong>
              {session.email.length > 0 ? (
                <span className="sac-admin-email" title={session.email}>
                  {session.email}
                </span>
              ) : null}
            </span>
          </span>
        ),
        role: <Pill tone={roleTone(session.role)}>{roleLabel(session.role)}</Pill>,
        device: (
          <span className="sac-admin-session-device">
            <span
              className="sac-admin-session-device__name"
              // The compact label is shown; the raw UA stays available on hover
              // for whoever is investigating a suspicious device.
              title={session.userAgent ?? undefined}
            >
              {describeDevice(session.userAgent)}
            </span>
            {session.current ? <Pill tone="ok">Sessão atual</Pill> : null}
          </span>
        ),
        ip: <span className="sac-num">{session.ip ?? '—'}</span>,
        createdAt: (
          <span className="sac-num" title={session.createdAt || undefined}>
            {session.createdAt ? formatDateTime(session.createdAt) : '—'}
          </span>
        ),
        lastUsedAt: (
          <span className="sac-num" title={session.lastUsedAt ?? undefined}>
            {session.lastUsedAt !== null ? formatDateTime(session.lastUsedAt) : '—'}
          </span>
        ),
        actions: session.current ? (
          <Button
            size="sm"
            variant="ghost"
            icon="close"
            disabled
            title="A sessão atual não pode ser revogada por esta tabela. Use “Sair” no menu da conta para encerrá-la neste navegador."
          >
            Revogar
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            icon="close"
            aria-label={`Revogar a sessão de ${operatorLabel(session)} em ${describeDevice(
              session.userAgent,
            )}`}
            onClick={() => {
              setNotice(null);
              setRevokeError(null);
              setRevokeTarget(session);
            }}
          >
            Revogar
          </Button>
        ),
      })),
    [items],
  );

  return (
    <Card
      title="Sessões ativas"
      subtitle={
        loading
          ? 'Consultando as sessões do workspace…'
          : `${total} sessão(ões) ativa(s) no workspace. Revogar encerra o refresh token de um dispositivo imediatamente.`
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" icon="pulse" loading={loading} onClick={reload}>
            Atualizar
          </Button>
        </div>

        {notice !== null ? (
          <Alert title="Sessão revogada" tone="success">
            {notice}
          </Alert>
        ) : null}

        {loading ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : error !== null ? (
          <Alert title="Não foi possível carregar as sessões" tone="danger">
            <div className="flex flex-col gap-2">
              <span>{error}</span>
              <div>
                <Button size="sm" icon="pulse" onClick={reload}>
                  Tentar novamente
                </Button>
              </div>
            </div>
          </Alert>
        ) : items.length === 0 && page > totalPages ? (
          // The revoked session was the last row of a page that no longer
          // exists: the clamp effect moves to the last page, so this frame is
          // "loading", never a false "no sessions".
          <div className="flex flex-col gap-2" aria-busy="true">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon="devices"
            title="Nenhuma sessão ativa"
            description="Não há refresh tokens válidos para os operadores deste workspace. Uma sessão aparece aqui quando alguém entra e desaparece ao sair ou quando o token expira."
            action={
              <Button variant="secondary" icon="pulse" onClick={reload}>
                Atualizar
              </Button>
            }
          />
        ) : (
          <>
            <p className="sac-admin-scroll-hint">
              Deslize a tabela para ver papel, dispositivo, IP e as datas de cada sessão.
            </p>
            <DataTable
              caption={`Sessões ativas — ${items.length} de ${total} sessão(ões)`}
              columns={columns}
              rows={rows}
            />

            <div className="sac-admin-pagination">
              <span className="sac-admin-pagination__summary">
                {adminUsersRangeLabel(currentPage, perPage, total, items.length)} sessão(ões) ·
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
          Chamadas: <span className="sac-num">GET /admin/sessions?page=&amp;perPage=</span> ·{' '}
          <span className="sac-num">DELETE /admin/sessions/:id</span>. A revogação encerra o refresh
          token na hora; o access token restante expira no prazo normal do JWT.
        </p>
      </div>

      <ConfirmActionDialog
        open={revokeTarget !== null}
        title={`Revogar a sessão de ${
          revokeTarget !== null ? operatorLabel(revokeTarget) : 'operador'
        }?`}
        description={`O dispositivo "${describeDevice(
          revokeTarget?.userAgent,
        )}" perderá o acesso e precisará entrar novamente.`}
        confirmLabel="Revogar sessão"
        tone="danger"
        loading={revoking}
        onConfirm={() => void handleRevoke()}
        onClose={() => {
          if (!revoking) {
            setRevokeTarget(null);
            setRevokeError(null);
          }
        }}
      >
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            A API revoga o refresh token imediatamente (
            <span className="sac-num">DELETE /admin/sessions/:id</span>). A sessão atual deste
            navegador não pode ser revogada por aqui — a API responde{' '}
            <span className="sac-num">409 CANNOT_REVOKE_CURRENT_SESSION</span>; encerre-a com{' '}
            <strong>Sair</strong> no menu da conta.
          </p>
          {revokeError !== null ? (
            <Alert title="Não foi possível revogar a sessão" tone="danger">
              {revokeError}
            </Alert>
          ) : null}
        </div>
      </ConfirmActionDialog>
    </Card>
  );
}
