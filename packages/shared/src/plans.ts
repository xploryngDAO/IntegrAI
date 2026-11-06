/**
 * ============================================================================
 * Fase 4 - tenant plans, quotas and lifecycle
 * ============================================================================
 *
 * `plan` is the commercial label shown by the platform console and billed by
 * the (future) subscription integration. The EFFECTIVE quota lives on the
 * tenant row (`max_accounts` / `max_agents`) so the console can grant a one-off
 * increase without inventing a new plan; `PLAN_LIMITS` only holds the defaults
 * applied when a tenant is created or moved to another plan.
 *
 * `ENTERPRISE` is "practically unlimited" by using a very high numeric quota
 * instead of a nullable column: every consumer (plan limits, console, export)
 * keeps one single code path.
 */

export type TenantPlan = 'FREE' | 'PRO' | 'ENTERPRISE';

export const TENANT_PLANS = ['FREE', 'PRO', 'ENTERPRISE'] as const;

export interface PlanLimits {
  maxAccounts: number;
  maxAgents: number;
}

/** Practical ceiling for ENTERPRISE (no count can realistically reach it). */
export const ENTERPRISE_UNLIMITED = 1_000_000;

/**
 * Default quotas per plan (docs/PHASE4_PLATFORM.md):
 * - FREE       : 1 store, 3 operators (trial / single store).
 * - PRO        : 10 stores, 25 operators.
 * - ENTERPRISE : no practical limit (custom contract).
 */
export const PLAN_LIMITS: Record<TenantPlan, PlanLimits> = {
  FREE: { maxAccounts: 1, maxAgents: 3 },
  PRO: { maxAccounts: 10, maxAgents: 25 },
  ENTERPRISE: { maxAccounts: ENTERPRISE_UNLIMITED, maxAgents: ENTERPRISE_UNLIMITED },
};

export const TENANT_PLAN_LABEL: Record<TenantPlan, string> = {
  FREE: 'Free',
  PRO: 'Pro',
  ENTERPRISE: 'Enterprise',
};

/** Tenant lifecycle. `DELETED` is the LGPD soft delete (data preserved). */
export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';

export const TENANT_STATUSES: readonly TenantStatus[] = ['ACTIVE', 'SUSPENDED', 'DELETED'];

/** Statuses the platform console may set through `PATCH /platform/tenants/:id`. */
export const OPERABLE_TENANT_STATUSES: readonly TenantStatus[] = ['ACTIVE', 'SUSPENDED'];

/** A workspace is usable only when ACTIVE and not soft-deleted. */
export function isTenantActive(tenant: {
  status: string;
  deletedAt: Date | null;
}): boolean {
  return tenant.status === 'ACTIVE' && tenant.deletedAt === null;
}

export function isTenantPlan(value: unknown): value is TenantPlan {
  return typeof value === 'string' && (TENANT_PLANS as readonly string[]).includes(value);
}

/* ==========================================================================
 * Platform console search (Fase 4: `GET /platform/tenants?search=`)
 * ========================================================================== */

/** Longest accepted search term (chars) for the console tenant list. */
export const TENANT_SEARCH_MAX_LENGTH = 120;

/**
 * Normalizes the console search term: trims it and treats blank/null/undefined
 * as "no filter". The HTTP schema enforces the 1..120 length; this helper keeps
 * service/repository callers (and direct tests) consistent.
 */
export function normalizeTenantSearch(value?: string | null): string | undefined {
  const term = (value ?? '').trim();
  return term.length > 0 ? term : undefined;
}
