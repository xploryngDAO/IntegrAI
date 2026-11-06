/**
 * Tenant drill-down of `/platform` — metrics, billing and workspace operations.
 *
 * `GET /platform/tenants/:id/metrics` feeds the cards and the 14-day sparkline;
 * `PATCH /platform/tenants/:id/billing` saves only the billing fields the
 * operator actually changed. The "Operações" card (backup, soft delete and
 * physical purge) lives in `TenantOperationsCard`. The dialog is a Convergência
 * `Dialog`: centered above 640px and a bottom sheet on phones, so the same
 * markup works at 390px.
 *
 * Failure policy: 403 escalates to the page-level "sem permissão" screen (the
 * console is gone for this operator), 404/422 keep the dialog open with the real
 * server message, and a missing endpoint (405/501) is reported as not published.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Grid, StatCard } from '@xploryng/convergencia';
import { api } from '../../lib/api';
import type {
  PlatformTenantBillingUpdate,
  PlatformTenantLimits,
  PlatformTenantMetrics,
  TenantPlan,
} from '../../lib/types';
import {
  BILLING_EMAIL_MAX_LENGTH,
  asCount,
  asNumber,
  billingErrorMessage,
  billingStatusOptions,
  billingStatusLabel,
  billingStatusTone,
  formatLimit,
  formatPercent,
  isForbiddenError,
  isoToDateInput,
  overallUsagePercent,
  planLabel,
  quotaPercent,
  tenantMetricsErrorMessage,
  tenantStatusLabel,
  tenantStatusTone,
  trialEndsAtToIso,
} from '../../lib/platform';
import { STATUS_LABEL, formatDate, formatDurationMinutes } from '../../lib/labels';
import { plural } from '../../lib/plural';
import { fieldErrorsFromIssues, isValidEmail, validationIssues } from '../../lib/validation';
import { useWorkspace } from '../../lib/store';
import { Alert, Button, Card, FieldRow, Input, Modal, Pill, Select, Skeleton } from '../ui';
import { TenantCheckoutCard } from './TenantCheckoutCard';
import { TenantOperationsCard } from './TenantOperationsCard';
import { TicketSparkline } from './TicketSparkline';

/** Minimal tenant identity a drill-down needs (row, alert or any future link). */
export interface TenantTarget {
  id: string;
  name: string;
  slug: string;
  status?: string;
  plan?: TenantPlan;
  billingStatus?: string | null;
  trialEndsAt?: string | null;
  billingEmail?: string | null;
}

export interface TenantDetailDialogProps {
  tenant: TenantTarget;
  onClose: () => void;
  /**
   * Notifies the page that a tenant mutation succeeded (billing, soft delete
   * or purge): counters and the tenant list are re-read.
   */
  onSaved: () => void;
  /** 403 anywhere inside the drawer: the page takes over with its own state. */
  onForbidden: () => void;
}

const METRICS_SKELETON_KEYS = [0, 1, 2, 3, 4, 5];

const TICKET_STATUS_ORDER = [
  'UNREAD',
  'OPEN_WAITING_AGENT',
  'WAITING_BUYER',
  'MEDIATION',
  'NO_RESPONSE_NEEDED',
  'RESOLVED',
];

const TICKET_STATUS_LABEL: Record<string, string> = { ...STATUS_LABEL };

function ticketStatusLabel(status: string): string {
  const key = status.trim().toUpperCase();
  return TICKET_STATUS_LABEL[key] ?? (status.trim().length > 0 ? status : '—');
}

function ticketStatusRank(status: string): number {
  const index = TICKET_STATUS_ORDER.indexOf(status.trim().toUpperCase());
  return index === -1 ? TICKET_STATUS_ORDER.length : index;
}

/** `2026-11-05` (date input) → `05/11/2026` without a timezone shift. */
function dateInputLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  return formatDate(value);
}

function tenantHeading(tenant: TenantTarget): string {
  const name = tenant.name.trim();
  const slug = tenant.slug.trim();
  if (name.length === 0) return slug.length > 0 ? slug : 'tenant';
  if (slug.length === 0 || name === slug) return name;
  return `${name} (${slug})`;
}

/* ==========================================================================
 * Metrics
 * ========================================================================== */

function UsageDetail({
  used,
  limit,
  percent,
}: {
  used: number;
  limit: number;
  percent: number | null;
}): JSX.Element {
  return (
    <span>
      {used} de {formatLimit(limit)}
      {percent === null ? '' : ` · ${formatPercent(percent)} em uso`}
    </span>
  );
}

function MetricsView({
  tenant,
  metrics,
}: {
  tenant: TenantTarget;
  metrics: PlatformTenantMetrics;
}): JSX.Element {
  const limits: PlatformTenantLimits = metrics.limits ?? { maxAccounts: 0, maxAgents: 0 };
  const accounts = asCount(metrics.accounts);
  const agents = asCount(metrics.agents);
  const accountsPct = quotaPercent(accounts, limits.maxAccounts);
  const agentsPct = quotaPercent(agents, limits.maxAgents);
  const overallPct = overallUsagePercent(metrics.usagePct);
  const avgFirstResponse = asNumber(metrics.avgFirstResponseMinutes);

  const statuses = useMemo(() => {
    const byStatus = metrics.ticketsByStatus ?? {};
    return Object.entries(byStatus)
      .map(([status, count]) => ({ status, count: asCount(count) }))
      .sort(
        (a, b) =>
          ticketStatusRank(a.status) - ticketStatusRank(b.status) ||
          a.status.localeCompare(b.status),
      );
  }, [metrics.ticketsByStatus]);

  const ticketsTotal = statuses.reduce((sum, entry) => sum + entry.count, 0);
  const daily = metrics.ticketsLast14d ?? [];
  const dailyTotal = daily.reduce((sum, point) => sum + asCount(point?.count), 0);

  return (
    <div className="flex flex-col gap-4">
      <Grid min={160}>
        <Card>
          <StatCard label="Contas" value={String(accounts)} icon="network" />
          <p className="m-0 mt-1 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
            <UsageDetail used={accounts} limit={limits.maxAccounts} percent={accountsPct} />
          </p>
        </Card>
        <Card>
          <StatCard label="Agentes" value={String(agents)} icon="users" />
          <p className="m-0 mt-1 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
            <UsageDetail used={agents} limit={limits.maxAgents} percent={agentsPct} />
          </p>
        </Card>
        <Card>
          <StatCard
            label="Tickets abertos"
            value={String(asCount(metrics.openTickets))}
            detail="fila ativa"
            icon="chat"
          />
        </Card>
        <Card>
          <StatCard
            label="SLA em risco"
            value={String(asCount(metrics.slaAtRisk))}
            detail="próximos do prazo"
            icon="clock"
          />
        </Card>
        <Card>
          <StatCard
            label="SLA violado"
            value={String(asCount(metrics.slaBreached))}
            detail="fora do prazo"
            icon="flag"
          />
        </Card>
        <Card>
          <StatCard
            label="1ª resposta"
            value={avgFirstResponse === null ? '—' : formatDurationMinutes(avgFirstResponse)}
            detail="média de resposta"
            icon="pulse"
          />
        </Card>
        <Card>
          <StatCard
            label="Mensagens 7d"
            value={String(asCount(metrics.messagesLast7d))}
            detail="últimos 7 dias"
            icon="chat"
          />
        </Card>
        <Card>
          <StatCard
            label="Uso do plano"
            value={formatPercent(overallPct)}
            detail={`${planLabel(metrics.plan)} · ${formatLimit(limits.maxAccounts)} contas / ${formatLimit(limits.maxAgents)} agentes`}
            icon="chart"
          />
        </Card>
      </Grid>

      <Card
        title="Tickets por status"
        subtitle={`${plural(ticketsTotal, 'ticket', 'tickets')} no tenant`}
      >
        {statuses.length === 0 ? (
          <p className="m-0 mt-3 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
            Nenhum ticket registrado para este tenant.
          </p>
        ) : (
          <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
            {statuses.map((entry) => (
              <li key={entry.status} className="flex items-center justify-between gap-3">
                <span className="text-[var(--cv-font-meta)]">{ticketStatusLabel(entry.status)}</span>
                <span className="sac-num text-[var(--cv-font-meta)] font-semibold">
                  {entry.count}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Tickets nos últimos 14 dias"
        subtitle={`${plural(dailyTotal, 'ticket', 'tickets')} no período · série diária de ${tenantHeading(tenant)}`}
      >
        {daily.length === 0 ? (
          <p className="m-0 mt-3 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
            A API não devolveu a série diária de tickets para este tenant.
          </p>
        ) : (
          <div className="mt-3">
            <TicketSparkline points={daily} label={`Tickets por dia de ${tenantHeading(tenant)}`} />
          </div>
        )}
      </Card>
    </div>
  );
}

/* ==========================================================================
 * Billing form
 * ========================================================================== */

type BillingField = 'billingStatus' | 'trialEndsAt' | 'billingEmail';
const BILLING_FIELDS: readonly BillingField[] = ['billingStatus', 'trialEndsAt', 'billingEmail'];

interface BillingBaseline {
  status: string;
  trialEndsAt: string;
  billingEmail: string;
}

function baselineOf(tenant: TenantTarget): BillingBaseline {
  return {
    status: (tenant.billingStatus ?? '').trim(),
    trialEndsAt: isoToDateInput(tenant.trialEndsAt),
    billingEmail: (tenant.billingEmail ?? '').trim(),
  };
}

function TenantBillingForm({
  tenant,
  onSaved,
  onForbidden,
}: {
  tenant: TenantTarget;
  onSaved: () => void;
  onForbidden: () => void;
}): JSX.Element {
  const pushToast = useWorkspace((state) => state.pushToast);
  const [baseline, setBaseline] = useState<BillingBaseline>(() => baselineOf(tenant));
  const [status, setStatus] = useState(baseline.status);
  const [trialEndsAt, setTrialEndsAt] = useState(baseline.trialEndsAt);
  const [billingEmail, setBillingEmail] = useState(baseline.billingEmail);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<BillingField, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function clearErrors(): void {
    setFieldErrors({});
    setError(null);
    setSuccess(null);
  }

  async function handleSave(): Promise<void> {
    if (saving) return;
    setError(null);
    setSuccess(null);
    setFieldErrors({});

    const body: PlatformTenantBillingUpdate = {};

    if (status !== baseline.status && status.trim().length > 0) {
      body.billingStatus = status.trim();
    }

    if (trialEndsAt !== baseline.trialEndsAt) {
      if (trialEndsAt.trim().length === 0) {
        body.trialEndsAt = null;
      } else {
        const iso = trialEndsAtToIso(trialEndsAt);
        if (iso === null) {
          setFieldErrors({ trialEndsAt: 'Informe uma data válida (dia/mês/ano).' });
          return;
        }
        body.trialEndsAt = iso;
      }
    }

    const email = billingEmail.trim();
    if (email !== baseline.billingEmail) {
      if (email.length === 0) {
        body.billingEmail = null;
      } else if (!isValidEmail(email)) {
        setFieldErrors({ billingEmail: 'Informe um e-mail válido, como financeiro@empresa.com.' });
        return;
      } else if (email.length > BILLING_EMAIL_MAX_LENGTH) {
        setFieldErrors({
          billingEmail: `O e-mail de cobrança aceita no máximo ${BILLING_EMAIL_MAX_LENGTH} caracteres.`,
        });
        return;
      } else {
        body.billingEmail = email;
      }
    }

    if (Object.keys(body).length === 0) {
      setError('Nenhuma alteração de cobrança para salvar. Ajuste um campo e tente novamente.');
      return;
    }

    setSaving(true);
    try {
      // The API answers the normalised `TenantBillingView`; adopting it keeps
      // the form/current-value hints truthful after the first save.
      const updated = await api.updatePlatformTenantBilling(tenant.id, body);
      const nextStatus = updated?.billingStatus ?? (status || baseline.status);
      const nextTrial = updated ? isoToDateInput(updated.trialEndsAt) : trialEndsAt;
      const nextEmail = updated ? (updated.billingEmail ?? '') : email;
      setBaseline({ status: nextStatus, trialEndsAt: nextTrial, billingEmail: nextEmail });
      setStatus(nextStatus);
      setTrialEndsAt(nextTrial);
      setBillingEmail(nextEmail);
      setSuccess(`Cobrança de ${tenantHeading(tenant)} atualizada.`);
      pushToast({
        tone: 'ok',
        title: 'Cobrança atualizada',
        description: `${tenantHeading(tenant)} · ${billingStatusLabel(nextStatus)}`,
      });
      onSaved();
    } catch (saveError) {
      if (isForbiddenError(saveError)) {
        onForbidden();
        return;
      }
      setError(billingErrorMessage(saveError));
      const issues = validationIssues(saveError);
      if (issues.length > 0) {
        setFieldErrors(fieldErrorsFromIssues<BillingField>(issues, BILLING_FIELDS));
      }
    } finally {
      setSaving(false);
    }
  }

  const trialHint =
    baseline.trialEndsAt.length === 0
      ? 'Sem trial registrado. Ao escolher uma data, o teste termina no fim desse dia.'
      : `Fim do trial atual: ${dateInputLabel(baseline.trialEndsAt)} · deixe vazio para remover.`;

  const emailHint =
    tenant.billingEmail === null || tenant.billingEmail === undefined || tenant.billingEmail === ''
      ? 'Opcional. Deixe vazio para não enviar e-mail de cobrança.'
      : 'Deixe vazio para remover o e-mail atual.';

  return (
    <Card
      title="Cobrança"
      subtitle="Somente os campos alterados são enviados."
    >
      <div className="mt-3 flex flex-col gap-3">
        <Select
          label="Status da cobrança"
          value={status}
          options={billingStatusOptions(baseline.status)}
          disabled={saving}
          hint={
            baseline.status.length === 0
              ? 'A lista devolveu o tenant sem status de cobrança; escolha um valor para definir.'
              : `Atual: ${billingStatusLabel(baseline.status)}. "Não alterar" mantém o valor atual.`
          }
          error={fieldErrors.billingStatus}
          onChange={(event) => {
            clearErrors();
            setStatus(event.target.value);
          }}
        />

        <FieldRow>
          <Input
            label="Fim do teste"
            type="date"
            value={trialEndsAt}
            disabled={saving}
            hint={trialHint}
            error={fieldErrors.trialEndsAt}
            onChange={(event) => {
              clearErrors();
              setTrialEndsAt(event.target.value);
            }}
          />
          <Input
            label="E-mail de cobrança"
            type="email"
            inputMode="email"
            autoComplete="off"
            value={billingEmail}
            disabled={saving}
            placeholder="financeiro@empresa.com"
            hint={emailHint}
            error={fieldErrors.billingEmail}
            onChange={(event) => {
              clearErrors();
              setBillingEmail(event.target.value);
            }}
          />
        </FieldRow>

        {error !== null ? (
          <Alert title="Não foi possível salvar a cobrança" tone="danger">
            {error}
          </Alert>
        ) : null}

        {success !== null ? (
          <Alert title="Cobrança atualizada" tone="success">
            {success}
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 max-w-full break-all text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
            Alterações de cobrança valem assim que você salvar.
          </p>
          <Button
            variant="primary"
            icon="check"
            loading={saving}
            disabled={saving}
            onClick={() => void handleSave()}
          >
            Salvar cobrança
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ==========================================================================
 * Dialog
 * ========================================================================== */

function MetricsSkeleton(): JSX.Element {
  return (
    <Grid min={160} aria-busy="true">
      {METRICS_SKELETON_KEYS.map((index) => (
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

export function TenantDetailDialog({
  tenant,
  onClose,
  onSaved,
  onForbidden,
}: TenantDetailDialogProps): JSX.Element {
  const [metrics, setMetrics] = useState<PlatformTenantMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  /**
   * Effective status of the open detail.
   *
   * The row captured by the page is a snapshot: after the platform soft delete
   * (`DELETE /platform/tenants/:id`) the drawer must turn the pill into
   * "Excluído" and unlock the purge step without closing. The API answer is
   * adopted locally; a later prop with a different status (page refresh) resets
   * it to the authoritative value.
   */
  const [status, setStatus] = useState<string | null>(tenant.status ?? null);
  useEffect(() => {
    setStatus(tenant.status ?? null);
  }, [tenant.status]);

  useEffect(() => {
    let active = true;

    async function loadMetrics(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const result = await api.platformTenantMetrics(tenant.id);
        if (active) setMetrics(result);
      } catch (metricsError) {
        if (!active) return;
        if (isForbiddenError(metricsError)) {
          onForbidden();
          return;
        }
        setError(tenantMetricsErrorMessage(metricsError));
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadMetrics();
    return () => {
      active = false;
    };
  }, [tenant.id, reloadKey, onForbidden]);

  const effectivePlan = metrics?.plan ?? tenant.plan;
  const statusPill: ReactNode = status ? (
    <Pill tone={tenantStatusTone(status)}>{tenantStatusLabel(status)}</Pill>
  ) : null;
  const billingPill: ReactNode =
    tenant.billingStatus !== null && tenant.billingStatus !== undefined && tenant.billingStatus !== '' ? (
      <Pill tone={billingStatusTone(tenant.billingStatus)}>
        {billingStatusLabel(tenant.billingStatus)}
      </Pill>
    ) : null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Detalhes do tenant"
      description={`Métricas operacionais, cobrança e operações (backup, exclusão e purga) de ${tenantHeading(tenant)}.`}
      footer={
        <>
          <Button
            icon="pulse"
            loading={loading}
            onClick={() => setReloadKey((key) => key + 1)}
          >
            Atualizar dados
          </Button>
          <Button onClick={onClose}>Fechar</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {effectivePlan ? <Pill tone="accent">{planLabel(effectivePlan)}</Pill> : null}
          {statusPill}
          {billingPill}
          <span className="sac-num break-all text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
            {tenant.slug.trim().length > 0 ? tenant.slug : tenant.id}
          </span>
        </div>

        {loading ? (
          <MetricsSkeleton />
        ) : error !== null ? (
          <Alert title="Não foi possível carregar as métricas do tenant" tone="danger">
            <div className="flex flex-col gap-2">
              <span>{error}</span>
              <div>
                <Button size="sm" icon="pulse" onClick={() => setReloadKey((key) => key + 1)}>
                  Tentar novamente
                </Button>
              </div>
            </div>
          </Alert>
        ) : metrics !== null ? (
          <MetricsView tenant={tenant} metrics={metrics} />
        ) : null}

        <TenantCheckoutCard
          tenantId={tenant.id}
          tenantName={tenantHeading(tenant)}
          plan={effectivePlan}
          onForbidden={onForbidden}
        />

        <TenantBillingForm tenant={tenant} onSaved={onSaved} onForbidden={onForbidden} />

        <TenantOperationsCard
          tenantId={tenant.id}
          tenantName={
            tenant.name.trim().length > 0 ? tenant.name.trim() : tenant.slug.trim() || tenant.id
          }
          slug={tenant.slug}
          status={status}
          onStatusChange={setStatus}
          onChanged={onSaved}
          onForbidden={onForbidden}
        />
      </div>
    </Modal>
  );
}
