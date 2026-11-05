import {
  NotFoundError,
  ValidationError,
  type AdapterDependencies,
  type MarketplaceAccountRecord,
} from '@sac/shared';

/** Loads and validates a Mercado Livre account for the adapter entry points. */
export async function loadMeliAccount(
  deps: AdapterDependencies,
  accountId: string,
): Promise<MarketplaceAccountRecord> {
  const account = await deps.repos.accounts.findById(accountId);
  if (!account) throw new NotFoundError('MarketplaceAccount', accountId);
  if (account.marketplace !== 'MERCADO_LIVRE') {
    throw new ValidationError(
      `Conta ${accountId} pertence a ${account.marketplace}, não a MERCADO_LIVRE`,
      { accountId, marketplace: account.marketplace },
    );
  }
  return account;
}
