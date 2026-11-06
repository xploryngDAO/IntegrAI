/**
 * Audit trail of the billing gateway callbacks
 * (`GET /platform/billing/events?limit=50`).
 *
 * The API answers `{ limit, items }` with the newest event first; the rows are
 * rendered as a stacked list (not a table) so type, tenant, status and date stay
 * readable at 390px without horizontal scrolling. Loading, error and empty are
 * owned by this card, so a missing endpoint never takes `/platform` down.
 */
import { Card, EmptyState, Pill, Skeleton, Alert, Button } from '../ui';
import { formatDateTime } from '../../lib/labels';
import {
  billingEventStatusLabel,
  billingEventStatusTone,
  billingEventTypeLabel,
} from '../../lib/platform';
import type { PlatformBillingEvent } from '../../lib/types';

export interface BillingEventsCardProps {
  events: PlatformBillingEvent[];
  /** Effective limit reported by the API (subtitle only). */
  limit: number;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

/** Network data is untrusted: a missing field must never break the list. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function EventRow({ event }: { event: PlatformBillingEvent }): JSX.Element {
  const type = asText(event.type);
  const slug = asText(event.tenantSlug);
  const status = asText(event.status);
  const receivedAt = asText(event.receivedAt);

  return (
    <li className="flex flex-col gap-1 border-t border-[var(--cv-color-border)] py-2.5 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <strong
          className="min-w-0 break-words text-[var(--cv-font-control)] font-medium"
          title={type.length > 0 ? type : undefined}
        >
          {billingEventTypeLabel(type)}
        </strong>
        <Pill tone={billingEventStatusTone(status)}>{billingEventStatusLabel(status)}</Pill>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
        <span className="sac-num min-w-0 break-all" title="Slug do tenant">
          {slug.length > 0 ? slug : '—'}
        </span>
        <span aria-hidden="true">·</span>
        <time className="sac-num" dateTime={receivedAt.length > 0 ? receivedAt : undefined}>
          {formatDateTime(receivedAt)}
        </time>
      </div>
    </li>
  );
}

export function BillingEventsCard({
  events,
  limit,
  loading,
  error,
  onRetry,
}: BillingEventsCardProps): JSX.Element {
  const total = events.length;

  return (
    <Card
      title="Últimos eventos de billing"
      subtitle={`Callbacks do gateway (auditoria), mais recentes primeiro · até ${limit} eventos.`}
      actions={total > 0 ? <Pill tone="neutral">{total}</Pill> : undefined}
    >
      {loading ? (
        <div className="mt-3 flex flex-col gap-2" aria-busy="true">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : error !== null ? (
        <div className="mt-3">
          <Alert title="Não foi possível carregar os eventos de billing" tone="danger">
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
            icon="wallet"
            title="Nenhum evento de billing"
            description="O gateway ainda não enviou nenhum callback. Ativações, pagamentos e cancelamentos aparecem aqui assim que o webhook autenticado for processado."
          />
        </div>
      ) : (
        <ul
          className="m-0 mt-3 flex list-none flex-col p-0"
          aria-label="Eventos de billing mais recentes"
        >
          {events.map((event, index) => (
            <EventRow key={asText(event.id) || `${asText(event.type)}-${index}`} event={event} />
          ))}
        </ul>
      )}
    </Card>
  );
}
