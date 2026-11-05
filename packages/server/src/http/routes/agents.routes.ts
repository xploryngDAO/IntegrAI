import type { FastifyPluginAsync } from 'fastify';
import type { HttpRouteContext } from '../types';
import { createAgentControllers } from '../controllers/agent.controller';

/** `/api/v1/agents` - assignment dropdown + load board. */
export const agentRoutes: FastifyPluginAsync<HttpRouteContext> = async (app, ctx) => {
  const controllers = createAgentControllers(ctx);
  app.get('/', controllers.list);
};
