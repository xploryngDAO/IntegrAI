import type {
  IClock,
  ILogger,
  ITenantRepository,
  ITenantService,
  TenantProfile,
  TenantRecord,
  UpdateTenantCommand,
  UpdateTenantInput,
} from '@sac/shared';
import { NotFoundError, ValidationError } from '@sac/shared';

/**
 * ============================================================================
 * TenantService - workspace identity + onboarding completion (Fase 2)
 * ============================================================================
 *
 * The tenant id always comes from the authenticated JWT (`/tenants/me`); the
 * request body can only change the display name and the onboarding marker, so a
 * caller can never touch another workspace.
 *
 *  - `get`    : projection rendered by the SPA (id, slug, name, completion).
 *  - `update` : `onboardingCompleted: true` stamps the FIRST completion (a wizard
 *    rerun keeps the original timestamp); `false` clears it so the wizard can be
 *    restarted; `name` renames the workspace.
 */

const MAX_TENANT_NAME_LENGTH = 160;

export interface TenantServiceDependencies {
  logger: ILogger;
  clock: IClock;
  repos: {
    tenants: ITenantRepository;
  };
}

export class TenantService implements ITenantService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly tenants: ITenantRepository;

  constructor(deps: TenantServiceDependencies) {
    this.logger = deps.logger.child({ component: 'TenantService' });
    this.clock = deps.clock;
    this.tenants = deps.repos.tenants;
  }

  async get(tenantId: string): Promise<TenantProfile> {
    const tenant = await this.tenants.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant', tenantId);
    return toProfile(tenant);
  }

  async update(tenantId: string, command: UpdateTenantCommand): Promise<TenantProfile> {
    if (command.name === undefined && command.onboardingCompleted === undefined) {
      throw new ValidationError('At least one of name or onboardingCompleted is required');
    }

    const tenant = await this.tenants.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant', tenantId);

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

    const updated = await this.tenants.update(tenantId, patch);

    this.logger.info('tenant.updated', {
      tenantId,
      fields: Object.keys(patch),
      onboardingCompleted: updated.onboardingCompletedAt !== null,
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
  };
}
