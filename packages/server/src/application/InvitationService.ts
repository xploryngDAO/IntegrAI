import bcrypt from 'bcryptjs';

import type {
  AcceptInvitationCommand,
  AcceptInvitationResult,
  AgentRecord,
  AgentRole,
  CreateInvitationCommand,
  CreateInvitationResult,
  IAgentRepository,
  IAuthSessionService,
  IClock,
  IEmailService,
  IInvitationRepository,
  IInvitationService,
  ILogger,
  InvitationRecord,
  InvitationStatus,
  InvitationSummary,
  ITenantRepository,
  SessionDeviceInfo,
} from '@sac/shared';
import { AppError, ConflictError, NotFoundError, ValidationError } from '@sac/shared';

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
 *  - `accept` : public flow. The token proves ownership of the e-mail, so the
 *    new operator is created already verified, in the invitation tenant and
 *    with the invited role; a session (JWT + rotating refresh token) is opened
 *    right away so the SPA can enter without a second login.
 *
 * Failure paths use stable `AppError.code`s: `INVALID_INVITATION_TOKEN` (400),
 * `VALIDATION_ERROR` (422) and `CONFLICT` (409).
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

    const token = randomToken(INVITATION_TOKEN_BYTES);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);

    const invitation = await this.invitations.upsert({
      tenantId: command.actor.tenantId,
      email,
      role,
      tokenHash: hashToken(token),
      invitedBy: command.actor.id,
      expiresAt,
    });

    await this.sendInvitationEmail(invitation, token, command.actor.name);

    this.logger.info('invitation.created', {
      invitationId: invitation.id,
      tenantId: invitation.tenantId,
      role: invitation.role,
      invitedBy: command.actor.id,
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

    const token = signAccessToken({
      subject: agent,
      secret: this.jwtSecret,
      expiresIn: this.jwtExpiresIn,
    });
    const refreshToken = await this.issueRefreshToken(agent, device);

    this.logger.info('invitation.accepted', {
      invitationId: invitation.id,
      tenantId: invitation.tenantId,
      userId: agent.id,
      role: agent.role,
    });

    return {
      token,
      ...(refreshToken !== null ? { refreshToken } : {}),
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

  /** Returns `null` when the refresh token could not be issued (never fatal). */
  private async issueRefreshToken(
    agent: AgentRecord,
    device?: SessionDeviceInfo,
  ): Promise<string | null> {
    if (this.sessions === undefined) return null;

    try {
      const issued = await this.sessions.issue(agent.id, device);
      return issued.refreshToken;
    } catch (error) {
      this.logger.warn('invitation.session.issue_failed', {
        userId: agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async sendInvitationEmail(
    invitation: InvitationRecord,
    token: string,
    inviterName: string,
  ): Promise<void> {
    const link = `${this.resolveLinkBase()}/invite?token=${encodeURIComponent(token)}`;
    try {
      await this.email.sendInvitationEmail(invitation.email, link, inviterName);
    } catch (error) {
      // The invitation is already persisted: the ADMIN can resend once SMTP
      // recovers. Never log the token or the link.
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
}
