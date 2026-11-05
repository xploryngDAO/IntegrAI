import type { AccountDiagnosis, ChannelHealthView, Marketplace } from '@sac/shared';
import type { AccountRow } from '../../lib/types';
import { Grid } from '@xploryng/convergencia';
import { ConnectorCard } from './ConnectorCard';

const MARKETPLACES: readonly Marketplace[] = ['AMAZON', 'MERCADO_LIVRE', 'SHOPEE'];

export interface LinkedAccountsListProps {
  accounts: AccountRow[];
  health?: ChannelHealthView[];
  /** Last real diagnosis per accountId (store `accountDiagnoses` + system channels). */
  diagnoses?: Record<string, AccountDiagnosis>;
  diagnosingAccountId?: string | null;
  busyMarketplace?: Marketplace | null;
  onReconnect: (marketplace: Marketplace) => void;
  onDiagnose: (account: AccountRow) => void;
  onRefreshToken: (account: AccountRow) => void;
  onDisconnect: (account: AccountRow) => void;
}

/** Prefer a live account as the card subject; extras are counted below it. */
function primaryAccountFor(accounts: AccountRow[], marketplace: Marketplace): AccountRow | null {
  const matches = accounts.filter((account) => account.marketplace === marketplace);
  if (matches.length === 0) return null;
  return matches.find((account) => account.status === 'ACTIVE') ?? matches[0] ?? null;
}

/**
 * Three connector cards (one per channel) on top of the Convergência Grid.
 * Extra stores on the same marketplace are summarised inside the card.
 */
export function LinkedAccountsList({
  accounts,
  health = [],
  diagnoses = {},
  diagnosingAccountId = null,
  busyMarketplace = null,
  onReconnect,
  onDiagnose,
  onRefreshToken,
  onDisconnect,
}: LinkedAccountsListProps): JSX.Element {
  return (
    <Grid min={300}>
      {MARKETPLACES.map((marketplace) => {
        const channelAccounts = accounts.filter((account) => account.marketplace === marketplace);
        const primary = primaryAccountFor(accounts, marketplace);
        return (
          <ConnectorCard
            key={marketplace}
            marketplace={marketplace}
            account={primary}
            health={health.find((entry) => entry.marketplace === marketplace) ?? null}
            diagnosis={primary ? diagnoses[primary.id] ?? null : null}
            diagnosing={Boolean(primary && diagnosingAccountId === primary.id)}
            extraAccounts={Math.max(0, channelAccounts.length - 1)}
            busy={busyMarketplace === marketplace}
            onReconnect={onReconnect}
            onDiagnose={onDiagnose}
            onRefreshToken={onRefreshToken}
            onDisconnect={onDisconnect}
          />
        );
      })}
    </Grid>
  );
}
