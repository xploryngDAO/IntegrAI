import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createAccountControllers } from '../controllers/account.controller';

/** `/api/v1/accounts` - onboarding wizard, OAuth, credentials, refresh. */
export const accountRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createAccountControllers(ctx);

  app.get('/', controllers.list);
  app.get('/connectors', controllers.connectors);
  app.post('/oauth/:marketplace/start', controllers.oauthStart);
  app.get('/oauth/:marketplace/callback', controllers.oauthCallback);
  app.post('/connect', controllers.connect);
  app.delete('/:id', controllers.disconnect);
  app.post('/:id/refresh', controllers.refresh);
};
