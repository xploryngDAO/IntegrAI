/**
 * Operational alerts of the platform console (`GET /platform/alerts`).
 *
 * Alerts are grouped by normalised severity and rendered critical → warning →
 * info. Every row drills into the tenant drawer, so an alert is actionable
 * instead of a dead end. The panel owns loading/empty/error so a missing
 * endpoint never blocks the rest of `/platform`.
 */
import { useMemo } from 'react';
import { cx, Icon } from '@xploryng/convergencia';
import {
  ALERT_SEVERITY_LABEL,
  ALERT_SEVERITY_ORDER,
  alertTypeLabel,
  asNumber,
  normalizeAlertSeverity,
  type AlertSeverity,
} from '../../lib/platform';
import type { PlatformAlert } from '../../lib/types';
import { Alert, Button, Card, EmptyState, Pill, Skeleton } from '../ui';

const SEVERITY_DOT: Record<AlertSeverity, string> = {
  critical: 'bg-[var(--cv-color-danger)]',
  warning: 'bg-[var(--cv-color-warning)]',
  info: 'bg-[var(--cv-color-accent)]',
};

const ALERT_ITEM_CLASS =
  'flex w-full items-start gap-2.5 rounded-[var(--cv-radius-control)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] p-3 text-left transition-colors hover:border-[var(--cv-color-border-strong)]';

export interface AlertsPanelProps {
  alerts: PlatformAlert[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Drill-down: opens the tenant drawer for the alert's tenant. */
  onOpenTenant: (alert: PlatformAlert) => void;
}

/** Alert kinds whose `value` is a binary flag (1), not a meaningful number. */
const BINARY_ALERT_TYPES = new Set(['TENANT_SUSPENDED', 'ACCOUNT_STATUS', 'ACCOUNT_ERROR']);

function alertValue(alert: PlatformAlert): string | null {
  const type = asText(alert.type).toUpperCase();
  if (BINARY_ALERT_TYPES.has(type)) return null;

  const numeric = asNumber(alert.value);
  if (numeric !== null) {
    // Quota alerts carry a percentage (`AGENTS_QUOTA`, `ACCOUNTS_QUOTA`);
    // SLA/invitation alerts carry a count.
    const suffix = type === 'AGENTS_QUOTA' || type === 'ACCOUNTS_QUOTA' ? '%' : '';
    return `${numeric.toLocaleString('pt-BR')}${suffix}`;
  }
  if (typeof alert.value === 'string' && alert.value.trim().length > 0) return alert.value.trim();
  return null;
}

/** Network data is untrusted: a missing field must not break the panel. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function AlertContent({ alert }: { alert: PlatformAlert }): JSX.Element {
  const severity = normalizeAlertSeverity(alert.severity);
  const value = alertValue(alert);
  const type = asText(alert.type);
  const slug = asText(alert.tenantSlug);
  const message = asText(alert.message);

  return (
    <>
      <span
        aria-hidden="true"
        className={cx('mt-1.5 h-2 w-2 flex-none rounded-full', SEVERITY_DOT[severity])}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <strong className="text-[var(--cv-font-control)] font-medium">
            {slug.length > 0 ? slug : '—'}
          </strong>
          {type.length > 0 ? (
            <span
              className="text-[10px] uppercase tracking-[0.08em] text-[var(--cv-color-text-muted)]"
              title={type}
            >
              {alertTypeLabel(type)}
            </span>
          ) : null}
        </span>
        <span className="text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text)]">
          {message.length > 0 ? message : 'Sem detalhe informado pela API.'}
        </span>
        {value !== null ? (
          <span className="sac-num text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
            valor: {value}
          </span>
        ) : null}
      </span>
      <Icon name="chevron" size={14} className="mt-1 flex-none text-[var(--cv-color-text-muted)]" />
    </>
  );
}

export function AlertsPanel({
  alerts,
  loading,
  error,
  onRetry,
  onOpenTenant,
}: AlertsPanelProps): JSX.Element {
  const groups = useMemo(() => {
    const buckets = new Map<AlertSeverity, PlatformAlert[]>();
    for (const alert of alerts) {
      const severity = normalizeAlertSeverity(alert.severity);
      const bucket = buckets.get(severity);
      if (bucket) bucket.push(alert);
      else buckets.set(severity, [alert]);
    }
    return ALERT_SEVERITY_ORDER.filter((severity) => buckets.has(severity)).map((severity) => ({
      severity,
      items: buckets.get(severity) ?? [],
    }));
  }, [alerts]);

  const total = alerts.length;

  return (
    <Card
      title="Alertas da plataforma"
      subtitle="Fila operacional dos tenants, agrupada por severidade (crítico → informativo). Clique em um alerta para abrir o tenant."
      actions={total > 0 ? <Pill tone="warn">{total}</Pill> : undefined}
    >
      {loading ? (
        <div className="mt-3 flex flex-col gap-2" aria-busy="true">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      ) : error !== null ? (
        <div className="mt-3">
          <Alert title="Não foi possível carregar os alertas" tone="danger">
            <div className="flex flex-col gap-2">
              <span>{error}</span>
              <div>
                <Button size="sm" icon="pulse" onClick={onRetry}>
                  Tentar novamente
                </Button>
              </div>
            </div>
          </Alert>
        </div>
      ) : total === 0 ? (
        <div className="mt-3">
          <EmptyState
            icon="check"
            title="Nenhum alerta ativo"
            description="Nenhum tenant exige atenção neste momento. A lista se atualiza a cada consulta ao console."
          />
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          {groups.map((group) => (
            <section
              key={group.severity}
              aria-labelledby={`platform-alerts-${group.severity}`}
              className="flex flex-col gap-2"
            >
              <h4
                id={`platform-alerts-${group.severity}`}
                className="m-0 flex items-center gap-2 text-[var(--cv-font-micro)] uppercase tracking-[0.08em] text-[var(--cv-color-text-muted)]"
              >
                <span
                  aria-hidden="true"
                  className={cx('h-1.5 w-1.5 rounded-full', SEVERITY_DOT[group.severity])}
                />
                {ALERT_SEVERITY_LABEL[group.severity]} · {group.items.length}
              </h4>

              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {group.items.map((alert, index) => {
                  const tenantId = asText(alert.tenantId);
                  const tenantSlug = asText(alert.tenantSlug);
                  const alertType = asText(alert.type);
                  const canOpen = tenantId.length > 0;
                  const key = `${tenantId}:${alertType}:${index}`;
                  return (
                    <li key={key} className="min-w-0">
                      {canOpen ? (
                        <button
                          type="button"
                          className={ALERT_ITEM_CLASS}
                          onClick={() => onOpenTenant(alert)}
                          aria-label={`Abrir tenant ${tenantSlug || tenantId} a partir do alerta ${alertTypeLabel(alertType)}`}
                        >
                          <AlertContent alert={alert} />
                        </button>
                      ) : (
                        <div className={ALERT_ITEM_CLASS}>
                          <AlertContent alert={alert} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
