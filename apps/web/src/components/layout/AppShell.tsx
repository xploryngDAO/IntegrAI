import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Icon, type IconName } from '@xploryng/convergencia';
import { useWorkspace } from '../../lib/store';
import { isPlatformAdmin, isTenantAdmin } from '../../lib/platform';
import { Topbar } from './Topbar';

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
 * Fase 4 adds two role-gated entries. They are only *shortcuts*: the API is the
 * real guard, so a direct URL still lands on the page (which renders the 403 /
 * access-restricted state instead of breaking).
 */
export function AppShell({ children }: AppShellProps): JSX.Element {
  const totalTickets = useWorkspace((state) => state.totalTickets);
  const currentAgent = useWorkspace((state) => state.currentAgent);

  const nav: NavEntry[] = [...BASE_NAV];
  if (isPlatformAdmin(currentAgent)) {
    nav.push({ to: '/platform', label: 'Plataforma', icon: 'grid', end: false });
  }
  if (isTenantAdmin(currentAgent)) {
    nav.push({ to: '/settings', label: 'Ajustes', icon: 'sliders', end: false });
  }

  return (
    <div className="sac-shell">
      <aside className="sac-rail" aria-label="Navegação principal">
        <NavLink to="/" className="sac-rail__brand" aria-label="SAC Hub — início">
          SH
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
