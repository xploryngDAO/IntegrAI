import type { AdapterDependencies, IMarketplaceChannelAdapter } from '@sac/shared';
import { AmazonChannelAdapter } from './AmazonChannelAdapter';

export { AmazonChannelAdapter };
export type { AmazonAccountSettings, SesRelayPayload, AmazonOrderBundle } from './types';

/**
 * Amazon channel adapter factory (registry entry point).
 *
 * Implements `IMarketplaceChannelAdapter` for `marketplace === 'AMAZON'`:
 * SES inbound relay with HMAC verification, LWA + RDT authentication, SP-API
 * order enrichment/messaging and the SMTP Buyer-Seller relay.
 */
export function createAmazonChannelAdapter(
  deps: AdapterDependencies,
): IMarketplaceChannelAdapter {
  return new AmazonChannelAdapter(deps);
}
