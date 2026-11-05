import type { HTMLAttributes, ReactNode } from 'react';
import { Card as CvCard, cx } from '@xploryng/convergencia';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  padded?: boolean;
}

/**
 * Convergência surface with an optional header row.
 * Cards separate content with restrained borders; avoid stacking decorative
 * cards inside cards (see docs/foundations.md).
 */
export function Card({
  title,
  subtitle,
  actions,
  footer,
  padded = true,
  children,
  className,
  ...props
}: CardProps) {
  return (
    <CvCard
      {...props}
      className={cx(padded && 'p-[14px]', className)}
      footer={
        footer ? (
          <div className="flex w-full items-center justify-between gap-2">{footer}</div>
        ) : undefined
      }
    >
      {(title || actions) && (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {title ? (
              <h3 className="m-0 text-[var(--cv-font-lead)] font-semibold leading-[var(--cv-font-line-heading)]">
                {title}
              </h3>
            ) : null}
            {subtitle ? (
              <p className="m-0 mt-[2px] text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
                {subtitle}
              </p>
            ) : null}
          </div>
          {actions ? <div className="flex flex-none items-center gap-1">{actions}</div> : null}
        </div>
      )}
      {children}
    </CvCard>
  );
}
