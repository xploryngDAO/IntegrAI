import type { HttpRouteContext, RouteHandler } from '../types';
import { ok } from '../responses';

export interface AgentControllers {
  list: RouteHandler;
}

export function createAgentControllers(ctx: HttpRouteContext): AgentControllers {
  const { services } = ctx;

  return {
    /** `GET /agents` - assignment dropdown + load board. */
    async list() {
      return ok(await services.agents.list());
    },
  };
}
