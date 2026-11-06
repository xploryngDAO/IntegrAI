/**
 * Extra confirmation of the physical LGPD purge (`POST /platform/tenants/:id/purge`).
 *
 * The action is only reachable for a workspace already in `DELETED`; the caller
 * hides the button otherwise. Typing `PURGAR` (uppercase, exact) is the second
 * guard before a request that removes rows from every table and the S3 objects
 * of the workspace.
 */
import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal } from '../ui';

/** Word the operator has to type to unlock the destructive action. */
export const PURGE_CONFIRMATION_WORD = 'PURGAR';

/** Stable id so the confirmation field can receive focus after the DS dialog mounts. */
const PURGE_INPUT_ID = 'tenant-purge-confirmation';

export interface TenantPurgeDialogProps {
  tenantName: string;
  /** Server message of the failed purge; keeps the dialog open. */
  error: string | null;
  purging: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function TenantPurgeDialog({
  tenantName,
  error,
  purging,
  onCancel,
  onConfirm,
}: TenantPurgeDialogProps): JSX.Element {
  const [typedWord, setTypedWord] = useState('');
  const matches = typedWord.trim() === PURGE_CONFIRMATION_WORD;
  const canConfirm = matches && !purging;

  useEffect(() => {
    // Same delayed focus as the delete dialog: Radix auto-focuses the close
    // control first, and the confirmation field is the step that matters.
    const timer = window.setTimeout(() => {
      document.getElementById(PURGE_INPUT_ID)?.focus();
    }, 60);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <Modal
      open
      onClose={() => {
        if (!purging) onCancel();
      }}
      title="Purgar workspace definitivamente"
      description={`Purga física e irreversível de "${tenantName}". Esta ação não pode ser desfeita.`}
      footer={
        <>
          <Button
            className="min-h-[var(--cv-size-touch)]"
            onClick={onCancel}
            disabled={purging}
          >
            Cancelar
          </Button>
          <Button
            variant="danger"
            icon="tool"
            loading={purging}
            disabled={!canConfirm}
            className="min-h-[var(--cv-size-touch)]"
            onClick={onConfirm}
          >
            Purgar definitivamente
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Alert title="Purga física irreversível" tone="danger">
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
            <li>Remove as linhas do workspace em todas as tabelas operacionais.</li>
            <li>Remove os objetos do workspace no storage, incluindo os backups indexados.</li>
            <li>Não existe restauração pelo console depois desta etapa.</li>
          </ul>
        </Alert>

        <div className="flex flex-col gap-1.5">
          <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
            Para confirmar, digite <strong>{PURGE_CONFIRMATION_WORD}</strong> em letras
            maiúsculas:
          </p>
          <Input
            id={PURGE_INPUT_ID}
            label="Confirmação"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="characters"
            value={typedWord}
            disabled={purging}
            placeholder={PURGE_CONFIRMATION_WORD}
            hint={`O botão libera apenas com a palavra ${PURGE_CONFIRMATION_WORD}.`}
            error={
              typedWord.length > 0 && !matches
                ? `Digite ${PURGE_CONFIRMATION_WORD} (letras maiúsculas), sem espaços.`
                : undefined
            }
            onChange={(event) => setTypedWord(event.target.value)}
          />
        </div>

        {error !== null ? (
          <Alert title="Não foi possível purgar o workspace" tone="danger">
            {error}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}
