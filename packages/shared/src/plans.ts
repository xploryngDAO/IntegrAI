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
 * Billing (Fase 4): subscription status and BRL list prices
 * ========================================================================== */

/**
 * Commercial state of a workspace subscription.
 *
 * `TRIALING` is the default for a new workspace; `PAST_DUE` means a payment is
 * late (the workspace keeps operating until the collection policy says
 * otherwise); `CANCELED` stops billing. The payment gateway is a documented
 * follow-up: these columns are the base the integration will read/write.
 */
export type BillingStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';

export const BILLING_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'] as const;

/**
 * Monthly list price per plan, in BRL (the billing base used by
 * `GET /platform/billing/summary`). FREE is free; PRO is 299; ENTERPRISE is
 * 1.499. No gateway, taxes or proration are applied here.
 */
export const PLAN_MONTHLY_PRICE_BRL: Record<TenantPlan, number> = {
  FREE: 0,
  PRO: 299,
  ENTERPRISE: 1_499,
};

/** Monthly price in BRL for a plan (0 for FREE). */
export function monthlyPriceBrl(plan: TenantPlan): number {
  return PLAN_MONTHLY_PRICE_BRL[plan];
}

export function isBillingStatus(value: unknown): value is BillingStatus {
  return typeof value === 'string' && (BILLING_STATUSES as readonly string[]).includes(value);
}

/* ==========================================================================
 * Billing gateway contract (provider-agnostic webhook)
 * ========================================================================== */

/** `GET /platform/billing/events?limit=` contract bounds. */
export const BILLING_EVENTS_DEFAULT_LIMIT = 50;
export const BILLING_EVENTS_MAX_LIMIT = 100;

/**
 * Normalized event kinds accepted by `POST /api/v1/billing/webhook`.
 *
 * The payload is provider-agnostic on purpose: the gateway adapter (if any) is
 * responsible for translating its native event names into one of these five
 * values before calling the API. The API never calls a gateway.
 */
export type BillingWebhookType =
  | 'subscription.activated'
  | 'subscription.updated'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'subscription.canceled';

export const BILLING_WEBHOOK_TYPES = [
  'subscription.activated',
  'subscription.updated',
  'payment.succeeded',
  'payment.failed',
  'subscription.canceled',
] as const;

export function isBillingWebhookType(value: unknown): value is BillingWebhookType {
  return typeof value === 'string' && (BILLING_WEBHOOK_TYPES as readonly string[]).includes(value);
}

/**
 * Subscription transition applied by the webhook state machine.
 *
 * Returns `undefined` when the event does not change the subscription state
 * (`subscription.updated` only refreshes plan/cycle metadata). `CANCELED` is
 * terminal for payment failures: a late `payment.failed` never revives a
 * canceled subscription.
 */
export function nextBillingStatus(
  type: BillingWebhookType,
  current: BillingStatus,
): BillingStatus | undefined {
  switch (type) {
    case 'subscription.activated':
    case 'payment.succeeded':
      return 'ACTIVE';
    case 'payment.failed':
      return current === 'CANCELED' ? 'CANCELED' : 'PAST_DUE';
    case 'subscription.canceled':
      return 'CANCELED';
    case 'subscription.updated':
    default:
      return undefined;
  }
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
