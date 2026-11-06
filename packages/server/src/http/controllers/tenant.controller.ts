import type { HttpRouteContext, RouteHandler } from '../types';
import {
  deleteTenantBodySchema,
  parseInput,
  updateTenantBodySchema,
} from '../schemas';
import { ok } from '../responses';
import { requireAgent, requireTenantId } from '../middleware/auth';

export interface TenantControllers {
  get: RouteHandler;
  update: RouteHandler;
  exportData: RouteHandler;
  remove: RouteHandler;
}

/** `Content-Disposition` filename must stay ASCII and quote-safe. */
function exportFileName(slug: string, exportedAt: string): string {
  const safeSlug = slug.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'tenant';
  const day = exportedAt.slice(0, 10);
  return `tenant-${safeSlug}-export-${day}.json`;
}

/**
 * `/tenants/me` - workspace self-service (Fase 2 identity, Fase 4 LGPD).
 *
 * The tenant is ALWAYS resolved from the authenticated JWT (`requireTenantId`),
 * never from the path/body: a caller cannot read, export, rename or delete
 * another workspace. Export and delete are ADMIN-only and run through
 * `TenantPrivacyService`, which re-validates the actor against the database.
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

    /**
     * `GET /tenants/me/export` (ADMIN) - LGPD portability.
     *
     * Returns the workspace artifact as a downloadable JSON document (no
     * envelope so the file is directly usable). Password hashes, TOTP secrets,
     * marketplace tokens and raw buyer PII are excluded by the service.
     */
    async exportData(request, reply) {
      const tenantId = requireTenantId(request);
      const actor = requireAgent(request);

      const artifact = await services.tenantPrivacy.exportData(tenantId, actor.id);

      reply.header(
        'content-disposition',
        `attachment; filename="${exportFileName(artifact.tenant.slug, artifact.meta.exportedAt)}"`,
      );
      reply.header('content-type', 'application/json; charset=utf-8');
      return artifact;
    },

    /**
     * `DELETE /tenants/me` (ADMIN) - LGPD soft delete.
     *
     * Requires the ADMIN password + the exact workspace slug; answers `202`
     * because the erasure is asynchronous by design (physical purge is a future
     * job, see docs/PHASE4_PLATFORM.md). The tenant stops being usable on the
     * next request (403 TENANT_INACTIVE).
     */
    async remove(request, reply) {
      const tenantId = requireTenantId(request);
      const actor = requireAgent(request);
      const body = parseInput(deleteTenantBodySchema, request.body, 'body');

      const result = await services.tenantPrivacy.deleteTenant(tenantId, body, actor.id);

      reply.code(202);
      return ok(result);
    },
  };
}
