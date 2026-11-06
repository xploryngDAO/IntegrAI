import type {
  AgentPresenceStatus,
  AgentRecord,
  AgentRole,
  CreateAgentInput,
  CreateTenantInput,
  IAgentRepository,
  IInvitationRepository,
  IPlatformRepository,
  IPlatformTenantRepository,
  ITenantRepository,
  InvitationRecord,
  Paginated,
  PlatformAlertQuery,
  PlatformAlertSnapshot,
  PlatformBillingPlanCount,
  PlatformMetricsRecord,
  PlatformTenantListQuery,
  TenantBillingPatch,
  TenantMetricsQuery,
  TenantMetricsRecord,
  TenantPolicyPatch,
  TenantRecord,
  TenantSubscriptionPatch,
  TenantUsageCounts,
  UpdateTenantInput,
  UpsertInvitationInput,
} from '@sac/shared';
import { PLAN_LIMITS, normalizeTenantSearch } from '@sac/shared';

/**
 * In-memory repositories shared by the Fase 4 unit tests.
 *
 * They mirror the production semantics that matter for the assertions:
 * `applyPolicies` writes only the provided fields, `softDelete` flips
 * status+deletedAt, and the platform aggregates are injected per test.
 */

export function makeTenant(overrides: Partial<TenantRecord> = {}): TenantRecord {
  const at = new Date('2026-11-01T12:00:00.000Z');
  const plan = overrides.plan ?? 'FREE';
  return {
    id: overrides.id ?? `tenant-${Math.random().toString(36).slice(2, 10)}`,
    slug: overrides.slug ?? 'acme',
    name: overrides.name ?? 'Acme',
    status: overrides.status ?? 'ACTIVE',
    plan,
    maxAccounts: overrides.maxAccounts ?? PLAN_LIMITS[plan].maxAccounts,
    maxAgents: overrides.maxAgents ?? PLAN_LIMITS[plan].maxAgents,
    billingStatus: overrides.billingStatus ?? 'TRIALING',
    trialEndsAt: overrides.trialEndsAt ?? null,
    billingEmail: overrides.billingEmail ?? null,
    onboardingCompletedAt: overrides.onboardingCompletedAt ?? null,
    deletedAt: overrides.deletedAt ?? null,
    createdAt: overrides.createdAt ?? at,
    updatedAt: overrides.updatedAt ?? at,
  };
}

export function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  const at = new Date('2026-11-01T12:00:00.000Z');
  return {
    id: overrides.id ?? `agent-${Math.random().toString(36).slice(2, 10)}`,
    // `??` would turn an explicit `tenantId: null` into the default, so the
    // nullable fields use an explicit undefined check.
    tenantId: overrides.tenantId !== undefined ? overrides.tenantId : 'tenant-1',
    email: overrides.email ?? 'admin@acme.test',
    name: overrides.name ?? 'Ana Admin',
    passwordHash: overrides.passwordHash ?? 'not-a-real-hash',
    role: overrides.role ?? 'ADMIN',
    presence: overrides.presence ?? 'OFFLINE',
    avatarColor: overrides.avatarColor ?? '#2563eb',
    maxConcurrent: overrides.maxConcurrent ?? 20,
    isActive: overrides.isActive ?? true,
    lastSeenAt: overrides.lastSeenAt !== undefined ? overrides.lastSeenAt : null,
    emailVerifiedAt:
      overrides.emailVerifiedAt !== undefined
        ? overrides.emailVerifiedAt
        : new Date('2026-11-01T12:00:00.000Z'),
    twoFactorSecretEnc: overrides.twoFactorSecretEnc ?? null,
    twoFactorEnabled: overrides.twoFactorEnabled ?? false,
    isPlatformAdmin: overrides.isPlatformAdmin ?? false,
    mustResetPassword: overrides.mustResetPassword ?? false,
    createdAt: overrides.createdAt ?? at,
    updatedAt: overrides.updatedAt ?? at,
  };
}

export class InMemoryTenantRepository implements ITenantRepository {
  readonly rows: TenantRecord[] = [];
  private sequence = 0;

  constructor(private readonly now: () => Date = () => new Date('2026-11-01T12:00:00.000Z')) {}

  seed(overrides: Partial<TenantRecord> = {}): TenantRecord {
    const row = makeTenant({
      id: overrides.id ?? `tenant-${(this.sequence += 1)}`,
      ...overrides,
    });
    this.rows.push(row);
    return row;
  }

  async create(input: CreateTenantInput): Promise<TenantRecord> {
    const plan = input.plan ?? 'FREE';
    return this.seed({
      slug: input.slug,
      name: input.name,
      status: input.status ?? 'ACTIVE',
      plan,
      maxAccounts: PLAN_LIMITS[plan].maxAccounts,
      maxAgents: PLAN_LIMITS[plan].maxAgents,
    });
  }

  async findBySlug(slug: string): Promise<TenantRecord | null> {
    return this.rows.find((row) => row.slug === slug) ?? null;
  }

  async findById(id: string): Promise<TenantRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async update(id: string, input: UpdateTenantInput): Promise<TenantRecord> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`Tenant not found: ${id}`);
    if (input.name !== undefined) row.name = input.name;
    if (input.onboardingCompletedAt !== undefined) {
      row.onboardingCompletedAt = input.onboardingCompletedAt;
    }
    row.updatedAt = this.now();
    return row;
  }

  async delete(id: string): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

export class InMemoryPlatformTenantRepository implements IPlatformTenantRepository {
  constructor(
    private readonly tenants: InMemoryTenantRepository,
    private readonly now: () => Date = () => new Date('2026-11-01T12:00:00.000Z'),
  ) {}

  async list(query: PlatformTenantListQuery): Promise<Paginated<TenantRecord>> {
    const search = normalizeTenantSearch(query.search);
    const filtered = [...this.tenants.rows]
      .filter(
        (row) =>
          search === undefined ||
          row.name.toLowerCase().includes(search.toLowerCase()) ||
          row.slug.toLowerCase().includes(search.toLowerCase()),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const total = filtered.length;
    const start = (query.page - 1) * query.pageSize;
    return {
      items: filtered.slice(start, start + query.pageSize),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
    };
  }

  async applyPolicies(id: string, patch: TenantPolicyPatch): Promise<TenantRecord> {
    const row = this.tenants.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`Tenant not found: ${id}`);
    if (patch.plan !== undefined) row.plan = patch.plan;
    if (patch.maxAccounts !== undefined) row.maxAccounts = patch.maxAccounts;
    if (patch.maxAgents !== undefined) row.maxAgents = patch.maxAgents;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.deletedAt !== undefined) row.deletedAt = patch.deletedAt;
    row.updatedAt = this.now();
    return row;
  }

  async applyBilling(id: string, patch: TenantBillingPatch): Promise<TenantRecord> {
    const row = this.tenants.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`Tenant not found: ${id}`);
    if (patch.billingStatus !== undefined) row.billingStatus = patch.billingStatus;
    if (patch.trialEndsAt !== undefined) row.trialEndsAt = patch.trialEndsAt;
    if (patch.billingEmail !== undefined) row.billingEmail = patch.billingEmail;
    row.updatedAt = this.now();
    return row;
  }

  async applySubscription(
    id: string,
    patch: TenantSubscriptionPatch,
  ): Promise<TenantRecord> {
    const row = this.tenants.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`Tenant not found: ${id}`);
    if (patch.billingStatus !== undefined) row.billingStatus = patch.billingStatus;
    if (patch.plan !== undefined) row.plan = patch.plan;
    if (patch.maxAccounts !== undefined) row.maxAccounts = patch.maxAccounts;
    if (patch.maxAgents !== undefined) row.maxAgents = patch.maxAgents;
    if (patch.trialEndsAt !== undefined) row.trialEndsAt = patch.trialEndsAt;
    row.updatedAt = this.now();
    return row;
  }

  async softDelete(id: string, at: Date): Promise<TenantRecord> {
    return this.applyPolicies(id, { status: 'DELETED', deletedAt: at });
  }
}

export class StubPlatformRepository implements IPlatformRepository {
  /** tenantId -> counts; unknown tenants resolve to zeros. */
  usage: Record<string, TenantUsageCounts> = {};
  metricsRecord: PlatformMetricsRecord = {
    totalTenants: 0,
    activeTenants: 0,
    accountsByMarketplace: { AMAZON: 0, MERCADO_LIVRE: 0, SHOPEE: 0 },
    openTickets: 0,
    messagesLast24h: 0,
    slaAtRisk: 0,
  };
  tenantMetricsRecord: TenantMetricsRecord = {
    accounts: 0,
    agents: 0,
    ticketsByStatus: {
      UNREAD: 0,
      OPEN_WAITING_AGENT: 0,
      WAITING_BUYER: 0,
      NO_RESPONSE_NEEDED: 0,
      MEDIATION: 0,
      RESOLVED: 0,
    },
    slaAtRisk: 0,
    slaBreached: 0,
    avgFirstResponseMinutes: null,
    messagesLast7d: 0,
    ticketsByDay: [],
  };
  alertSnapshotRecord: PlatformAlertSnapshot = {
    tenants: [],
    accounts: [],
    usage: {},
    slaAtRisk: {},
    expiringInvitations: {},
  };
  billingRows: PlatformBillingPlanCount[] = [];
  readonly usageRequests: string[][] = [];
  readonly metricsInputs: Array<{ messagesSince: Date; slaHorizon: Date }> = [];
  readonly tenantMetricsRequests: Array<{ tenantId: string; input: TenantMetricsQuery }> = [];
  readonly alertInputs: PlatformAlertQuery[] = [];
  billingRequests = 0;

  async usageFor(tenantIds: string[]): Promise<Record<string, TenantUsageCounts>> {
    this.usageRequests.push(tenantIds);
    const result: Record<string, TenantUsageCounts> = {};
    for (const id of tenantIds) {
      result[id] = this.usage[id] ?? { accounts: 0, agents: 0, tickets: 0 };
    }
    return result;
  }

  async metrics(input: {
    messagesSince: Date;
    slaHorizon: Date;
  }): Promise<PlatformMetricsRecord> {
    this.metricsInputs.push(input);
    return this.metricsRecord;
  }

  async tenantMetrics(
    tenantId: string,
    input: TenantMetricsQuery,
  ): Promise<TenantMetricsRecord> {
    this.tenantMetricsRequests.push({ tenantId, input });
    return this.tenantMetricsRecord;
  }

  async alertSnapshot(input: PlatformAlertQuery): Promise<PlatformAlertSnapshot> {
    this.alertInputs.push(input);
    return this.alertSnapshotRecord;
  }

  async billingByPlanAndStatus(): Promise<PlatformBillingPlanCount[]> {
    this.billingRequests += 1;
    return this.billingRows;
  }
}

export class StubAgentRepository implements IAgentRepository {
  readonly rows: AgentRecord[] = [];

  seed(overrides: Partial<AgentRecord> = {}): AgentRecord {
    const row = makeAgent(overrides);
    this.rows.push(row);
    return row;
  }

  async create(input: CreateAgentInput): Promise<AgentRecord> {
    const row = makeAgent({
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      tenantId: input.tenantId ?? null,
      role: (input.role ?? 'AGENT') as AgentRole,
      emailVerifiedAt: input.emailVerifiedAt ?? null,
    });
    this.rows.push(row);
    return row;
  }

  async findByEmail(email: string): Promise<AgentRecord | null> {
    return this.rows.find((row) => row.email === email) ?? null;
  }

  async findById(id: string): Promise<AgentRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async list(filter?: {
    presence?: AgentPresenceStatus;
    activeOnly?: boolean;
    tenantId?: string | null;
  }): Promise<AgentRecord[]> {
    return this.rows.filter(
      (row) =>
        (filter?.presence === undefined || row.presence === filter.presence) &&
        (filter?.activeOnly !== true || row.isActive) &&
        (filter?.tenantId === undefined || row.tenantId === filter.tenantId),
    );
  }

  async updatePresence(
    id: string,
    presence: AgentPresenceStatus,
    at: Date,
  ): Promise<AgentRecord> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`Agent not found: ${id}`);
    row.presence = presence;
    row.lastSeenAt = at;
    return row;
  }

  async updateName(id: string, name: string): Promise<AgentRecord> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`Agent not found: ${id}`);
    row.name = name;
    return row;
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row !== undefined) row.passwordHash = passwordHash;
  }

  async markEmailVerified(id: string, at: Date): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row !== undefined) row.emailVerifiedAt = at;
  }
}

/** Minimal invitation repository: only the pending-seat accounting is used. */
export class StubInvitationRepository implements IInvitationRepository {
  readonly rows: InvitationRecord[] = [];

  seed(overrides: Partial<InvitationRecord> = {}): InvitationRecord {
    const row: InvitationRecord = {
      id: overrides.id ?? `invite-${this.rows.length + 1}`,
      tenantId: overrides.tenantId ?? 'tenant-1',
      email: overrides.email ?? `invitee-${this.rows.length + 1}@acme.test`,
      role: overrides.role ?? 'AGENT',
      tokenHash: overrides.tokenHash ?? `hash-${this.rows.length + 1}`,
      invitedBy: overrides.invitedBy ?? null,
      expiresAt: overrides.expiresAt ?? new Date('2026-11-10T12:00:00.000Z'),
      acceptedAt: overrides.acceptedAt ?? null,
      createdAt: overrides.createdAt ?? new Date('2026-11-01T12:00:00.000Z'),
    };
    this.rows.push(row);
    return row;
  }

  async upsert(input: UpsertInvitationInput): Promise<InvitationRecord> {
    const existing = this.rows.find(
      (row) => row.tenantId === input.tenantId && row.email === input.email,
    );
    if (existing !== undefined) {
      existing.tokenHash = input.tokenHash;
      existing.expiresAt = input.expiresAt;
      return existing;
    }
    return this.seed({
      tenantId: input.tenantId,
      email: input.email,
      role: input.role,
      tokenHash: input.tokenHash,
      invitedBy: input.invitedBy ?? null,
      expiresAt: input.expiresAt,
    });
  }

  async findByTokenHash(tokenHash: string): Promise<InvitationRecord | null> {
    return this.rows.find((row) => row.tokenHash === tokenHash) ?? null;
  }

  async findById(id: string): Promise<InvitationRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async listByTenant(tenantId: string): Promise<InvitationRecord[]> {
    return this.rows.filter((row) => row.tenantId === tenantId);
  }

  async accept(id: string, at: Date): Promise<InvitationRecord | null> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined || row.acceptedAt !== null) return null;
    row.acceptedAt = at;
    return row;
  }

  async revoke(id: string, tenantId: string, at: Date): Promise<boolean> {
    const row = this.rows.find((entry) => entry.id === id && entry.tenantId === tenantId);
    if (row === undefined || row.acceptedAt !== null) return false;
    row.expiresAt = at;
    return true;
  }

  async deletePending(id: string, tenantId: string, at: Date): Promise<boolean> {
    const index = this.rows.findIndex(
      (entry) =>
        entry.id === id &&
        entry.tenantId === tenantId &&
        entry.acceptedAt === null &&
        entry.expiresAt.getTime() > at.getTime(),
    );
    if (index < 0) return false;
    this.rows.splice(index, 1);
    return true;
  }

  async reissue(
    id: string,
    tenantId: string,
    input: { tokenHash: string; expiresAt: Date },
  ): Promise<boolean> {
    const row = this.rows.find(
      (entry) => entry.id === id && entry.tenantId === tenantId && entry.acceptedAt === null,
    );
    if (row === undefined) return false;
    row.tokenHash = input.tokenHash;
    row.expiresAt = input.expiresAt;
    return true;
  }
}
