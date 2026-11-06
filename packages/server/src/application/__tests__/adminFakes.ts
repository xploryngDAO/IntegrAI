import type {
  AdminUserListFilter,
  AdminUserRecord,
  AgentRecord,
  AgentRole,
  AuditEventInput,
  AuditEventRecord,
  AuditEventView,
  AuditListFilter,
  AuditLogPage,
  CreateAuditEventInput,
  IAdminUserRepository,
  IAuditEventRepository,
  IAuditService,
  IClock,
  UserSessionView,
} from '@sac/shared';

import { makeAgent } from './platformFakes';

/**
 * In-memory repository/service doubles for the administrative slice.
 *
 * They mirror the production semantics that matter to the assertions: the audit
 * table is append-only and `list` applies the tenant/action/actor/date filters,
 * while `IAdminUserRepository` sorts by `createdAt` and derives the counters.
 */

export class InMemoryAuditEventRepository implements IAuditEventRepository {
  readonly rows: AuditEventRecord[] = [];
  /** When true, the NEXT create rejects (best-effort write test). */
  failNextCreate = false;
  /** Every input received by `create`, including the scrubbed metadata. */
  readonly createInputs: CreateAuditEventInput[] = [];
  /** Last filter received by `list` (lets tests assert the export cap). */
  lastFilter: AuditListFilter | null = null;
  private sequence = 0;

  constructor(private readonly clock: IClock) {}

  async create(input: CreateAuditEventInput): Promise<void> {
    // Defer so `AuditService.record` is observably asynchronous.
    await Promise.resolve();
    this.createInputs.push(input);
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('audit store unavailable');
    }
    this.rows.push({
      id: `audit-${(this.sequence += 1)}`,
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorEmail: input.actorEmail,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ip: input.ip,
      userAgent: input.userAgent,
      metadata: input.metadata,
      createdAt: this.clock.now(),
    });
  }

  async list(
    filter: AuditListFilter,
  ): Promise<{ items: AuditEventRecord[]; total: number }> {
    this.lastFilter = filter;
    const matches = this.rows
      .filter((row) => row.tenantId === filter.tenantId)
      .filter((row) => filter.action === undefined || row.action === filter.action)
      .filter((row) => filter.actorId === undefined || row.actorId === filter.actorId)
      .filter((row) => filter.from === undefined || row.createdAt.getTime() >= filter.from.getTime())
      .filter((row) => filter.to === undefined || row.createdAt.getTime() <= filter.to.getTime())
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
      );

    return {
      items: matches.slice(filter.offset, filter.offset + filter.limit),
      total: matches.length,
    };
  }

  seed(overrides: Partial<AuditEventRecord> = {}): AuditEventRecord {
    const row: AuditEventRecord = {
      id: overrides.id ?? `audit-${(this.sequence += 1)}`,
      tenantId: overrides.tenantId !== undefined ? overrides.tenantId : 'tenant-1',
      actorId: overrides.actorId ?? null,
      actorEmail: overrides.actorEmail ?? null,
      action: overrides.action ?? 'auth.login.success',
      resourceType: overrides.resourceType ?? null,
      resourceId: overrides.resourceId ?? null,
      ip: overrides.ip ?? null,
      userAgent: overrides.userAgent ?? null,
      metadata: overrides.metadata ?? {},
      createdAt: overrides.createdAt ?? this.clock.now(),
    };
    this.rows.push(row);
    return row;
  }
}

/** Records every `record` call and serves a configurable page for `list`. */
export class RecordingAuditService implements IAuditService {
  readonly recorded: AuditEventInput[] = [];
  listResult: AuditLogPage = { items: [], page: 1, perPage: 25, total: 0 };
  readonly listCalls: Array<{ tenantId: string; query: Parameters<IAuditService['list']>[1] }> = [];
  exportRowsResult: AuditEventView[] = [];
  readonly exportCalls: Array<{
    tenantId: string;
    query: Parameters<IAuditService['exportRows']>[1];
    limit: Parameters<IAuditService['exportRows']>[2];
  }> = [];

  record(input: AuditEventInput): void {
    this.recorded.push(input);
  }

  async list(
    tenantId: string,
    query?: Parameters<IAuditService['list']>[1],
  ): Promise<AuditLogPage> {
    this.listCalls.push({ tenantId, query });
    return this.listResult;
  }

  async exportRows(
    tenantId: string,
    query?: Parameters<IAuditService['exportRows']>[1],
    limit?: Parameters<IAuditService['exportRows']>[2],
  ): Promise<AuditEventView[]> {
    this.exportCalls.push({ tenantId, query, limit });
    return this.exportRowsResult;
  }

  async flush(): Promise<void> {
    return undefined;
  }

  actions(): string[] {
    return this.recorded.map((entry) => entry.action);
  }
}

export class InMemoryAdminUserRepository implements IAdminUserRepository {
  readonly rows: AgentRecord[] = [];
  /** userId -> live session counter (test-controlled). */
  readonly sessionsCount = new Map<string, number>();
  /** userId -> last session instant (test-controlled). */
  readonly lastLoginAt = new Map<string, Date>();
  /** Last filter received by `listFiltered` (lets tests assert pagination). */
  lastFilter: AdminUserListFilter | null = null;

  constructor(private readonly clock: IClock) {}

  seed(overrides: Partial<AgentRecord> = {}): AgentRecord {
    const row = makeAgent(overrides);
    this.rows.push(row);
    return row;
  }

  async listByTenant(tenantId: string, _at: Date): Promise<AdminUserRecord[]> {
    return sortByCreatedAt(this.rows.filter((row) => row.tenantId === tenantId)).map((agent) =>
      this.toRecord(agent),
    );
  }

  async listFiltered(
    filter: AdminUserListFilter,
    _at: Date,
  ): Promise<{ items: AdminUserRecord[]; total: number }> {
    this.lastFilter = filter;
    const search = filter.search?.trim().toLowerCase();

    const matched = sortByCreatedAt(
      this.rows
        .filter((row) => row.tenantId === filter.tenantId)
        .filter((row) => filter.role === undefined || row.role === filter.role)
        .filter(
          (row) =>
            filter.status === undefined ||
            row.isActive === (filter.status === 'ACTIVE'),
        )
        .filter(
          (row) =>
            search === undefined ||
            row.name.toLowerCase().includes(search) ||
            row.email.toLowerCase().includes(search),
        ),
    );

    return {
      items: matched
        .slice(filter.offset, filter.offset + filter.limit)
        .map((agent) => this.toRecord(agent)),
      // `total` describes the FILTERED set, mirroring the Prisma `count`.
      total: matched.length,
    };
  }

  async findById(id: string): Promise<AgentRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async update(
    id: string,
    patch: { role?: AgentRole; isActive?: boolean },
  ): Promise<AgentRecord> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`Agent not found: ${id}`);
    if (patch.role !== undefined) row.role = patch.role;
    if (patch.isActive !== undefined) row.isActive = patch.isActive;
    row.updatedAt = this.clock.now();
    // Prisma's `mapAgent` returns a fresh object; mirror that so aliasing bugs
    // (reading the "previous" value after the write) surface in tests.
    return { ...row };
  }

  async countActiveAdmins(tenantId: string): Promise<number> {
    return this.rows.filter(
      (row) => row.tenantId === tenantId && row.role === 'ADMIN' && row.isActive,
    ).length;
  }

  private toRecord(agent: AgentRecord): AdminUserRecord {
    return {
      agent,
      sessionsCount: this.sessionsCount.get(agent.id) ?? 0,
      lastLoginAt: this.lastLoginAt.get(agent.id) ?? null,
    };
  }
}

/** Same ordering the Prisma repository applies: `created_at`, then `id`. */
function sortByCreatedAt(rows: AgentRecord[]): AgentRecord[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
}

/** Minimal session view helper for controller tests (not a repository). */
export function makeUserSession(overrides: Partial<UserSessionView> = {}): UserSessionView {
  return {
    id: overrides.id ?? 'session-1',
    createdAt: overrides.createdAt ?? '2026-11-06T12:00:00.000Z',
    lastUsedAt: overrides.lastUsedAt ?? null,
    userAgent: overrides.userAgent ?? null,
    ip: overrides.ip ?? null,
    current: overrides.current ?? false,
  };
}
