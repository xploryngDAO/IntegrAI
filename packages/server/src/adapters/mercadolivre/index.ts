import type { AdapterDependencies, IMarketplaceChannelAdapter } from '@sac/shared';
import { MercadoLivreChannelAdapter } from './MercadoLivreChannelAdapter';

export { MercadoLivreChannelAdapter } from './MercadoLivreChannelAdapter';

/** Builds the Mercado Livre channel adapter (registered in `adapters/registry.ts`). */
export function createMercadoLivreChannelAdapter(
  deps: AdapterDependencies,
): IMarketplaceChannelAdapter {
  return new MercadoLivreChannelAdapter(deps);
}
