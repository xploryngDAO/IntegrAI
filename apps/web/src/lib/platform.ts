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
    if (error.status === 0) return error.message;
    const code = error.code && error.code !== 'HTTP_ERROR' ? ` (${error.code})` : '';
    return `${error.message}${code}`;
  }
  return error instanceof Error && error.message
    ? error.message
    : 'Não foi possível falar com a API. Tente novamente.';
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
