import type { ReactNode } from 'react';
import {
  Alert as CvAlert,
  Dialog as CvDialog,
  EmptyState as CvEmptyState,
  Kbd as CvKbd,
  SegmentedControl as CvSegmented,
  Skeleton as CvSkeleton,
  Spinner as CvSpinner,
  Tooltip as CvTooltip,
  type IconName,
  type Tone,
} from '@xploryng/convergencia';
import { Button } from './Button';

/* --------------------------------------------------------------- dialogs --- */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ open, onClose, title, description, children, footer }: ModalProps) {
  return (
    <CvDialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      title={title}
      description={description}
      footer={footer}
    >
      {children}
    </CvDialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  tone = 'primary',
  loading = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={onClose} disabled={loading}>
            Cancelar
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
        Esta ação é registrada no histórico do atendimento e enviada ao marketplace. Revise antes de
        confirmar.
      </p>
    </Modal>
  );
}

/* -------------------------------------------------------------- feedback --- */

export function Alert({
  title,
  tone = 'accent',
  children,
}: {
  title: string;
  tone?: 'accent' | 'success' | 'warning' | 'danger' | 'neutral' | 'rose';
  children?: ReactNode;
}) {
  return (
    <CvAlert title={title} tone={tone as Tone}>
      {children}
    </CvAlert>
  );
}

export function EmptyState({
  title,
  description,
  icon = 'folder',
  action,
}: {
  title: string;
  description: string;
  icon?: IconName;
  action?: ReactNode;
}) {
  return <CvEmptyState title={title} description={description} icon={icon} action={action} />;
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={className}>
      <CvSkeleton width="100%" height={14} />
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <CvSpinner label={label} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <CvKbd>{children}</CvKbd>;
}

export function Tooltip({ label, children }: { label: string; children: React.ReactElement }) {
  return <CvTooltip content={label}>{children}</CvTooltip>;
}

export function SegmentedControl({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return <CvSegmented label={label} options={options} value={value} onValueChange={onChange} />;
}
