import { Moon, Sun } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import { Icon, type IconName } from '@xploryng/convergencia';
import type { AgentPresenceStatus, Marketplace } from '@sac/shared';
import { useWorkspace } from '../../lib/store';
import { useTheme } from '../../lib/theme';
import { isPlatformAdmin, isTenantAdmin } from '../../lib/platform';
import { Avatar, IconButton, SegmentedControl } from '../ui';

const MARKET_ORDER: Marketplace[] = ['AMAZON', 'MERCADO_LIVRE', 'SHOPEE'];
const MARKET_LABEL: Record<Marketplace, string> = {
  AMAZON: 'Amazon',
  MERCADO_LIVRE: 'Meli',
  SHOPEE: 'Shopee',
};

const PRESENCE_OPTIONS = [
  { value: 'ONLINE', label: 'Online' },
  { value: 'PAUSED', label: 'Pausa' },
  { value: 'OFFLINE', label: 'Offline' },
];

function formatMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const total = Math.max(0, Math.round(value));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}` : `${minutes}min`;
}

/**
 * Global telemetry bar: channel health (click filters the queue), SLA average,
 * theme, operator presence and identity.
 */
export function Topbar(): JSX.Element {
  const health = useWorkspace((state) => state.health);
  const accounts = useWorkspace((state) => state.accounts);
  const stats = useWorkspace((state) => state.stats);
  const totalTickets = useWorkspace((state) => state.totalTickets);
  const filters = useWorkspace((state) => state.filters);
  const setFilters = useWorkspace((state) => state.setFilters);
  const presence = useWorkspace((state) => state.presence);
  const setPresence = useWorkspace((state) => state.setPresence);
  const currentAgent = useWorkspace((state) => state.currentAgent);
  const { theme, toggle } = useTheme();
  const { pathname } = useLocation();
  const onAccounts = pathname.startsWith('/accounts');
  const onOnboarding = pathname.startsWith('/onboarding');
  const onPlatform = pathname.startsWith('/platform');
  const onSettings = pathname.startsWith('/settings');
  // Onboarding is a focused flow: channel health, SLA and the queue badge are
  // hidden so the wizard keeps a single primary action per step. The Fase 4
  // admin screens are also focused surfaces (no queue telemetry).
  const focusMode = onAccounts || onOnboarding || onPlatform || onSettings;

  const title = onOnboarding
    ? 'Primeiros passos'
    : onAccounts
      ? 'Canais'
      : onPlatform
        ? 'Plataforma'
        : onSettings
          ? 'Configurações'
          : 'Atendimento';
  const subtitle = onOnboarding
    ? 'Conecte os canais e faça o primeiro atendimento'
    : onAccounts
      ? `${accounts.length} loja(s) · tokens, webhooks e autorizações`
      : onPlatform
        ? 'Console interno · tenants e planos'
        : onSettings
          ? 'Workspace, privacidade e zona de perigo'
          : `${accounts.length > 0 ? `${accounts.length} lojas conectadas` : 'Nenhuma loja conectada'}${
              totalTickets > 0 ? ` · ${totalTickets} na fila` : ''
            }`;

  const platformAdmin = isPlatformAdmin(currentAgent);
  const tenantAdmin = isTenantAdmin(currentAgent);
  const adminLinks: { to: string; label: string; icon: IconName }[] = [];
  if (platformAdmin) adminLinks.push({ to: '/platform', label: 'Plataforma', icon: 'grid' });
  if (tenantAdmin) adminLinks.push({ to: '/settings', label: 'Ajustes', icon: 'sliders' });

  const selected = filters.marketplaces;
  const allSelected = selected.length === 0 || selected.length === MARKET_ORDER.length;

  function toggleMarket(marketplace: Marketplace): void {
    const current = allSelected ? [...MARKET_ORDER] : selected;
    const next = current.includes(marketplace)
      ? current.filter((entry) => entry !== marketplace)
      : [...current, marketplace];
    setFilters({ marketplaces: next.length === 0 ? [...MARKET_ORDER] : next });
  }

  function healthTone(marketplace: Marketplace): string {
    const channel = health.find((entry) => entry.marketplace === marketplace);
    if (!channel) return 'var(--cv-color-border-strong)';
    if (channel.inboundHealthy && channel.outboundHealthy) return 'var(--cv-color-success)';
    if (channel.status === 'DISCONNECTED') return 'var(--cv-color-danger)';
    return 'var(--cv-color-warning)';
  }

  const avgFirstResponse = stats?.avgFirstResponseMinutes ?? null;

  return (
    <header className="sac-topbar">
      <div className="sac-topbar__title">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>

      {focusMode ? null : (
        <div className="sac-topbar__channels" role="group" aria-label="Saúde e filtro de canais">
          {MARKET_ORDER.map((marketplace) => {
            const active = allSelected || selected.includes(marketplace);
            const channel = health.find((entry) => entry.marketplace === marketplace);
            const detail = channel
              ? `${channel.accountDisplayName}: ${channel.detail || channel.status}`
              : 'Sem telemetria';
            return (
              <button
                key={marketplace}
                type="button"
                className="sac-topbar__channel"
                aria-pressed={active}
                aria-label={`${MARKET_LABEL[marketplace]} — ${detail}`}
                title={detail}
                onClick={() => toggleMarket(marketplace)}
              >
                <span
                  className="sac-market__dot"
                  style={{ background: healthTone(marketplace) }}
                  aria-hidden="true"
                />
                {MARKET_LABEL[marketplace]}
              </button>
            );
          })}
        </div>
      )}

      <div className="sac-topbar__spacer" />

      {adminLinks.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          className="sac-topbar__link"
          title={link.label}
          aria-label={link.label}
        >
          <Icon name={link.icon} size={17} />
          <span>{link.label}</span>
        </NavLink>
      ))}

      {focusMode ? null : (
        <div className="sac-topbar__metric" title="Tempo médio até a primeira resposta">
          <strong className="sac-num">{formatMinutes(avgFirstResponse)}</strong>
          <span>SLA médio</span>
        </div>
      )}

      <IconButton
        label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'}
        icon={theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
        onClick={toggle}
      />

      <SegmentedControl
        label="Disponibilidade do agente"
        options={PRESENCE_OPTIONS}
        value={presence}
        onChange={(value) => void setPresence(value as AgentPresenceStatus)}
      />

      <div className="sac-row sac-topbar__agent">
        <Avatar name={currentAgent?.name ?? 'Operador'} size="sm" />
        <div className="sac-col sac-topbar__agent-text">
          <span className="truncate text-[var(--cv-font-control)] font-medium leading-tight">
            {currentAgent?.name ?? 'Operador'}
          </span>
          <span className="truncate text-[var(--cv-font-micro)] uppercase tracking-[0.06em] text-[var(--cv-color-text-muted)]">
            {currentAgent?.role ?? 'AGENT'}
          </span>
        </div>
      </div>
    </header>
  );
}
