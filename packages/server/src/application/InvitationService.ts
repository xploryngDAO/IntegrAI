import bcrypt from 'bcryptjs';

import type {
  AcceptInvitationCommand,
  AcceptInvitationResult,
  AdminInvitationListResult,
  AdminInvitationStatus,
  AdminInvitationView,
  AgentRecord,
  AgentRole,
  AuditActorContext,
  CreateInvitationCommand,
  CreateInvitationResult,
  IAgentRepository,
  IAuditService,
  IAuthSessionService,
  IClock,
  IEmailService,
  IInvitationRepository,
  IInvitationService,
  ILogger,
  IPlanLimitService,
  InvitationRecord,
  InvitationStatus,
  InvitationSummary,
  IssuedSession,
  ITenantRepository,
  ResendInvitationActor,
  ResendInvitationResult,
  SessionDeviceInfo,
} from '@sac/shared';
import {
  AppError,
  AUDIT_ACTIONS,
  ConflictError,
  NotFoundError,
  ValidationError,
  redactPiiForLogs,
} from '@sac/shared';

import { hashToken, randomToken, signAccessToken } from './auth/access-token';
import { isUniqueConstraintViolation } from './repositories/errors';

/**
 * ============================================================================
 * InvitationService - operator invites (Fase 1, no 2FA)
 * ============================================================================
 *
 * An ADMIN invites an operator into its own tenant:
 *
 *  - `create` : validates the e-mail, refuses an address that already belongs
 *    to an operator (e-mail is globally unique) and upserts the invitation.
 *    A resend for the same `(tenant, e-mail)` regenerates the token and extends
 *    the TTL instead of duplicating the row. The raw 32-byte token only exists
 *    in the e-mail link; the database receives its SHA-256.
 *  - `list`   : tenant-scoped projection with `pending | accepted | expired`.
 *  - `revoke` : expires a still-pending invitation in place (single-use), 404
 *    when the row does not belong to the caller tenant.
 *  - `listForAdmin` / `revokeForAdmin`: ADMIN console projection (uppercase
 *    status) and the hard-delete revoke, audited as `invitation.revoked`.
 *  - `resendForAdmin`: ADMIN console re-issue of a PENDING/EXPIRED row with a
 *    NEW token and a fresh 7-day TTL, audited as `invitation.resent`. The
 *    e-mail is delivered BEFORE the row is written: a delivery failure answers
 *    502 `EMAIL_SEND_FAILED` and keeps the stored hash/expiry untouched (see
 *    `resendForAdmin` for the trade-off).
 *  - `accept` : public flow. The token proves ownership of the e-mail, so the
 *    new operator is created already verified, in the invitation tenant and
 *    with the invited role; a session (JWT + rotating refresh token) is opened
 *    right away so the SPA can enter without a second login.
 *
 * Failure paths use stable `AppError.code`s: `INVALID_INVITATION_TOKEN` (400),
 * `VALIDATION_ERROR` (422), `CONFLICT` (409) and `EMAIL_SEND_FAILED` (502).
 */

/** Fase 1 design: invitation links live 7 days (`docs/PHASE1_AUTH.md`). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITATION_TOKEN_BYTES = 32;
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 256;
const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;
const MIN_NAME_LENGTH = 1;
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;

const INVITABLE_ROLES: readonly AgentRole[] = ['AGENT', 'SUPERVISOR', 'ADMIN'];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeEmail(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return email.length > 0 && email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);
}

export interface InvitationServiceConfig {
  /** Preferred base for the invite link (the SPA that serves `/invite`). */
  webOrigin: string;
  /** Fallback base when `WEB_ORIGIN` is not configured. */
  appBaseUrl: string;
}

export interface InvitationServiceDependencies {
  logger: ILogger;
  clock: IClock;
  email: IEmailService;
  jwtSecret: string;
  jwtExpiresIn: string;
  config: InvitationServiceConfig;
  /** Optional: without it `accept` still returns the access JWT. */
  sessions?: IAuthSessionService;
  /**
   * Fase 4 quota gate (`max_agents`). Optional only for legacy unit harnesses;
   * the container always wires it, and without it invitations bypass the plan.
   */
  planLimits?: IPlanLimitService;
  /** Administrative audit trail (best effort). */
  audit?: IAuditService;
  repos: {
    invitations: IInvitationRepository;
    agents: IAgentRepository;
    tenants: ITenantRepository;
  };
}

export class InvitationService implements IInvitationService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly email: IEmailService;
  private readonly jwtSecret: string;
  private readonly jwtExpiresIn: string;
  private readonly config: InvitationServiceConfig;
  private readonly invitations: IInvitationRepository;
  private readonly agents: IAgentRepository;
  private readonly tenants: ITenantRepository;
  private readonly sessions: IAuthSessionService | undefined;
  private readonly planLimits: IPlanLimitService | undefined;
  private readonly audit: IAuditService | undefined;

  constructor(deps: InvitationServiceDependencies) {
    this.logger = deps.logger.child({ component: 'InvitationService' });
    this.clock = deps.clock;
    this.email = deps.email;
    this.jwtSecret = deps.jwtSecret;
    this.jwtExpiresIn = deps.jwtExpiresIn;
    this.config = deps.config;
    this.invitations = deps.repos.invitations;
    this.agents = deps.repos.agents;
    this.tenants = deps.repos.tenants;
    this.sessions = deps.sessions;
    this.planLimits = deps.planLimits;
    this.audit = deps.audit;

    if (!this.jwtSecret || this.jwtSecret.length < 16) {
      throw new Error('InvitationService requires a configured JWT_SECRET (min 16 chars)');
    }
  }

  /* ==================================================================== */
  /* Create / resend                                                      */
  /* ==================================================================== */

  async create(command: CreateInvitationCommand): Promise<CreateInvitationResult> {
    const email = normalizeEmail(command.email);
    const role = command.role;

    if (!isValidEmail(email)) {
      throw new ValidationError('A valid e-mail address is required', { field: 'email' });
    }
    if (!INVITABLE_ROLES.includes(role)) {
      throw new ValidationError('Unsupported invitation role', { field: 'role' });
    }

    // E-mail is unique globally (`agents.email`), so this single lookup covers
    // both "already in this tenant" and "already in another tenant".
    const existingOperator = await this.agents.findByEmail(email);
    if (existingOperator !== null) {
      throw new ConflictError('An operator with this e-mail already exists');
    }

    // Fase 4: a pending invitation reserves a seat. Without this check an ADMIN
    // at the limit could mail links that all fail on acceptance. A resend for an
    // address that is already pending is exempt (no second seat).
    await this.planLimits?.assertCanInviteAgent(command.actor.tenantId, { excludeEmail: email });

    const token = this.issueInvitationToken();
    const invitation = await this.invitations.upsert({
      tenantId: command.actor.tenantId,
      email,
      role,
      tokenHash: token.tokenHash,
      invitedBy: command.actor.id,
      expiresAt: token.expiresAt,
    });

    await this.sendInvitationEmailBestEffort(invitation, token.token, command.actor.name);

    this.logger.info('invitation.created', {
      invitationId: invitation.id,
      tenantId: invitation.tenantId,
      role: invitation.role,
      invitedBy: command.actor.id,
    });

    this.audit?.record({
      action: AUDIT_ACTIONS.invitationCreated,
      tenantId: invitation.tenantId,
      actorId: command.actor.id,
      actorEmail: command.actor.email ?? null,
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { role: invitation.role },
    });

    return {
      invitationId: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    };
  }

  /* ==================================================================== */
  /* List                                                                 */
  /* ==================================================================== */

  async list(tenantId: string): Promise<InvitationSummary[]> {
    const records = await this.invitations.listByTenant(tenantId);
    const now = this.clock.now();
    return records.map((record) => this.toSummary(record, now));
  }

  /* ==================================================================== */
  /* Revoke                                                               */
  /* ==================================================================== */

  async revoke(invitationId: string, tenantId: string): Promise<void> {
    if (!UUID_PATTERN.test((invitationId ?? '').trim())) {
      throw new NotFoundError('Invitation', invitationId);
    }

    const invitation = await this.invitations.findById(invitationId);
    // Cross-tenant ids are indistinguishable from unknown ids (no enumeration).
    if (invitation === null || invitation.tenantId !== tenantId) {
      throw new NotFoundError('Invitation', invitationId);
    }
    if (invitation.acceptedAt !== null) {
      throw new ConflictError('Invitation has already been accepted');
    }

    const now = this.clock.now();
    if (invitation.expiresAt.getTime() <= now.getTime()) {
      // Already expired: revoking is idempotent and keeps the endpoint simple.
      return;
    }

    const revoked = await this.invitations.revoke(invitation.id, tenantId, now);
    if (!revoked) {
      // A concurrent acceptance/revocation won the race.
      throw new ConflictError('Invitation is no longer pending');
    }

    this.logger.info('invitation.revoked', {
      invitationId: invitation.id,
      tenantId,
    });
  }

  /* ==================================================================== */
  /* ADMIN console (list + hard-delete revoke)                            */
  /* ==================================================================== */

  /**
   * Admin console projection: uppercase status, ISO instants and an explicit
   * `acceptedAt`. Always tenant-scoped and newest first.
   */
  async listForAdmin(tenantId: string): Promise<AdminInvitationListResult> {
    const records = await this.invitations.listByTenant(tenantId);
    const now = this.clock.now();
    const items = records
      .slice()
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
      )
      .map((record) => this.toAdminView(record, now));
    return { items, total: items.length };
  }

  /**
   * ADMIN revoke: hard-deletes a PENDING invitation of the caller tenant.
   *
   * Only a still-pending row is deleted (the link stops working because the row
   * is gone). An already accepted row answers 409 `INVITATION_ALREADY_ACCEPTED`
   * and an expired one is an idempotent no-op — neither is PENDING anymore.
   * Every effective deletion is audited as `invitation.revoked`.
   */
  async revokeForAdmin(
    tenantId: string,
    actor: AuditActorContext,
    invitationId: string,
  ): Promise<void> {
    if (!UUID_PATTERN.test((invitationId ?? '').trim())) {
      throw new NotFoundError('Invitation', invitationId);
    }

    const invitation = await this.invitations.findById(invitationId);
    // Cross-tenant ids are indistinguishable from unknown ids (no enumeration).
    if (invitation === null || invitation.tenantId !== tenantId) {
      throw new NotFoundError('Invitation', invitationId);
    }
    if (invitation.acceptedAt !== null) {
      throw this.alreadyAcceptedError();
    }

    const now = this.clock.now();
    if (invitation.expiresAt.getTime() <= now.getTime()) {
      // No longer PENDING: nothing to revoke, keep the endpoint idempotent.
      return;
    }

    const deleted = await this.invitations.deletePending(invitation.id, tenantId, now);
    if (!deleted) {
      // A concurrent acceptance/expiry won the race.
      throw this.alreadyAcceptedError();
    }

    this.logger.info('invitation.revoked', {
      invitationId: invitation.id,
      tenantId,
      actorId: actor.id,
    });

    this.audit?.record({
      action: AUDIT_ACTIONS.invitationRevoked,
      tenantId,
      actorId: actor.id,
      // The actor e-mail is a first-class audited column (full); the invitee
      // e-mail stays in metadata but is redacted before it reaches the store.
      actorEmail: actor.email ?? null,
      resourceType: 'invitation',
      resourceId: invitation.id,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        email: redactPiiForLogs(invitation.email),
        role: invitation.role,
      },
    });
  }

  /* ==================================================================== */
  /* ADMIN console - resend                                               */
  /* ==================================================================== */

  /**
   * ADMIN resend: rotates the single-use token of a PENDING **or EXPIRED**
   * invitation of the caller tenant and mails it through the exact same
   * template/link builder as `create`.
   *
   * Ordering decision (send-then-persist):
   *
   *  1. The previous hash is still valid while the e-mail is being sent, so a
   *     delivery failure (SMTP down, relay timeout) cannot leave the row with a
   *     token the invitee never received — and cannot burn the link the invitee
   *     already has. The caller gets 502 `EMAIL_SEND_FAILED` and nothing was
   *     written.
   *  2. Only after the relay accepted the message is the row updated with the
   *     new hash/TTL. The conditional update (`accepted_at IS NULL`) means a
   *     concurrent acceptance still wins: the endpoint answers 409 and the
   *     already-mailed link is simply dead, never a persisted inconsistency.
   *
   * The unavoidable window is a process crash between the relay call and the
   * update: the invitee receives a link that was never stored. That is strictly
   * better than persisting a token for an e-mail that failed to leave.
   */
  async resendForAdmin(
    tenantId: string,
    actor: ResendInvitationActor,
    invitationId: string,
  ): Promise<ResendInvitationResult> {
    if (!UUID_PATTERN.test((invitationId ?? '').trim())) {
      throw new NotFoundError('Invitation', invitationId);
    }

    const invitation = await this.invitations.findById(invitationId);
    // Cross-tenant ids are indistinguishable from unknown ids (no enumeration).
    if (invitation === null || invitation.tenantId !== tenantId) {
      throw new NotFoundError('Invitation', invitationId);
    }
    if (invitation.acceptedAt !== null) {
      throw this.alreadyAcceptedError();
    }

    // A brand-new 32-byte token; the previous hash is never reused.
    const issued = this.issueInvitationToken();
    try {
      await this.deliverInvitationEmail(invitation, issued.token, actor.name);
    } catch (error) {
      // The row is intentionally untouched: the old link keeps working and the
      // ADMIN can retry once SMTP recovers. Never log the token or the link.
      this.logger.warn('invitation.resend.email_failed', {
        invitationId: invitation.id,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.emailSendFailedError();
    }

    const reissued = await this.invitations.reissue(invitation.id, tenantId, {
      tokenHash: issued.tokenHash,
      expiresAt: issued.expiresAt,
    });
    if (!reissued) {
      // A concurrent acceptance/revoke won the race after the e-mail went out.
      throw this.alreadyAcceptedError();
    }

    this.logger.info('invitation.resent', {
      invitationId: invitation.id,
      tenantId,
      actorId: actor.id,
      role: invitation.role,
    });

    this.audit?.record({
      action: AUDIT_ACTIONS.invitationResent,
      tenantId,
      actorId: actor.id,
      // Full actor e-mail on its own column; the invitee e-mail is redacted.
      actorEmail: actor.email ?? null,
      resourceType: 'invitation',
      resourceId: invitation.id,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        email: redactPiiForLogs(invitation.email),
        role: invitation.role,
      },
    });

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: issued.expiresAt,
      status: 'PENDING',
    };
  }

  /* ==================================================================== */
  /* Accept                                                               */
  /* ==================================================================== */

  async accept(
    command: AcceptInvitationCommand,
    device?: SessionDeviceInfo,
  ): Promise<AcceptInvitationResult> {
    const rawToken = (command.token ?? '').trim();
    if (rawToken.length < MIN_TOKEN_LENGTH || rawToken.length > MAX_TOKEN_LENGTH) {
      throw this.invalidTokenError();
    }

    const name = (command.name ?? '').trim();
    if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) {
      throw new ValidationError(`Name must be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters`, {
        field: 'name',
      });
    }
    const password = command.password ?? '';
    this.assertPassword(password);

    const invitation = await this.invitations.findByTokenHash(hashToken(rawToken));
    const now = this.clock.now();
    if (
      invitation === null ||
      invitation.acceptedAt !== null ||
      invitation.expiresAt.getTime() <= now.getTime()
    ) {
      // Unknown, replayed and expired links are indistinguishable on purpose.
      throw this.invalidTokenError();
    }

    const existingOperator = await this.agents.findByEmail(invitation.email);
    if (existingOperator !== null) {
      throw new ConflictError('An account with this e-mail already exists');
    }

    const tenant = await this.tenants.findById(invitation.tenantId);
    if (tenant === null || tenant.status !== 'ACTIVE') {
      throw new ConflictError('Workspace is not available for new operators');
    }

    // Fase 4: the workspace may have downgraded/shrunk since the invite was
    // sent, so acceptance re-checks the `max_agents` quota.
    await this.planLimits?.assertCanAddAgent(invitation.tenantId);

    // The password is hashed before the insert; the plaintext never reaches the
    // repository, the logs or the e-mail service.
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    let agent: AgentRecord;
    try {
      agent = await this.agents.create({
        email: invitation.email,
        name,
        passwordHash,
        tenantId: invitation.tenantId,
        role: invitation.role,
        // The invitation proves ownership of the e-mail: no second verification.
        emailVerifiedAt: now,
      });
    } catch (error) {
      // A concurrent signup/invite can win the global e-mail unique constraint.
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictError('An account with this e-mail already exists');
      }
      throw error;
    }

    const accepted = await this.invitations.accept(invitation.id, now);
    if (accepted === null) {
      // Only reachable through a concurrent acceptance of the same token; the
      // unique e-mail already guarantees a single operator was created.
      this.logger.warn('invitation.accept.already_consumed', {
        invitationId: invitation.id,
        userId: agent.id,
      });
    }

    const issued = await this.issueRefreshSession(agent, device);
    const token = signAccessToken({
      subject: agent,
      secret: this.jwtSecret,
      expiresIn: this.jwtExpiresIn,
      ...(issued?.sessionId !== undefined ? { sessionId: issued.sessionId } : {}),
    });

    this.logger.info('invitation.accepted', {
      invitationId: invitation.id,
      tenantId: invitation.tenantId,
      userId: agent.id,
      role: agent.role,
    });

    this.audit?.record({
      action: AUDIT_ACTIONS.invitationAccepted,
      tenantId: invitation.tenantId,
      actorId: agent.id,
      actorEmail: agent.email,
      resourceType: 'user',
      resourceId: agent.id,
      metadata: { invitationId: invitation.id, role: agent.role },
    });

    return {
      token,
      ...(issued !== null ? { refreshToken: issued.refreshToken } : {}),
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        role: agent.role,
        presence: agent.presence,
        tenantId: invitation.tenantId,
      },
    };
  }

  /* ==================================================================== */
  /* Internals                                                            */
  /* ==================================================================== */

  private toSummary(record: InvitationRecord, now: Date): InvitationSummary {
    const status: InvitationStatus =
      record.acceptedAt !== null
        ? 'accepted'
        : record.expiresAt.getTime() <= now.getTime()
          ? 'expired'
          : 'pending';

    return {
      id: record.id,
      email: record.email,
      role: record.role,
      status,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      acceptedAt: record.acceptedAt,
    };
  }

  private toAdminView(record: InvitationRecord, now: Date): AdminInvitationView {
    const status: AdminInvitationStatus =
      record.acceptedAt !== null
        ? 'ACCEPTED'
        : record.expiresAt.getTime() <= now.getTime()
          ? 'EXPIRED'
          : 'PENDING';

    return {
      id: record.id,
      email: record.email,
      role: record.role,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
      acceptedAt: record.acceptedAt?.toISOString() ?? null,
      status,
    };
  }

  private alreadyAcceptedError(): AppError {
    return new AppError(
      'INVITATION_ALREADY_ACCEPTED',
      'Invitation has already been accepted',
      409,
    );
  }

  private assertPassword(password: string): void {
    if (
      password.length < MIN_PASSWORD_LENGTH ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      throw new ValidationError(
        `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
        { field: 'password', minLength: MIN_PASSWORD_LENGTH },
      );
    }
  }

  /** Returns `null` when the refresh session could not be issued (never fatal). */
  private async issueRefreshSession(
    agent: AgentRecord,
    device?: SessionDeviceInfo,
  ): Promise<IssuedSession | null> {
    if (this.sessions === undefined) return null;

    try {
      return await this.sessions.issue(agent.id, device);
    } catch (error) {
      this.logger.warn('invitation.session.issue_failed', {
        userId: agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Shared token factory: one fresh 32-byte token, its SHA-256 and the TTL
   * window. `create` and `resendForAdmin` MUST go through this helper so a
   * resend can never reuse the previous hash.
   */
  private issueInvitationToken(): { token: string; tokenHash: string; expiresAt: Date } {
    const token = randomToken(INVITATION_TOKEN_BYTES);
    return {
      token,
      tokenHash: hashToken(token),
      expiresAt: new Date(this.clock.now().getTime() + INVITATION_TTL_MS),
    };
  }

  /**
   * Shared delivery: builds the SPA link and hands it to the e-mail port. The
   * same template (`IEmailService.sendInvitationEmail`) serves `create` and
   * `resendForAdmin`; errors propagate to the caller, which decides between
   * best effort (create) and 502 (resend).
   */
  private async deliverInvitationEmail(
    invitation: InvitationRecord,
    token: string,
    inviterName?: string | null,
  ): Promise<void> {
    const link = `${this.resolveLinkBase()}/invite?token=${encodeURIComponent(token)}`;
    await this.email.sendInvitationEmail(invitation.email, link, inviterName ?? undefined);
  }

  /** `create` keeps the row even when SMTP is down: the ADMIN can resend. */
  private async sendInvitationEmailBestEffort(
    invitation: InvitationRecord,
    token: string,
    inviterName: string,
  ): Promise<void> {
    try {
      await this.deliverInvitationEmail(invitation, token, inviterName);
    } catch (error) {
      // Never log the token or the link.
      this.logger.warn('invitation.email.send_failed', {
        invitationId: invitation.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Invite pages live in the SPA, so the first `WEB_ORIGIN` wins and
   * `APP_BASE_URL` is the fallback for API-only deployments (mirrors AuthService).
   */
  private resolveLinkBase(): string {
    const webOrigins = (this.config.webOrigin ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const base = webOrigins[0] ?? (this.config.appBaseUrl ?? '').trim();
    return base.replace(/\/+$/, '');
  }

  private invalidTokenError(): AppError {
    return new AppError(
      'INVALID_INVITATION_TOKEN',
      'Invitation link is invalid, expired or already used',
      400,
    );
  }

  /** SMTP/relay failure while re-issuing an invite; the row was not touched. */
  private emailSendFailedError(): AppError {
    return new AppError(
      'EMAIL_SEND_FAILED',
      'Invitation e-mail could not be delivered; the invitation was not changed',
      502,
    );
  }
}
