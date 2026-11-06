import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createPlatformControllers } from '../controllers/platform.controller';
import { requirePlatformAdmin } from '../middleware/auth';

/**
 * `/api/v1/platform` - internal console (Fase 4).
 *
 * Every route requires a valid JWT (global guard) AND `agents.is_platform_admin`
 * (re-checked in the database by `requirePlatformAdmin`): a regular tenant
 * ADMIN gets 403. There is no route that mutates a workspace on behalf of a
 * tenant user here.
 */
export const platformRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createPlatformControllers(ctx);
  const platformOnly = requirePlatformAdmin(ctx.services.platform);

  app.get('/tenants', { preHandler: platformOnly }, controllers.listTenants);
  app.patch('/tenants/:id', { preHandler: platformOnly }, controllers.updateTenant);
  // Platform soft delete (no workspace password): used for abandoned/restored
  // workspaces whose ADMIN credentials are unknown; purge stays a separate step.
  app.delete('/tenants/:id', { preHandler: platformOnly }, controllers.deleteTenant);
  // Manual LGPD purge: only for an ALREADY soft-deleted workspace (`deleted_at`
  // set). The automatic path is the daily `queue.tenant.purge` scheduler.
  app.post('/tenants/:id/purge', { preHandler: platformOnly }, controllers.purgeTenant);
  // Fase 4 - backup/restore por workspace. `restore` is static and always wins
  // over `/tenants/:id/...`; it NEVER overwrites an existing tenant.
  app.post('/tenants/restore', { preHandler: platformOnly }, controllers.restoreTenant);
  app.post('/tenants/:id/backup', { preHandler: platformOnly }, controllers.createBackup);
  app.get('/tenants/:id/backups', { preHandler: platformOnly }, controllers.listBackups);
  app.get('/metrics', { preHandler: platformOnly }, controllers.metrics);
  // Fase 4 - per-tenant observability and billing base.
  app.get('/tenants/:id/metrics', { preHandler: platformOnly }, controllers.tenantMetrics);
  app.get('/alerts', { preHandler: platformOnly }, controllers.alerts);
  app.get('/billing/summary', { preHandler: platformOnly }, controllers.billingSummary);
  // Billing gateway audit trail: the last N webhook events (type/tenant/status).
  app.get('/billing/events', { preHandler: platformOnly }, controllers.billingEvents);
  // Hosted checkout URL built from env (no gateway call from the API).
  app.post('/tenants/:id/checkout', { preHandler: platformOnly }, controllers.checkout);
  app.patch('/tenants/:id/billing', { preHandler: platformOnly }, controllers.updateBilling);
  // Fase 2 onboarding: how to CREATE the app in each marketplace portal
  // (Meli DevCenter, Shopee Open Platform, Amazon Seller Central). Derived from
  // the deployment config; public ids + exact URLs + env var names, no secrets.
  app.get('/integration-setup', { preHandler: platformOnly }, controllers.integrationSetup);
};
