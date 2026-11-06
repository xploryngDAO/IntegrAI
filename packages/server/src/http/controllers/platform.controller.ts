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
  purgeTenant: RouteHandler;
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
    /**
     * `GET /platform/tenants?page&pageSize&search` - tenants + plan + limits +
     * counts. `search` filters by name/slug server-side (case-insensitive) and
     * the envelope keeps the filtered `total`/`totalPages`.
     */
    async listTenants(request) {
      const query = parseInput(platformTenantListQuerySchema, request.query, 'query');
      return ok(await services.platform.listTenants(query));
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

    /**
     * `POST /platform/tenants/:id/purge` - LGPD physical deletion, run manually.
     *
     * Only a soft-deleted workspace can be purged (409 otherwise); the daily
     * `queue.tenant.purge` job is the automatic path.
     */
    async purgeTenant(request) {
      const { id } = parseInput(platformTenantParamsSchema, request.params, 'params');
      const actorId = requireAgent(request).id;
      const result = await services.tenantPurge.purgeTenant(id, actorId);

      services.logger.info('http.platform.tenant_purged', {
        requestId: request.id,
        actorId,
        tenantId: id,
        slug: result.slug,
        counts: result.counts,
      });

      return ok(result);
    },

    /** `GET /platform/metrics` - global operational totals. */
    async metrics() {
      return ok(await services.platform.metrics());
    },
  };
}
