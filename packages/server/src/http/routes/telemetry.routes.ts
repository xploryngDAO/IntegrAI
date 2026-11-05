import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createStatsControllers } from '../controllers/stats.controller';

/** `/api/v1` telemetry: queue snapshot, aggregate stats, channel health. */
export const telemetryRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createStatsControllers(ctx);
  app.get('/queue/snapshot', controllers.queueSnapshot);
  app.get('/stats', controllers.stats);
  app.get('/channels/health', controllers.channelsHealth);
};
