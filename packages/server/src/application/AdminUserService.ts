import type {
  AdminOverview,
  AgentRecord,
  AgentRole,
  AdminSessionListQuery,
  AdminSessionListResult,
  AdminSessionRecord,
  AdminSessionView,
  AdminUserListFilter,
  AdminUserListQuery,
  AdminUserRecord,
  AdminUserListResult,
  AdminUserView,
  AuditActorContext,
  IAdminUserRepository,
  IAdminUserService,
  IAuditService,
  ICache,
  IClock,
  IEmailService,
  ILogger,
  ISessionRepository,
  ITenantRepository,
  UpdateAdminUserCommand,
} from '@sac/shared';
import {
  ADMIN_SESSIONS_DEFAULT_PER_PAGE,
  ADMIN_SESSIONS_MAX_PER_PAGE,
  ADMIN_USERS_DEFAULT_PER_PAGE,
  ADMIN_USERS_EXPORT_MAX_ROWS,
  ADMIN_USERS_MAX_PER_PAGE,
  AppError,
  AUDIT_ACTIONS,
  NotFoundError,
  redactPiiForLogs,
} from '@sac/shared';

import { setUserRevocationWatermark } from './auth/access-token-revocation';

/**
 * ============================================================================
 * AdminUserService - workspace team administration (ADMIN only)
 * ============================================================================
 *
 * Guards live here, not only in the HTTP layer, so a future caller (worker,
 * CLI) cannot bypass them:
 *
 *  - every target is re-read and must belong to the caller's tenant, otherwise
 *    404 (never 403: the API does not reveal that a foreign row exists);
 *  - an ADMIN cannot change its own role/active flag (`409 CANNOT_MODIFY_SELF`);
 *  - the last ACTIVE ADMIN can neither be demoted nor deactivated
 *    (`409 LAST_ADMIN_PROTECTED`);
 *  - an ADMIN cannot bulk-revoke its own sessions
 *    (`409 CANNOT_REVOKE_OWN_SESSIONS`) — `POST /auth/logout` is the endpoint
 *    for that, and it also closes the current refresh session;
 *  - an ADMIN cannot revoke the exact session that issued its own access token
 *    (`409 CANNOT_REVOKE_CURRENT_SESSION`) — same reason, and the console list
 *    flags that row with `current: true`;
 *  - `revokeSessions` revokes the refresh sessions AND stamps the per-user
 *    access-token watermark, so live JWTs of the target die immediately.
 *
 * Every mutation is audited through the best-effort `AuditService`.
 *
 * An effective role/active-flag change also e-mails the AFFECTED operator (never
 * the actor) through the best-effort `IEmailService`: the response never waits
 * for the relay and a delivery failure is only logged.
 */

export const ADMIN_USER_ERROR_CODES = {
  cannotModifySelf: 'CANNOT_MODIFY_SELF',
  lastAdminProtected: 'LAST_ADMIN_PROTECTED',
  cannotRevokeOwnSessions: 'CANNOT_REVOKE_OWN_SESSIONS',
  cannotRevokeCurrentSession: 'CANNOT_REVOKE_CURRENT_SESSION',
} as const;

export interface AdminUserServiceDependencies {
  logger: ILogger;
  clock: IClock;
  cache: ICache;
  repos: {
    adminUsers: IAdminUserRepository;
    sessions: ISessionRepository;
  };
  /** Optional only so legacy unit harnesses keep compiling. */
  audit?: IAuditService;
  /** Optional only so legacy unit harnesses keep compiling (no SMTP needed). */
  email?: IEmailService;
  /** Workspace display name for the alert body; optional for the same reason. */
  tenants?: ITenantRepository;
}

export class AdminUserService implements IAdminUserService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly cache: ICache;
  private readonly adminUsers: IAdminUserRepository;
  private readonly sessions: ISessionRepository;
  private readonly audit: IAuditService | undefined;
  private readonly email: IEmailService | undefined;
  private readonly tenants: ITenantRepository | undefined;

  constructor(deps: AdminUserServiceDependencies) {
    this.logger = deps.logger.child({ component: 'AdminUserService' });
    this.clock = deps.clock;
    this.cache = deps.cache;
    this.adminUsers = deps.repos.adminUsers;
    this.sessions = deps.repos.sessions;
    this.audit = deps.audit;
    this.email = deps.email;
    this.tenants = deps.tenants;
  }

  /* ==================================================================== */
  /* Workspace overview                                                   */
  /* ==================================================================== */

  /**
   * Aggregated snapshot of the caller workspace (`GET /admin/overview`).
   *
   * The tenant is always the JWT one (never client-controlled) and the reference
   * instant is the injected clock, so "active session" / "pending invitation" /
   * "last 24h audit" share one consistent `now`.
   */
  async overview(tenantId: string): Promise<AdminOverview> {
    return this.adminUsers.overview(tenantId, this.clock.now());
  }

  /* ==================================================================== */
  /* List                                                                 */
  /* ==================================================================== */

  /**
   * Filtered, paginated team list. `total` counts the FILTERED set (used by the
   * UI to compute the number of pages) and the order is `createdAt` ascending
   * with `id` as a deterministic tiebreaker (both at the database and in the
   * in-memory doubles).
   */
  async list(tenantId: string, query: AdminUserListQuery = {}): Promise<AdminUserListResult> {
    const page = clampInteger(query.page, 1, Number.MAX_SAFE_INTEGER, 1);
    const perPage = clampInteger(
      query.perPage,
      1,
      ADMIN_USERS_MAX_PER_PAGE,
      ADMIN_USERS_DEFAULT_PER_PAGE,
    );

    const { items, total } = await this.adminUsers.listFiltered(
      buildListFilter(tenantId, query, (page - 1) * perPage, perPage),
      this.clock.now(),
    );

    return { items: items.map(toAdminUserView), total, page, perPage };
  }

  /**
   * CSV export read: same tenant scope/filters as `list`, no pagination and
   * hard-capped at `ADMIN_USERS_EXPORT_MAX_ROWS` (10k) so a huge workspace
   * cannot exhaust the API memory.
   */
  async exportRows(
    tenantId: string,
    query: AdminUserListQuery = {},
    limit: number = ADMIN_USERS_EXPORT_MAX_ROWS,
  ): Promise<AdminUserView[]> {
    const rows = clampInteger(limit, 1, ADMIN_USERS_EXPORT_MAX_ROWS, ADMIN_USERS_EXPORT_MAX_ROWS);
    const { items } = await this.adminUsers.listFiltered(
      buildListFilter(tenantId, query, 0, rows),
      this.clock.now(),
    );
    return items.map(toAdminUserView);
  }

  /* ==================================================================== */
  /* Update role / active flag                                            */
  /* ==================================================================== */

  async update(
    tenantId: string,
    actor: AuditActorContext,
    userId: string,
    command: UpdateAdminUserCommand,
  ): Promise<AdminUserView> {
    const target = await this.requireTenantUser(tenantId, userId);

    if (target.id === actor.id) {
      throw new AppError(
        ADMIN_USER_ERROR_CODES.cannotModifySelf,
        'An administrator cannot change its own role or active status',
        409,
        { userId: target.id },
      );
    }

    const roleChanged = command.role !== undefined && command.role !== target.role;
    const activeChanged = command.isActive !== undefined && command.isActive !== target.isActive;

    // Snapshot the previous values BEFORE the write: a repository that returns
    // the same row object (in-memory doubles) would otherwise mutate `target`
    // and make the audit diff report the new role as the old one.
    const previousRole = target.role;
    const previousActive = target.isActive;

    // No-op PATCH: answer the current projection instead of writing/auditing.
    if (!roleChanged && !activeChanged) {
      return this.projectOne(tenantId, target.id);
    }

    // Last-admin guard. Only an ACTIVE ADMIN losing the ADMIN role or being
    // deactivated can leave the workspace without an administrator.
    const demotingAdmin = target.role === 'ADMIN' && roleChanged && command.role !== 'ADMIN';
    const deactivatingAdmin = target.role === 'ADMIN' && target.isActive && command.isActive === false;
    if (demotingAdmin || deactivatingAdmin) {
      const activeAdmins = await this.adminUsers.countActiveAdmins(tenantId);
      if (activeAdmins <= 1) {
        throw new AppError(
          ADMIN_USER_ERROR_CODES.lastAdminProtected,
          'The last active administrator of the workspace cannot be demoted or deactivated',
          409,
          { userId: target.id, activeAdmins },
        );
      }
    }

    const updated = await this.adminUsers.update(target.id, {
      ...(roleChanged ? { role: command.role } : {}),
      ...(activeChanged ? { isActive: command.isActive } : {}),
    });

    if (roleChanged) {
      this.audit?.record({
        action: AUDIT_ACTIONS.adminUserRoleChanged,
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        resourceType: 'user',
        resourceId: updated.id,
        metadata: { from: previousRole, to: updated.role },
      });
    }

    if (activeChanged) {
      this.audit?.record({
        action:
          updated.isActive === true
            ? AUDIT_ACTIONS.adminUserActivated
            : AUDIT_ACTIONS.adminUserDeactivated,
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        resourceType: 'user',
        resourceId: updated.id,
        metadata: { isActive: updated.isActive, previousIsActive: previousActive },
      });
    }

    this.logger.info('admin.user.updated', {
      tenantId,
      actorId: actor.id,
      userId: updated.id,
      roleChanged,
      activeChanged,
      isActive: updated.isActive,
      role: updated.role,
    });

    // Best effort, fire-and-forget: the change is already persisted and audited,
    // so the HTTP response never waits for (nor fails with) the relay.
    this.notifyAccountChanges({
      tenantId,
      actor,
      target: updated,
      previousRole,
      roleChanged,
      activeChanged,
    });

    return this.projectOne(tenantId, updated.id);
  }

  /* ==================================================================== */
  /* Bulk session revocation                                              */
  /* ==================================================================== */

  async revokeSessions(
    tenantId: string,
    actor: AuditActorContext,
    userId: string,
  ): Promise<{ revoked: number }> {
    const target = await this.requireTenantUser(tenantId, userId);

    if (target.id === actor.id) {
      throw new AppError(
        ADMIN_USER_ERROR_CODES.cannotRevokeOwnSessions,
        'Use the logout/session endpoints to end your own sessions',
        409,
        { userId: target.id },
      );
    }

    const now = this.clock.now();
    const revoked = await this.sessions.revokeAllForUser(target.id, now);

    // Refresh sessions alone would leave a stateless JWT usable until `exp`.
    // Best effort by contract: a Redis outage must not fail the operation.
    await setUserRevocationWatermark({
      userId: target.id,
      cache: this.cache,
      logger: this.logger,
      at: now,
    });

    this.audit?.record({
      action: AUDIT_ACTIONS.adminUserSessionsRevoked,
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      resourceType: 'user',
      resourceId: target.id,
      metadata: { revoked },
    });

    this.logger.info('admin.user.sessions_revoked', {
      tenantId,
      actorId: actor.id,
      userId: target.id,
      revoked,
    });

    return { revoked };
  }

  /* ==================================================================== */
  /* Workspace sessions                                                   */
  /* ==================================================================== */

  /**
   * LIVE sessions of the workspace (`revokedAt IS NULL` and `expiresAt > now`),
   * tenant-scoped by the JWT and ordered by last use (nulls last) then creation.
   *
   * `total` is the live set, not the page. `current` is derived from the
   * access-token `sid` claim: a legacy token without `sid` marks no row.
   */
  async listSessions(
    tenantId: string,
    query: AdminSessionListQuery = {},
    currentSessionId?: string,
  ): Promise<AdminSessionListResult> {
    const page = clampInteger(query.page, 1, Number.MAX_SAFE_INTEGER, 1);
    const perPage = clampInteger(
      query.perPage,
      1,
      ADMIN_SESSIONS_MAX_PER_PAGE,
      ADMIN_SESSIONS_DEFAULT_PER_PAGE,
    );

    const { items, total } = await this.adminUsers.listAtivasByTenant(
      { tenantId, offset: (page - 1) * perPage, limit: perPage },
      this.clock.now(),
    );

    return { items: items.map((row) => toAdminSessionView(row, currentSessionId)), total };
  }

  /**
   * Revokes ONE session of the workspace.
   *
   * The current session is refused BEFORE touching the store: closing the
   * device that issued the caller's own access token is a logout, not an
   * administrative action, and doing it here would leave a valid JWT behind.
   * Every other target is revoked conditionally (`revokedAt IS NULL`), so an
   * already-revoked/unknown/foreign row is the same 404.
   */
  async revokeSession(
    tenantId: string,
    actor: AuditActorContext,
    sessionId: string,
    currentSessionId?: string,
  ): Promise<void> {
    if (currentSessionId !== undefined && sessionId === currentSessionId) {
      throw new AppError(
        ADMIN_USER_ERROR_CODES.cannotRevokeCurrentSession,
        'Use the logout/session endpoints to end your own current session',
        409,
        { sessionId },
      );
    }

    const target = await this.adminUsers.revokeById(tenantId, sessionId, this.clock.now());
    if (target === null) throw new NotFoundError('Session', sessionId);

    // The operator e-mail is PII: it is masked here AND scrubbed again by
    // `AuditService` before the metadata reaches the database/logs.
    this.audit?.record({
      action: AUDIT_ACTIONS.adminSessionRevoked,
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      resourceType: 'session',
      resourceId: target.session.id,
      metadata: {
        agentEmail: redactPiiForLogs(target.agent.email),
        targetAgentId: target.agent.id,
      },
    });

    this.logger.info('admin.session.revoked', {
      tenantId,
      actorId: actor.id,
      sessionId: target.session.id,
      targetAgentId: target.agent.id,
    });
  }

  /* ==================================================================== */
  /* Internals                                                            */
  /* ==================================================================== */

  /**
   * Schedules the account-change e-mails (never awaited).
   *
   * Contract:
   *  - fire-and-forget: the response/audit row are already produced, so a slow
   *    or broken relay can never delay or fail the administrative operation;
   *  - the recipient is the AFFECTED operator, never the actor. A self-change is
   *    already refused above; the guard is kept so relaxing that rule can never
   *    e-mail the person who performed the change;
   *  - at most one message per dimension that effectively changed.
   */
  private notifyAccountChanges(input: {
    tenantId: string;
    actor: AuditActorContext;
    target: AgentRecord;
    previousRole: AgentRole;
    roleChanged: boolean;
    activeChanged: boolean;
  }): void {
    if (this.email === undefined) return;
    if (input.target.id === input.actor.id) return;

    // `deliverAccountChangeEmails` swallows every failure, so this promise never
    // rejects (same pattern as the new-device login alert).
    void this.deliverAccountChangeEmails(input);
  }

  private async deliverAccountChangeEmails(input: {
    tenantId: string;
    actor: AuditActorContext;
    target: AgentRecord;
    previousRole: AgentRole;
    roleChanged: boolean;
    activeChanged: boolean;
  }): Promise<void> {
    const email = this.email;
    if (email === undefined) return;

    try {
      const tenantName = await this.resolveTenantName(input.tenantId);
      // Unknown actor e-mail is rendered as "um administrador" by the template.
      const changedBy = input.actor.email ?? null;
      const recipient = {
        to: input.target.email,
        name: input.target.name,
        changedBy,
        tenantName,
      };

      if (input.roleChanged) {
        await email.sendRoleChangedAlert({
          ...recipient,
          previousRole: input.previousRole,
          newRole: input.target.role,
        });
      }

      if (input.activeChanged) {
        if (input.target.isActive) {
          await email.sendAccountReactivatedAlert(recipient);
        } else {
          await email.sendAccountDeactivatedAlert(recipient);
        }
      }
    } catch (error) {
      // Best effort: the mutation already succeeded, so this only warns. No
      // token/link is involved; identifiers are the ones already in the log.
      this.logger.warn('admin.user.account_alert_failed', {
        tenantId: input.tenantId,
        userId: input.target.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Workspace display name for the alert body; never fatal. */
  private async resolveTenantName(tenantId: string): Promise<string | null> {
    if (this.tenants === undefined) return null;
    try {
      const tenant = await this.tenants.findById(tenantId);
      return tenant?.name ?? null;
    } catch (error) {
      this.logger.warn('admin.user.account_alert_tenant_lookup_failed', {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Tenant boundary: an id from another workspace is a 404, never a 403. */
  private async requireTenantUser(tenantId: string, userId: string): Promise<AgentRecord> {
    const agent = await this.adminUsers.findById(userId);
    if (agent === null || agent.tenantId !== tenantId) {
      throw new NotFoundError('User', userId);
    }
    return agent;
  }

  /** Re-reads the tenant list so the response carries the fresh counters. */
  private async projectOne(tenantId: string, userId: string): Promise<AdminUserView> {
    const rows = await this.adminUsers.listByTenant(tenantId, this.clock.now());
    const row = rows.find((entry) => entry.agent.id === userId);
    if (row === undefined) throw new NotFoundError('User', userId);
    return toAdminUserView(row);
  }
}

function toAdminUserView(row: AdminUserRecord): AdminUserView {
  return {
    id: row.agent.id,
    name: row.agent.name,
    email: row.agent.email,
    role: row.agent.role,
    isActive: row.agent.isActive,
    lastLoginAt: row.lastLoginAt !== null ? row.lastLoginAt.toISOString() : null,
    createdAt: row.agent.createdAt.toISOString(),
    sessionsCount: row.sessionsCount,
  };
}

function toAdminSessionView(
  row: AdminSessionRecord,
  currentSessionId?: string,
): AdminSessionView {
  return {
    id: row.session.id,
    agentId: row.agent.id,
    name: row.agent.name,
    email: row.agent.email,
    role: row.agent.role,
    ip: row.session.ip,
    userAgent: row.session.userAgent,
    createdAt: row.session.createdAt.toISOString(),
    lastUsedAt: row.session.lastUsedAt !== null ? row.session.lastUsedAt.toISOString() : null,
    current: currentSessionId !== undefined && row.session.id === currentSessionId,
  };
}

/**
 * Tenant is always the first, non-overridable field; the optional filters are
 * only added when present so the repository can build a minimal `where`.
 */
function buildListFilter(
  tenantId: string,
  query: AdminUserListQuery,
  offset: number,
  limit: number,
): AdminUserListFilter {
  const filter: AdminUserListFilter = { tenantId, offset, limit };
  const search = query.search?.trim();
  if (search !== undefined && search.length > 0) filter.search = search;
  if (query.role !== undefined) filter.role = query.role;
  if (query.status !== undefined) filter.status = query.status;
  return filter;
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
