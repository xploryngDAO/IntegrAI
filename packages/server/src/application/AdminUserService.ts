import type {
  AgentRecord,
  AdminUserRecord,
  AdminUserListResult,
  AdminUserView,
  AuditActorContext,
  IAdminUserRepository,
  IAdminUserService,
  IAuditService,
  ICache,
  IClock,
  ILogger,
  ISessionRepository,
  UpdateAdminUserCommand,
} from '@sac/shared';
import { AppError, AUDIT_ACTIONS, NotFoundError } from '@sac/shared';

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
 *  - `revokeSessions` revokes the refresh sessions AND stamps the per-user
 *    access-token watermark, so live JWTs of the target die immediately.
 *
 * Every mutation is audited through the best-effort `AuditService`.
 */

export const ADMIN_USER_ERROR_CODES = {
  cannotModifySelf: 'CANNOT_MODIFY_SELF',
  lastAdminProtected: 'LAST_ADMIN_PROTECTED',
  cannotRevokeOwnSessions: 'CANNOT_REVOKE_OWN_SESSIONS',
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
}

export class AdminUserService implements IAdminUserService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly cache: ICache;
  private readonly adminUsers: IAdminUserRepository;
  private readonly sessions: ISessionRepository;
  private readonly audit: IAuditService | undefined;

  constructor(deps: AdminUserServiceDependencies) {
    this.logger = deps.logger.child({ component: 'AdminUserService' });
    this.clock = deps.clock;
    this.cache = deps.cache;
    this.adminUsers = deps.repos.adminUsers;
    this.sessions = deps.repos.sessions;
    this.audit = deps.audit;
  }

  /* ==================================================================== */
  /* List                                                                 */
  /* ==================================================================== */

  async list(tenantId: string): Promise<AdminUserListResult> {
    const rows = await this.adminUsers.listByTenant(tenantId, this.clock.now());
    return { items: rows.map(toAdminUserView), total: rows.length };
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
  /* Internals                                                            */
  /* ==================================================================== */

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
