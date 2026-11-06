import { useEffect, useState } from 'react';
import { Grid, Heading, StatCard } from '@xploryng/convergencia';
import { api, ApiClientError } from '../../lib/api';
import { adminOverviewErrorMessage, adminOverviewMarketplaces } from '../../lib/admin';
import type { AdminOverview as AdminOverviewData } from '../../lib/types';
import { Alert, Button, Card, Skeleton } from '../ui';

export interface AdminOverviewProps {
  /**
   * Page-level refresh counter. The header "Atualizar" increments it, and so do
   * the tabs after a write that changes a counter (invite, role, session…).
   */
  refreshKey?: number;
  /** A 403 on the overview turns the whole `/admin` page into "Acesso restrito". */
  onForbidden: () => void;
}

/**
 * One secondary counter of a card ("Ativos", "Não lidos", "Amazon"…).
 *
 * A `dt`/`dd` pair: the metric name and its number. Rendered inside the `dl`
 * each card owns, with the first row without a divider.
 */
function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-[var(--cv-color-border)] pt-2 first:border-t-0 first:pt-0">
      <dt className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">{label}</dt>
      <dd className="sac-num m-0 text-[var(--cv-font-meta)] font-medium">{value}</dd>
    </div>
  );
}

/** Six placeholder cards: the grid the real counters will occupy. */
function OverviewSkeleton(): JSX.Element {
  return (
    <Grid min={320} aria-busy="true">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <Card key={index}>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </Card>
      ))}
    </Grid>
  );
}

/**
 * "Visão geral" of `/admin` — the workspace snapshot rendered above the tabs
 * (`GET /admin/overview`, ADMIN).
 *
 * Six cards, one per domain the page administers: operators (total/active/
 * admins), active sessions, pending invitations, marketplace accounts
 * (total/connected plus the breakdown per channel), tickets (total/unread/
 * unassigned) and the audit trail volume of the last 24h.
 *
 * The counters are the API's own aggregates — the card never derives a number
 * from a list it did not fully read. `api.adminOverview` normalises the payload
 * (absent → `0`, negative → `0`), so a deployment behind the contract still
 * renders a coherent snapshot instead of `NaN`/`-1`/blank cells.
 *
 * States: skeleton on the first read (a later refresh keeps the numbers on
 * screen while `aria-busy` marks the section), the real API error with a
 * "Tentar novamente" on failure, and "Acesso restrito" through `onForbidden` on
 * 403 — the page never loops a forbidden call. Every new `refreshKey` re-reads
 * the route.
 */
export function AdminOverview({ refreshKey = 0, onForbidden }: AdminOverviewProps): JSX.Element {
  const [data, setData] = useState<AdminOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;

    async function loadOverview(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const overview = await api.adminOverview();
        if (!active) return;
        setData(overview);
      } catch (failure) {
        if (!active) return;
        if (failure instanceof ApiClientError && failure.status === 403) {
          onForbidden();
          return;
        }
        // A stale snapshot labelled as "now" would be worse than the error:
        // the last good numbers are dropped and the retry is offered.
        setData(null);
        setError(adminOverviewErrorMessage(failure));
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadOverview();
    return () => {
      active = false;
    };
  }, [onForbidden, refreshKey, reloadKey]);

  function reload(): void {
    setReloadKey((key) => key + 1);
  }

  const showSkeleton = loading && data === null;
  const marketplaces =
    data === null ? [] : adminOverviewMarketplaces(data.accounts.byMarketplace);

  return (
    <section
      className="sac-admin-overview flex flex-col gap-3"
      aria-labelledby="sac-admin-overview-title"
      aria-busy={loading ? 'true' : undefined}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <Heading level={2} id="sac-admin-overview-title" className="mb-0">
          Visão geral
        </Heading>
        <span className="text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
          {loading
            ? 'Atualizando os números do workspace…'
            : 'Números do workspace · atualiza com “Atualizar” e após alterações na equipe.'}
        </span>
      </div>

      {showSkeleton ? (
        <OverviewSkeleton />
      ) : error !== null ? (
        <Alert title="Não foi possível carregar a visão geral" tone="danger">
          <div className="flex flex-col gap-2">
            <span>{error}</span>
            <div>
              <Button size="sm" icon="pulse" onClick={reload}>
                Tentar novamente
              </Button>
            </div>
          </div>
        </Alert>
      ) : data === null ? null : (
        <Grid min={320}>
          <Card>
            <StatCard
              label="Usuários"
              value={String(data.users.total)}
              detail="operadores no workspace"
              icon="users"
            />
            <dl className="m-0 mt-3 flex flex-col gap-2">
              <Metric label="Ativos" value={data.users.active} />
              <Metric label="Administradores" value={data.users.admins} />
            </dl>
          </Card>

          <Card>
            <StatCard
              label="Sessões ativas"
              value={String(data.sessions.active)}
              detail="dispositivos com refresh token válido"
              icon="devices"
            />
          </Card>

          <Card>
            <StatCard
              label="Convites pendentes"
              value={String(data.invitations.pending)}
              detail="links de convite aguardando aceite"
              icon="link"
            />
          </Card>

          <Card>
            <StatCard
              label="Contas"
              value={String(data.accounts.total)}
              detail="contas de marketplace no workspace"
              icon="network"
            />
            <dl className="m-0 mt-3 flex flex-col gap-2">
              <Metric label="Conectadas" value={data.accounts.connected} />
              {marketplaces.map((marketplace) => (
                <Metric key={marketplace.key} label={marketplace.label} value={marketplace.count} />
              ))}
            </dl>
          </Card>

          <Card>
            <StatCard
              label="Tickets"
              value={String(data.tickets.total)}
              detail="chamados de compradores no workspace"
              icon="chat"
            />
            <dl className="m-0 mt-3 flex flex-col gap-2">
              <Metric label="Não lidos" value={data.tickets.unread} />
              <Metric label="Sem responsável" value={data.tickets.unassigned} />
            </dl>
          </Card>

          <Card>
            <StatCard
              label="Eventos de auditoria"
              value={String(data.audit.last24h)}
              detail="ações administrativas nas últimas 24 horas"
              icon="book"
            />
          </Card>
        </Grid>
      )}

      <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
        Somente um ADMIN do workspace vê estes contadores; a API revalida o papel em cada chamada
        e os números refletem o estado atual do workspace.
      </p>
    </section>
  );
}
