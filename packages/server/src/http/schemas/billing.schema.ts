import { z } from 'zod';
import {
  BILLING_EVENTS_DEFAULT_LIMIT,
  BILLING_EVENTS_MAX_LIMIT,
} from '@sac/shared';

/**
 * HTTP schemas of the billing gateway contract (Fase 4).
 *
 * The webhook body is NOT validated here: the raw bytes must be authenticated
 * (HMAC) before any parsing rule runs, so `BillingService.handleWebhook` owns
 * the normalized-payload validation. Only the console query is shaped here.
 */

/** `GET /platform/billing/events?limit=` - newest billing webhook events. */
export const billingEventsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(BILLING_EVENTS_MAX_LIMIT)
    .default(BILLING_EVENTS_DEFAULT_LIMIT),
});

export type BillingEventsQuery = z.infer<typeof billingEventsQuerySchema>;
