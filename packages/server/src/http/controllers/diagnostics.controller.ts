import type { AccountDiagnosis, SystemDiagnosis } from '@sac/shared';
import type { HttpRouteContext, RouteHandler } from '../types';
import { diagnoseAccountParamsSchema, parseInput } from '../schemas';
import { ok } from '../responses';
import { requireAgent } from '../middleware/auth';
import { DIAGNOSTICS_TIMEOUT_MS } from '../constants';
import { withTimeout } from '../utils/timeout';

export interface DiagnosticsControllers {
  system: RouteHandler;
  account: RouteHandler;
}

/**
 * Live integration diagnostics (contract §9).
 *
 * These are the only routes that intentionally talk to the marketplaces in the
 * request path: they rotate/exchange tokens and perform cheap reads. Results are
 * returned as data - a failing check is still HTTP 200; only an unknown account
 * (404, raised by the service) or a timeout (504) produces an error envelope.
 */
export function createDiagnosticsControllers(ctx: HttpRouteContext): DiagnosticsControllers {
  const { services } = ctx;
  const log = services.logger.child({ component: 'http.diagnostics' });

  return {
    /** `GET /diagnostics` (ADMIN) - infrastructure + every connected account. */
    async system(request) {
      const agent = requireAgent(request);
      const startedAt = performance.now();

      log.info('diagnostics.system.started', {
        requestId: request.id,
        agentId: agent.id,
      });

      const diagnosis: SystemDiagnosis = await withTimeout(
        services.diagnostics.system(),
        DIAGNOSTICS_TIMEOUT_MS,
        'system',
      );

      log.info('diagnostics.system.finished', {
        requestId: request.id,
        agentId: agent.id,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        overall: diagnosis.overall,
        channels: diagnosis.channels.length,
      });

      return ok(diagnosis);
    },

    /** `POST /accounts/:id/diagnose` (ADMIN) - real calls for a single account. */
    async account(request) {
      const agent = requireAgent(request);
      const { id } = parseInput(diagnoseAccountParamsSchema, request.params, 'params');
      const startedAt = performance.now();

      log.info('diagnostics.account.started', {
        requestId: request.id,
        agentId: agent.id,
        accountId: id,
      });

      const diagnosis: AccountDiagnosis = await withTimeout(
        services.diagnostics.account(id),
        DIAGNOSTICS_TIMEOUT_MS,
        `account:${id}`,
      );

      log.info('diagnostics.account.finished', {
        requestId: request.id,
        agentId: agent.id,
        accountId: id,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        marketplace: diagnosis.marketplace,
        overall: diagnosis.overall,
        checks: diagnosis.checks.length,
      });

      return ok(diagnosis);
    },
  };
}
