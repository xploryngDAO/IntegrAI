import { NotFoundError } from '@sac/shared';
import type { AuthResponse, IAgentSummary } from '@sac/shared';
import type { HttpRouteContext, RouteHandler } from '../types';
import { loginBodySchema, presenceBodySchema } from '../schemas';
import { parseInput } from '../schemas/common';
import { ok } from '../responses';
import { requireAgent } from '../middleware/auth';
import { toAgentRole } from '../mappers';

export interface AuthControllers {
  login: RouteHandler;
  me: RouteHandler;
  setPresence: RouteHandler;
}

export function createAuthControllers(ctx: HttpRouteContext): AuthControllers {
  const { services, hub } = ctx;

  const publishPresence = (summary: Pick<IAgentSummary, 'id' | 'name' | 'presence'>): void => {
    hub.publisher.agentPresence({
      agentId: summary.id,
      agentName: summary.name,
      presence: summary.presence,
      at: services.clock.now().toISOString(),
    });
  };

  return {
    /** `POST /auth/login` - public. */
    async login(request) {
      const body = parseInput(loginBodySchema, request.body, 'body');
      const result = await services.agents.login(body.email, body.password);

      const response: AuthResponse = {
        token: result.token,
        agent: {
          id: result.agent.id,
          name: result.agent.name,
          email: result.agent.email,
          role: toAgentRole(result.agent.role),
          presence: result.agent.presence,
        },
      };

      publishPresence({
        id: result.agent.id,
        name: result.agent.name,
        presence: result.agent.presence,
      });

      return ok(response);
    },

    /** `GET /auth/me` - identity + live workload for the operator header. */
    async me(request) {
      const agent = requireAgent(request);
      const agents = await services.agents.list();
      const summary = agents.find((entry) => entry.id === agent.id);
      if (summary === undefined) throw new NotFoundError('Agent', agent.id);

      return ok({
        id: summary.id,
        name: summary.name,
        email: summary.email,
        role: toAgentRole(summary.role),
        presence: summary.presence,
        activeTickets: summary.activeTickets,
      });
    },

    /** `PUT /auth/presence` - operator availability toggle. */
    async setPresence(request) {
      const agent = requireAgent(request);
      const body = parseInput(presenceBodySchema, request.body, 'body');
      const summary = await services.agents.setPresence(agent.id, body.presence);
      publishPresence(summary);
      return ok(summary);
    },
  };
}
