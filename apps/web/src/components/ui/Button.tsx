import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, cx, type IconName } from '@xploryng/convergencia';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Convergência icon name or any node (lucide, custom svg). */
  icon?: IconName | ReactNode;
  fullWidth?: boolean;
}

function renderIcon(icon: ButtonProps['icon']): ReactNode {
  if (!icon) return null;
  if (typeof icon === 'string') return <Icon name={icon as IconName} size={17} />;
  return icon;
}

/**
 * Primary action button backed by Convergência `.cv-button`.
 * `loading` keeps the accessible name and blocks double submits.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  fullWidth = false,
  children,
  className,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'cv-button',
        `cv-button--${variant}`,
        `cv-button--${size}`,
        fullWidth && 'w-full',
        className,
      )}
    >
      {loading ? <span className="cv-spinner" aria-hidden="true" /> : renderIcon(icon)}
      {children !== undefined && children !== null && <span>{children}</span>}
    </button>
  );
}

export interface IconButtonProps {
  label: string;
  icon: IconName | ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit';
}

/** Icon-only action. The accessible name is mandatory in the Convergência contract. */
export function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'md',
  onClick,
  disabled,
  className,
  type = 'button',
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'cv-button',
        `cv-button--${variant}`,
        `cv-button--${size}`,
        'cv-icon-button',
        className,
      )}
    >
      <span>{renderIcon(icon)}</span>
    </button>
  );
}
