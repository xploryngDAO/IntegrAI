import type { TicketListFilter } from '@sac/shared';
import type { HttpRouteContext, RouteHandler } from '../types';
import { parseInput, statsQuerySchema } from '../schemas';
import { ok } from '../responses';

export interface StatsControllers {
  queueSnapshot: RouteHandler;
  stats: RouteHandler;
  channelsHealth: RouteHandler;
}

export function createStatsControllers(ctx: HttpRouteContext): StatsControllers {
  const { services } = ctx;

  return {
    /** `GET /queue/snapshot` - polling fallback when the socket cannot connect. */
    async queueSnapshot() {
      return ok(await services.tickets.getQueueSnapshot());
    },

    /** `GET /stats?marketplace=&accountId=` - topbar telemetry. */
    async stats(request) {
      const query = parseInput(statsQuerySchema, request.query, 'query');

      const filter: TicketListFilter = {};
      if (query.marketplace !== undefined) filter.marketplace = query.marketplace;
      if (query.accountId !== undefined) filter.accountId = query.accountId;
      if (query.filter !== undefined) filter.queueKey = query.filter;

      return ok(await services.tickets.getStats(filter));
    },

    /** `GET /channels/health` - per-account circuit-breaker snapshot. */
    async channelsHealth() {
      return ok(await services.health.channels());
    },
  };
}
