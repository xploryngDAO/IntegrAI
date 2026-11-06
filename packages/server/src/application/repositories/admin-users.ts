import type { Agent, Prisma, PrismaClient } from '../../generated/prisma/client';
import { isMarketplace, TERMINAL_TICKET_STATUSES } from '@sac/shared';
import type {
  AdminOverview,
  AdminSessionListFilter,
  AdminSessionRecord,
  AdminUserListFilter,
  AdminUserRecord,
  AgentRecord,
  AgentRole,
  IAdminUserRepository,
  Marketplace,
} from '@sac/shared';

import { mapAgent, mapSession } from './mappers';

/** One day in milliseconds: the `audit.last24h` rolling window. */
const OVERVIEW_AUDIT_WINDOW_MS = 24 * 60 * 60 * 1_000;

const ADMIN_USER_ORDER: Prisma.AgentOrderByWithRelationInput[] = [
  { createdAt: 'asc' },
  { id: 'asc' },
];

/**
 * `GET /admin/sessions` order: most recently used device first. `lastUsedAt`
 * is nullable (never refreshed) and Postgres sorts NULL first on DESC by
 * default, so `nulls: 'last'` is explicit. `createdAt`/`id` keep the order
 * deterministic across pages.
 */
const ADMIN_SESSION_ORDER: Prisma.SessionOrderByWithRelationInput[] = [
  { lastUsedAt: { sort: 'desc', nulls: 'last' } },
  { createdAt: 'desc' },
  { id: 'desc' },
];

/**
 * Search filter of `GET /admin/users`: `name` OR `email` contains the term.
 *
 * `mode: 'insensitive'` is Prisma/Postgres `ILIKE`, so the comparison is
 * case-insensitive at the database (no rows are filtered in memory). The SAME
 * `where` is used by `count`, keeping `total` aligned with the filtered page.
 */
function adminUserSearchWhere(search: string | undefined): Prisma.AgentWhereInput {
  const term = (search ?? '').trim();
  if (term.length === 0) return {};
  return {
    OR: [
      { name: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
    ],
  };
}

/**
 * Prisma implementation of `IAdminUserRepository`.
 *
 * `listByTenant`/`listFiltered` derive the two counters the console needs
 * without an N+1: one `groupBy` for the live refresh sessions and another for
 * the last session instant (used as "last login"). A page with zero operators
 * short-circuits before querying `sessions` (an empty `IN ()` is wasted work).
 */
export class PrismaAdminUserRepository implements IAdminUserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /* ==================================================================== */
  /* Workspace overview (`GET /admin/overview`)                           */
  /* ==================================================================== */

  /**
   * Tenant-scoped overview counters.
   *
   * Seven aggregate reads in ONE `Promise.all` (no N+1, no business row loaded
   * into memory):
   *
   *  - `agents`   grouped by `(role, isActive)` -> total/active/admins;
   *  - `sessions` count of live refresh sessions -> sessions.active;
   *  - `invitations` count of pending invites -> invitations.pending;
   *  - `marketplaceAccounts` grouped by `(marketplace, status)` -> total,
   *    connected (ACTIVE only) and the per-marketplace partition;
   *  - `supportTickets` grouped by `status` -> total/unread;
   *  - `supportTickets` count of unassigned non-terminal -> tickets.unassigned;
   *  - `auditEvents` count inside the rolling 24h window.
   *
   * The schema has no `CLOSED` ticket status: "closed" is represented by the
   * domain's terminal statuses (`NO_RESPONSE_NEEDED`, `RESOLVED`), which are
   * exactly the ones excluded from `unassigned`.
   */
  async overview(tenantId: string, at: Date): Promise<AdminOverview> {
    const auditSince = new Date(at.getTime() - OVERVIEW_AUDIT_WINDOW_MS);

    const [
      agentGroups,
      activeSessions,
      pendingInvitations,
      accountGroups,
      ticketGroups,
      unassignedTickets,
      auditLast24h,
    ] = await Promise.all([
      this.prisma.agent.groupBy({
        by: ['role', 'isActive'],
        where: { tenantId },
        _count: { _all: true },
      }),
      this.prisma.session.count({
        where: { tenantId, revokedAt: null, expiresAt: { gt: at } },
      }),
      this.prisma.invitation.count({
        where: { tenantId, acceptedAt: null, expiresAt: { gt: at } },
      }),
      this.prisma.marketplaceAccount.groupBy({
        by: ['marketplace', 'status'],
        where: { tenantId },
        _count: { _all: true },
      }),
      this.prisma.supportTicket.groupBy({
        by: ['status'],
        where: { tenantId },
        _count: { _all: true },
      }),
      this.prisma.supportTicket.count({
        where: {
          tenantId,
          assignedAgentId: null,
          status: { notIn: [...TERMINAL_TICKET_STATUSES] },
        },
      }),
      this.prisma.auditEvent.count({
        where: { tenantId, createdAt: { gte: auditSince } },
      }),
    ]);

    let usersTotal = 0;
    let usersActive = 0;
    let admins = 0;
    for (const row of agentGroups) {
      const count = row._count._all;
      usersTotal += count;
      if (row.isActive) usersActive += count;
      if (row.role === 'ADMIN' && row.isActive) admins += count;
    }

    // The three real marketplaces are ALWAYS present (zero-filled): the UI
    // renders a fixed card per channel and must not special-case a missing key.
    const byMarketplace: Record<Marketplace, number> = {
      AMAZON: 0,
      MERCADO_LIVRE: 0,
      SHOPEE: 0,
    };
    let accountsTotal = 0;
    let connected = 0;
    for (const row of accountGroups) {
      const count = row._count._all;
      accountsTotal += count;
      if (row.status === 'ACTIVE') connected += count;
      // `BILLING` is a `marketplace_accounts` enum member used only by
      // `webhook_events`; defensive guard keeps the by-marketplace partition
      // aligned with `MARKETPLACES` without inventing a fourth card.
      if (isMarketplace(row.marketplace)) byMarketplace[row.marketplace] += count;
    }

    let ticketsTotal = 0;
    let unread = 0;
    for (const row of ticketGroups) {
      const count = row._count._all;
      ticketsTotal += count;
      if (row.status === 'UNREAD') unread += count;
    }

    return {
      users: { total: usersTotal, active: usersActive, admins },
      sessions: { active: activeSessions },
      invitations: { pending: pendingInvitations },
      accounts: { total: accountsTotal, connected, byMarketplace },
      tickets: { total: ticketsTotal, unread, unassigned: unassignedTickets },
      audit: { last24h: auditLast24h },
    };
  }

  async listByTenant(tenantId: string, at: Date): Promise<AdminUserRecord[]> {
    const records = await this.prisma.agent.findMany({
      where: { tenantId },
      orderBy: ADMIN_USER_ORDER,
    });
    return this.hydrate(records, at);
  }

  async listFiltered(
    filter: AdminUserListFilter,
    at: Date,
  ): Promise<{ items: AdminUserRecord[]; total: number }> {
    // Tenant comes first and is never client-controlled; the filters are only
    // added when present so an unfiltered page keeps a minimal `where`.
    const where: Prisma.AgentWhereInput = {
      tenantId: filter.tenantId,
      ...adminUserSearchWhere(filter.search),
      ...(filter.role !== undefined ? { role: filter.role } : {}),
      ...(filter.status !== undefined ? { isActive: filter.status === 'ACTIVE' } : {}),
    };

    const [records, total] = await Promise.all([
      this.prisma.agent.findMany({
        where,
        orderBy: ADMIN_USER_ORDER,
        skip: filter.offset,
        take: filter.limit,
      }),
      // Same `where` as `findMany`: `total` describes the FILTERED set.
      this.prisma.agent.count({ where }),
    ]);

    return { items: await this.hydrate(records, at), total };
  }

  async findById(id: string): Promise<AgentRecord | null> {
    const record = await this.prisma.agent.findUnique({ where: { id } });
    return record !== null ? mapAgent(record) : null;
  }

  async update(
    id: string,
    patch: { role?: AgentRole; isActive?: boolean },
  ): Promise<AgentRecord> {
    const data: Prisma.AgentUpdateInput = {};
    if (patch.role !== undefined) data.role = patch.role;
    if (patch.isActive !== undefined) data.isActive = patch.isActive;

    const record = await this.prisma.agent.update({ where: { id }, data });
    return mapAgent(record);
  }

  async countActiveAdmins(tenantId: string): Promise<number> {
    return this.prisma.agent.count({
      where: { tenantId, role: 'ADMIN', isActive: true },
    });
  }

  /**
   * LIVE sessions of one workspace, joined with the operator that owns them.
   *
   * `sessions` has no Prisma relation to `agents`, so the join is explicit:
   * the tenant's agent ids are the source of truth for ownership and only then
   * the live sessions are read. Both `sessions.tenant_id` and the agent tenant
   * are enforced, so a stale/mis-scoped session row can never leak across
   * workspaces. `findMany` and `count` share the exact same `where`, keeping
   * `total` aligned with the live set.
   */
  async listAtivasByTenant(
    filter: AdminSessionListFilter,
    at: Date,
  ): Promise<{ items: AdminSessionRecord[]; total: number }> {
    const agents = await this.prisma.agent.findMany({
      where: { tenantId: filter.tenantId },
    });
    if (agents.length === 0) return { items: [], total: 0 };

    const agentsById = new Map<string, AgentRecord>(
      agents.map((agent) => [agent.id, mapAgent(agent)]),
    );

    const where: Prisma.SessionWhereInput = {
      userId: { in: [...agentsById.keys()] },
      tenantId: filter.tenantId,
      revokedAt: null,
      expiresAt: { gt: at },
    };

    const [records, total] = await Promise.all([
      this.prisma.session.findMany({
        where,
        orderBy: ADMIN_SESSION_ORDER,
        skip: filter.offset,
        take: filter.limit,
      }),
      this.prisma.session.count({ where }),
    ]);

    const items: AdminSessionRecord[] = [];
    for (const record of records) {
      const agent = agentsById.get(record.userId);
      // Defensive: a session whose owner vanished from the tenant is skipped.
      if (agent !== undefined) items.push({ session: mapSession(record), agent });
    }

    return { items, total };
  }

  /**
   * Revokes ONE live session of the tenant and returns the revoked row + owner.
   *
   * `null` is the single 404 answer for unknown, foreign, already revoked and
   * expired ids, so the caller never learns whether a foreign row exists. The
   * write is a conditional `updateMany` (`revoked_at IS NULL`), which makes two
   * concurrent revokes of the same device race-safe.
   */
  async revokeById(tenantId: string, id: string, at: Date): Promise<AdminSessionRecord | null> {
    const record = await this.prisma.session.findFirst({
      where: { id, tenantId, expiresAt: { gt: at } },
    });
    if (record === null) return null;

    const agent = await this.prisma.agent.findFirst({
      where: { id: record.userId, tenantId },
    });
    if (agent === null) return null;

    const updated = await this.prisma.session.updateMany({
      where: { id, tenantId, revokedAt: null, expiresAt: { gt: at } },
      data: { revokedAt: at },
    });
    if (updated.count === 0) return null;

    return {
      session: { ...mapSession(record), revokedAt: at },
      agent: mapAgent(agent),
    };
  }

  /** Agent rows + the two derived counters (two grouped queries, no N+1). */
  private async hydrate(records: Agent[], at: Date): Promise<AdminUserRecord[]> {
    if (records.length === 0) return [];

    const ids = records.map((record) => record.id);
    const [sessionCounts, lastSessions] = await Promise.all([
      this.prisma.session.groupBy({
        by: ['userId'],
        where: { userId: { in: ids }, revokedAt: null, expiresAt: { gt: at } },
        _count: { _all: true },
      }),
      this.prisma.session.groupBy({
        by: ['userId'],
        where: { userId: { in: ids } },
        _max: { createdAt: true },
      }),
    ]);

    const countsByUser = new Map<string, number>(
      sessionCounts.map((row) => [row.userId, row._count._all]),
    );
    const lastLoginByUser = new Map<string, Date>(
      lastSessions
        .filter((row) => row._max.createdAt !== null)
        .map((row) => [row.userId, row._max.createdAt as Date]),
    );

    return records.map((record) => ({
      agent: mapAgent(record),
      sessionsCount: countsByUser.get(record.id) ?? 0,
      lastLoginAt: lastLoginByUser.get(record.id) ?? null,
    }));
  }
}

export function createAdminUserRepository(prisma: PrismaClient): PrismaAdminUserRepository {
  return new PrismaAdminUserRepository(prisma);
}
