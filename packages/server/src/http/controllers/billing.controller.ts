import type { HttpRouteContext, RouteHandler } from '../types';
import { BILLING_SIGNATURE_HEADER } from '../constants';

export interface BillingControllers {
  webhook: RouteHandler;
}

/**
 * `POST /api/v1/billing/webhook` - public, provider-agnostic gateway callback.
 *
 * The controller is intentionally thin: it forwards the EXACT raw bytes and the
 * `x-billing-signature` header to `BillingService`, which checks the HMAC before
 * parsing anything. The success body is plain (no `{ data }` envelope) because
 * this is a machine-to-machine endpoint: the gateway only needs an
 * acknowledgement and the duplicate marker.
 */
export function createBillingControllers(ctx: HttpRouteContext): BillingControllers {
  const { services } = ctx;

  return {
    async webhook(request, reply) {
      const header = request.headers[BILLING_SIGNATURE_HEADER];
      const signature = Array.isArray(header) ? header[0] : header;

      const result = await services.billing.handleWebhook({
        rawBody: request.rawBody ?? Buffer.alloc(0),
        signature: signature ?? null,
        body: request.body,
      });

      services.logger.info('http.billing.webhook', {
        requestId: request.id,
        type: result.type,
        tenantId: result.tenantId,
        duplicate: result.duplicate,
        billingStatus: result.billingStatus,
      });

      // 200 in both paths: a duplicate must never make the gateway retry.
      return reply.code(200).send({
        status: result.duplicate ? 'DUPLICATE' : 'PROCESSED',
        type: result.type,
        tenantId: result.tenantId,
        billingStatus: result.billingStatus,
      });
    },
  };
}
