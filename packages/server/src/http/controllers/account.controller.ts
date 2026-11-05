import type { Marketplace } from '@sac/shared';
import type { ConnectAccountRequest } from '@sac/shared';
import type { HttpRouteContext, RouteHandler } from '../types';
import {
  accountIdParamsSchema,
  connectAccountBodySchema,
  OAUTH_SLUGS,
  oauthCallbackParamsSchema,
  oauthStartBodySchema,
  oauthStartParamsSchema,
  parseInput,
} from '../schemas';
import { ok } from '../responses';
import { isAppError } from '@sac/shared';
import { asString } from '../utils/guards';
import { queryToStringRecord } from '../utils/query';
import { requireAgent } from '../middleware/auth';

export interface AccountControllers {
  list: RouteHandler;
  connectors: RouteHandler;
  oauthStart: RouteHandler;
  oauthCallback: RouteHandler;
  connect: RouteHandler;
  disconnect: RouteHandler;
  refresh: RouteHandler;
}

/** After the provider redirect we always land on the accounts page. */
function redirectLocation(webOrigin: string, params: Record<string, string>): string {
  // WEB_ORIGIN may be a comma-separated allowlist (operators app + hosted SPA);
  // the redirect must use the canonical (first) origin only.
  const primary = webOrigin
    .split(',')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  const base = (primary ?? 'http://localhost:5173').replace(/\/+$/, '');
  const query = new URLSearchParams(params).toString();
  return `${base}/accounts${query.length > 0 ? `?${query}` : ''}`;
}

export function createAccountControllers(ctx: HttpRouteContext): AccountControllers {
  const { services, options } = ctx;
  const log = services.logger.child({ component: 'http.accounts' });

  return {
    /** `GET /accounts` - store selector + account cards. */
    async list(request) {
      const agent = requireAgent(request);
      return ok(await services.accounts.listAccounts(agent.tenantId));
    },

    /** `GET /accounts/connectors` - drives the "Conectar loja" wizard. */
    async connectors() {
      return ok(services.accounts.describeConnectors());
    },

    /** `POST /accounts/oauth/:marketplace/start`. */
    async oauthStart(request) {
      const { marketplace: slug } = parseInput(oauthStartParamsSchema, request.params, 'params');
      const body = parseInput(oauthStartBodySchema, request.body, 'body');
      const marketplace: Marketplace = OAUTH_SLUGS[slug];
      const result = await services.accounts.startOAuth(marketplace, body.displayName);
      return ok(result);
    },

    /**
     * `GET /accounts/oauth/:marketplace/callback`.
     * Always a 302 back to the SPA; failures are surfaced as `?error=<code>` so
     * the browser never renders a JSON error on what looks like a page load.
     */
    async oauthCallback(request, reply) {
      const { marketplace: slug } = parseInput(oauthCallbackParamsSchema, request.params, 'params');
      const marketplace: Marketplace = OAUTH_SLUGS[slug];
      const rawQuery = queryToStringRecord(request.query);

      try {
        const code = asString(rawQuery['code']);
        const state = asString(rawQuery['state']);
        if (code === undefined || code.length === 0 || state === undefined || state.length === 0) {
          return reply.redirect(redirectLocation(options.webOrigin, { error: 'VALIDATION_ERROR' }), 302);
        }

        const shopId = asString(rawQuery['shop_id']) ?? asString(rawQuery['shopId']);

        await services.accounts.completeOAuth(marketplace, {
          code,
          state,
          shopId,
          rawQuery,
        });

        return reply.redirect(redirectLocation(options.webOrigin, { connected: slug }), 302);
      } catch (error) {
        const code = isAppError(error) ? error.code : 'INTERNAL_ERROR';
        log.warn('oauth.callback_failed', {
          marketplace,
          errorCode: code,
          requestId: request.id,
        });
        return reply.redirect(redirectLocation(options.webOrigin, { error: code }), 302);
      }
    },

    /** `POST /accounts/connect` - Amazon LWA refresh token / manual token flows. */
    async connect(request) {
      const body = parseInput(connectAccountBodySchema, request.body, 'body');

      const input: ConnectAccountRequest = {
        marketplace: body.marketplace,
        displayName: body.displayName,
        externalSellerId: body.externalSellerId,
        marketplaceSiteId: body.marketplaceSiteId,
        refreshToken: body.refreshToken,
        accessToken: body.accessToken,
        tokenExpiresAt: body.tokenExpiresAt,
        channelConfig: body.channelConfig,
      };

      const result = await services.accounts.connectWithCredentials(input);
      return ok(result);
    },

    /** `DELETE /accounts/:id`. */
    async disconnect(request) {
      const { id } = parseInput(accountIdParamsSchema, request.params, 'params');
      await services.accounts.disconnect(id);
      return ok({ ok: true, accountId: id });
    },

    /** `POST /accounts/:id/refresh` - force a token refresh now. */
    async refresh(request) {
      const { id } = parseInput(accountIdParamsSchema, request.params, 'params');
      const result = await services.accounts.refreshNow(id);
      return ok(result);
    },
  };
}
