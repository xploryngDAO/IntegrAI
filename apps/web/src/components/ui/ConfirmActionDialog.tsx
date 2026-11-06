import type { ReactNode } from 'react';
import { Button } from './Button';
import { Modal } from './Feedback';

export interface ConfirmActionDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  /** Label of the dismiss action (default "Cancelar"). */
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  /** Optional body with the specific consequences of the action. */
  children?: ReactNode;
}

/**
 * Generic confirmation dialog for actions whose copy is not the marketplace
 * one (`ConfirmDialog` is kept for channel actions).
 *
 * Used by account/session/admin flows: the caller writes the exact consequence,
 * the dialog only owns the two buttons, the busy state and the keyboard/overlay
 * dismissal contract of the Convergência dialog.
 */
export function ConfirmActionDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancelar',
  tone = 'primary',
  loading = false,
  onConfirm,
  onClose,
  children,
}: ConfirmActionDialogProps): JSX.Element {
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!loading) onClose();
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children ?? (
        <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
          {description}
        </p>
      )}
    </Modal>
  );
}
