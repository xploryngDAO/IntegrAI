import type {
  AdapterDependencies,
  IAdapterRegistry,
  IMarketplaceChannelAdapter,
  Marketplace,
} from '@sac/shared';
import { createAmazonChannelAdapter } from './amazon';
import { createMercadoLivreChannelAdapter } from './mercadolivre';
import { createShopeeChannelAdapter } from './shopee';

/**
 * Single place where the three marketplace adapters are instantiated.
 * The core container builds the registry once and hands it to the outbound
 * router, the webhook ingress service and the worker factory.
 */
export function createAdapterRegistry(deps: AdapterDependencies): IAdapterRegistry {
  const adapters = new Map<Marketplace, IMarketplaceChannelAdapter>([
    ['AMAZON', createAmazonChannelAdapter(deps)],
    ['MERCADO_LIVRE', createMercadoLivreChannelAdapter(deps)],
    ['SHOPEE', createShopeeChannelAdapter(deps)],
  ]);

  return {
    get(marketplace: Marketplace): IMarketplaceChannelAdapter {
      const adapter = adapters.get(marketplace);
      if (!adapter) throw new Error(`No channel adapter registered for ${marketplace}`);
      return adapter;
    },
  };
}
