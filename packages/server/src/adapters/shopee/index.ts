import type { AdapterDependencies, IMarketplaceChannelAdapter } from '@sac/shared';
import { ShopeeChannelAdapter } from './ShopeeChannelAdapter';

/**
 * Shopee Open Platform v2 adapter entry point.
 *
 * The registry (`adapters/registry.ts`) and the core `AccountService` import
 * exclusively from here: the factory is used by the dependency container and
 * `exchangeAuthorizationCode` / `buildShopeeAuthorizeUrl` power the OAuth
 * onboarding flow.
 */
export function createShopeeChannelAdapter(deps: AdapterDependencies): IMarketplaceChannelAdapter {
  return new ShopeeChannelAdapter(deps);
}

export { ShopeeChannelAdapter };

/** Signing primitives (pure; exercised by the unit tests). */
export {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  assertTimestampFresh,
  buildSignBase,
  clockSkewSeconds,
  computeSign,
  computeWebhookSign,
  safeEqualHex,
} from './client/sign';
export type { ComputeSignInput } from './client/sign';

/** Auth + onboarding helpers used by the core AccountService. */
export {
  ShopeeAuth,
  buildShopeeAuthorizeUrl,
  exchangeAuthorizationCode,
  loadShopeeAccount,
  shopIdOf,
} from './client/ShopeeAuth';
export type {
  ShopeeAuthOptions,
  ShopeeAuthorizationCodeExchangeResult,
  ShopeeAuthorizationCodeInput,
} from './client/ShopeeAuth';

/** Low-level client + collaborators (exported for integration tests/replays). */
export { ShopeeClient, shopeeErrorCode } from './client/ShopeeClient';
export { ShopeeWebhookParser, SHOPEE_WEBHOOK_REASONS } from './inbound/ShopeeWebhookParser';
export { ShopeeHydrator } from './inbound/ShopeeHydrator';
export { ShopeeChat } from './outbound/ShopeeChat';
export { ShopeeReturns } from './outbound/ShopeeReturns';
export { ShopeeMaintenance } from './ShopeeMaintenance';
export type { ShopeeMaintenanceTask } from './ShopeeMaintenance';

/** Pure triage/snapshot mappers. */
export {
  buildItemSnapshot,
  buildOrderContext,
  buildTrackingSnapshot,
  mapChatTriage,
  normalizeEventId,
  parseShopeePushBody,
  triageShopeePush,
} from './mappers';

export { SHOPEE_API_PATHS, SHOPEE_MARKETPLACE } from './types';
export type {
  ShopeeApiEnvelope,
  ShopeeCallResult,
  ShopeeLostPushCursor,
  ShopeePushPayload,
  ShopeeRequestSpec,
  ShopeeTokenSet,
  ShopeeTrackingSnapshot,
  ShopeeTriageDecision,
} from './types';
