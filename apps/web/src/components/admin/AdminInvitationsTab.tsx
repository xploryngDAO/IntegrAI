import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DataTable } from '@xploryng/convergencia';
import { api, ApiClientError } from '../../lib/api';
import {
  adminErrorMessage,
  canResendInvitation,
  invitationErrorMessage,
  invitationStatusLabel,
  invitationStatusTone,
  isInvitationExpired,
  isInvitationPending,
  resendInvitationErrorMessage,
  roleLabel,
  roleTone,
} from '../../lib/admin';
import { formatDateTime } from '../../lib/labels';
import type { AdminInvitation } from '../../lib/types';
import { Alert, Button, Card, ConfirmActionDialog, EmptyState, Pill, Skeleton } from '../ui';
import { InviteUserDialog } from './InviteUserDialog';

export interface AdminInvitationsTabProps {
  /** A 403 anywhere turns the whole `/admin` page into "Acesso restrito". */
  onForbidden: () => void;
  /** Page-level refresh counter (the header "Atualizar" also reloads the list). */
  refreshKey?: number;
}

/**
 * "Convites" tab of `/admin`.
 *
 * The pending invitations of the workspace (`GET /admin/invitations`) with the
 * writes the API allows on them:
 *  - revoke a **PENDING** invite (`DELETE /admin/invitations/:id`, 204);
 *  - re-send the link of a **PENDING** or **EXPIRED** invite
 *    (`POST /admin/invitations/:id/resend`), never an ACCEPTED one.
 *
 * The CTA reuses `InviteUserDialog` (`POST /invitations`) and the list is
 * re-read after every successful write, so the table always reflects the
 * server — never an optimistic guess.
 *
 * A 409 (`INVITATION_ALREADY_ACCEPTED`) keeps the dialog open and shows the
 * API's real message: the invitee accepted in another session and the row must
 * not disappear as if the revoke/re-send had worked. A 502
 * (`EMAIL_SEND_FAILED`) is surfaced as a delivery failure — the UI never claims
 * the e-mail was sent when the API could not deliver it.
 */
export function AdminInvitationsTab({
  onForbidden,
  refreshKey = 0,
}: AdminInvitationsTabProps): JSX.Element {
  const [items, setItems] = useState<AdminInvitation[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AdminInvitation | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [resendTarget, setResendTarget] = useState<AdminInvitation | null>(null);
  const [resending, setResending] = useState(false);
  /** Id of the row whose re-send is running (per-row loading, not a global one). */
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    let active = true;

    async function load(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const result = await api.adminInvitations();
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

    void load();
    return () => {
      active = false;
    };
  }, [onForbidden, refreshKey, reloadKey]);

  const pendingCount = items.filter((invitation) => isInvitationPending(invitation.status)).length;

  function reload(): void {
    setReloadKey((key) => key + 1);
  }

  async function handleRevoke(): Promise<void> {
    if (revokeTarget === null || revoking) return;
    const target = revokeTarget;
    setRevoking(true);
    setRevokeError(null);
    try {
      await api.revokeInvitation(target.id);
      setRevokeTarget(null);
      setNotice({
        tone: 'success',
        text: `Convite de ${target.email} revogado. O link enviado por e-mail deixa de funcionar.`,
      });
      reload();
    } catch (failure) {
      if (failure instanceof ApiClientError && failure.status === 403) {
        onForbidden();
        return;
      }
      // Keep the dialog open: the real 409 message ("already accepted") is the
      // whole point of this error state. Re-reading the list updates the status.
      setRevokeError(invitationErrorMessage(failure));
      reload();
    } finally {
      setRevoking(false);
    }
  }

  async function handleResend(): Promise<void> {
    if (resendTarget === null || resending) return;
    const target = resendTarget;
    setResending(true);
    setResendingId(target.id);
    setResendError(null);
    try {
      const result = await api.resendInvitation(target.id);
      const email = result?.email || target.email;
      const recipient = email.length > 0 ? email : 'o operador convidado';
      setResendTarget(null);
      setNotice({
        tone: 'success',
        text:
          result?.expiresAt
            ? `Convite reenviado para ${recipient}. O novo link expira em ${formatDateTime(result.expiresAt)}.`
            : `Convite reenviado para ${recipient}. A lista já reflete o novo prazo do convite.`,
      });
      // The POST response is only the success signal: the row is re-read from
      // the server so the status/expiry shown are the API's, not a local patch.
      reload();
    } catch (failure) {
      if (failure instanceof ApiClientError && failure.status === 403) {
        setResendTarget(null);
        onForbidden();
        return;
      }
      // Keep the dialog open with the real message (409 already accepted, 502
      // e-mail not delivered…) and refresh the list so the row stops lying.
      setResendError(resendInvitationErrorMessage(failure));
      reload();
    } finally {
      setResending(false);
      setResendingId(null);
    }
  }

  const columns = [
    { key: 'email', label: 'E-mail' },
    { key: 'role', label: 'Papel' },
    { key: 'createdAt', label: 'Criado' },
    { key: 'expiresAt', label: 'Expira' },
    { key: 'status', label: 'Status' },
    { key: 'actions', label: 'Ações' },
  ];

  const rows = useMemo<Record<string, ReactNode>[]>(
    () =>
      items.map((invitation) => ({
        email:
          invitation.email.length > 0 ? (
            <span className="sac-admin-email" title={invitation.email}>
              {invitation.email}
            </span>
          ) : (
            <span className="text-[var(--cv-color-text-muted)]">—</span>
          ),
        role: <Pill tone={roleTone(invitation.role)}>{roleLabel(invitation.role)}</Pill>,
        createdAt: (
          <span className="sac-num" title={invitation.createdAt || undefined}>
            {invitation.createdAt ? formatDateTime(invitation.createdAt) : '—'}
          </span>
        ),
        expiresAt: (
          <span className="sac-num" title={invitation.expiresAt || undefined}>
            {invitation.expiresAt ? formatDateTime(invitation.expiresAt) : '—'}
          </span>
        ),
        status: (
          <Pill
            tone={invitationStatusTone(invitation.status)}
            title={
              invitation.acceptedAt !== null
                ? `Aceito em ${formatDateTime(invitation.acceptedAt)}`
                : undefined
            }
          >
            {invitationStatusLabel(invitation.status)}
          </Pill>
        ),
        actions: canResendInvitation(invitation.status) ? (
          <span className="sac-admin-actions">
            <Button
              size="sm"
              variant="ghost"
              icon="link"
              loading={resendingId === invitation.id}
              disabled={resendingId !== null && resendingId !== invitation.id}
              aria-label={`Reenviar o convite de ${invitation.email || 'operador'}`}
              onClick={() => {
                setNotice(null);
                setResendError(null);
                setResendTarget(invitation);
              }}
            >
              Reenviar
            </Button>
            {isInvitationPending(invitation.status) ? (
              <Button
                size="sm"
                variant="ghost"
                icon="close"
                aria-label={`Revogar o convite de ${invitation.email || 'operador'}`}
                onClick={() => {
                  setNotice(null);
                  setRevokeError(null);
                  setRevokeTarget(invitation);
                }}
              >
                Revogar
              </Button>
            ) : null}
          </span>
        ) : (
          <span
            className="text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]"
            title={
              invitation.status.trim().toUpperCase() === 'ACCEPTED'
                ? 'Convites aceitos não podem ser reenviados nem revogados.'
                : 'Nenhuma ação disponível para o status atual deste convite.'
            }
          >
            —
          </span>
        ),
      })),
    [items, resendingId],
  );

  return (
    <Card
      title="Convites da equipe"
      subtitle={
        loading
          ? 'Consultando os convites do workspace…'
          : `${pendingCount} pendente(s) de ${total} convite(s). Pendentes e expirados podem ser reenviados; a revogação vale só para pendentes.`
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" icon="pulse" loading={loading} onClick={reload}>
            Atualizar
          </Button>
          <Button variant="primary" icon="plus" onClick={() => setInviteOpen(true)}>
            Convidar operador
          </Button>
        </div>

        {notice !== null ? (
          <Alert
            title={notice.tone === 'success' ? 'Convites atualizados' : 'Ação não concluída'}
            tone={notice.tone}
          >
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
          <Alert title="Não foi possível carregar os convites" tone="danger">
            <div className="flex flex-col gap-2">
              <span>{error}</span>
              <div>
                <Button size="sm" icon="pulse" onClick={reload}>
                  Tentar novamente
                </Button>
              </div>
            </div>
          </Alert>
        ) : items.length === 0 ? (
          <EmptyState
            icon="users"
            title="Nenhum convite registrado"
            description="Convide um operador para enviar o link de uso único. Convites pendentes e expirados aparecem aqui com a data de expiração e podem ser reenviados; só os pendentes podem ser revogados."
            action={
              <Button variant="primary" icon="plus" onClick={() => setInviteOpen(true)}>
                Convidar operador
              </Button>
            }
          />
        ) : (
          <>
            <p className="sac-admin-scroll-hint">
              Deslize a tabela para ver papel, datas, status e as ações de reenviar e revogar.
            </p>
            <DataTable
              caption={`Convites do workspace — ${items.length} convite(s)`}
              columns={columns}
              rows={rows}
            />
          </>
        )}

        <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
          Chamadas: <span className="sac-num">GET /admin/invitations</span> ·{' '}
          <span className="sac-num">POST /admin/invitations/:id/resend</span> ·{' '}
          <span className="sac-num">DELETE /admin/invitations/:id</span>. O reenvio manda o e-mail
          novamente e renova a expiração do convite; a revogação invalida o link sem reenviar e-mail.
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
            reload();
          }}
        />
      ) : null}

      <ConfirmActionDialog
        open={resendTarget !== null}
        title={`Reenviar o convite de ${resendTarget?.email || 'operador'}?`}
        description="A API reenvia o e-mail do link de uso único e define um novo prazo de expiração."
        confirmLabel="Reenviar convite"
        tone="primary"
        loading={resending}
        onConfirm={() => void handleResend()}
        onClose={() => {
          if (!resending) {
            setResendTarget(null);
            setResendError(null);
          }
        }}
      >
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            {resendTarget !== null && isInvitationExpired(resendTarget.status)
              ? `Este convite expirou em ${
                  resendTarget.expiresAt ? formatDateTime(resendTarget.expiresAt) : 'uma data anterior'
                }. O reenvio o deixa pendente de novo, com um novo link de uso único.`
              : 'O convite continua pendente. Um novo e-mail com o link de uso único será enviado ao operador.'}
          </p>
          <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            Nenhum operador é criado por esta ação e convites aceitos nunca podem ser reenviados.
          </p>
          {resendError !== null ? (
            <Alert title="Não foi possível reenviar o convite" tone="danger">
              {resendError}
            </Alert>
          ) : null}
        </div>
      </ConfirmActionDialog>

      <ConfirmActionDialog
        open={revokeTarget !== null}
        title={`Revogar o convite de ${revokeTarget?.email || 'operador'}?`}
        description="O link de uso único deixa de funcionar imediatamente."
        confirmLabel="Revogar convite"
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
            O operador convidado não conseguirá aceitar o convite; será preciso enviar um novo para o
            mesmo e-mail. Convites já aceitos não aparecem com a ação de revogar.
          </p>
          {revokeError !== null ? (
            <Alert title="Não foi possível revogar o convite" tone="danger">
              {revokeError}
            </Alert>
          ) : null}
        </div>
      </ConfirmActionDialog>
    </Card>
  );
}
