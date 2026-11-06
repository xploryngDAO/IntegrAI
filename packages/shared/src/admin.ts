import type { AgentRecord, SessionRecord } from './dto';
import type { AgentRole, Marketplace } from './enums';

/**
 * ============================================================================
 * Administrative surface: audit trail + workspace user management
 * ============================================================================
 *
 * The UI consumes these shapes verbatim (`apps/web/src/lib/types.ts`):
 *
 *   GET   /api/v1/admin/overview            -> AdminOverview
 *   GET   /api/v1/admin/users               -> AdminUserListResult
 *   PATCH /api/v1/admin/users/:id           -> AdminUserView
 *   POST  /api/v1/admin/users/:id/revoke-sessions -> { revoked }
 *   POST  /api/v1/admin/users/:id/reset-2fa -> AdminUserTwoFactorResetResult
 *   GET   /api/v1/admin/invitations         -> AdminInvitationListResult
 *   DELETE /api/v1/admin/invitations/:id    -> 204
 *   GET   /api/v1/admin/sessions            -> AdminSessionListResult
 *   DELETE /api/v1/admin/sessions/:id       -> 204
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
  /**
   * Successful password/SSO login from a device fingerprint (IP + user-agent)
   * never seen for that operator in the last 90 days. The e-mail in the row is
   * redacted: the alert itself is delivered to the operator's inbox.
   */
  loginNewDevice: 'auth.login.new_device',
  logout: 'auth.logout',
  passwordResetCompleted: 'auth.password.reset_completed',
  twoFactorEnabled: 'auth.2fa.enabled',
  twoFactorDisabled: 'auth.2fa.disabled',
  /**
   * Operator enrolled TOTP through the ENFORCED login flow (workspace policy
   * `require_2fa`). Metadata carries `method: 'enforced_login'`; the regular
   * self-service enrollment keeps emitting `auth.2fa.enabled`.
   */
  twoFactorEnrolled: 'auth.2fa.enrolled',
  /** ADMIN changed the workspace `require_2fa` policy (before/after metadata). */
  tenant2faPolicyChanged: 'tenant.2fa_policy_changed',
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
  /**
   * ADMIN reset the TOTP factor of an operator who lost the authenticator (a
   * workspace with the `require_2fa` policy would otherwise lock them out).
   *
   * The row records WHO reset WHICH operator: the e-mail is masked and neither
   * the TOTP secret nor a recovery code ever reaches the metadata. The reset
   * also revokes the target sessions, so the next sign-in starts from scratch.
   */
  adminUser2faReset: 'admin.user.2fa_reset',
  /** ADMIN console revoked ONE session of another operator (`/admin/sessions`). */
  adminSessionRevoked: 'admin.session.revoked',
  /**
   * ADMIN downloaded the workspace team CSV (`GET /admin/users/export.csv`).
   *
   * Accountability/LGPD: the row records WHO exported, WHICH filters were
   * applied and HOW MANY rows were written — never the exported rows themselves
   * (the metadata carries no operator e-mail; `search` is redacted).
   */
  adminUsersExported: 'admin.users.exported',
  /**
   * ADMIN downloaded the audit trail CSV (`GET /admin/audit-logs/export.csv`).
   *
   * Reading the trail is itself auditable: the row proves which slice was taken
   * (`action`/`actorId`/`from`/`to`) and how many events left the system.
   */
  adminAuditExported: 'admin.audit.exported',
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

/**
 * Metadata of the auditable CSV exports (`admin.users.exported` and
 * `admin.audit.exported`), written by the download handlers after the CSV is
 * assembled.
 *
 * Contract:
 *  - `filters` only carries the filters the ADMIN actually applied: an
 *    unfiltered export omits the key entirely instead of storing `{}`;
 *  - every filter value is a string (ISO-8601 for `from`/`to`) and a user
 *    `search` is PII-redacted before it reaches the metadata;
 *  - `rowCount` is the number of DATA rows written, header excluded;
 *  - the exported rows themselves are never part of the metadata.
 */
export type ExportAuditMetadata = {
  filters?: Record<string, string>;
  rowCount: number;
  format: 'csv';
};

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
 * Workspace overview (`/admin/overview`)
 * ========================================================================== */

/**
 * Aggregated snapshot of the caller workspace.
 *
 * Every number is tenant-scoped by the JWT: the service never accepts a tenant
 * id from the client, and the repository derives all counters with
 * `count`/`groupBy` aggregates (no per-row N+1). The "now" instant comes from
 * the injected `IClock`, so the live/pending predicates are deterministic.
 *
 * Definitions (they mirror the SQL emitted by the repository):
 *  - `users.active` -> `agents.is_active = true`;
 *  - `users.admins` -> `agents.role = 'ADMIN'` AND `agents.is_active = true`;
 *  - `sessions.active` -> `revoked_at IS NULL` AND `expires_at > now`;
 *  - `invitations.pending` -> `accepted_at IS NULL` AND `expires_at > now`;
 *  - `accounts.connected` -> `status = 'ACTIVE'`;
 *  - `accounts.byMarketplace` -> the three real marketplaces, ALWAYS present and
 *    zero-filled; each value counts the workspace accounts of that marketplace
 *    regardless of status (i.e. it partitions `accounts.total`);
 *  - `tickets.unread` -> `status = 'UNREAD'`;
 *  - `tickets.unassigned` -> `assigned_agent_id IS NULL` and the ticket is not
 *    terminal. The schema has no `CLOSED`: the terminal statuses are
 *    `NO_RESPONSE_NEEDED` and `RESOLVED` (`TERMINAL_TICKET_STATUSES`);
 *  - `audit.last24h` -> audit rows created at/after `now - 24h`.
 */
export interface AdminOverview {
  users: {
    total: number;
    active: number;
    admins: number;
  };
  sessions: {
    active: number;
  };
  invitations: {
    pending: number;
  };
  accounts: {
    total: number;
    connected: number;
    byMarketplace: Record<Marketplace, number>;
  };
  tickets: {
    total: number;
    unread: number;
    unassigned: number;
  };
  audit: {
    last24h: number;
  };
}

/* ==========================================================================
 * Workspace users (`/admin/users`)
 * ========================================================================== */

/**
 * Pagination/filter defaults of `GET /admin/users`.
 *
 * `perPage` above the cap is a 422 (the HTTP schema rejects it) instead of a
 * silent truncation, exactly like `GET /admin/audit-logs`.
 */
export const ADMIN_USERS_DEFAULT_PER_PAGE = 25;
export const ADMIN_USERS_MAX_PER_PAGE = 100;

/** Longest accepted `search` term of `GET /admin/users` (chars, after trim). */
export const ADMIN_USER_SEARCH_MAX_LENGTH = 120;

/**
 * Hard cap of `GET /admin/users/export.csv`. The export is a bounded snapshot
 * (no pagination): at most the 10k oldest matching rows are written so the
 * response stays memory-safe regardless of the workspace size.
 */
export const ADMIN_USERS_EXPORT_MAX_ROWS = 10_000;

/**
 * Pagination of `GET /admin/sessions`.
 *
 * The console shows every live device of the workspace, so the default page is
 * larger than the team list (50) while the hard cap stays at 100 (a larger
 * `perPage` is a 422, never a silent truncation).
 */
export const ADMIN_SESSIONS_DEFAULT_PER_PAGE = 50;
export const ADMIN_SESSIONS_MAX_PER_PAGE = 100;

/** Derived status filter of `GET /admin/users` (maps to `is_active`). */
export type AdminUserStatus = 'ACTIVE' | 'INACTIVE';

/**
 * Query of `GET /admin/users`: optional filters plus 1-based pagination.
 *
 * The HTTP layer parses the raw strings with zod (`422` on invalid role/status/
 * page) and the service re-normalizes/clamps so other callers (worker, CLI)
 * cannot bypass the cap.
 */
export interface AdminUserListQuery {
  /** Case-insensitive substring of the name OR the e-mail (trimmed). */
  search?: string;
  role?: AgentRole;
  status?: AdminUserStatus;
  page?: number;
  perPage?: number;
}

/**
 * Repository query: tenant is ALWAYS injected from the JWT/actor, never from
 * the client. `offset`/`limit` are already resolved by the service.
 */
export interface AdminUserListFilter {
  tenantId: string;
  search?: string;
  role?: AgentRole;
  status?: AdminUserStatus;
  offset: number;
  limit: number;
}

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
  /**
   * True when the operator has an ACTIVE TOTP factor.
   *
   * The console only offers `POST /admin/users/:id/reset-2fa` on rows where
   * this is true: resetting a factor that does not exist is a 409
   * (`TWO_FACTOR_NOT_ENABLED`), never a silent no-op.
   */
  twoFactorEnabled: boolean;
}

export interface AdminUserListResult {
  items: AdminUserView[];
  /** Total rows matching the filters (NOT the page length). */
  total: number;
  page: number;
  perPage: number;
}

export interface UpdateAdminUserCommand {
  role?: AgentRole;
  isActive?: boolean;
}

/**
 * Result of `POST /admin/users/:id/reset-2fa`.
 *
 * `twoFactorEnabled` is always `false` after a successful reset (the TOTP
 * secret and every recovery code are wiped), so the console can update the row
 * without another round-trip.
 */
export interface AdminUserTwoFactorResetResult {
  id: string;
  twoFactorEnabled: false;
}

/** Application projection: agent row + the two derived counters. */
export interface AdminUserRecord {
  agent: AgentRecord;
  sessionsCount: number;
  lastLoginAt: Date | null;
}

/* --------------------------------------------------------------------------
 * Workspace sessions (`/admin/sessions`)
 * -------------------------------------------------------------------------- */

/**
 * Query of `GET /admin/sessions`: only 1-based pagination, always tenant-scoped
 * by the JWT. The service re-normalizes/clamps the values so a non-HTTP caller
 * cannot exceed `ADMIN_SESSIONS_MAX_PER_PAGE`.
 */
export interface AdminSessionListQuery {
  page?: number;
  perPage?: number;
}

/** Repository query: tenant is ALWAYS injected from the JWT, never the client. */
export interface AdminSessionListFilter {
  tenantId: string;
  offset: number;
  limit: number;
}

/**
 * One live session joined with the operator that owns it. The Prisma schema has
 * no relation between `sessions` and `agents`, so the repository resolves the
 * join explicitly (tenant's agent ids -> live sessions) and returns both rows.
 */
export interface AdminSessionRecord {
  session: SessionRecord;
  agent: AgentRecord;
}

/** Wire projection of one row of `GET /admin/sessions` (ISO-8601 instants). */
export interface AdminSessionView {
  id: string;
  agentId: string;
  name: string;
  email: string;
  role: AgentRole;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** True for the session that issued the access token of the request (`sid`). */
  current: boolean;
}

export interface AdminSessionListResult {
  items: AdminSessionView[];
  /** Total LIVE sessions of the workspace (NOT the page length). */
  total: number;
}

export interface IAdminUserRepository {
  /**
   * Tenant-scoped overview counters (`GET /admin/overview`). One aggregate
   * `count`/`groupBy` per concern; `at` is the injected clock instant used by
   * the live/pending predicates.
   */
  overview(tenantId: string, at: Date): Promise<AdminOverview>;
  /** Tenant-scoped, ordered by `created_at` ascending; counters derived here. */
  listByTenant(tenantId: string, at: Date): Promise<AdminUserRecord[]>;
  /**
   * Tenant-scoped filtered page (search/role/status) ordered by `created_at`
   * ascending with `id` as tiebreaker. `total` counts the FILTERED set.
   */
  listFiltered(
    filter: AdminUserListFilter,
    at: Date,
  ): Promise<{ items: AdminUserRecord[]; total: number }>;
  findById(id: string): Promise<AgentRecord | null>;
  update(id: string, patch: { role?: AgentRole; isActive?: boolean }): Promise<AgentRecord>;
  /** Active ADMINs of the workspace (last-admin guard). */
  countActiveAdmins(tenantId: string): Promise<number>;
  /**
   * LIVE sessions of the workspace joined with their operator, ordered by
   * `lastUsedAt` DESC NULLS LAST and then `createdAt` DESC. `total` counts the
   * whole live set (not the page) so the console can paginate.
   */
  listAtivasByTenant(
    filter: AdminSessionListFilter,
    at: Date,
  ): Promise<{ items: AdminSessionRecord[]; total: number }>;
  /**
   * Revokes ONE live session of the tenant and returns the revoked row joined
   * with its operator. `null` means "not found": unknown id, another tenant, or
   * an already revoked/expired session — the service never reveals which.
   */
  revokeById(tenantId: string, id: string, at: Date): Promise<AdminSessionRecord | null>;
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
 *    impossible;
 *  - resetting the 2FA factor of the caller itself is likewise refused (409) —
 *    `/settings` is the flow for the operator's own factor.
 */
export interface IAdminUserService {
  /** Aggregated, tenant-scoped snapshot of `GET /admin/overview`. */
  overview(tenantId: string): Promise<AdminOverview>;
  /** Filtered, paginated team list (tenant always comes from the JWT). */
  list(tenantId: string, query?: AdminUserListQuery): Promise<AdminUserListResult>;
  /**
   * CSV read used by `GET /admin/users/export.csv`: same filters/tenant scope
   * as `list`, ordered by `created_at` ascending, no pagination. Always bounded
   * by `ADMIN_USERS_EXPORT_MAX_ROWS` (10k).
   */
  exportRows(
    tenantId: string,
    query?: AdminUserListQuery,
    limit?: number,
  ): Promise<AdminUserView[]>;
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
  /**
   * Break-glass reset of one operator's TOTP factor (`POST /admin/users/:id/reset-2fa`).
   *
   * Guards (in the service, not only at the HTTP layer):
   *  - the target is re-read and must belong to the caller tenant (404);
   *  - an ADMIN cannot reset its own factor (409 `CANNOT_RESET_OWN_2FA`) — the
   *    self-service `/settings` flow is the endpoint for that;
   *  - a target without an ACTIVE factor is a 409 `TWO_FACTOR_NOT_ENABLED`
   *    (there is nothing to break, and a silent no-op would mislead the console).
   *
   * A successful reset wipes the TOTP secret AND every recovery code (one
   * repository transaction), revokes all refresh sessions of the target and
   * stamps its access-token watermark, so the operator must sign in again. The
   * role/active flag of the target and the actor's own account are untouched;
   * the action is audited as `admin.user.2fa_reset`.
   */
  resetTwoFactor(
    tenantId: string,
    actor: AuditActorContext,
    userId: string,
  ): Promise<AdminUserTwoFactorResetResult>;
  /**
   * LIVE sessions of the workspace, tenant-scoped and ordered by last use.
   * `currentSessionId` is the access-token `sid` claim: the matching row is the
   * only one flagged with `current: true` (a legacy token without `sid` simply
   * marks no row as current).
   */
  listSessions(
    tenantId: string,
    query?: AdminSessionListQuery,
    currentSessionId?: string,
  ): Promise<AdminSessionListResult>;
  /**
   * Revokes ONE session of the workspace.
   *
   * 404 for an unknown/foreign/already-revoked session (existence is never
   * disclosed), 409 `CANNOT_REVOKE_CURRENT_SESSION` when the target is the
   * session that issued the caller's own access token (logout is the endpoint
   * for that), and a best-effort `admin.session.revoked` audit row otherwise.
   */
  revokeSession(
    tenantId: string,
    actor: AuditActorContext,
    sessionId: string,
    currentSessionId?: string,
  ): Promise<void>;
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
