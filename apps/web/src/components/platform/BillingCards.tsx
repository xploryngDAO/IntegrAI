/**
 * Billing summary of the platform (`GET /platform/billing/summary`).
 *
 * Four Convergência cards: MRR, trials, past-due tenants and the MRR breakdown
 * by plan. Amounts are rounded to whole reais — the console shows the recurring
 * revenue, not cents — and every number is coerced because the API may
 * serialise counters as strings.
 */
import { Grid, StatCard } from '@xploryng/convergencia';
import { asCount, asNumber, planLabel } from '../../lib/platform';
import type { PlatformBillingSummary } from '../../lib/types';
import { Alert, Button, Card, Skeleton } from '../ui';

function formatMrr(value: unknown): string {
  const numeric = asNumber(value);
  if (numeric === null) return '—';
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(numeric);
  } catch {
    return `R$ ${Math.round(numeric)}`;
  }
}

export interface BillingCardsProps {
  summary: PlatformBillingSummary | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

function BillingSkeleton(): JSX.Element {
  return (
    <Grid min={210} aria-busy="true">
      {[0, 1, 2, 3].map((index) => (
        <Card key={index}>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </Card>
      ))}
    </Grid>
  );
}

export function BillingCards({
  summary,
  loading,
  error,
  onRetry,
}: BillingCardsProps): JSX.Element | null {
  if (loading) return <BillingSkeleton />;

  if (error !== null) {
    return (
      <Alert title="Não foi possível carregar a cobrança" tone="danger">
        <div className="flex flex-col gap-2">
          <span>{error}</span>
          <div>
            <Button size="sm" icon="pulse" onClick={onRetry}>
              Tentar novamente
            </Button>
          </div>
        </div>
      </Alert>
    );
  }

  if (summary === null) return null;

  const byPlan = Array.isArray(summary.byPlan) ? summary.byPlan : [];
  const trialing = asCount(summary.trialing);
  const pastDue = asCount(summary.pastDue);

  return (
    <Grid min={210}>
      <Card>
        <StatCard
          label="MRR"
          value={formatMrr(summary.mrr)}
          detail="receita recorrente mensal"
          icon="chart"
        />
      </Card>
      <Card>
        <StatCard
          label="Em teste"
          value={String(trialing)}
          detail={trialing === 1 ? 'tenant em período de teste' : 'tenants em período de teste'}
          icon="clock"
        />
      </Card>
      <Card>
        <StatCard
          label="Pagamento pendente"
          value={String(pastDue)}
          detail={pastDue === 1 ? 'tenant com cobrança em atraso' : 'tenants com cobrança em atraso'}
          icon="bell"
        />
      </Card>
      <Card title="Receita por plano" subtitle="Tenants e MRR de cada plano">
        {byPlan.length === 0 ? (
          <p className="m-0 mt-3 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            Nenhum plano com cobrança ativa registrado nesta API.
          </p>
        ) : (
          <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
            {byPlan.map((slice) => (
              <li
                key={slice.plan}
                className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--cv-color-border)] pt-2 first:border-t-0 first:pt-0"
              >
                <span className="text-[var(--cv-font-meta)] font-medium">
                  {planLabel(slice.plan)}
                </span>
                <span className="flex items-center gap-3 text-[var(--cv-font-meta)]">
                  <span className="text-[var(--cv-color-text-muted)]">
                    {asCount(slice.tenants)} tenant(s)
                  </span>
                  <strong className="sac-num">{formatMrr(slice.mrr)}</strong>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Grid>
  );
}
