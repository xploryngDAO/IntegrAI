/**
 * Confirmation of the platform-console soft delete (`DELETE /platform/tenants/:id`).
 *
 * A platform administrator does not need the workspace password on this route,
 * so the guard against a one-click destructive action is the **exact slug**,
 * typed by the operator: the confirm button stays disabled until it matches.
 * The purge is deliberately NOT offered here — it is a separate action that
 * only exists after the workspace reaches `DELETED`.
 */
import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal } from '../ui';

/** Stable id so the confirmation field can receive focus after the DS dialog mounts. */
const SLUG_INPUT_ID = 'tenant-delete-slug-confirmation';

export interface TenantDeleteDialogProps {
  tenantName: string;
  /** Slug the operator has to type (case-insensitive, like the API contract). */
  slug: string;
  /** Server message of the failed DELETE; keeps the dialog open. */
  error: string | null;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function TenantDeleteDialog({
  tenantName,
  slug,
  error,
  deleting,
  onCancel,
  onConfirm,
}: TenantDeleteDialogProps): JSX.Element {
  const [typedSlug, setTypedSlug] = useState('');

  const expectedSlug = slug.trim();
  const matches =
    expectedSlug.length > 0 &&
    typedSlug.trim().toLocaleLowerCase('pt-BR') === expectedSlug.toLocaleLowerCase('pt-BR');
  const canConfirm = matches && !deleting;

  useEffect(() => {
    // Radix focuses its own close control when the dialog mounts; the field is
    // the real first step, so focus moves here right after that auto-focus.
    const timer = window.setTimeout(() => {
      document.getElementById(SLUG_INPUT_ID)?.focus();
    }, 60);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <Modal
      open
      onClose={() => {
        if (!deleting) onCancel();
      }}
      title="Excluir workspace"
      description={`Você está prestes a excluir logicamente "${tenantName}" (${expectedSlug.length > 0 ? expectedSlug : 'slug não informado'}).`}
      footer={
        <>
          <Button
            className="min-h-[var(--cv-size-touch)]"
            onClick={onCancel}
            disabled={deleting}
          >
            Cancelar
          </Button>
          <Button
            variant="danger"
            icon="close"
            loading={deleting}
            disabled={!canConfirm}
            className="min-h-[var(--cv-size-touch)]"
            onClick={onConfirm}
          >
            Excluir workspace
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Alert title="O que a exclusão faz" tone="danger">
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
            <li>Encerra imediatamente as sessões ativas dos operadores do workspace.</li>
            <li>
              Marca o workspace como <strong>DELETED</strong>: ele sai do acesso e a purga
              física (LGPD) fica agendada para depois da janela de retenção.
            </li>
            <li>
              Nada é apagado definitivamente nesta etapa — a purga é uma ação separada, com
              confirmação própria.
            </li>
          </ul>
        </Alert>

        <div className="flex flex-col gap-1.5">
          <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
            Para confirmar, digite o slug exato do workspace:
          </p>
          <code className="sac-num max-w-full w-fit break-all rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-2 py-1 text-[var(--cv-font-control)]">
            {expectedSlug.length > 0 ? expectedSlug : '—'}
          </code>
          <Input
            id={SLUG_INPUT_ID}
            label="Slug do workspace"
            autoComplete="off"
            spellCheck={false}
            value={typedSlug}
            disabled={deleting}
            placeholder={expectedSlug.length > 0 ? expectedSlug : 'slug do workspace'}
            hint="Maiúsculas e minúsculas não fazem diferença; o texto precisa ser o slug completo."
            error={
              typedSlug.length > 0 && !matches ? 'O slug não confere com o deste workspace.' : undefined
            }
            onChange={(event) => setTypedSlug(event.target.value)}
          />
        </div>

        {expectedSlug.length === 0 ? (
          <Alert title="Slug indisponível" tone="warning">
            O console abriu este tenant sem o slug. Feche o painel, atualize a lista e abra o
            workspace novamente antes de excluí-lo.
          </Alert>
        ) : null}

        {error !== null ? (
          <Alert title="Não foi possível excluir o workspace" tone="danger">
            {error}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}
