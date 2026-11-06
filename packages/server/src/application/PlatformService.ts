import type {
  IAgentRepository,
  IClock,
  ILogger,
  IPlatformRepository,
  IPlatformService,
  IPlatformTenantRepository,
  ITenantRepository,
  PlatformAlert,
  PlatformAlertSeverity,
  PlatformAlertSnapshot,
  PlatformAlertTenantRecord,
  PlatformAlertsResult,
  PlatformBillingSummary,
  PlatformMetrics,
  PlatformTenantListQuery,
  PlatformTenantListResult,
  PlatformTenantUpdateCommand,
  PlatformTenantView,
  TenantBillingPatch,
  TenantBillingUpdateCommand,
  TenantBillingView,
  TenantMetrics,
  TenantPolicyPatch,
  TenantRecord,
  TenantUsageCounts,
} from '@sac/shared';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  OPEN_TICKET_STATUSES,
  PLAN_LIMITS,
  TENANT_PLANS,
  TICKET_STATUSES,
  ValidationError,
  monthlyPriceBrl,
  normalizeTenantSearch,
} from '@sac/shared';

/**
 * ============================================================================
 * PlatformService - Fase 4 internal console
 * ============================================================================
 *
 * Cross-tenant operations, gated by `agents.is_platform_admin`:
 *
 *  - `requirePlatformAdmin` re-reads the operator from the database on every
 *    call (never trusts the JWT claim), so revoking the flag is immediate.
 *  - `listTenants` merges tenant rows with per-tenant usage counts and accepts
 *    an optional server-side search (name OR slug, case-insensitive).
 *  - `updateTenant` changes plan/quota/status; changing the plan alone resets
 *    the quotas to that plan's defaults (explicit max* wins).
 *  - `metrics` is the global operational snapshot of `/platform/metrics`.
 *  - `tenantMetrics` is the same idea scoped to ONE workspace.
 *  - `alerts` derives operational alerts from live rows (no alert table).
 *  - `billingSummary`/`updateBilling` are the billing base (MRR + subscription
 *    fields); the payment gateway itself is a documented follow-up.
 *
 * A DELETED (LGPD) workspace cannot be reactivated through the console: only
 * the purge job (or the manual purge endpoint) owns that transition. Billing
 * updates are refused for a deleted workspace for the same reason.
 */

const SLA_RISK_HORIZON_MINUTES = 120;
const METRICS_WINDOW_MS = 24 * 60 * 60 * 1_000;
const TENANT_MESSAGES_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const METRICS_TICKET_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1_000;
const ACCOUNT_ERROR_WINDOW_MS = 24 * 60 * 60 * 1_000;
const INVITATION_EXPIRY_HORIZON_MS = 48 * 60 * 60 * 1_000;

/** Quota percentages that trigger a warning / a critical alert. */
const QUOTA_WARNING_PCT = 80;
const QUOTA_EXCEEDED_PCT = 100;

/** Open at-risk tickets above this count raise a platform alert. */
export const SLA_AT_RISK_ALERT_THRESHOLD = 10;
const INVITATION_EXPIRY_HORIZON_HOURS = 48;

const ZERO_COUNTS: TenantUsageCounts = { accounts: 0, agents: 0, tickets: 0 };

const SEVERITY_RANK: Record<PlatformAlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export interface PlatformServiceDependencies {
  logger: ILogger;
  clock: IClock;
  repos: {
    agents: IAgentRepository;
    tenants: ITenantRepository;
    platformTenants: IPlatformTenantRepository;
    platform: IPlatformRepository;
  };
}

export class PlatformService implements IPlatformService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly agents: IAgentRepository;
  private readonly tenants: ITenantRepository;
  private readonly platformTenants: IPlatformTenantRepository;
  private readonly platform: IPlatformRepository;

  constructor(deps: PlatformServiceDependencies) {
    this.logger = deps.logger.child({ component: 'PlatformService' });
    this.clock = deps.clock;
    this.agents = deps.repos.agents;
    this.tenants = deps.repos.tenants;
    this.platformTenants = deps.repos.platformTenants;
    this.platform = deps.repos.platform;
  }

  /* ==================================================================== */
  /* Authorization                                                        */
  /* ==================================================================== */

  async requirePlatformAdmin(actorId: string): Promise<void> {
    const agent = await this.agents.findById(actorId);
    if (agent === null || !agent.isActive || !agent.isPlatformAdmin) {
      this.logger.warn('platform.access.denied', { actorId });
      throw new AuthorizationError('Platform administrator privileges are required');
    }
  }

  /* ==================================================================== */
  /* Tenants                                                              */
  /* ==================================================================== */

  async listTenants(query: PlatformTenantListQuery): Promise<PlatformTenantListResult> {
    // The schema already trims/caps the term; normalizing here keeps direct
    // service callers (console jobs, tests) consistent: blank == no filter.
    const search = normalizeTenantSearch(query.search);
    const result = await this.platformTenants.list({
      page: query.page,
      pageSize: query.pageSize,
      ...(search !== undefined ? { search } : {}),
    });
    const usage = await this.platform.usageFor(result.items.map((tenant) => tenant.id));

    return {
      items: result.items.map((tenant) => toView(tenant, usage[tenant.id] ?? ZERO_COUNTS)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    };
  }

  async updateTenant(
    tenantId: string,
    command: PlatformTenantUpdateCommand,
  ): Promise<PlatformTenantView> {
    const tenant = await this.tenants.findById(tenantId);
    if (tenant === null) throw new NotFoundError('Tenant', tenantId);

    const patch: TenantPolicyPatch = {};

    if (command.plan !== undefined) {
      // A bare plan change realigns the quotas with the plan defaults; an
      // explicit max* in the same request is honored (custom contract).
      const defaults = PLAN_LIMITS[command.plan];
      patch.plan = command.plan;
      patch.maxAccounts = command.maxAccounts ?? defaults.maxAccounts;
      patch.maxAgents = command.maxAgents ?? defaults.maxAgents;
    } else {
      if (command.maxAccounts !== undefined) patch.maxAccounts = command.maxAccounts;
      if (command.maxAgents !== undefined) patch.maxAgents = command.maxAgents;
    }

    if (command.maxAccounts !== undefined && command.maxAccounts < 1) {
      throw new ValidationError('maxAccounts must be >= 1', { field: 'maxAccounts' });
    }
    if (command.maxAgents !== undefined && command.maxAgents < 1) {
      throw new ValidationError('maxAgents must be >= 1', { field: 'maxAgents' });
    }

    if (command.status !== undefined) {
      if (tenant.deletedAt !== null || tenant.status === 'DELETED') {
        throw new ConflictError('Deleted workspaces cannot be reactivated through the console', {
          code: 'TENANT_DELETED',
        });
      }
      patch.status = command.status;
    }

    if (Object.keys(patch).length === 0) {
      throw new ValidationError('At least one of plan, maxAccounts, maxAgents or status is required');
    }

    const updated = await this.platformTenants.applyPolicies(tenantId, patch);
    this.logger.info('platform.tenant.updated', {
      tenantId,
      fields: Object.keys(patch),
      plan: updated.plan,
      status: updated.status,
    });

    const usage = await this.platform.usageFor([tenantId]);
    return toView(updated, usage[tenantId] ?? ZERO_COUNTS);
  }

  /* ==================================================================== */
  /* Metrics                                                              */
  /* ==================================================================== */

  async metrics(): Promise<PlatformMetrics> {
    const now = this.clock.now();
    const record = await this.platform.metrics({
      messagesSince: new Date(now.getTime() - METRICS_WINDOW_MS),
      slaHorizon: new Date(now.getTime() + SLA_RISK_HORIZON_MINUTES * 60 * 1_000),
    });

    const totalAccounts = Object.values(record.accountsByMarketplace).reduce(
      (sum, value) => sum + value,
      0,
    );

    return {
      generatedAt: now.toISOString(),
      totalTenants: record.totalTenants,
      activeTenants: record.activeTenants,
      accountsByMarketplace: record.accountsByMarketplace,
      totalAccounts,
      openTickets: record.openTickets,
      messagesLast24h: record.messagesLast24h,
      slaAtRisk: record.slaAtRisk,
      slaRiskHorizonMinutes: SLA_RISK_HORIZON_MINUTES,
    };
  }

  /**
   * `GET /platform/tenants/:id/metrics` - operational snapshot of ONE
   * workspace. The 14-day series always has 14 entries (zero-filled), so the
   * UI can render a chart without filling gaps client-side.
   */
  async tenantMetrics(tenantId: string): Promise<TenantMetrics> {
    const tenant = await this.tenants.findById(tenantId);
    if (tenant === null) throw new NotFoundError('Tenant', tenantId);

    const now = this.clock.now();
    const startOfTodayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const ticketsSince = new Date(startOfTodayUtc - (METRICS_TICKET_DAYS - 1) * DAY_MS);

    const record = await this.platform.tenantMetrics(tenantId, {
      messagesSince: new Date(now.getTime() - TENANT_MESSAGES_WINDOW_MS),
      ticketsSince,
      slaHorizon: new Date(now.getTime() + SLA_RISK_HORIZON_MINUTES * 60 * 1_000),
    });

    const ticketsByStatus = Object.fromEntries(
      TICKET_STATUSES.map((status) => [status, record.ticketsByStatus[status] ?? 0]),
    ) as Record<(typeof TICKET_STATUSES)[number], number>;
    const openTickets = OPEN_TICKET_STATUSES.reduce(
      (sum, status) => sum + (ticketsByStatus[status] ?? 0),
      0,
    );

    const countsByDay = new Map(record.ticketsByDay.map((row) => [row.date, row.count]));
    const ticketsLast14d = Array.from({ length: METRICS_TICKET_DAYS }, (_, index) => {
      const date = new Date(ticketsSince.getTime() + index * DAY_MS).toISOString().slice(0, 10);
      return { date, count: countsByDay.get(date) ?? 0 };
    });

    return {
      accounts: record.accounts,
      agents: record.agents,
      ticketsByStatus,
      openTickets,
      slaAtRisk: record.slaAtRisk,
      slaBreached: record.slaBreached,
      avgFirstResponseMinutes:
        record.avgFirstResponseMinutes === null
          ? null
          : Math.round(record.avgFirstResponseMinutes * 10) / 10,
      messagesLast7d: record.messagesLast7d,
      ticketsLast14d,
      plan: tenant.plan,
      limits: { maxAccounts: tenant.maxAccounts, maxAgents: tenant.maxAgents },
      usagePct: {
        accounts: usagePercentage(record.accounts, tenant.maxAccounts),
        agents: usagePercentage(record.agents, tenant.maxAgents),
      },
    };
  }

  /* ==================================================================== */
  /* Alerts                                                               */
  /* ==================================================================== */

  /**
   * `GET /platform/alerts` - list derived from live rows (no alert table).
   *
   * Signals: suspended workspace, account not ACTIVE, recent account error,
   * agents/accounts quota at 80% (warning) or 100% (critical), high SLA risk
   * (> 10 open tickets, critical above 20) and invitations expiring in 48 h.
   */
  async alerts(): Promise<PlatformAlertsResult> {
    const now = this.clock.now();
    const snapshot = await this.platform.alertSnapshot({
      now,
      errorSince: new Date(now.getTime() - ACCOUNT_ERROR_WINDOW_MS),
      slaHorizon: new Date(now.getTime() + SLA_RISK_HORIZON_MINUTES * 60 * 1_000),
      invitationHorizon: new Date(now.getTime() + INVITATION_EXPIRY_HORIZON_MS),
    });

    const alerts = buildAlerts(snapshot, now);
    return { generatedAt: now.toISOString(), total: alerts.length, alerts };
  }

  /* ==================================================================== */
  /* Billing                                                              */
  /* ==================================================================== */

  /**
   * `GET /platform/billing/summary` - MRR base.
   *
   * Only ACTIVE subscriptions contribute to `mrr` and to `byPlan[].mrr`;
   * TRIALING and PAST_DUE are reported separately (their plan price is not
   * recognized as recurring revenue yet). CANCELED tenants are excluded.
   */
  async billingSummary(): Promise<PlatformBillingSummary> {
    const rows = await this.platform.billingByPlanAndStatus();
    const byPlan = TENANT_PLANS.map((plan) => ({ plan, tenants: 0, mrr: 0 }));
    const byPlanIndex = new Map(byPlan.map((entry) => [entry.plan, entry]));

    let mrr = 0;
    let trialing = 0;
    let pastDue = 0;

    for (const row of rows) {
      if (row.billingStatus === 'TRIALING') {
        trialing += row.tenants;
        continue;
      }
      if (row.billingStatus === 'PAST_DUE') {
        pastDue += row.tenants;
        continue;
      }
      if (row.billingStatus !== 'ACTIVE') continue; // CANCELED does not bill.

      const entry = byPlanIndex.get(row.plan);
      if (entry === undefined) continue;
      const contribution = monthlyPriceBrl(row.plan) * row.tenants;
      entry.tenants += row.tenants;
      entry.mrr += contribution;
      mrr += contribution;
    }

    return { mrr, byPlan, trialing, pastDue };
  }

  /**
   * `PATCH /platform/tenants/:id/billing` - subscription status, trial end and
   * billing contact. The payment gateway is NOT called here (follow-up).
   */
  async updateBilling(
    tenantId: string,
    command: TenantBillingUpdateCommand,
  ): Promise<TenantBillingView> {
    const tenant = await this.tenants.findById(tenantId);
    if (tenant === null) throw new NotFoundError('Tenant', tenantId);
    if (tenant.deletedAt !== null || tenant.status === 'DELETED') {
      throw new ConflictError('Deleted workspaces cannot change billing', {
        code: 'TENANT_DELETED',
      });
    }

    const patch: TenantBillingPatch = {};

    if (command.billingStatus !== undefined) patch.billingStatus = command.billingStatus;

    if (command.trialEndsAt !== undefined) {
      if (command.trialEndsAt !== null && Number.isNaN(command.trialEndsAt.getTime())) {
        throw new ValidationError('trialEndsAt must be a valid date', { field: 'trialEndsAt' });
      }
      patch.trialEndsAt = command.trialEndsAt;
    }

    if (command.billingEmail !== undefined) {
      if (command.billingEmail === null) {
        patch.billingEmail = null;
      } else {
        const email = command.billingEmail.trim();
        if (email.length === 0 || email.length > 180 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new ValidationError('billingEmail must be a valid e-mail', {
            field: 'billingEmail',
          });
        }
        patch.billingEmail = email;
      }
    }

    if (Object.keys(patch).length === 0) {
      throw new ValidationError(
        'At least one of billingStatus, trialEndsAt or billingEmail is required',
      );
    }

    const updated = await this.platformTenants.applyBilling(tenantId, patch);
    this.logger.info('platform.tenant.billing_updated', {
      tenantId,
      fields: Object.keys(patch),
      billingStatus: updated.billingStatus,
    });

    return toBillingView(updated);
  }
}

/* ====================================================================== */
/* Helpers                                                                */
/* ====================================================================== */

/** Percentage of a quota in use, rounded; 0 when the quota is not positive. */
function usagePercentage(used: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.round((used / limit) * 100);
}

function truncate(value: string, max = 160): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function tenantAlert(
  tenant: PlatformAlertTenantRecord,
  type: PlatformAlert['type'],
  severity: PlatformAlertSeverity,
  message: string,
  value: number,
): PlatformAlert {
  return {
    severity,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    type,
    message,
    value,
  };
}

function quotaAlert(
  tenant: PlatformAlertTenantRecord,
  resource: 'agents' | 'accounts',
  used: number,
  limit: number,
): PlatformAlert | null {
  const percentage = usagePercentage(used, limit);
  if (percentage < QUOTA_WARNING_PCT) return null;

  const exceeded = percentage >= QUOTA_EXCEEDED_PCT;
  const label = resource === 'agents' ? 'Agents' : 'Accounts';
  const type = resource === 'agents' ? 'AGENTS_QUOTA' : 'ACCOUNTS_QUOTA';
  const message = exceeded
    ? `${label} quota exceeded: ${used}/${limit} (${percentage}%).`
    : `${label} quota at ${percentage}% (${used}/${limit}).`;

  return tenantAlert(
    tenant,
    type,
    exceeded ? 'critical' : 'warning',
    message,
    percentage,
  );
}

/**
 * Pure derivation: receives the cross-tenant snapshot and returns the alert
 * list, ordered critical -> warning -> info and then by tenant/type.
 */
export function buildAlerts(snapshot: PlatformAlertSnapshot, now: Date = new Date()): PlatformAlert[] {
  const alerts: PlatformAlert[] = [];

  for (const tenant of snapshot.tenants) {
    if (tenant.status === 'SUSPENDED') {
      alerts.push(
        tenantAlert(
          tenant,
          'TENANT_SUSPENDED',
          'warning',
          'Workspace is suspended and cannot be used by its operators.',
          1,
        ),
      );
    }

    const usage = snapshot.usage[tenant.id] ?? { accounts: 0, agents: 0 };
    const agentsQuota = quotaAlert(tenant, 'agents', usage.agents, tenant.maxAgents);
    if (agentsQuota !== null) alerts.push(agentsQuota);
    const accountsQuota = quotaAlert(tenant, 'accounts', usage.accounts, tenant.maxAccounts);
    if (accountsQuota !== null) alerts.push(accountsQuota);

    const slaAtRisk = snapshot.slaAtRisk[tenant.id] ?? 0;
    if (slaAtRisk > SLA_AT_RISK_ALERT_THRESHOLD) {
      alerts.push(
        tenantAlert(
          tenant,
          'SLA_AT_RISK',
          slaAtRisk > SLA_AT_RISK_ALERT_THRESHOLD * 2 ? 'critical' : 'warning',
          `${slaAtRisk} open tickets are at SLA risk (deadline within ${SLA_RISK_HORIZON_MINUTES} minutes).`,
          slaAtRisk,
        ),
      );
    }

    const expiringInvitations = snapshot.expiringInvitations[tenant.id] ?? 0;
    if (expiringInvitations > 0) {
      alerts.push(
        tenantAlert(
          tenant,
          'INVITATIONS_EXPIRING',
          'info',
          `${expiringInvitations} pending invitation(s) expire within ${INVITATION_EXPIRY_HORIZON_HOURS} hours.`,
          expiringInvitations,
        ),
      );
    }
  }

  const tenantsById = new Map(snapshot.tenants.map((tenant) => [tenant.id, tenant]));

  for (const account of snapshot.accounts) {
    if (account.tenantId === null) continue;
    const tenant = tenantsById.get(account.tenantId);
    if (tenant === undefined) continue;

    if (account.status !== 'ACTIVE') {
      alerts.push(
        tenantAlert(
          tenant,
          'ACCOUNT_STATUS',
          account.status === 'DISCONNECTED' ? 'critical' : 'warning',
          `Account "${account.displayName}" (${account.marketplace}) is ${account.status}.`,
          1,
        ),
      );
      continue;
    }

    if (account.lastErrorAt !== null) {
      const detail = account.lastError !== null ? `: ${truncate(account.lastError)}` : '.';
      alerts.push(
        tenantAlert(
          tenant,
          'ACCOUNT_ERROR',
          'warning',
          `Account "${account.displayName}" (${account.marketplace}) reported a recent error${detail}`,
          Math.max(0, Math.floor((now.getTime() - account.lastErrorAt.getTime()) / 60_000)),
        ),
      );
    }
  }

  alerts.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.tenantSlug.localeCompare(b.tenantSlug) ||
      a.type.localeCompare(b.type) ||
      a.message.localeCompare(b.message),
  );

  return alerts;
}

/** JSON projection (dates as ISO strings) shared by list/update. */
export function toView(tenant: TenantRecord, counts: TenantUsageCounts): PlatformTenantView {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    plan: tenant.plan,
    status: tenant.status,
    limits: { maxAccounts: tenant.maxAccounts, maxAgents: tenant.maxAgents },
    counts,
    onboardingCompletedAt: tenant.onboardingCompletedAt?.toISOString() ?? null,
    deletedAt: tenant.deletedAt?.toISOString() ?? null,
    createdAt: tenant.createdAt.toISOString(),
  };
}

/** `PATCH /platform/tenants/:id/billing` projection. */
export function toBillingView(tenant: TenantRecord): TenantBillingView {
  return {
    tenantId: tenant.id,
    slug: tenant.slug,
    plan: tenant.plan,
    billingStatus: tenant.billingStatus,
    trialEndsAt: tenant.trialEndsAt?.toISOString() ?? null,
    billingEmail: tenant.billingEmail,
    monthlyPriceBrl: monthlyPriceBrl(tenant.plan),
    updatedAt: tenant.updatedAt.toISOString(),
  };
}
