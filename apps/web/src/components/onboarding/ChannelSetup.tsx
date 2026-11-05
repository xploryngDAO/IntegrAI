import { useEffect, useState } from 'react';
import type { Marketplace } from '@sac/shared';
import { Grid, Icon } from '@xploryng/convergencia';
import { api, ApiClientError } from '../../lib/api';
import type { AccountRow } from '../../lib/types';
import { MARKETPLACE_LABEL, formatDateTime } from '../../lib/labels';
import {
  Alert,
  Button,
  Card,
  MarketplaceBadge,
  Pill,
  Skeleton,
  type PillTone,
} from '../ui';

/** One slug per channel: the same `POST /accounts/oauth/:marketplace/start`. */
const OAUTH_SLUG: Record<Marketplace, 'mercadolivre' | 'shopee' | 'amazon'> = {
  AMAZON: 'amazon',
  MERCADO_LIVRE: 'mercadolivre',
  SHOPEE: 'shopee',
};

const CHANNELS: readonly Marketplace[] = ['AMAZON', 'MERCADO_LIVRE', 'SHOPEE'];

const AMAZON_UNAVAILABLE =
  'A autorização OAuth da Amazon ainda não está habilitada neste ambiente. Fale com o suporte para conectar esta loja.';

interface ChannelFeedback {
  marketplace: Marketplace;
  tone: 'warning' | 'danger';
  title: string;
  message: string;
}

function primaryAccount(accounts: AccountRow[], marketplace: Marketplace): AccountRow | null {
  const matches = accounts.filter((account) => account.marketplace === marketplace);
  if (matches.length === 0) return null;
  return matches.find((account) => account.status === 'ACTIVE') ?? matches[0] ?? null;
}

function statusOf(account: AccountRow | null): { label: string; tone: PillTone } {
  if (!account) return { label: 'Não conectado', tone: 'neutral' };
  if (account.status === 'ACTIVE') return { label: 'Conectado', tone: 'ok' };
  if (account.status === 'TOKEN_EXPIRED') return { label: 'Token expirado', tone: 'warn' };
  return { label: 'Desconectado', tone: 'neutral' };
}

/**
 * Schema caps `displayName` at 120 characters; the operator never types it here
 * (the goal is one click), so the label is derived from the channel.
 */
function defaultDisplayName(marketplace: Marketplace): string {
  return `${MARKETPLACE_LABEL[marketplace]} · Loja principal`.slice(0, 120);
}

function describeFailure(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 0) return error.message;
    if (error.status === 401) return 'Sua sessão expirou. Entre novamente para autorizar a loja.';
    return `A API recusou o início da autorização (HTTP ${error.status}): ${error.message}`;
  }
  return 'Não foi possível falar com a API. Verifique a conexão e tente novamente.';
}

/**
 * The Amazon OAuth endpoint is optional (docs/PHASE2_ONBOARDING.md §2): an
 * unconfigured environment answers 409 `AMAZON_OAUTH_NOT_CONFIGURED`, and a
 * server without the route answers 404/405/422/501.
 */
function isAmazonOAuthUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  if (error.code === 'AMAZON_OAUTH_NOT_CONFIGURED') return true;
  return (
    error.status === 404 || error.status === 405 || error.status === 422 || error.status === 501
  );
}

export interface ChannelSetupProps {
  /** Live `GET /accounts` result owned by the onboarding page. */
  accounts: AccountRow[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

/**
 * Step 2 — connect the stores. Amazon, Mercado Livre and Shopee each get one
 * card with the real account status; Meli/Shopee start the existing OAuth flow,
 * Amazon is offered only when the server advertises the OAuth capability.
 */
export function ChannelSetup({ accounts, loading, error, onRetry }: ChannelSetupProps): JSX.Element {
  const [busy, setBusy] = useState<Marketplace | null>(null);
  const [feedback, setFeedback] = useState<ChannelFeedback | null>(null);
  // `null` = capability unknown (connector list failed), so the click attempts
  // the real call instead of assuming the endpoint is missing.
  const [amazonOAuth, setAmazonOAuth] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .connectors()
      .then((list) => {
        if (!active) return;
        const amazon = list.find((entry) => entry.marketplace === 'AMAZON');
        setAmazonOAuth(
          amazon !== undefined && (amazon.authMode === 'OAUTH2' || amazon.authorizeUrlTemplate != null),
        );
      })
      .catch(() => {
        if (active) setAmazonOAuth(null);
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleConnect(marketplace: Marketplace): Promise<void> {
    if (busy !== null) return;
    setFeedback(null);

    // Known-missing Amazon endpoint: explain instead of firing a call that can
    // only fail. Every other case goes to the real API.
    if (marketplace === 'AMAZON' && amazonOAuth === false) {
      setFeedback({
        marketplace,
        tone: 'warning',
        title: 'Amazon indisponível',
        message: AMAZON_UNAVAILABLE,
      });
      return;
    }

    setBusy(marketplace);
    try {
      const { authorizeUrl } = await api.startOAuth(
        OAUTH_SLUG[marketplace],
        defaultDisplayName(marketplace),
      );
      if (typeof authorizeUrl !== 'string' || authorizeUrl.length === 0) {
        setFeedback({
          marketplace,
          tone: 'danger',
          title: 'Autorização não iniciada',
          message: 'A API não devolveu a URL de autorização. Tente novamente em instantes.',
        });
        return;
      }
      // Full-page hand-off to the provider; the OAuth callback returns to /accounts.
      window.location.assign(authorizeUrl);
    } catch (error) {
      if (marketplace === 'AMAZON' && isAmazonOAuthUnavailable(error)) {
        setAmazonOAuth(false);
        setFeedback({
          marketplace,
          tone: 'warning',
          title: 'Amazon indisponível',
          message: AMAZON_UNAVAILABLE,
        });
        return;
      }
      setFeedback({
        marketplace,
        tone: 'danger',
        title: 'Não foi possível iniciar a autorização',
        message: describeFailure(error),
      });
    } finally {
      setBusy(null);
    }
  }

  const connectedCount = accounts.filter((account) => account.status === 'ACTIVE').length;
  const expiredCount = accounts.filter((account) => account.status === 'TOKEN_EXPIRED').length;

  if (loading && accounts.length === 0) {
    return (
      <Grid min={300} aria-busy="true">
        {CHANNELS.map((marketplace) => (
          <Card key={marketplace}>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-7 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-10 w-full" />
            </div>
          </Card>
        ))}
      </Grid>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={connectedCount > 0 ? 'ok' : 'neutral'}>
          <span className="inline-flex items-center gap-1">
            <Icon name={connectedCount > 0 ? 'check' : 'pause'} size={11} /> {connectedCount}{' '}
            conectada(s)
          </span>
        </Pill>
        {expiredCount > 0 ? <Pill tone="warn">{expiredCount} token(s) expirado(s)</Pill> : null}
        <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          {accounts.length} loja(s) neste workspace
        </span>
      </div>

      {error !== null ? (
        <div className="flex flex-col items-start gap-2">
          <Alert title="Não foi possível ler as lojas conectadas" tone="danger">
            {error}
          </Alert>
          <Button variant="secondary" size="sm" icon="pulse" onClick={onRetry}>
            Tentar novamente
          </Button>
        </div>
      ) : null}

      <Grid min={300}>
        {CHANNELS.map((marketplace) => {
          const account = primaryAccount(accounts, marketplace);
          const status = statusOf(account);
          const channelFeedback = feedback?.marketplace === marketplace ? feedback : null;
          const tokenExpiry = account?.tokenExpiresAt ?? null;

          return (
            <Card
              key={marketplace}
              title={
                <span className="flex items-center gap-2">
                  <MarketplaceBadge marketplace={marketplace} compact />
                  <span>{MARKETPLACE_LABEL[marketplace]}</span>
                </span>
              }
              subtitle={account ? account.displayName : 'Nenhuma loja conectada'}
              actions={<Pill tone={status.tone}>{status.label}</Pill>}
              footer={
                <>
                  <span className="min-w-0 truncate text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
                    {account
                      ? `Token expira ${formatDateTime(tokenExpiry)}`
                      : 'OAuth 2.0 · tokens cifrados'}
                  </span>
                  <Button
                    variant={account ? 'secondary' : 'primary'}
                    size="sm"
                    icon="link"
                    loading={busy === marketplace}
                    disabled={busy !== null && busy !== marketplace}
                    aria-label={`${account ? 'Reconectar' : 'Conectar'} ${MARKETPLACE_LABEL[marketplace]}`}
                    onClick={() => void handleConnect(marketplace)}
                  >
                    {account ? 'Reconectar' : 'Conectar'}
                  </Button>
                </>
              }
            >
              <div className="mt-1 flex flex-col gap-2">
                <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
                  {marketplace === 'AMAZON'
                    ? 'A Amazon autoriza a loja pelo Seller Central. A conexão exige um app aprovado no SP-API.'
                    : `Autorize a loja no portal do ${MARKETPLACE_LABEL[marketplace]} para receber mensagens e pedidos aqui.`}
                </p>

                {marketplace === 'AMAZON' &&
                amazonOAuth === false &&
                channelFeedback === null ? (
                  <p className="m-0 flex items-start gap-1.5 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-warning)]">
                    <Icon name="bell" size={12} style={{ marginTop: 1, flex: 'none' }} />
                    OAuth da Amazon indisponível neste ambiente. Fale com o suporte para conectar
                    esta loja.
                  </p>
                ) : null}

                {account?.status === 'TOKEN_EXPIRED' ? (
                  <p className="m-0 flex items-start gap-1.5 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-warning)]">
                    <Icon name="bell" size={12} style={{ marginTop: 1, flex: 'none' }} />
                    O token expirou. Reconecte para retomar a sincronização deste canal.
                  </p>
                ) : null}

                {channelFeedback ? (
                  <Alert title={channelFeedback.title} tone={channelFeedback.tone}>
                    {channelFeedback.message}
                  </Alert>
                ) : null}
              </div>
            </Card>
          );
        })}
      </Grid>

      <p className="m-0 flex items-start gap-1.5 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
        <Icon name="lock" size={12} style={{ marginTop: 1, flex: 'none' }} />
        Os tokens ficam cifrados no servidor e são renovados automaticamente. Você pode conectar mais
        de uma loja por canal em Canais.
      </p>
    </div>
  );
}
