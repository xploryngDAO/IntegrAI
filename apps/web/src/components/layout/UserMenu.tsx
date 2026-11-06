import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icon, cx, type IconName } from '@xploryng/convergencia';
import { LogOut } from 'lucide-react';
import { useWorkspace } from '../../lib/store';
import { isPlatformAdmin, isTenantAdmin } from '../../lib/platform';
import { roleLabel, roleTone } from '../../lib/admin';
import { Avatar, Pill } from '../ui';
import { useEndSession } from './useEndSession';

export type UserMenuVariant = 'topbar' | 'rail';

interface MenuEntry {
  key: string;
  label: string;
  icon: IconName;
  to: string;
}

/** Menu width; kept in sync with `.sac-user__menu` (max-width handles phones). */
const MENU_WIDTH = 288;

interface MenuPosition {
  left: number;
  width: number;
  top: number | null;
  bottom: number | null;
}

/**
 * Identity menu of the authenticated operator.
 *
 * Owns the account surface of the shell: profile, settings, administration
 * (ADMIN), platform shortcuts (platform staff), the public status page and the
 * sign-out action. It is rendered in the topbar (all breakpoints) and in the
 * rail footer (desktop); both share the same sign-out path.
 *
 * The popover is portaled into the Convergência root (so dark-theme tokens keep
 * applying) and positioned `fixed` from the trigger rectangle: the topbar clips
 * its own overflow, which would cut an absolutely positioned menu.
 *
 * Accessibility follows the Convergência menu contract: the trigger exposes
 * `aria-haspopup="menu"`/`aria-expanded`, the popover is a `role="menu"` with
 * arrow-key navigation, Escape closes and returns focus to the trigger, and a
 * pointer outside closes it.
 */
export function UserMenu({ variant = 'topbar' }: { variant?: UserMenuVariant }): JSX.Element {
  const agent = useWorkspace((state) => state.currentAgent);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { end: signOut, pending: signingOut } = useEndSession('current');

  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback((restoreFocus = false): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const updatePosition = useCallback((): void => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(MENU_WIDTH, window.innerWidth - 24);
    const preferredLeft = variant === 'rail' ? rect.right + 8 : rect.right - width;
    const left = Math.min(Math.max(12, preferredLeft), window.innerWidth - width - 12);

    if (variant === 'rail') {
      setPosition({ left, width, top: null, bottom: Math.max(12, window.innerHeight - rect.top + 8) });
    } else {
      setPosition({ left, width, top: rect.bottom + 8, bottom: null });
    }
  }, [variant]);

  function toggle(): void {
    if (!open) updatePosition();
    setOpen((current) => !current);
  }

  // Outside pointer / Escape dismissal. The popover lives in a portal, so both
  // the trigger wrapper and the menu node are checked.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent | TouchEvent): void {
      const target = event.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') close(true);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [close, open]);

  // Keep the fixed menu glued to the trigger on resize and on any scroll.
  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  // Navigating from any other control must not leave the menu floating open.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Focus the first actionable item as soon as the popover is mounted.
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)');
    first?.focus();
  }, [open]);

  function moveFocus(event: React.KeyboardEvent<HTMLDivElement>): void {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  }

  const isAdmin = isTenantAdmin(agent);
  const isPlatform = isPlatformAdmin(agent);

  const accountLinks: MenuEntry[] = [
    { key: 'profile', label: 'Perfil', icon: 'users', to: '/profile' },
    { key: 'settings', label: 'Configurações', icon: 'sliders', to: '/settings' },
  ];
  if (isAdmin) {
    accountLinks.push({ key: 'admin', label: 'Administração', icon: 'lock', to: '/admin' });
  }

  const platformLinks: MenuEntry[] = [];
  if (isPlatform) {
    platformLinks.push({ key: 'platform', label: 'Plataforma', icon: 'grid', to: '/platform' });
    platformLinks.push({ key: 'setup', label: 'Integrações', icon: 'rocket', to: '/setup' });
  }

  function go(entry: MenuEntry): void {
    setOpen(false);
    navigate(entry.to);
  }

  const name = agent?.name ?? 'Operador';
  const email = agent?.email ?? '';
  const role = agent?.role ?? 'AGENT';
  const triggerLabel = open ? 'Fechar menu da conta' : 'Abrir menu da conta';
  const portalTarget =
    typeof document === 'undefined'
      ? null
      : (document.querySelector('.cv-root') ?? document.body);

  const menu =
    open && position !== null ? (
      <div
        ref={menuRef}
        role="menu"
        aria-label="Menu da conta"
        className="sac-user__menu"
        data-placement={variant === 'rail' ? 'up' : 'down'}
        style={{
          position: 'fixed',
          left: `${position.left}px`,
          width: `${position.width}px`,
          top: position.top !== null ? `${position.top}px` : undefined,
          bottom: position.bottom !== null ? `${position.bottom}px` : undefined,
        }}
        onKeyDown={moveFocus}
      >
        <div className="sac-user__head">
          <Avatar name={name} size="md" />
          <div className="sac-user__head-text">
            <span className="sac-user__head-name" title={name}>
              {name}
            </span>
            {email.length > 0 ? (
              <span className="sac-user__head-email" title={email}>
                {email}
              </span>
            ) : null}
            <span className="sac-user__head-role">
              <Pill tone={roleTone(role)}>{roleLabel(role)}</Pill>
            </span>
          </div>
        </div>

        {accountLinks.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="menuitem"
            className="sac-user__item"
            onClick={() => go(entry)}
          >
            <Icon name={entry.icon} size={16} />
            <span className="sac-user__item-label">{entry.label}</span>
          </button>
        ))}

        {platformLinks.length > 0 ? (
          <>
            <div className="sac-user__sep" role="presentation" />
            <p className="sac-user__section">Plataforma</p>
            {platformLinks.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="menuitem"
                className="sac-user__item"
                onClick={() => go(entry)}
              >
                <Icon name={entry.icon} size={16} />
                <span className="sac-user__item-label">{entry.label}</span>
              </button>
            ))}
          </>
        ) : null}

        <div className="sac-user__sep" role="presentation" />

        <button
          type="button"
          role="menuitem"
          className="sac-user__item"
          onClick={() => go({ key: 'status', label: 'Status', icon: 'pulse', to: '/status' })}
        >
          <Icon name="pulse" size={16} />
          <span className="sac-user__item-label">Status dos sistemas</span>
        </button>

        <div className="sac-user__sep" role="presentation" />

        <button
          type="button"
          role="menuitem"
          className="sac-user__item"
          data-danger="true"
          disabled={signingOut}
          aria-busy={signingOut || undefined}
          onClick={() => {
            setOpen(false);
            void signOut();
          }}
        >
          {signingOut ? <span className="cv-spinner" aria-hidden="true" /> : <LogOut size={16} />}
          <span className="sac-user__item-label">{signingOut ? 'Saindo…' : 'Sair'}</span>
        </button>
      </div>
    ) : null;

  return (
    <div className="sac-user" data-variant={variant} ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={cx('sac-user__trigger', variant === 'rail' && 'sac-user__trigger--rail')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${triggerLabel} — ${name}`}
        title={variant === 'rail' ? `${name} · ${roleLabel(role)}` : undefined}
        onClick={toggle}
      >
        <Avatar name={name} size="sm" />
        {variant === 'topbar' ? (
          <>
            <span className="sac-user__text">
              <span className="sac-user__name">{name}</span>
              <span className="sac-user__role">{roleLabel(role)}</span>
            </span>
            <span className="sac-user__chevron" aria-hidden="true">
              <Icon name="down" size={14} />
            </span>
          </>
        ) : null}
      </button>

      {menu !== null && portalTarget !== null ? createPortal(menu, portalTarget) : null}
    </div>
  );
}
