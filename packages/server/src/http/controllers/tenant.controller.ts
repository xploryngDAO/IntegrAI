import type { HttpRouteContext, RouteHandler } from '../types';
import { parseInput, updateTenantBodySchema } from '../schemas';
import { ok } from '../responses';
import { requireTenantId } from '../middleware/auth';

export interface TenantControllers {
  get: RouteHandler;
  update: RouteHandler;
}

/**
 * `/tenants/me` (Fase 2).
 *
 * The tenant is ALWAYS resolved from the authenticated JWT (`requireTenantId`),
 * never from the path/body: a caller cannot read or rename another workspace.
 */
export function createTenantControllers(ctx: HttpRouteContext): TenantControllers {
  const { services } = ctx;

  return {
    /** `GET /tenants/me` - id, slug, name, onboardingCompletedAt. */
    async get(request) {
      const tenantId = requireTenantId(request);
      return ok(await services.tenants.get(tenantId));
    },

    /** `PATCH /tenants/me` (ADMIN) - rename and/or complete the onboarding. */
    async update(request) {
      const tenantId = requireTenantId(request);
      const body = parseInput(updateTenantBodySchema, request.body, 'body');
      return ok(await services.tenants.update(tenantId, body));
    },
  };
}
