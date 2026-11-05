import { AlertTriangle, FileText, Image as ImageIcon, X } from 'lucide-react';
import { Spinner } from '../ui';
import { formatFileSize } from '../../lib/format';

/** Attachment staged in the composer while it uploads to `POST /files/upload`. */
export interface PendingAttachment {
  localId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: 'uploading' | 'done' | 'error';
  /** Object-storage key returned by the API; only present when status === 'done'. */
  key?: string;
  error?: string;
}

/** Kept for callers that format pending chips (10 MB limit messaging). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function formatAttachmentSize(bytes: number): string {
  return formatFileSize(bytes);
}

function AttachmentIcon({ mimeType }: { mimeType: string }): JSX.Element {
  if (mimeType.startsWith('image/')) return <ImageIcon size={13} aria-hidden="true" />;
  return <FileText size={13} aria-hidden="true" />;
}

interface AttachmentTrayProps {
  items: PendingAttachment[];
  onRemove: (localId: string) => void;
}

/** Pending-upload chips on the DS file-pill geometry (`.sac-msg__file`). */
export function AttachmentTray({ items, onRemove }: AttachmentTrayProps): JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Anexos do rascunho">
      {items.map((item) => {
        const failed = item.status === 'error';
        const uploading = item.status === 'uploading';
        return (
          <span
            key={item.localId}
            className="sac-msg__file"
            style={
              failed
                ? { borderColor: 'var(--cv-color-danger)', color: 'var(--cv-color-danger)' }
                : undefined
            }
          >
            {uploading ? (
              <Spinner label={`Enviando ${item.fileName}`} />
            ) : failed ? (
              <AlertTriangle size={13} aria-hidden="true" />
            ) : (
              <AttachmentIcon mimeType={item.mimeType} />
            )}
            <span className="sac-clip max-w-[160px]" title={item.fileName}>
              {item.fileName}
            </span>
            <span className="sac-num">{formatFileSize(item.sizeBytes)}</span>
            {uploading ? (
              <span className="sac-label">enviando</span>
            ) : failed ? (
              <span className="sac-label">falhou</span>
            ) : null}
            <button
              type="button"
              aria-label={`Remover anexo ${item.fileName}`}
              title={`Remover ${item.fileName}`}
              onClick={() => onRemove(item.localId)}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-[var(--cv-color-text-muted)] hover:bg-elevated hover:text-[var(--cv-color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </span>
        );
      })}
    </div>
  );
}
