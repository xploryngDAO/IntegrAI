import type {
  IClock,
  IInvitationRepository,
  ILogger,
  IPlanLimitService,
  IPlatformRepository,
  ITenantRepository,
  PlanUsageView,
  TenantRecord,
  TenantUsageCounts,
} from '@sac/shared';
import {
  NotFoundError,
  PlanLimitReachedError,
  TenantInactiveError,
  isTenantActive,
} from '@sac/shared';

/**
 * ============================================================================
 * PlanLimitService - Fase 4 quotas (max_agents / max_accounts)
 * ============================================================================
 *
 * One gate for every "grow the workspace" path:
 *
 *  - `assertCanAddAgent`  : accepting an invitation / creating an operator.
 *  - `assertCanInviteAgent`: sending an invitation (pending invites reserve a
 *    seat, otherwise an ADMIN could mail 10 links with 1 free seat).
 *  - `assertCanAddAccount`: connecting a NEW marketplace store.
 *
 * The effective quota is read from the tenant row, so the console can override
 * it and ENTERPRISE is unlimited in practice without a second code path.
 * Every rejection is a `PLAN_LIMIT_REACHED` (409) carrying
 * `{ limit, current, plan, resource }` for the upgrade prompt.
 */

export interface PlanLimitServiceDependencies {
  logger: ILogger;
  clock: IClock;
  repos: {
    tenants: ITenantRepository;
    platform: IPlatformRepository;
    invitations: IInvitationRepository;
  };
}

const ZERO: TenantUsageCounts = { accounts: 0, agents: 0, tickets: 0 };

export class PlanLimitService implements IPlanLimitService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly tenants: ITenantRepository;
  private readonly platform: IPlatformRepository;
  private readonly invitations: IInvitationRepository;

  constructor(deps: PlanLimitServiceDependencies) {
    this.logger = deps.logger.child({ component: 'PlanLimitService' });
    this.clock = deps.clock;
    this.tenants = deps.repos.tenants;
    this.platform = deps.repos.platform;
    this.invitations = deps.repos.invitations;
  }

  async usage(tenantId: string): Promise<PlanUsageView> {
    const tenant = await this.requireTenant(tenantId);
    const counts = await this.counts(tenantId);
    return {
      plan: tenant.plan,
      limits: { maxAccounts: tenant.maxAccounts, maxAgents: tenant.maxAgents },
      usage: { agents: counts.agents, accounts: counts.accounts },
    };
  }

  async assertCanAddAgent(tenantId: string): Promise<void> {
    const tenant = await this.requireTenant(tenantId);
    const counts = await this.counts(tenantId);
    this.assertBelow('agents', tenant, counts.agents);
  }

  async assertCanInviteAgent(
    tenantId: string,
    options?: { excludeEmail?: string },
  ): Promise<void> {
    const tenant = await this.requireTenant(tenantId);
    const [counts, pending] = await Promise.all([
      this.counts(tenantId),
      this.pendingInvitations(tenantId, options?.excludeEmail),
    ]);
    // A pending invitation reserves one seat, so "agents + pending" is what the
    // workspace would use as soon as every invite is accepted. A resend for an
    // address that is already pending does not reserve a second seat.
    this.assertBelow('agents', tenant, counts.agents + pending);
  }

  async assertCanAddAccount(tenantId: string): Promise<void> {
    const tenant = await this.requireTenant(tenantId);
    const counts = await this.counts(tenantId);
    this.assertBelow('accounts', tenant, counts.accounts);
  }

  /* ==================================================================== */
  /* Internals                                                            */
  /* ==================================================================== */

  private assertBelow(
    resource: 'agents' | 'accounts',
    tenant: TenantRecord,
    current: number,
  ): void {
    const limit = resource === 'agents' ? tenant.maxAgents : tenant.maxAccounts;
    if (current >= limit) {
      this.logger.warn('plan.limit.reached', {
        tenantId: tenant.id,
        plan: tenant.plan,
        resource,
        limit,
        current,
      });
      throw new PlanLimitReachedError({ plan: tenant.plan, limit, current, resource });
    }
  }

  private async requireTenant(tenantId: string): Promise<TenantRecord> {
    const tenant = await this.tenants.findById(tenantId);
    if (tenant === null) throw new NotFoundError('Tenant', tenantId);
    if (!isTenantActive(tenant)) {
      // Defence in depth: the JWT guard already rejects an inactive workspace,
      // but a service call can come from a worker or an internal job.
      throw new TenantInactiveError(tenant.status, tenant.id);
    }
    return tenant;
  }

  private async counts(tenantId: string): Promise<TenantUsageCounts> {
    const usage = await this.platform.usageFor([tenantId]);
    return usage[tenantId] ?? ZERO;
  }

  private async pendingInvitations(
    tenantId: string,
    excludeEmail?: string,
  ): Promise<number> {
    const now = this.clock.now();
    const excluded = excludeEmail?.trim().toLowerCase();
    const rows = await this.invitations.listByTenant(tenantId);
    return rows.filter(
      (row) =>
        row.acceptedAt === null &&
        row.expiresAt.getTime() > now.getTime() &&
        (excluded === undefined || row.email.trim().toLowerCase() !== excluded),
    ).length;
  }
}
