import type { AccountDiagnosis, ChannelHealthView, DiagnosisStatus, Marketplace } from '@sac/shared';
import { Icon } from '@xploryng/convergencia';
import type { AccountRow } from '../../lib/types';
import { api } from '../../lib/api';
import { useWorkspace } from '../../lib/store';
import { MARKETPLACE_LABEL, formatDateTime } from '../../lib/labels';
import { plural } from '../../lib/plural';
import { Button, Card, MarketplaceBadge, Pill, Spinner } from '../ui';

/**
 * Re-reads `GET /accounts` and patches the store directly: `boot()` is
 * single-shot (shell bootstrap) and must not be re-run for a local refresh.
 */
export async function reloadAccounts(): Promise<void> {
  try {
    const accounts = await api.listAccounts();
    useWorkspace.setState({ accounts });
  } catch {
    // Keep the previous list; the mutation already reported its outcome.
  }
}

const DIAGNOSIS_LABEL: Record<DiagnosisStatus, string> = {
  ok: 'Conectado',
  warn: 'Atenção',
  fail: 'Falha na conexão',
  skipped: 'Não verificado',
};

const DIAGNOSIS_TONE: Record<DiagnosisStatus, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'danger',
  skipped: 'neutral',
};

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** Status pill is driven by the last real diagnosis; account status is the fallback. */
function statusPill(account: AccountRow | null, diagnosis: AccountDiagnosis | null): JSX.Element {
  if (diagnosis) {
    return (
      <Pill
        tone={DIAGNOSIS_TONE[diagnosis.overall]}
        title={`Diagnóstico real de ${formatDateTime(diagnosis.testedAt)}`}
      >
        {DIAGNOSIS_LABEL[diagnosis.overall]}
      </Pill>
    );
  }
  if (!account || account.status === 'DISCONNECTED') return <Pill tone="neutral">Desconectado</Pill>;
  if (account.status === 'TOKEN_EXPIRED') return <Pill tone="warn">Token expirado</Pill>;
  return <Pill tone="ok">Conectado</Pill>;
}

function HealthDot({ ok }: { ok: boolean }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full"
      style={{ background: ok ? 'var(--cv-color-success)' : 'var(--cv-color-danger)' }}
      aria-hidden="true"
    />
  );
}

export interface ConnectorCardProps {
  marketplace: Marketplace;
  account: AccountRow | null;
  /** Live channel health for this account (from `GET /channels/health`). */
  health?: ChannelHealthView | null;
  /** Last real diagnosis for this account (`POST /accounts/:id/diagnose`). */
  diagnosis?: AccountDiagnosis | null;
  /** True while this account's diagnosis request is in flight. */
  diagnosing?: boolean;
  /** Number of extra stores connected on this marketplace (beyond the shown one). */
  extraAccounts?: number;
  busy?: boolean;
  onReconnect: (marketplace: Marketplace) => void;
  onDiagnose: (account: AccountRow) => void;
  onRefreshToken: (account: AccountRow) => void;
  onDisconnect: (account: AccountRow) => void;
  className?: string;
}

/** One marketplace connector card: identity, health, real diagnosis and actions. */
export function ConnectorCard({
  marketplace,
  account,
  health,
  diagnosis = null,
  diagnosing = false,
  extraAccounts = 0,
  busy,
  onReconnect,
  onDiagnose,
  onRefreshToken,
  onDisconnect,
  className,
}: ConnectorCardProps): JSX.Element {
  const lastSync = account
    ? pickString(account.channelConfig, ['last_synced_at', 'lastSyncAt', 'last_sync_at'])
    : null;
  const tokenExpiresAt = account?.tokenExpiresAt ?? null;
  const tokenExpired =
    account?.status === 'TOKEN_EXPIRED' ||
    (tokenExpiresAt ? Date.parse(tokenExpiresAt) < Date.now() : false);
  const idLabel = marketplace === 'SHOPEE' ? 'Shop ID' : 'Seller ID';

  return (
    <Card
      className={className}
      title={
        <span className="flex items-center gap-2">
          <MarketplaceBadge marketplace={marketplace} compact />
          <span>{MARKETPLACE_LABEL[marketplace]}</span>
        </span>
      }
      subtitle={account ? account.displayName : 'Nenhuma loja conectada'}
      actions={
        busy ? <Spinner label="Atualizando" /> : statusPill(account, diagnosis)
      }
      footer={
        <>
          <span className="text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
            {extraAccounts > 0
              ? `+${plural(extraAccounts, 'loja', 'lojas')} neste canal`
              : 'Token cifrado em repouso'}
          </span>
          <Button
            variant={account ? 'secondary' : 'primary'}
            size="sm"
            icon="link"
            disabled={busy}
            onClick={() => onReconnect(marketplace)}
          >
            {account ? 'Reconectar' : 'Conectar'}
          </Button>
        </>
      }
    >
      <dl className="mt-1 flex flex-col gap-1.5">
        <div className="sac-kv">
          <dt>{idLabel}</dt>
          <dd className="sac-num truncate" title={account?.externalSellerId ?? '—'}>
            {account?.externalSellerId ?? '—'}
          </dd>
        </div>
        <div className="sac-kv">
          <dt>Site</dt>
          <dd className="sac-num">{account?.marketplaceSiteId ?? '—'}</dd>
        </div>
        <div className="sac-kv">
          <dt>Token expira</dt>
          <dd className={`sac-num ${tokenExpired ? 'text-[var(--cv-color-danger)]' : ''}`}>
            {formatDateTime(tokenExpiresAt)}
          </dd>
        </div>
        <div className="sac-kv">
          <dt>Último sync</dt>
          <dd className="sac-num">{formatDateTime(lastSync)}</dd>
        </div>
      </dl>

      {health ? (
        <div className="mt-2 flex flex-col gap-1 border-t border-[var(--cv-color-border)] pt-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
            <span className="inline-flex items-center gap-1">
              <HealthDot ok={health.inboundHealthy} /> entrada
            </span>
            <span className="inline-flex items-center gap-1">
              <HealthDot ok={health.outboundHealthy} /> saída
            </span>
            {health.crrPercent !== null ? (
              <span className="sac-num">CRR {Math.round(health.crrPercent)}%</span>
            ) : null}
          </div>
          <p className="m-0 truncate text-[var(--cv-font-micro)]" title={health.detail}>
            {health.detail}
          </p>
        </div>
      ) : null}

      {diagnosis ? (
        <div className="mt-2 flex flex-col gap-1 border-t border-[var(--cv-color-border)] pt-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
            <Icon name="clock" size={12} />
            <span className="sac-num">Diagnóstico {formatDateTime(diagnosis.testedAt)}</span>
            {account ? (
              <button
                type="button"
                className="cv-link ml-auto shrink-0 text-[var(--cv-font-micro)]"
                onClick={() => onDiagnose(account)}
              >
                ver checks
              </button>
            ) : null}
          </div>
          {diagnosis.overall === 'fail' ? (
            <div
              className="flex items-start gap-1.5 rounded-[var(--cv-radius-small)] border px-2 py-1.5 text-[var(--cv-font-micro)] leading-snug"
              style={{
                borderColor: 'color-mix(in srgb, var(--cv-color-danger) 32%, transparent)',
                background: 'var(--cv-color-danger-soft)',
                color: 'var(--cv-color-danger)',
              }}
            >
              <Icon name="close" size={12} style={{ marginTop: 1, flex: 'none' }} />
              Diagnóstico reprovado — corrija os checks antes de operar este canal.
            </div>
          ) : null}
          {diagnosis.overall === 'warn' ? (
            <div
              className="flex items-start gap-1.5 rounded-[var(--cv-radius-small)] border px-2 py-1.5 text-[var(--cv-font-micro)] leading-snug"
              style={{
                borderColor: 'color-mix(in srgb, var(--cv-color-warning) 32%, transparent)',
                background: 'var(--cv-color-warning-soft)',
                color: 'var(--cv-color-warning)',
              }}
            >
              <Icon name="bell" size={12} style={{ marginTop: 1, flex: 'none' }} />
              Canal opera com avisos — veja as remediações no diagnóstico.
            </div>
          ) : null}
        </div>
      ) : null}

      {account?.status === 'TOKEN_EXPIRED' ? (
        <div
          className="mt-2 flex items-start gap-1.5 rounded-[var(--cv-radius-small)] border px-2 py-1.5 text-[var(--cv-font-micro)] leading-snug"
          style={{
            borderColor: 'color-mix(in srgb, var(--cv-color-warning) 32%, transparent)',
            background: 'var(--cv-color-warning-soft)',
            color: 'var(--cv-color-warning)',
          }}
        >
          <Icon name="bell" size={12} />
          Renove o token para retomar o envio e a sincronização deste canal.
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-[var(--cv-color-border)] pt-2">
        <Button
          variant="secondary"
          size="sm"
          icon="pulse"
          disabled={!account || busy}
          loading={diagnosing}
          onClick={() => {
            if (account) onDiagnose(account);
          }}
        >
          Testar conexão
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="clock"
          disabled={!account || busy}
          onClick={() => {
            if (account) onRefreshToken(account);
          }}
        >
          Atualizar token
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="close"
          disabled={!account || busy}
          onClick={() => {
            if (account) onDisconnect(account);
          }}
        >
          Desconectar
        </Button>
      </div>
    </Card>
  );
}
