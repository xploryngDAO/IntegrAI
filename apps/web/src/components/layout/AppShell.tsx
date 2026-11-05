import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Icon } from '@xploryng/convergencia';
import { useWorkspace } from '../../lib/store';
import { Topbar } from './Topbar';

export interface AppShellProps {
  /** Kept for callers that already loaded telemetry; the topbar also reads the store. */
  health?: unknown;
  accounts?: unknown;
  /** Optional global ribbon rendered right under the topbar (demo mode). */
  banner?: ReactNode;
  /** Optional content; defaults to the router `<Outlet/>`. */
  children?: ReactNode;
}

const NAV = [
  { to: '/', label: 'Fila', icon: 'chat' as const, end: true },
  { to: '/accounts', label: 'Canais', icon: 'network' as const, end: false },
];

/**
 * Application chrome: Convergência rail + topbar + routed content.
 * The rail keeps navigation, the topbar keeps telemetry and identity; content
 * pages own their own columns (docs/UI_SPEC.md, docs/CONVERGENCIA_ADOPTION.md).
 */
export function AppShell({ banner, children }: AppShellProps): JSX.Element {
  const totalTickets = useWorkspace((state) => state.totalTickets);

  return (
    <div className="sac-shell">
      <aside className="sac-rail" aria-label="Navegação principal">
        <NavLink to="/" className="sac-rail__brand" aria-label="SAC Hub — início">
          SH
        </NavLink>

        <nav className="sac-rail__nav">
          {NAV.map((item) => (
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
        {banner}
        <main className="sac-content" id="sac-main">
          {children ?? <Outlet />}
        </main>
      </div>
    </div>
  );
}
