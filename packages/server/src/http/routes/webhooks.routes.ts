import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createWebhookHandler } from '../controllers/webhook.controller';

/**
 * `/webhooks/*` - marketplace push endpoints (no JWT, raw body preserved).
 *
 * Mounted at the server root (not under `/api/v1`) because the URLs are
 * registered with the marketplaces; changing them would break signature
 * verification for Shopee (HMAC covers the full URL).
 */
export const webhookRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  app.post('/mercadolivre', createWebhookHandler(ctx, 'MERCADO_LIVRE'));
  app.post('/shopee', createWebhookHandler(ctx, 'SHOPEE'));
  app.post('/amazon/ses', createWebhookHandler(ctx, 'AMAZON'));
};
