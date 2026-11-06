/**
 * Fase 4 — platform console helpers.
 *
 * The platform API is the real guard (`403` on `/platform/*`). The helpers here
 * only decide what the shell may *offer*: the `/platform` shortcut is rendered
 * when `/auth/me` identifies a platform admin, and `/settings` when the
 * operator is an ADMIN of the tenant.
 *
 * `/auth/me` currently normalises unknown roles to `AGENT`, so the backend
 * signals platform staff explicitly. Both accepted shapes are defensive:
 *   - `role: 'PLATFORM_ADMIN'` (case-insensitive);
 *   - `isPlatformAdmin: true` / `platformAdmin: true` added to the payload.
 */
import type { IAgentSummary } from '@sac/shared';

import { ApiClientError } from './api';
import type { PlatformTenantLimits, TenantPlan } from './types';

/** Fields a newer `/auth/me` may carry without changing the shared contract. */
type AgentWithPlatformFlags = IAgentSummary & {
  isPlatformAdmin?: boolean;
  platformAdmin?: boolean;
};

function normalizedRole(role: unknown): string {
  if (typeof role !== 'string') return '';
  return role
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

/** Platform staff: global console (`/platform`). */
export function isPlatformAdmin(agent: IAgentSummary | null | undefined): boolean {
  if (!agent) return false;
  const extended = agent as AgentWithPlatformFlags;
  if (extended.isPlatformAdmin === true || extended.platformAdmin === true) return true;

  const role = normalizedRole(extended.role);
  return (
    role === 'PLATFORM_ADMIN' ||
    role === 'PLATFORMADMIN' ||
    role === 'PLATFORM_OWNER' ||
    role === 'SUPER_ADMIN' ||
    role === 'SUPERADMIN'
  );
}

/** ADMIN of the current tenant: workspace settings + LGPD actions. */
export function isTenantAdmin(agent: IAgentSummary | null | undefined): boolean {
  if (!agent) return false;
  return normalizedRole((agent as AgentWithPlatformFlags).role) === 'ADMIN';
}

/* ==========================================================================
 * Plans and limits
 * ========================================================================== */

export const PLATFORM_PLANS = [
  { value: 'FREE', label: 'Free' },
  { value: 'PRO', label: 'Pro' },
  { value: 'ENTERPRISE', label: 'Enterprise' },
] as const;

/** Practical ceiling of the ENTERPRISE plan (mirrors `@sac/shared`). */
export const ENTERPRISE_UNLIMITED = 1_000_000;

/** Default quotas applied when a tenant moves to a plan (mirrors `PLAN_LIMITS`). */
export const PLAN_DEFAULT_LIMITS: Record<TenantPlan, PlatformTenantLimits> = {
  FREE: { maxAccounts: 1, maxAgents: 3 },
  PRO: { maxAccounts: 10, maxAgents: 25 },
  ENTERPRISE: { maxAccounts: ENTERPRISE_UNLIMITED, maxAgents: ENTERPRISE_UNLIMITED },
};

const PLAN_LABEL: Record<string, string> = {
  FREE: 'Free',
  PRO: 'Pro',
  ENTERPRISE: 'Enterprise',
};

export function planLabel(plan: string | null | undefined): string {
  const value = (plan ?? '').trim();
  if (value.length === 0) return '—';
  return PLAN_LABEL[value.toUpperCase()] ?? value;
}

/** Canonical option value for a plan returned by the API. */
export function canonicalPlan(plan: string | null | undefined): TenantPlan {
  const value = (plan ?? '').trim().toUpperCase();
  const known = PLATFORM_PLANS.find((entry) => entry.value === value);
  return known?.value ?? PLATFORM_PLANS[0].value;
}

/**
 * Options for the plan select. A plan the console does not know yet stays
 * selectable so an operator never overwrites it by merely opening the modal.
 */
export function planOptions(plan: string | null | undefined): { value: string; label: string }[] {
  const current = (plan ?? '').trim();
  const options: { value: string; label: string }[] = PLATFORM_PLANS.map((entry) => ({
    value: entry.value,
    label: entry.label,
  }));
  if (current.length > 0 && !PLATFORM_PLANS.some((entry) => entry.value === current.toUpperCase())) {
    options.push({ value: current, label: planLabel(current) });
  }
  return options;
}

export function formatLimit(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value >= ENTERPRISE_UNLIMITED ? 'ilimitado' : String(value);
}

/* ==========================================================================
 * Numbers (the console API is allowed to serialise counters as strings)
 * ========================================================================== */

/** Coerces a counter to a non-negative integer; anything invalid becomes 0. */
export function asCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
  }
  return 0;
}

/** Coerces to a finite number, keeping `null` for absent/invalid input. */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * `42` / `42,5` / `140` (pt-BR) for a value already expressed in percent.
 * Over-quota tenants are shown above 100% — clamping would hide the overage.
 */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const normalized = Math.max(0, value);
  return `${normalized.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

/** Percentage of a quota in use; `null` when the quota is unlimited/unknown. */
export function quotaPercent(value: unknown, limit: unknown): number | null {
  const used = asCount(value);
  const ceiling = asNumber(limit);
  if (ceiling === null || ceiling <= 0 || ceiling >= ENTERPRISE_UNLIMITED) return null;
  return Math.max(0, (used / ceiling) * 100);
}

/**
 * Overall usage of `usagePct`, which the API answers as an object per resource
 * (a plain number from an earlier contract is also accepted). The highest
 * resource wins; values above 100% are preserved.
 */
export function overallUsagePercent(usagePct: unknown): number | null {
  const direct = asNumber(usagePct);
  if (direct !== null) return Math.max(0, direct);

  if (typeof usagePct === 'object' && usagePct !== null) {
    const entries = usagePct as { accounts?: unknown; agents?: unknown };
    const values = [asNumber(entries.accounts), asNumber(entries.agents)].filter(
      (value): value is number => value !== null,
    );
    if (values.length === 0) return null;
    return Math.max(0, Math.max(...values));
  }
  return null;
}

/* ==========================================================================
 * Tenant status
 * ========================================================================== */

export type TenantStatusTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'rose' | 'info';

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Ativo',
  TRIAL: 'Em teste',
  PAST_DUE: 'Pagamento pendente',
  SUSPENDED: 'Suspenso',
  CANCELED: 'Cancelado',
  CANCELLED: 'Cancelado',
  INACTIVE: 'Inativo',
  DELETED: 'Excluído',
};

export function tenantStatusLabel(status: string | null | undefined): string {
  const value = (status ?? '').trim();
  if (value.length === 0) return '—';
  return STATUS_LABEL[value.toUpperCase()] ?? value;
}

export function tenantStatusTone(status: string | null | undefined): TenantStatusTone {
  switch ((status ?? '').trim().toUpperCase()) {
    case 'ACTIVE':
      return 'ok';
    case 'TRIAL':
      return 'accent';
    case 'PAST_DUE':
      return 'warn';
    case 'SUSPENDED':
    case 'INACTIVE':
      return 'danger';
    case 'CANCELED':
    case 'CANCELLED':
    case 'DELETED':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/* ==========================================================================
 * Billing
 * ========================================================================== */

/** Server enum `BillingStatus` (TRIALING | ACTIVE | PAST_DUE | CANCELED). */
export const BILLING_STATUSES = [
  { value: 'ACTIVE', label: 'Ativa' },
  { value: 'TRIALING', label: 'Em teste (trial)' },
  { value: 'PAST_DUE', label: 'Pagamento pendente' },
  { value: 'CANCELED', label: 'Cancelada' },
] as const;

/** `platformTenantBillingBodySchema` caps the billing e-mail at 180 chars. */
export const BILLING_EMAIL_MAX_LENGTH = 180;

const BILLING_STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Ativa',
  TRIAL: 'Em teste',
  TRIALING: 'Em teste (trial)',
  PAST_DUE: 'Pagamento pendente',
  CANCELED: 'Cancelada',
  CANCELLED: 'Cancelada',
  INCOMPLETE: 'Incompleta',
  UNPAID: 'Não paga',
  PAUSED: 'Pausada',
};

export function billingStatusLabel(status: string | null | undefined): string {
  const value = (status ?? '').trim();
  if (value.length === 0) return '—';
  return BILLING_STATUS_LABEL[value.toUpperCase()] ?? value;
}

export function billingStatusTone(status: string | null | undefined): TenantStatusTone {
  switch ((status ?? '').trim().toUpperCase()) {
    case 'ACTIVE':
      return 'ok';
    case 'TRIAL':
    case 'TRIALING':
      return 'accent';
    case 'PAST_DUE':
    case 'UNPAID':
    case 'INCOMPLETE':
      return 'warn';
    case 'CANCELED':
    case 'CANCELLED':
      return 'neutral';
    case 'PAUSED':
      return 'danger';
    default:
      return 'neutral';
  }
}

/**
 * Options of the billing status select. The first entry means "keep the current
 * value" (the form only PATCHes what the operator changed); a status the console
 * does not know yet stays selectable so opening the form never rewrites it.
 */
export function billingStatusOptions(
  current: string | null | undefined,
): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [{ value: '', label: 'Não alterar' }];
  for (const entry of BILLING_STATUSES) options.push({ value: entry.value, label: entry.label });

  const value = (current ?? '').trim();
  if (
    value.length > 0 &&
    !BILLING_STATUSES.some((entry) => entry.value === value.toUpperCase())
  ) {
    options.push({ value, label: billingStatusLabel(value) });
  }
  return options;
}

/**
 * `<input type="date">` (`YYYY-MM-DD`) → ISO instant.
 *
 * The chosen day is the last day of the trial, so the timestamp is the end of
 * that day in UTC; `null` means the input was not a valid date.
 */
export function trialEndsAtToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const parsed = new Date(`${trimmed}T23:59:59.999Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  // Reject impossible dates such as 2026-02-31 (Date rolls them over).
  if (parsed.toISOString().slice(0, 10) !== trimmed) return null;
  return parsed.toISOString();
}

/** ISO instant → `<input type="date">` value (`''` when absent/invalid). */
export function isoToDateInput(value: string | null | undefined): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())}`;
}

/* ==========================================================================
 * Billing events (audit trail of the gateway callbacks)
 * ========================================================================== */

/**
 * PT-BR label of the normalised gateway event
 * (`BILLING_WEBHOOK_TYPES` in `@sac/shared`). An unknown type is rendered raw:
 * an operator debugging a gateway integration needs the exact code.
 */
const BILLING_EVENT_TYPE_LABEL: Record<string, string> = {
  'subscription.activated': 'Assinatura ativada',
  'subscription.updated': 'Assinatura atualizada',
  'payment.succeeded': 'Pagamento confirmado',
  'payment.failed': 'Pagamento recusado',
  'subscription.canceled': 'Assinatura cancelada',
};

export function billingEventTypeLabel(type: string | null | undefined): string {
  const value = (type ?? '').trim();
  if (value.length === 0) return 'Evento';
  return BILLING_EVENT_TYPE_LABEL[value.toLowerCase()] ?? value;
}

/** `webhook_events.status`: RECEIVED | PROCESSED | FAILED (tolerant to new ones). */
const BILLING_EVENT_STATUS_LABEL: Record<string, string> = {
  RECEIVED: 'Recebido',
  PROCESSED: 'Processado',
  FAILED: 'Falhou',
  DUPLICATE: 'Duplicado',
};

export function billingEventStatusLabel(status: string | null | undefined): string {
  const value = (status ?? '').trim();
  if (value.length === 0) return '—';
  return BILLING_EVENT_STATUS_LABEL[value.toUpperCase()] ?? value;
}

export function billingEventStatusTone(
  status: string | null | undefined,
): TenantStatusTone {
  switch ((status ?? '').trim().toUpperCase()) {
    case 'PROCESSED':
      return 'ok';
    case 'RECEIVED':
      return 'accent';
    case 'FAILED':
      return 'danger';
    default:
      return 'neutral';
  }
}

/* ==========================================================================
 * Alerts
 * ========================================================================== */

export type AlertSeverity = 'critical' | 'warning' | 'info';

/** Rendering order: critical first, informational last. */
export const ALERT_SEVERITY_ORDER: readonly AlertSeverity[] = ['critical', 'warning', 'info'];

export const ALERT_SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: 'Crítico',
  warning: 'Atenção',
  info: 'Informativo',
};

/**
 * PT-BR labels of the stable alert kinds the API derives from live rows.
 * Unknown kinds fall back to the raw code, which is what an operator needs to
 * report a bug without a translation round-trip.
 */
const ALERT_TYPE_LABEL: Record<string, string> = {
  TENANT_SUSPENDED: 'Tenant suspenso',
  ACCOUNT_STATUS: 'Status de conta',
  ACCOUNT_ERROR: 'Erro de conta',
  AGENTS_QUOTA: 'Quota de agentes',
  ACCOUNTS_QUOTA: 'Quota de contas',
  SLA_AT_RISK: 'SLA em risco',
  INVITATIONS_EXPIRING: 'Convites expirando',
};

export function alertTypeLabel(type: string | null | undefined): string {
  const value = (type ?? '').trim();
  if (value.length === 0) return 'Alerta';
  return ALERT_TYPE_LABEL[value.toUpperCase()] ?? value;
}

const CRITICAL_SEVERITIES = new Set([
  'CRITICAL',
  'CRITICO',
  'CRÍTICO',
  'FATAL',
  'ERROR',
  'DANGER',
  'SEVERE',
  'HIGH',
  'URGENT',
]);

const WARNING_SEVERITIES = new Set([
  'WARNING',
  'WARN',
  'ATENCAO',
  'ATENÇÃO',
  'MEDIUM',
  'MEDIO',
  'MÉDIO',
  'MODERATE',
]);

/** Normalises the severity reported by the API (accent/case insensitive). */
export function normalizeAlertSeverity(severity: unknown): AlertSeverity {
  const raw =
    typeof severity === 'string'
      ? severity
          .trim()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toUpperCase()
      : '';
  if (CRITICAL_SEVERITIES.has(raw)) return 'critical';
  if (WARNING_SEVERITIES.has(raw)) return 'warning';
  return 'info';
}

export function alertSeverityRank(severity: unknown): number {
  return ALERT_SEVERITY_ORDER.indexOf(normalizeAlertSeverity(severity));
}

/** Pill tone of an alert severity. */
export function alertSeverityTone(
  severity: unknown,
): 'danger' | 'warn' | 'info' {
  switch (normalizeAlertSeverity(severity)) {
    case 'critical':
      return 'danger';
    case 'warning':
      return 'warn';
    default:
      return 'info';
  }
}

/* ==========================================================================
 * API failures
 * ========================================================================== */

export function isForbiddenError(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 403;
}

/** Real, operator-facing message (server text preserved when available). */
export function platformErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 403) {
      return 'Sua conta não tem permissão para acessar o console da plataforma.';
    }
    if (error.status === 404 || error.status === 405 || error.status === 501) {
      return 'O console da plataforma não está publicado nesta API.';
    }
    if (error.status === 422) {
      return `${error.message} Revise os valores enviados e tente novamente.`;
    }
    if (error.status === 0) return error.message;
    const code = error.code && error.code !== 'HTTP_ERROR' ? ` (${error.code})` : '';
    return `${error.message}${code}`;
  }
  return error instanceof Error && error.message
    ? error.message
    : 'Não foi possível falar com a API. Tente novamente.';
}

/**
 * Failure of `GET /platform/tenants/:id/metrics`.
 *
 * A 404 here means the tenant disappeared (or the id is wrong) — not that the
 * endpoint is missing — so it must not reuse the "console not published" copy.
 */
export function tenantMetricsErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 404) {
      return 'Tenant não encontrado (HTTP 404). Ele pode ter sido removido; feche este painel e atualize a lista.';
    }
    if (error.status === 405 || error.status === 501) {
      return 'As métricas por tenant não estão publicadas nesta API.';
    }
    if (error.status === 422) {
      return `A API recusou a consulta de métricas (HTTP 422): ${error.message}`;
    }
  }
  return platformErrorMessage(error);
}

/** Failure of `PATCH /platform/tenants/:id/billing` (validation stays visible). */
export function billingErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 404) {
      return 'Tenant não encontrado (HTTP 404). Atualize a lista e abra o tenant novamente.';
    }
    if (error.status === 409) {
      return `${error.message} (HTTP 409). A cobrança mudou em outra sessão; atualize os dados e tente novamente.`;
    }
    if (error.status === 422) {
      const message = error.message.trim();
      return message.length > 0 && message !== 'Erro HTTP 422.'
        ? message
        : 'A API recusou os dados de cobrança (HTTP 422). Revise o status, a data do trial e o e-mail.';
    }
    if (error.status === 405 || error.status === 501) {
      return 'A atualização de cobrança não está publicada nesta API.';
    }
  }
  return platformErrorMessage(error);
}

/** Errors of the LGPD/danger-zone actions keep the server message untouched. */
export function tenantActionErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'INVALID_PASSWORD') {
      return 'Senha incorreta. Confira a senha do administrador e tente novamente.';
    }
    if (error.code === 'TENANT_ALREADY_DELETED') {
      return 'Este workspace já foi excluído e não pode ser excluído novamente.';
    }
    if (error.status === 401) {
      return 'Senha incorreta ou sessão expirada. Confira a senha e tente novamente.';
    }
    if (error.status === 403) {
      return `${error.message} (HTTP 403 — apenas um ADMIN do workspace pode executar esta ação).`;
    }
    if (error.status === 0) return error.message;
    return `${error.message} (HTTP ${error.status})`;
  }
  return error instanceof Error && error.message
    ? error.message
    : 'Não foi possível falar com a API. Tente novamente.';
}

/** `details.missing` of `BILLING_NOT_CONFIGURED` (`['BILLING_CHECKOUT_URL_TEMPLATE']`). */
function missingBillingVariables(error: ApiClientError): string[] {
  const details = error.details;
  if (typeof details !== 'object' || details === null) return [];
  const missing = (details as { missing?: unknown }).missing;
  if (!Array.isArray(missing)) return [];
  return missing.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * `details.resource` of a `404 NOT_FOUND` app error (`{ resource: 'Tenant' }`).
 * A route that is simply not published has no `details`, so both 404 shapes can
 * be told apart without guessing.
 */
function notFoundResource(error: ApiClientError): string {
  const details = error.details;
  if (typeof details !== 'object' || details === null) return '';
  const resource = (details as { resource?: unknown }).resource;
  return typeof resource === 'string' ? resource : '';
}

/**
 * Failure of `POST /platform/tenants/:id/checkout`.
 *
 * `503 BILLING_NOT_CONFIGURED` is not an outage: the API is healthy and the
 * deployment is missing environment variables, so the message names them and
 * a retry is not offered — the fix belongs to the operator's environment.
 */
export function checkoutErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 503 || error.code === 'BILLING_NOT_CONFIGURED') {
      const missing = missingBillingVariables(error);
      const list = missing.length > 0 ? ` Faltam: ${missing.join(', ')}.` : '';
      return `A cobrança ainda não está configurada nesta API (HTTP 503 · BILLING_NOT_CONFIGURED).${list} Defina BILLING_CHECKOUT_URL_TEMPLATE (e BILLING_SUCCESS_URL/BILLING_CANCEL_URL) no ambiente da API para habilitar o checkout; nenhum valor foi alterado e nada foi cobrado.`;
    }
    if (error.status === 404) {
      return notFoundResource(error) === 'Tenant'
        ? 'Tenant não encontrado (HTTP 404). Feche este painel e atualize a lista de tenants.'
        : 'O checkout por tenant não está publicado nesta API (HTTP 404).';
    }
    if (error.status === 409) {
      return `${error.message} (HTTP 409). Este workspace não pode iniciar um checkout no estado atual.`;
    }
    if (error.status === 403) {
      return 'Sua conta não tem permissão de platform admin para gerar o checkout deste tenant.';
    }
    if (error.status === 422) {
      return `A API recusou o pedido de checkout (HTTP 422): ${error.message}`;
    }
    if (error.status === 405 || error.status === 501) {
      return 'O checkout por tenant não está publicado nesta API.';
    }
  }
  return platformErrorMessage(error);
}

/** Failure of `GET /platform/billing/events`. */
export function billingEventsErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 404 || error.status === 405 || error.status === 501) {
      return 'A auditoria de eventos de billing não está publicada nesta API.';
    }
    if (error.status === 422) {
      return `A API recusou a consulta de eventos (HTTP 422): ${error.message}`;
    }
  }
  return platformErrorMessage(error);
}
