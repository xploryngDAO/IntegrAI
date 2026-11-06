import { useState } from 'react';
import { api } from '../../lib/api';
import { adminErrorMessage, ROLE_OPTIONS } from '../../lib/admin';
import { isValidEmail } from '../../lib/validation';
import type { InviteUserResult } from '../../lib/types';
import { Alert, Button, Input, Modal, Select } from '../ui';

export interface InviteUserDialogProps {
  onClose: () => void;
  onInvited: (result: InviteUserResult) => void;
}

/**
 * "Convidar operador" CTA of `/admin`.
 *
 * Uses the existing Fase 1 invitation endpoint (`POST /invitations`, ADMIN): the
 * API mails the single-use invite link that opens `/invite?token=…`. The dialog
 * never claims the invitation exists before the API answers 201.
 */
export function InviteUserDialog({ onClose, onInvited }: InviteUserDialogProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('AGENT');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedEmail = email.trim().toLowerCase();
  const emailError =
    trimmedEmail.length === 0
      ? undefined
      : isValidEmail(trimmedEmail)
        ? undefined
        : 'Informe um e-mail válido.';

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    if (!isValidEmail(trimmedEmail)) {
      setError('Informe um e-mail válido para enviar o convite.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await api.inviteUser({ email: trimmedEmail, role });
      onInvited(result);
      onClose();
    } catch (inviteError) {
      setError(adminErrorMessage(inviteError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!submitting) onClose();
      }}
      title="Convidar operador"
      description="A API envia um link de uso único para o e-mail informado. O convite expira em 7 dias."
      footer={
        <>
          <Button onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="admin-invite-form"
            variant="primary"
            icon="users"
            loading={submitting}
            disabled={!isValidEmail(trimmedEmail)}
          >
            Enviar convite
          </Button>
        </>
      }
    >
      <form
        id="admin-invite-form"
        className="flex flex-col gap-3"
        onSubmit={(event) => void handleSubmit(event)}
      >
        <Input
          label="E-mail do operador"
          type="email"
          autoComplete="email"
          placeholder="nome@suaempresa.com.br"
          value={email}
          required
          error={emailError}
          disabled={submitting}
          onChange={(event) => {
            setEmail(event.target.value);
            setError(null);
          }}
        />

        <Select
          label="Papel inicial"
          options={ROLE_OPTIONS.map((option) => ({ ...option }))}
          value={role}
          disabled={submitting}
          hint="Pode ser alterado depois na tabela de usuários."
          onChange={(event) => {
            setRole(event.target.value);
            setError(null);
          }}
        />

        <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
          Chamada executada: <span className="sac-num">POST /invitations</span>. Reenviar para o
          mesmo e-mail renova o token do convite pendente.
        </p>

        {error !== null ? (
          <Alert title="Não foi possível enviar o convite" tone="danger">
            {error}
          </Alert>
        ) : null}
      </form>
    </Modal>
  );
}
