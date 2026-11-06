import type { HttpRouteContext, RouteHandler } from '../types';
import {
  billingEventsQuerySchema,
  integrationSetupQuerySchema,
  parseInput,
  platformTenantBillingBodySchema,
  platformTenantListQuerySchema,
  platformTenantParamsSchema,
  platformTenantRestoreBodySchema,
  platformTenantUpdateBodySchema,
} from '../schemas';
import { ok } from '../responses';
import { requireAgent } from '../middleware/auth';

export interface PlatformControllers {
  listTenants: RouteHandler;
  updateTenant: RouteHandler;
  deleteTenant: RouteHandler;
  purgeTenant: RouteHandler;
  metrics: RouteHandler;
  tenantMetrics: RouteHandler;
  alerts: RouteHandler;
  billingSummary: RouteHandler;
  billingEvents: RouteHandler;
  checkout: RouteHandler;
  updateBilling: RouteHandler;
  createBackup: RouteHandler;
  listBackups: RouteHandler;
  restoreTenant: RouteHandler;
  integrationSetup: RouteHandler;
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
     * `DELETE /platform/tenants/:id` - platform-console soft delete.
     *
     * Does not require the workspace password (the caller is a platform
     * administrator), revokes sessions and marks the workspace `DELETED`; the
     * physical LGPD purge remains a separate explicit step.
     */
    async deleteTenant(request) {
      const { id } = parseInput(platformTenantParamsSchema, request.params, 'params');
      const actorId = requireAgent(request).id;
      const result = await services.tenantPrivacy.deleteTenantByPlatform(id, actorId);

      services.logger.info('http.platform.tenant_deleted', {
        requestId: request.id,
        actorId,
        tenantId: id,
        slug: result.slug,
      });

      return ok(result);
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

    /**
     * `GET /platform/tenants/:id/metrics` - operational snapshot of one
     * workspace (counts, SLA, volume and quota usage).
     */
    async tenantMetrics(request) {
      const { id } = parseInput(platformTenantParamsSchema, request.params, 'params');
      return ok(await services.platform.tenantMetrics(id));
    },

    /**
     * `GET /platform/alerts` - alerts derived from live rows, ordered by
     * severity. No alert table is involved.
     *
     * The envelope `data` is the alert LIST (the console renders it directly);
     * `meta` carries the generation timestamp and the total.
     */
    async alerts() {
      const result = await services.platform.alerts();
      return ok(result.alerts, { generatedAt: result.generatedAt, total: result.total });
    },

    /** `GET /platform/billing/summary` - MRR by plan + trial/past-due counts. */
    async billingSummary() {
      return ok(await services.platform.billingSummary());
    },

    /**
     * `GET /platform/billing/events?limit=50` - audit trail of the billing
     * gateway callbacks (newest first), joined with the workspace slug.
     */
    async billingEvents(request) {
      const query = parseInput(billingEventsQuerySchema, request.query, 'query');
      return ok(await services.billing.listEvents(query.limit));
    },

    /**
     * `POST /platform/tenants/:id/checkout` - hosted checkout URL rendered from
     * `BILLING_CHECKOUT_URL_TEMPLATE`. No gateway request is made here.
     */
    async checkout(request) {
      const { id } = parseInput(platformTenantParamsSchema, request.params, 'params');
      const result = await services.billing.checkout(id);

      services.logger.info('http.platform.checkout_created', {
        requestId: request.id,
        actorId: requireAgent(request).id,
        tenantId: id,
      });

      return ok(result);
    },

    /** `PATCH /platform/tenants/:id/billing` - subscription status/trial/contact. */
    async updateBilling(request) {
      const { id } = parseInput(platformTenantParamsSchema, request.params, 'params');
      const body = parseInput(platformTenantBillingBodySchema, request.body, 'body');
      const updated = await services.platform.updateBilling(id, body);

      services.logger.info('http.platform.billing_updated', {
        requestId: request.id,
        actorId: requireAgent(request).id,
        tenantId: id,
        fields: Object.keys(body),
      });

      return ok(updated);
    },

    /**
     * `POST /platform/tenants/:id/backup` - writes the JSON artifact to
     * `backups/<slug>/<timestamp>.json` and indexes it in `tenant_backups`.
     * The response carries only the pointer, size and per-table counts.
     */
    async createBackup(request) {
      const { id } = parseInput(platformTenantParamsSchema, request.params, 'params');
      const actorId = requireAgent(request).id;
      const result = await services.tenantBackup.createBackup(id, actorId);

      services.logger.info('http.platform.tenant_backup_created', {
        requestId: request.id,
        actorId,
        tenantId: id,
        backupKey: result.backupKey,
        sizeBytes: result.sizeBytes,
        counts: result.counts,
      });

      return ok(result);
    },

    /** `GET /platform/tenants/:id/backups` - index rows, newest first. */
    async listBackups(request) {
      const { id } = parseInput(platformTenantParamsSchema, request.params, 'params');
      return ok(await services.tenantBackup.listBackups(id));
    },

    /**
     * `POST /platform/tenants/restore` - creates a NEW workspace from a backup
     * artifact. Credentials are never restored (stores must be reconnected) and
     * the response never includes the temporary passwords.
     */
    async restoreTenant(request) {
      const body = parseInput(platformTenantRestoreBodySchema, request.body, 'body');
      const actorId = requireAgent(request).id;
      const result = await services.tenantBackup.restore(body, actorId);

      services.logger.info('http.platform.tenant_restored', {
        requestId: request.id,
        actorId,
        backupKey: body.backupKey,
        tenantId: result.tenantId,
        slug: result.slug,
        counts: result.counts,
      });

      return ok(result);
    },

    /**
     * `GET /platform/integration-setup?marketplace=` - Fase 2 onboarding.
     *
     * Environment-derived instructions to create the app in the Meli DevCenter,
     * the Shopee Open Platform and Amazon Seller Central. Public identifiers and
     * the exact redirect/webhook URLs only: secrets are named (`missing` and
     * `webhookSecretEnv`) but never returned.
     */
    async integrationSetup(request) {
      const query = parseInput(integrationSetupQuerySchema, request.query, 'query');
      const guide = services.integrationSetup.guide(query.marketplace);

      services.logger.info('http.platform.integration_setup_read', {
        requestId: request.id,
        actorId: requireAgent(request).id,
        marketplace: query.marketplace ?? null,
        configured: guide.channels.map((channel) => ({
          marketplace: channel.marketplace,
          configured: channel.configured,
          missing: channel.missing.length,
        })),
      });

      return ok(guide);
    },
  };
}
