import { cx } from '@xploryng/convergencia';

/**
 * Brand block shared by the session-free screens (login, signup, e-mail flows
 * and the public status page): Convergência mark + product wordmark.
 */
export function BrandMark({ className }: { className?: string }): JSX.Element {
  return (
    <div className={cx('flex items-center gap-3', className)}>
      <span className="flex h-11 w-11 flex-none items-center justify-center rounded-[var(--cv-radius-control)] bg-[var(--cv-color-accent)] font-mono text-[13px] font-semibold tracking-[0.06em] text-[var(--cv-color-on-accent)]">
        SH
      </span>
      <div className="min-w-0">
        <div className="font-mono text-[15px] font-semibold leading-tight tracking-[0.16em] text-[var(--cv-color-text)]">
          SAC HUB
        </div>
        <div className="sac-brand__descriptor text-[var(--cv-font-micro)] uppercase leading-snug tracking-[0.1em] text-[var(--cv-color-text-muted)]">
          Central de atendimento omnichannel
        </div>
      </div>
    </div>
  );
}
