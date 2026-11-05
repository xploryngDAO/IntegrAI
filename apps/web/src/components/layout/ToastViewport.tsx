import { IconButton } from '../ui';
import { useWorkspace } from '../../lib/store';
import type { ToastTone } from '../../lib/types';

const TONE_STYLE: Record<ToastTone, { background: string; border: string; color: string }> = {
  ok: {
    background: 'var(--cv-color-success-soft)',
    border: 'color-mix(in srgb, var(--cv-color-success) 35%, transparent)',
    color: 'var(--cv-color-success)',
  },
  warn: {
    background: 'var(--cv-color-warning-soft)',
    border: 'color-mix(in srgb, var(--cv-color-warning) 35%, transparent)',
    color: 'var(--cv-color-warning)',
  },
  danger: {
    background: 'var(--cv-color-danger-soft)',
    border: 'color-mix(in srgb, var(--cv-color-danger) 35%, transparent)',
    color: 'var(--cv-color-danger)',
  },
  info: {
    background: 'var(--cv-color-accent-soft)',
    border: 'color-mix(in srgb, var(--cv-color-accent) 30%, transparent)',
    color: 'var(--cv-color-accent-text)',
  },
};

/** Global toast viewport (aria-live), mounted once in App.tsx. */
export function ToastViewport(): JSX.Element {
  const toasts = useWorkspace((state) => state.toasts);
  const dismissToast = useWorkspace((state) => state.dismissToast);

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-5 right-5 z-[70] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((toast) => {
        const tone = TONE_STYLE[toast.tone];
        return (
          <div
            key={toast.id}
            role="status"
            className="pointer-events-auto flex animate-[fade-in_var(--cv-motion-normal)_var(--cv-motion-ease)] items-start gap-2 rounded-[var(--cv-radius-control)] border px-3 py-2.5"
            style={{
              background: 'var(--cv-color-surface)',
              borderColor: tone.border,
              boxShadow: 'var(--cv-shadow-floating)',
            }}
          >
            <span
              className="mt-1.5 h-2 w-2 flex-none rounded-full"
              style={{ background: tone.color }}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="m-0 text-[var(--cv-font-control)] font-medium leading-5">
                {toast.title}
              </p>
              {toast.description ? (
                <p className="m-0 mt-0.5 break-words text-[var(--cv-font-meta)] leading-5 text-[var(--cv-color-text-muted)]">
                  {toast.description}
                </p>
              ) : null}
            </div>
            <IconButton
              label="Fechar notificação"
              icon="close"
              onClick={() => dismissToast(toast.id)}
            />
          </div>
        );
      })}
    </div>
  );
}
