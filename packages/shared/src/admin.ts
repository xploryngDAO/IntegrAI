import type { AgentRecord } from './dto';
import type { AgentRole } from './enums';

/**
 * ============================================================================
 * Administrative surface: audit trail + workspace user management
 * ============================================================================
 *
 * The UI consumes these shapes verbatim (`apps/web/src/lib/types.ts`):
 *
 *   GET   /api/v1/admin/users               -> AdminUserListResult
 *   PATCH /api/v1/admin/users/:id           -> AdminUserView
 *   POST  /api/v1/admin/users/:id/revoke-sessions -> { revoked }
 *   GET   /api/v1/admin/invitations         -> AdminInvitationListResult
 *   DELETE /api/v1/admin/invitations/:id    -> 204
 *   GET   /api/v1/admin/audit-logs          -> AuditLogPage
 *   GET   /api/v1/admin/audit-logs/export.csv -> text/csv attachment
 *   GET   /api/v1/auth/sessions             -> { items: UserSessionView[] }
 *   POST  /api/v1/auth/sessions/revoke-others -> { revoked }
 *
 * Every `*At` field in the HTTP contract is an ISO-8601 string; the application
 * layer maps the `Date` columns before the response leaves the controller.
 */

/* ==========================================================================
 * Audit actions (stable codes, never rendered raw by the UI when known)
 * ========================================================================== */

/**
 * Minimum catalogue required by the administrative audit contract. Extra action
 * codes are allowed (the column is a plain varchar) but these are the ones the
 * product currently emits and the UI knows how to label.
 */
export const AUDIT_ACTIONS = {
  loginSuccess: 'auth.login.success',
  loginFailure: 'auth.login.failure',
  logout: 'auth.logout',
  passwordResetCompleted: 'auth.password.reset_completed',
  twoFactorEnabled: 'auth.2fa.enabled',
  twoFactorDisabled: 'auth.2fa.disabled',
  profileUpdated: 'auth.profile.updated',
  invitationCreated: 'invitation.created',
  invitationAccepted: 'invitation.accepted',
  invitationRevoked: 'invitation.revoked',
  /** ADMIN console re-issue of a PENDING/EXPIRED invite (new token + TTL). */
  invitationResent: 'invitation.resent',
  adminUserRoleChanged: 'admin.user.role_changed',
  adminUserActivated: 'admin.user.activated',
  adminUserDeactivated: 'admin.user.deactivated',
  adminUserSessionsRevoked: 'admin.user.sessions_revoked',
  tenantSsoUpdated: 'tenant.sso.updated',
  tenantSsoDeleted: 'tenant.sso.deleted',
  billingWebhookProcessed: 'billing.webhook.processed',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Hard cap of the audit/team endpoints; the request is rejected above it. */
export const AUDIT_MAX_PER_PAGE = 100;
export const AUDIT_DEFAULT_PER_PAGE = 25;

/**
 * Hard cap of `GET /admin/audit-logs/export.csv`. The export is a bounded
 * snapshot (no pagination): the newest 10k matching rows are written and the
 * response stays memory-safe regardless of the tenant history size.
 */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

/* ==========================================================================
 * Audit trail
 * ========================================================================== */

/**
 * Request provenance attached to an auditable action. Only `id` is mandatory
 * (some actions are emitted by background/system flows that have no operator).
 */
export interface AuditActorContext {
  id: string;
  email?: string | null;
  tenantId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Best-effort write model accepted by `AuditService.record`. */
export interface AuditEventInput {
  /** Stable action code; an unknown value is stored as-is. */
  action: string;
  tenantId?: string | null;
  actorId?: string | null;
  /** Full e-mail is allowed by the contract; sensitive metadata is scrubbed. */
  actorEmail?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Free-form payload; sensitive keys are removed before persisting. */
  metadata?: Record<string, unknown>;
}

/** Normalized row the repository persists (metadata already scrubbed). */
export interface CreateAuditEventInput {
  action: string;
  tenantId: string | null;
  actorId: string | null;
  actorEmail: string | null;
  resourceType: string | null;
  resourceId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

/** Persisted audit row (`created_at` stays a `Date` in the application layer). */
export interface AuditEventRecord {
  id: string;
  tenantId: string | null;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/** Wire projection of one audit row. */
export interface AuditEventView {
  id: string;
  tenantId: string | null;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * Filters of `GET /admin/audit-logs`. `from`/`to` are parsed by the HTTP layer
 * from ISO-8601 strings; `page` is 1-based and `perPage` is capped at
 * `AUDIT_MAX_PER_PAGE`.
 */
export interface AuditLogQuery {
  action?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  page?: number;
  perPage?: number;
}

/** Repository query (tenant is always injected from the JWT, never the client). */
export interface AuditListFilter {
  tenantId: string;
  action?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  offset: number;
  limit: number;
}

export interface AuditLogPage {
  items: AuditEventView[];
  page: number;
  perPage: number;
  total: number;
}

export interface IAuditEventRepository {
  create(input: CreateAuditEventInput): Promise<void>;
  list(filter: AuditListFilter): Promise<{ items: AuditEventRecord[]; total: number }>;
}

/**
 * Audit writer/reader.
 *
 * `record` is BEST EFFORT: it never throws, never awaits the caller and logs a
 * warning when the persistence fails (an audit outage must not break a login or
 * an administrative action). `flush` exists for tests and graceful shutdown.
 */
export interface IAuditService {
  record(input: AuditEventInput): void;
  list(tenantId: string, query?: AuditLogQuery): Promise<AuditLogPage>;
  /**
   * Flat, capped read used by `GET /admin/audit-logs/export.csv`.
   *
   * Applies the same tenant scope/filters as `list` (newest first) but without
   * pagination, returning at most `limit` rows; the limit is hard-capped at
   * `AUDIT_EXPORT_MAX_ROWS`.
   */
  exportRows(
    tenantId: string,
    query?: AuditLogQuery,
    limit?: number,
  ): Promise<AuditEventView[]>;
  /** Resolves once every queued write settled (never rejects). */
  flush(): Promise<void>;
}

/* ==========================================================================
 * Workspace users (`/admin/users`)
 * ========================================================================== */

/** One operator row of `GET /admin/users` (ISO-8601 instants). */
export interface AdminUserView {
  id: string;
  name: string;
  email: string;
  role: AgentRole;
  isActive: boolean;
  /** Last time a session was opened for this operator (login or refresh). */
  lastLoginAt: string | null;
  createdAt: string;
  /** Live refresh sessions (`revoked_at IS NULL` and not expired). */
  sessionsCount: number;
}

export interface AdminUserListResult {
  items: AdminUserView[];
  total: number;
}

export interface UpdateAdminUserCommand {
  role?: AgentRole;
  isActive?: boolean;
}

/** Application projection: agent row + the two derived counters. */
export interface AdminUserRecord {
  agent: AgentRecord;
  sessionsCount: number;
  lastLoginAt: Date | null;
}

export interface IAdminUserRepository {
  /** Tenant-scoped, ordered by `created_at` ascending; counters derived here. */
  listByTenant(tenantId: string, at: Date): Promise<AdminUserRecord[]>;
  findById(id: string): Promise<AgentRecord | null>;
  update(id: string, patch: { role?: AgentRole; isActive?: boolean }): Promise<AgentRecord>;
  /** Active ADMINs of the workspace (last-admin guard). */
  countActiveAdmins(tenantId: string): Promise<number>;
}

/**
 * Workspace administration.
 *
 * Guards enforced in the service (not only at the HTTP layer):
 *  - every target is re-read and must belong to the caller tenant (404);
 *  - an ADMIN can never change its own role/active flag (409);
 *  - the last ACTIVE ADMIN of the workspace can neither be demoted nor
 *    deactivated (409);
 *  - revoking sessions of the caller itself is refused (409) — logout is the
 *    endpoint for that, and it keeps the caller's own session intact by mistake
 *    impossible.
 */
export interface IAdminUserService {
  list(tenantId: string): Promise<AdminUserListResult>;
  update(
    tenantId: string,
    actor: AuditActorContext,
    userId: string,
    command: UpdateAdminUserCommand,
  ): Promise<AdminUserView>;
  /** Bulk access-token revocation + refresh-session revocation of one target. */
  revokeSessions(
    tenantId: string,
    actor: AuditActorContext,
    userId: string,
  ): Promise<{ revoked: number }>;
}

/* ==========================================================================
 * Invitations (`/admin/invitations`)
 * ========================================================================== */

/** Console status: derived from `acceptedAt` and `expiresAt` vs. "now". */
export type AdminInvitationStatus = 'PENDING' | 'EXPIRED' | 'ACCEPTED';

/** One invite row of `GET /admin/invitations` (ISO-8601 instants). */
export interface AdminInvitationView {
  id: string;
  email: string;
  role: AgentRole;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  status: AdminInvitationStatus;
}

export interface AdminInvitationListResult {
  items: AdminInvitationView[];
  /** Total rows of the caller tenant (`items.length`, no pagination). */
  total: number;
}

/* ==========================================================================
 * Operator sessions (`/auth/sessions`)
 * ========================================================================== */

/** One live refresh session of the authenticated operator. */
export interface UserSessionView {
  id: string;
  /** ISO instant the session was opened. */
  createdAt: string;
  /** ISO instant of the last rotation, or null when never refreshed. */
  lastUsedAt: string | null;
  userAgent: string | null;
  ip: string | null;
  /** True for the session that issued the access token of the request. */
  current: boolean;
}

export interface RevokeSessionResult {
  /** False when there was nothing left to revoke (idempotent delete). */
  revoked: boolean;
  /** True when the revoked session is the one that issued the access token. */
  current: boolean;
}
