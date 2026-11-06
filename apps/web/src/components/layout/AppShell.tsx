import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Icon, type IconName } from '@xploryng/convergencia';
import { LogOut } from 'lucide-react';
import { useWorkspace } from '../../lib/store';
import { isPlatformAdmin, isTenantAdmin } from '../../lib/platform';
import { IconButton } from '../ui';
import { Topbar } from './Topbar';
import { UserMenu } from './UserMenu';
import { useEndSession } from './useEndSession';

export interface AppShellProps {
  /** Optional content; defaults to the router `<Outlet/>`. */
  children?: ReactNode;
}

interface NavEntry {
  to: string;
  label: string;
  icon: IconName;
  end: boolean;
}

const BASE_NAV: NavEntry[] = [
  { to: '/', label: 'Fila', icon: 'chat', end: true },
  { to: '/accounts', label: 'Canais', icon: 'network', end: false },
];

/**
 * Application chrome: Convergência rail + topbar + routed content.
 *
 * The rail keeps navigation, the topbar keeps telemetry and identity; content
 * pages own their own columns (docs/UI_SPEC.md, docs/CONVERGENCIA_ADOPTION.md).
 *
 * Fase 4 adds role-gated entries. They are only *shortcuts*: the API is the
 * real guard, so a direct URL still lands on the page (which renders the 403 /
 * access-restricted state instead of breaking).
 *
 * The rail footer hosts the same identity menu as the topbar plus a one-click
 * "Sair" (the rail disappears below 900px; the topbar menu remains the mobile
 * entry point and exposes the full account menu there).
 */
export function AppShell({ children }: AppShellProps): JSX.Element {
  const totalTickets = useWorkspace((state) => state.totalTickets);
  const currentAgent = useWorkspace((state) => state.currentAgent);
  const { end: signOut, pending: signingOut } = useEndSession('current');

  const nav: NavEntry[] = [...BASE_NAV];
  if (isTenantAdmin(currentAgent)) {
    nav.push({ to: '/admin', label: 'Admin', icon: 'users', end: false });
  }
  if (isPlatformAdmin(currentAgent)) {
    nav.push({ to: '/platform', label: 'Plataforma', icon: 'grid', end: false });
    nav.push({ to: '/setup', label: 'Apps', icon: 'rocket', end: false });
  }
  if (isTenantAdmin(currentAgent)) {
    nav.push({ to: '/settings', label: 'Ajustes', icon: 'sliders', end: false });
  }

  return (
    <div className="sac-shell">
      <aside className="sac-rail" aria-label="Navegação principal">
        {/* The visible "SH" is the accessible name's own content: an
            `aria-label` that omits it fails WCAG 2.5.3 (label in name), so the
            descriptive part is added as screen-reader-only text instead. */}
        <NavLink to="/" className="sac-rail__brand">
          SH
          <span className="cv-sr-only">SAC Hub — início</span>
        </NavLink>

        <nav className="sac-rail__nav">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className="sac-rail__item"
              title={item.label}
            >
              <Icon name={item.icon} size={20} />
              <span>{item.label}</span>
              {item.to === '/' && totalTickets > 0 ? (
                <span className="sac-rail__count" aria-label={`${totalTickets} na fila`}>
                  {totalTickets > 99 ? '99+' : totalTickets}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>

        <div className="sac-rail__footer">
          <UserMenu variant="rail" />
          <IconButton
            label={signingOut ? 'Saindo da conta…' : 'Sair'}
            icon={<LogOut size={17} />}
            disabled={signingOut}
            onClick={() => void signOut()}
          />
          <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--cv-color-text-muted)]">
            v1.0
          </span>
        </div>
      </aside>

      <div className="sac-main">
        <Topbar />
        <main className="sac-content" id="sac-main">
          {children ?? <Outlet />}
        </main>
      </div>
    </div>
  );
}
