import type { HttpRouteContext, RouteHandler } from '../types';
import { ok } from '../responses';
import { requireAgent } from '../middleware/auth';

export interface AgentControllers {
  list: RouteHandler;
}

export function createAgentControllers(ctx: HttpRouteContext): AgentControllers {
  const { services } = ctx;

  return {
    /** `GET /agents` - assignment dropdown + load board. */
    async list(request) {
      const agent = requireAgent(request);
      return ok(await services.agents.list(agent.tenantId));
    },
  };
}
