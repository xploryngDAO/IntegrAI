import { useMemo, useState, type ReactNode } from 'react';
import { DataTable } from '@xploryng/convergencia';
import { api } from '../../lib/api';
import { adminErrorMessage, roleLabel, roleTone } from '../../lib/admin';
import { formatDateTime } from '../../lib/labels';
import type { AdminUser } from '../../lib/types';
import {
  Alert,
  Avatar,
  Button,
  Card,
  ConfirmActionDialog,
  EmptyState,
  Pill,
  SearchField,
  Skeleton,
} from '../ui';
import { InviteUserDialog } from './InviteUserDialog';
import { UserRoleDialog } from './UserRoleDialog';

export interface AdminUsersTabProps {
  users: AdminUser[];
  total: number;
  loading: boolean;
  error: string | null;
  currentAgentId: string | null;
  onRetry: () => void;
  /** Re-reads `GET /admin/users` after a successful write. */
  onChanged: () => void;
  /** A 403 anywhere turns the whole `/admin` page into "Acesso restrito". */
  onForbidden: () => void;
}

function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

/**
 * "Usuários" tab of `/admin`.
 *
 * Table of the workspace operators with the three administrative actions the
 * API exposes: change role, activate/deactivate and revoke every session of one
 * operator. The CTA sends a real invitation (Fase 1 `/invitations`).
 *
 * Guards: the API answers 403/404/409/422 with a real message, which is always
 * shown; the operator cannot change their own role/active flag from this table
 * (an ADMIN locking themselves out is a support incident, not a workflow).
 */
export function AdminUsersTab({
  users,
  total,
  loading,
  error,
  currentAgentId,
  onRetry,
  onChanged,
  onForbidden,
}: AdminUsersTabProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [roleTarget, setRoleTarget] = useState<AdminUser | null>(null);
  const [statusTarget, setStatusTarget] = useState<AdminUser | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AdminUser | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const filtered = useMemo(() => {
    const needle = normalizeSearch(query);
    if (needle.length === 0) return users;
    return users.filter(
      (user) =>
        normalizeSearch(user.name).includes(needle) ||
        normalizeSearch(user.email).includes(needle),
    );
  }, [query, users]);

  const activeCount = users.filter((user) => user.isActive).length;
  const filtering = query.trim().length > 0;

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
      onChanged();
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
      onChanged();
    } catch (failure) {
      setRevokeTarget(null);
      handleFailure(failure);
    } finally {
      setRevoking(false);
    }
  }

  const columns = [
    { key: 'user', label: 'Usuário' },
    { key: 'email', label: 'E-mail' },
    { key: 'role', label: 'Papel' },
    { key: 'status', label: 'Status' },
    { key: 'lastLogin', label: 'Último login' },
    { key: 'sessions', label: 'Sessões' },
    { key: 'actions', label: 'Ações' },
  ];

  const rows = useMemo<Record<string, ReactNode>[]>(
    () =>
      filtered.map((user) => {
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
            </span>
          ),
        };
      }),
    [currentAgentId, filtered],
  );

  return (
    <Card
      title="Equipe do workspace"
      subtitle={`${activeCount} ativo(s) de ${total} operador(es). O papel define o que cada um pode ver e fazer.`}
    >
      <div className="flex flex-col gap-3">
        <div className="sac-admin-toolbar">
          <SearchField
            label="Filtrar equipe"
            value={query}
            placeholder="Nome ou e-mail"
            onChange={setQuery}
          />
          <div className="sac-admin-toolbar__actions">
            <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
              {filtering
                ? `${filtered.length} de ${users.length} operador(es)`
                : `${total} operador(es) no workspace`}
            </span>
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
                <Button size="sm" icon="pulse" onClick={onRetry}>
                  Tentar novamente
                </Button>
              </div>
            </div>
          </Alert>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={filtering ? 'search' : 'users'}
            title={filtering ? 'Nenhum operador encontrado' : 'Nenhum operador cadastrado'}
            description={
              filtering
                ? `Nenhum nome ou e-mail corresponde a "${query.trim()}". Ajuste o filtro ou limpe a busca.`
                : 'Convide o primeiro operador para começar a atender em equipe. O convite chega por e-mail.'
            }
            action={
              filtering ? (
                <Button variant="secondary" onClick={() => setQuery('')}>
                  Limpar filtro
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
              Deslize a tabela para ver papel, status, sessões e ações.
            </p>
            <DataTable
              caption={`Equipe do workspace — ${filtered.length} operador(es)`}
              columns={columns}
              rows={rows}
            />
          </>
        )}

        <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
          Chamadas: <span className="sac-num">GET /admin/users</span> ·{' '}
          <span className="sac-num">PATCH /admin/users/:id</span> ·{' '}
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
            onChanged();
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
    </Card>
  );
}
