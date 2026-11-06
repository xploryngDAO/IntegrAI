import type {
  AuditActorContext,
  IAuditService,
  IClock,
  ILogger,
  ITenantRepository,
  ITenantService,
  TenantProfile,
  TenantRecord,
  UpdateTenantCommand,
  UpdateTenantInput,
} from '@sac/shared';
import { AUDIT_ACTIONS, NotFoundError, ValidationError } from '@sac/shared';

/**
 * ============================================================================
 * TenantService - workspace identity + onboarding completion + 2FA policy
 * ============================================================================
 *
 * The tenant id always comes from the authenticated JWT (`/tenants/me`); the
 * request body can only change the display name, the onboarding marker and the
 * workspace 2FA policy, so a caller can never touch another workspace.
 *
 *  - `get`    : projection rendered by the SPA (id, slug, name, completion,
 *    `require2fa`).
 *  - `update` : `onboardingCompleted: true` stamps the FIRST completion (a wizard
 *    rerun keeps the original timestamp); `false` clears it so the wizard can be
 *    restarted; `name` renames the workspace; `require2fa` flips the policy
 *    (ADMIN-only at the HTTP layer) and is audited as
 *    `tenant.2fa_policy_changed` with before/after.
 */

const MAX_TENANT_NAME_LENGTH = 160;

export interface TenantServiceDependencies {
  logger: ILogger;
  clock: IClock;
  /** Best-effort audit trail; never blocks a workspace update. */
  audit?: IAuditService;
  repos: {
    tenants: ITenantRepository;
  };
}

export class TenantService implements ITenantService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly audit: IAuditService | undefined;
  private readonly tenants: ITenantRepository;

  constructor(deps: TenantServiceDependencies) {
    this.logger = deps.logger.child({ component: 'TenantService' });
    this.clock = deps.clock;
    this.audit = deps.audit;
    this.tenants = deps.repos.tenants;
  }

  async get(tenantId: string): Promise<TenantProfile> {
    const tenant = await this.tenants.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant', tenantId);
    return toProfile(tenant);
  }

  async update(
    tenantId: string,
    command: UpdateTenantCommand,
    actor?: AuditActorContext,
  ): Promise<TenantProfile> {
    if (
      command.name === undefined &&
      command.onboardingCompleted === undefined &&
      command.require2fa === undefined
    ) {
      throw new ValidationError(
        'At least one of name, onboardingCompleted or require2fa is required',
      );
    }

    const tenant = await this.tenants.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant', tenantId);
    // Capture BEFORE the repository call: some implementations mutate the row
    // in place, so reading `tenant.require2fa` afterwards could see the new value.
    const require2faBefore = tenant.require2fa;

    const patch: UpdateTenantInput = {};

    if (command.name !== undefined) {
      const name = command.name.trim();
      if (name.length === 0 || name.length > MAX_TENANT_NAME_LENGTH) {
        throw new ValidationError(
          `name must be between 1 and ${MAX_TENANT_NAME_LENGTH} characters`,
        );
      }
      patch.name = name;
    }

    if (command.onboardingCompleted !== undefined) {
      patch.onboardingCompletedAt = command.onboardingCompleted
        ? (tenant.onboardingCompletedAt ?? this.clock.now())
        : null;
    }

    if (command.require2fa !== undefined) {
      patch.require2fa = command.require2fa;
    }

    const updated = await this.tenants.update(tenantId, patch);

    if (patch.require2fa !== undefined && updated.require2fa !== require2faBefore) {
      this.audit?.record({
        action: AUDIT_ACTIONS.tenant2faPolicyChanged,
        tenantId,
        actorId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        resourceType: 'tenant',
        resourceId: tenantId,
        ip: actor?.ip ?? null,
        userAgent: actor?.userAgent ?? null,
        metadata: {
          field: 'require2fa',
          before: require2faBefore,
          after: updated.require2fa,
        },
      });
    }

    this.logger.info('tenant.updated', {
      tenantId,
      fields: Object.keys(patch),
      onboardingCompleted: updated.onboardingCompletedAt !== null,
      require2fa: updated.require2fa,
    });

    return toProfile(updated);
  }
}

/**
 * `TenantProfile` is intentionally narrower than `TenantRecord`: `status`,
 * `createdAt` and `updatedAt` are platform/console concerns, not operator ones.
 */
function toProfile(tenant: TenantRecord): TenantProfile {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    onboardingCompletedAt: tenant.onboardingCompletedAt,
    require2fa: tenant.require2fa,
  };
}
