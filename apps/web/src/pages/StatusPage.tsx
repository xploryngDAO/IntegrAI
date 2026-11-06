import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Moon, Sun } from 'lucide-react';
import { PageHeader } from '@xploryng/convergencia';
import { api } from '../lib/api';
import { formatDateTimeSeconds } from '../lib/format';
import { useTheme } from '../lib/theme';
import {
  STATUS_POLL_INTERVAL_MS,
  lastErrorLabel,
  latencyLabel,
  levelPresentation,
  normalizeMarketplace,
  rawMarketplaceLabel,
  serviceLabel,
  statusErrorMessage,
  summarizeChannel,
} from '../lib/status';
import type { SystemStatusSnapshot } from '../lib/types';
import { BrandMark } from '../components/layout/BrandMark';
import { Alert, Button, Card, IconButton, MarketplaceBadge, Pill, Skeleton } from '../components/ui';

type LoadMode = 'initial' | 'manual' | 'auto';

/** Services reported by `GET /status`, with the latency of the last check. */
function ServicesCard({
  services,
}: {
  services: SystemStatusSnapshot['services'];
}): JSX.Element {
  return (
    <Card title="Serviços" subtitle="Latência da última verificação, por serviço.">
      {services.length === 0 ? (
        <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
          A API não reportou serviços nesta verificação.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {services.map((service, index) => {
            const name = serviceLabel(service.name);
            const level = levelPresentation(service.status);
            return (
              <li
                key={`${name}-${index}`}
                className="flex items-center justify-between gap-3 border-t border-[var(--cv-color-border)] py-2.5 first:border-t-0 first:pt-0 last:pb-0"
              >
                <span
                  className="min-w-0 truncate text-[var(--cv-font-control)] font-medium"
                  title={name}
                >
                  {name}
                </span>
                <span className="flex flex-none items-center gap-3">
                  <span
                    className="sac-num text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]"
                    title="Latência da verificação"
                  >
                    {latencyLabel(service.latencyMs)}
                  </span>
                  <Pill tone={level.tone}>{level.label}</Pill>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** Marketplace health: healthy/accounts pair + timestamp of the last error. */
function ChannelsCard({
  channels,
}: {
  channels: SystemStatusSnapshot['channels'];
}): JSX.Element {
  return (
    <Card title="Canais" subtitle="Contas conectadas e saúde por marketplace.">
      {channels.length === 0 ? (
        <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
          A API não reportou canais nesta verificação.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {channels.map((channel, index) => {
            const marketplace = normalizeMarketplace(channel.marketplace);
            const summary = summarizeChannel(channel);
            return (
              <li
                key={`${rawMarketplaceLabel(channel.marketplace)}-${index}`}
                className="flex flex-col gap-1.5 border-t border-[var(--cv-color-border)] py-3 first:border-t-0 first:pt-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {marketplace !== null ? (
                    <MarketplaceBadge marketplace={marketplace} />
                  ) : (
                    <Pill tone="neutral">{rawMarketplaceLabel(channel.marketplace)}</Pill>
                  )}
                  <Pill tone={summary.tone}>{summary.label}</Pill>
                </div>
                <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
                  {lastErrorLabel(channel.lastErrorAt)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** First paint: skeletons keep the layout stable while the API answers. */
function StatusSkeleton(): JSX.Element {
  return (
    <>
      <Card title="Estado geral" subtitle="Consultando a API pública…">
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-56" />
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex flex-col gap-2" aria-hidden="true">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </Card>
        <Card>
          <div className="flex flex-col gap-2" aria-hidden="true">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </Card>
      </div>
    </>
  );
}

/**
 * `/status` — public availability page for the new `GET /status` endpoint.
 *
 * Session-free on purpose (App.tsx keeps it in `PUBLIC_PATHS`/`NO_PROBE_PATHS`):
 * it must render before, and without, `/auth/me` — an operator checking whether
 * the platform is down cannot depend on the session that may be broken.
 *
 * Data is polled every 60 s and can be refreshed by hand. A failed request never
 * falls back to simulated values: the real error is shown, and the previous real
 * snapshot stays visible only when explicitly labelled as the last successful
 * check.
 */
export function StatusPage(): JSX.Element {
  const { theme, toggle } = useTheme();

  const [snapshot, setSnapshot] = useState<SystemStatusSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (mode: LoadMode = 'auto'): Promise<void> => {
    // One request at a time: a slow poll must not race a manual refresh.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (mode === 'initial') setLoading(true);
    if (mode === 'manual') setRefreshing(true);

    try {
      const result = await api.status();
      if (!mountedRef.current) return;
      setSnapshot(result);
      setError(null);
    } catch (failure) {
      if (!mountedRef.current) return;
      // Keeps the last real snapshot on screen; the alert states it is stale.
      setError(statusErrorMessage(failure));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load('initial');

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load('auto');
    }, STATUS_POLL_INTERVAL_MS);

    // A tab brought back to the foreground shows fresh data immediately instead
    // of waiting for the next tick (browsers throttle background timers).
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') void load('auto');
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [load]);

  const busy = loading || refreshing;
  const overall = levelPresentation(snapshot?.status);
  const checkedAt = snapshot?.checkedAt ?? '';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[980px] flex-col gap-5 px-4 py-8 sm:px-6">
        <header className="flex items-start justify-between gap-3">
          <BrandMark />
          <IconButton
            label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'}
            icon={theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
            onClick={toggle}
          />
        </header>

        <main className="flex flex-col gap-5">
          <PageHeader
            eyebrow="Disponibilidade"
            title="Status dos sistemas"
            description="Serviços e canais conectados monitorados pela API pública do SAC Hub. Consulta sem login, atualizada automaticamente a cada 60 segundos."
            actions={
              <Button
                variant="secondary"
                icon="pulse"
                loading={busy}
                onClick={() => void load('manual')}
              >
                Atualizar
              </Button>
            }
          />

          {snapshot === null ? (
            loading ? (
              <StatusSkeleton />
            ) : error !== null ? (
              <Card title="Status indisponível" subtitle="A consulta ao endpoint público falhou.">
                <Alert title="Não foi possível carregar o status" tone="danger">
                  <div className="flex flex-col gap-2">
                    <span>{error}</span>
                    <div>
                      <Button
                        size="sm"
                        icon="pulse"
                        loading={busy}
                        onClick={() => void load('manual')}
                      >
                        Tentar novamente
                      </Button>
                    </div>
                  </div>
                </Alert>
              </Card>
            ) : (
              <StatusSkeleton />
            )
          ) : (
            <>
              <Card title="Estado geral" subtitle="Resultado da verificação mais recente.">
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <Pill
                      tone={overall.tone}
                      className="px-3 py-1 text-[var(--cv-font-control)]"
                    >
                      {overall.label}
                    </Pill>
                    <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
                      Verificado em{' '}
                      <time className="sac-num" dateTime={checkedAt || undefined}>
                        {formatDateTimeSeconds(checkedAt)}
                      </time>
                    </span>
                  </div>

                  {error !== null ? (
                    <Alert title="A última atualização falhou" tone="danger">
                      {error} Os valores desta página são da última verificação bem-sucedida, em{' '}
                      <span className="sac-num">{formatDateTimeSeconds(checkedAt)}</span>.
                    </Alert>
                  ) : null}
                </div>
              </Card>

              <div className="grid gap-4 lg:grid-cols-2">
                <ServicesCard services={snapshot.services} />
                <ChannelsCard channels={snapshot.channels} />
              </div>
            </>
          )}
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--cv-color-border)] pt-4 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          <span>Atualização automática a cada 60 segundos.</span>
          <Link
            to="/"
            className="underline-offset-2 hover:text-[var(--cv-color-text)] hover:underline"
          >
            Acessar o workspace
          </Link>
        </footer>
      </div>
    </div>
  );
}
