import { useState } from 'react';
import { api, setAuthToken } from '../../lib/api';
import type { TenantProfile } from '../../lib/types';
import { tenantActionErrorMessage } from '../../lib/platform';
import { Alert, Button, Input, Modal } from '../ui';

export interface DeleteWorkspaceDialogProps {
  tenant: TenantProfile;
  onClose: () => void;
}

/**
 * LGPD workspace deletion (`DELETE /tenants/me`).
 *
 * Two independent confirmations are required by the API contract: the ADMIN
 * password and the exact tenant slug. On success the local token is discarded
 * and the app hard-resets to `/login`, because the session gate caches the
 * authenticated state for the page load — a soft navigation would bounce back
 * into the (now deleted) workspace.
 */
export function DeleteWorkspaceDialog({ tenant, onClose }: DeleteWorkspaceDialogProps): JSX.Element {
  const [password, setPassword] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const slugMatches =
    slug.trim().toLocaleLowerCase('pt-BR') === tenant.slug.trim().toLocaleLowerCase('pt-BR');

  async function handleDelete(): Promise<void> {
    if (deleting) return;
    if (password.length === 0) {
      setError('Informe a senha do administrador para confirmar a exclusão.');
      return;
    }
    if (!slugMatches) {
      setError('Digite o slug exato do workspace para confirmar a exclusão.');
      return;
    }

    setDeleting(true);
    setError(null);
    try {
      // The API re-checks the exact slug and the ADMIN password (bcrypt) and
      // answers 202 with the soft-delete result.
      await api.deleteTenant({ password, confirmSlug: tenant.slug });
    } catch (deleteError) {
      setError(tenantActionErrorMessage(deleteError));
      setDeleting(false);
      return;
    }

    // Best-effort server-side logout; the token is discarded regardless.
    try {
      await api.logout();
    } catch {
      // The tenant is gone and the token below is cleared; no user action.
    }
    setAuthToken(null);
    window.location.replace('/login');
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!deleting) onClose();
      }}
      title="Excluir workspace definitivamente"
      description={`Você está prestes a excluir "${tenant.name}" (${tenant.slug}). Esta ação é irreversível.`}
      footer={
        <>
          <Button onClick={onClose} disabled={deleting}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            icon="close"
            loading={deleting}
            disabled={password.length === 0 || !slugMatches}
            onClick={() => void handleDelete()}
          >
            Excluir workspace
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Alert title="Ação irreversível" tone="danger">
          O workspace é desativado imediatamente e não pode ser recuperado pelo console. Contas,
          agentes, tickets e mensagens entram no fluxo de eliminação de dados da plataforma
          (soft delete + purge), conforme o pedido de eliminação da LGPD.
        </Alert>

        <Input
          label="Senha do administrador"
          type="password"
          autoComplete="current-password"
          value={password}
          placeholder="Sua senha atual"
          onChange={(event) => {
            setPassword(event.target.value);
            setError(null);
          }}
        />

        <div className="flex flex-col gap-1.5">
          <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
            Para confirmar, digite o slug do workspace:
          </p>
          <code className="sac-num w-fit rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-2 py-1 text-[var(--cv-font-control)]">
            {tenant.slug}
          </code>
          <Input
            label="Slug do workspace"
            autoComplete="off"
            spellCheck={false}
            value={slug}
            placeholder={tenant.slug}
            error={
              slug.length > 0 && !slugMatches ? 'O slug não confere com o workspace atual.' : undefined
            }
            onChange={(event) => {
              setSlug(event.target.value);
              setError(null);
            }}
          />
        </div>

        <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
          Após a exclusão, sua sessão é encerrada e você volta para o login.
        </p>

        {error !== null ? (
          <Alert title="Não foi possível excluir o workspace" tone="danger">
            {error}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}
