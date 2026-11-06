import type { HttpRouteContext, RouteHandler } from '../types';
import {
  parseInput,
  platformTenantListQuerySchema,
  platformTenantParamsSchema,
  platformTenantUpdateBodySchema,
} from '../schemas';
import { ok } from '../responses';
import { requireAgent } from '../middleware/auth';

export interface PlatformControllers {
  listTenants: RouteHandler;
  updateTenant: RouteHandler;
  metrics: RouteHandler;
}

/**
 * `/platform/*` - internal console (Fase 4).
 *
 * Authorization is enforced by the `requirePlatformAdmin` preHandler (JWT +
 * fresh `agents.is_platform_admin` check), so these handlers never look at the
 * caller tenant: the console is cross-tenant by design.
 */
export function createPlatformControllers(ctx: HttpRouteContext): PlatformControllers {
  const { services } = ctx;

  return {
    /** `GET /platform/tenants?page&pageSize` - tenants + plan + limits + counts. */
    async listTenants(request) {
      const query = parseInput(platformTenantListQuerySchema, request.query, 'query');
      return ok(await services.platform.listTenants({ page: query.page, pageSize: query.pageSize }));
    },

    /** `PATCH /platform/tenants/:id` - plan, quotas or status. */
    async updateTenant(request) {
      const { id } = parseInput(platformTenantParamsSchema, request.params, 'params');
      const body = parseInput(platformTenantUpdateBodySchema, request.body, 'body');
      const updated = await services.platform.updateTenant(id, body);

      services.logger.info('http.platform.tenant_updated', {
        requestId: request.id,
        actorId: requireAgent(request).id,
        tenantId: id,
        fields: Object.keys(body),
      });

      return ok(updated);
    },

    /** `GET /platform/metrics` - global operational totals. */
    async metrics() {
      return ok(await services.platform.metrics());
    },
  };
}
