import type {
  IAgentRepository,
  IClock,
  ILogger,
  IPlatformRepository,
  IPlatformService,
  IPlatformTenantRepository,
  ITenantRepository,
  PlatformMetrics,
  PlatformTenantListQuery,
  PlatformTenantListResult,
  PlatformTenantUpdateCommand,
  PlatformTenantView,
  TenantPolicyPatch,
  TenantRecord,
  TenantUsageCounts,
} from '@sac/shared';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  PLAN_LIMITS,
  ValidationError,
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
 *
 * A DELETED (LGPD) workspace cannot be reactivated through the console: only
 * the purge job (or the manual purge endpoint) owns that transition.
 */

const SLA_RISK_HORIZON_MINUTES = 120;
const METRICS_WINDOW_MS = 24 * 60 * 60 * 1_000;
const ZERO_COUNTS: TenantUsageCounts = { accounts: 0, agents: 0, tickets: 0 };

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
