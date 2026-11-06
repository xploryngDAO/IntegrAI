import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createBillingControllers } from '../controllers/billing.controller';

/**
 * `/api/v1/billing` - payment-gateway contract (Fase 4).
 *
 * The single route is PUBLIC by design (auth allowlist): the gateway cannot
 * present a JWT, so authenticity is proven by the HMAC SHA-256 signature of the
 * raw body (`x-billing-signature` + `BILLING_WEBHOOK_SECRET`). No provider is
 * called from here: the endpoint only records and applies the normalized event.
 */
export const billingRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createBillingControllers(ctx);
  app.post('/webhook', controllers.webhook);
};
