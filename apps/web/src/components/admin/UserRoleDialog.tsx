import { useState } from 'react';
import { api } from '../../lib/api';
import { adminErrorMessage, roleLabel, roleOptionsFor } from '../../lib/admin';
import type { AdminUser } from '../../lib/types';
import { Alert, Button, Modal, Select } from '../ui';

export interface UserRoleDialogProps {
  user: AdminUser;
  onClose: () => void;
  onSaved: (user: AdminUser) => void;
}

/**
 * Changes the workspace role of one operator (`PATCH /admin/users/:id { role }`).
 *
 * The select preserves a role this console does not know yet, so opening the
 * dialog and saving without changes can never silently rewrite it. The API is
 * the guard: a 403/409/422 is shown verbatim in the dialog.
 */
export function UserRoleDialog({ user, onClose, onSaved }: UserRoleDialogProps): JSX.Element {
  const [role, setRole] = useState(user.role);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = role !== user.role;

  async function handleSave(): Promise<void> {
    if (saving || !changed) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateAdminUser(user.id, { role });
      onSaved(updated);
      onClose();
    } catch (saveError) {
      setError(adminErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title={`Alterar papel de ${user.name}`}
      description={`Hoje este operador é ${roleLabel(user.role)}. O novo papel vale para as próximas requisições dele.`}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            icon="check"
            loading={saving}
            disabled={!changed}
            onClick={() => void handleSave()}
          >
            Salvar papel
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Select
          label="Novo papel"
          options={roleOptionsFor(user.role)}
          value={role}
          disabled={saving}
          hint="ADMIN administra a equipe e o workspace; SUPERVISOR e AGENT atuam na fila."
          onChange={(event) => {
            setRole(event.target.value);
            setError(null);
          }}
        />

        <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
          Operador: <strong className="font-medium text-[var(--cv-color-text)]">{user.email}</strong>{' '}
          · Chamada: <span className="sac-num">PATCH /admin/users/:id</span>
        </p>

        {error !== null ? (
          <Alert title="Não foi possível alterar o papel" tone="danger">
            {error}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}
