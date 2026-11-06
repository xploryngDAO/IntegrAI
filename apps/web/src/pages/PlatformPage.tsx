import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { DataTable, Grid, PageHeader, Pagination, StatCard } from '@xploryng/convergencia';
import type { Marketplace } from '@sac/shared';
import { api } from '../lib/api';
import type { PlatformMetrics, PlatformTenant } from '../lib/types';
import { MARKETPLACE_LABEL, MARKETPLACE_ORDER, formatDate } from '../lib/labels';
import {
  ENTERPRISE_UNLIMITED,
  isForbiddenError,
  planLabel,
  platformErrorMessage,
  formatLimit,
  tenantStatusLabel,
  tenantStatusTone,
} from '../lib/platform';
import { Alert, Button, Card, EmptyState, Pill, SearchField, Skeleton } from '../components/ui';
import { EditTenantDialog } from '../components/platform/EditTenantDialog';

const PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;
/** `GET /platform/tenants` caps `pageSize` at 100. */
const SEARCH_PAGE_SIZE = 100;

function asCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
  }
  return 0;
}

/** Accent-insensitive, case-insensitive name/slug match (client-side fallback). */
function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

function matchesSearch(tenant: PlatformTenant, query: string): boolean {
  const needle = normalizeSearch(query);
  if (needle.length === 0) return true;
  return [tenant.name, tenant.slug].some((value) => normalizeSearch(value ?? '').includes(needle));
}

/** Compact quota for the table (`∞` = ENTERPRISE ceiling). */
function quotaLabel(value: number): string {
  return value >= ENTERPRISE_UNLIMITED ? '∞' : String(value);
}

/**
 * `/platform` — Fase 4 internal console (ROADMAP Fase 4).
 *
 * Data comes only from the real platform API: global counters, a paginated
 * tenant table with a server-side name filter and the plan/limits editor. The
 * server is the guard: a `403` anywhere renders the "sem permissão" state and
 * never breaks the workspace gate.
 */
export function PlatformPage(): JSX.Element {
  const navigate = useNavigate();

  const [metrics, setMetrics] = useState<PlatformMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  const [tenants, setTenants] = useState<PlatformTenant[]>([]);
  const [serverTotal, setServerTotal] = useState(0);
  const [serverTotalPages, setServerTotalPages] = useState(1);
  const [tenantsLoading, setTenantsLoading] = useState(true);
  const [tenantsError, setTenantsError] = useState<string | null>(null);

  const [forbidden, setForbidden] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<PlatformTenant | null>(null);

  const retry = useCallback((): void => {
    setReloadKey((key) => key + 1);
  }, []);

  // Server-side filter: debounce so typing does not fire one request per key.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;

    async function loadMetrics(): Promise<void> {
      setMetricsLoading(true);
      setMetricsError(null);
      try {
        const result = await api.platformMetrics();
        if (active) setMetrics(result);
      } catch (error) {
        if (!active) return;
        if (isForbiddenError(error)) setForbidden(true);
        else setMetricsError(platformErrorMessage(error));
      } finally {
        if (active) setMetricsLoading(false);
      }
    }

    void loadMetrics();
    return () => {
      active = false;
    };
  }, [reloadKey]);

  // The console API paginates but has no `search` query yet. While filtering we
  // fetch one page of up to 100 tenants and filter/paginate locally; the param is
  // still sent so a future server-side filter is picked up without a UI change.
  const filtering = debouncedSearch.length > 0;
  const requestPage = filtering ? 1 : page;
  const requestPageSize = filtering ? SEARCH_PAGE_SIZE : PAGE_SIZE;

  useEffect(() => {
    let active = true;

    async function loadTenants(): Promise<void> {
      setTenantsLoading(true);
      setTenantsError(null);
      try {
        const payload = await api.platformTenants({
          page: requestPage,
          pageSize: requestPageSize,
          search: debouncedSearch.length > 0 ? debouncedSearch : undefined,
        });
        if (!active) return;
        const items = Array.isArray(payload.items) ? payload.items : [];
        const resolvedTotal =
          typeof payload.total === 'number' && Number.isFinite(payload.total)
            ? payload.total
            : items.length;
        const computedPages =
          typeof payload.totalPages === 'number' && payload.totalPages > 0
            ? payload.totalPages
            : Math.max(1, Math.ceil(resolvedTotal / requestPageSize));
        setTenants(items);
        setServerTotal(resolvedTotal);
        setServerTotalPages(computedPages);
      } catch (error) {
        if (!active) return;
        if (isForbiddenError(error)) setForbidden(true);
        else {
          setTenants([]);
          setServerTotal(0);
          setServerTotalPages(1);
          setTenantsError(platformErrorMessage(error));
        }
      } finally {
        if (active) setTenantsLoading(false);
      }
    }

    void loadTenants();
    return () => {
      active = false;
    };
  }, [debouncedSearch, reloadKey, requestPage, requestPageSize]);

  const filteredTenants = useMemo(
    () => (filtering ? tenants.filter((tenant) => matchesSearch(tenant, debouncedSearch)) : tenants),
    [debouncedSearch, filtering, tenants],
  );
  const filteredPages = filtering
    ? Math.max(1, Math.ceil(filteredTenants.length / PAGE_SIZE))
    : serverTotalPages;
  const safePage = Math.min(Math.max(1, page), filteredPages);
  const visibleTenants = useMemo(
    () =>
      filtering
        ? filteredTenants.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
        : filteredTenants,
    [filteredTenants, filtering, safePage],
  );
  const displayedTotal = filtering ? filteredTenants.length : serverTotal;

  const marketplaceUsage: Partial<Record<Marketplace, number>> =
    metrics?.accountsByMarketplace ?? {};
  const accountsTotal = MARKETPLACE_ORDER.reduce(
    (sum, marketplace) => sum + asCount(marketplaceUsage[marketplace]),
    0,
  );
  const marketplaceBreakdown = MARKETPLACE_ORDER.map(
    (marketplace) => `${MARKETPLACE_LABEL[marketplace]} ${asCount(marketplaceUsage[marketplace])}`,
  ).join(' · ');

  const rows = useMemo<Record<string, ReactNode>[]>(
    () =>
      visibleTenants.map((tenant) => ({
        name: <strong className="font-medium">{tenant.name || '—'}</strong>,
        slug: <span className="sac-num">{tenant.slug || '—'}</span>,
        plan: <Pill tone="accent">{planLabel(tenant.plan)}</Pill>,
        usage: (
          <span
            className="sac-num"
            title={`${tenant.counts.accounts} conta(s) de ${formatLimit(tenant.limits.maxAccounts)} · ${tenant.counts.agents} agente(s) de ${formatLimit(tenant.limits.maxAgents)} · ${tenant.counts.tickets} ticket(s)`}
          >
            {tenant.counts.accounts}/{quotaLabel(tenant.limits.maxAccounts)} contas ·{' '}
            {tenant.counts.agents}/{quotaLabel(tenant.limits.maxAgents)} agentes
          </span>
        ),
        status: (
          <Pill tone={tenantStatusTone(tenant.status)}>{tenantStatusLabel(tenant.status)}</Pill>
        ),
        createdAt: formatDate(tenant.createdAt),
        actions: (
          <Button
            size="sm"
            variant="ghost"
            icon="sliders"
            onClick={() => setEditing(tenant)}
            aria-label={`Editar plano de ${tenant.name}`}
          >
            Editar
          </Button>
        ),
      })),
    [visibleTenants],
  );

  const columns = [
    { key: 'name', label: 'Nome' },
    { key: 'slug', label: 'Slug' },
    { key: 'plan', label: 'Plano' },
    { key: 'usage', label: 'Contas / agentes' },
    { key: 'status', label: 'Status' },
    { key: 'createdAt', label: 'Criado em' },
    { key: 'actions', label: 'Ações' },
  ];

  const busy = metricsLoading || tenantsLoading;

  if (forbidden) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
        <PageHeader
          eyebrow="Plataforma"
          title="Console da plataforma"
          description="Área restrita à equipe da plataforma. Os dados são servidos apenas para contas autorizadas."
        />
        <Card>
          <EmptyState
            icon="lock"
            title="Sem permissão"
            description="Sua conta não tem acesso ao console da plataforma (HTTP 403). Se isso não for esperado, peça a um administrador para revisar o seu papel de acesso."
            action={
              <Button variant="primary" icon="arrow" onClick={() => navigate('/', { replace: false })}>
                Voltar para a fila
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <PageHeader
        eyebrow="Plataforma"
        title="Console da plataforma"
        description="Métricas globais dos tenants, uso por marketplace, fila de atendimento e o plano/limites de cada workspace."
        actions={
          <Button variant="secondary" icon="pulse" loading={busy} onClick={retry}>
            Atualizar
          </Button>
        }
      />

      {metricsLoading ? (
        <Grid min={210} aria-busy="true">
          {[0, 1, 2, 3].map((index) => (
            <Card key={index}>
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-8 w-1/3" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </Card>
          ))}
        </Grid>
      ) : metricsError !== null ? (
        <Alert title="Não foi possível carregar as métricas" tone="danger">
          <div className="flex flex-col gap-2">
            <span>{metricsError}</span>
            <div>
              <Button size="sm" icon="pulse" onClick={retry}>
                Tentar novamente
              </Button>
            </div>
          </div>
        </Alert>
      ) : (
        <Grid min={210}>
          <Card>
            <StatCard
              label="Tenants ativos"
              value={metrics === null ? '—' : String(asCount(metrics.activeTenants))}
              detail={
                typeof metrics?.totalTenants === 'number'
                  ? `de ${asCount(metrics.totalTenants)} workspaces no total`
                  : 'workspaces operando na plataforma'
              }
              icon="users"
            />
          </Card>
          <Card>
            <StatCard
              label="Contas por marketplace"
              value={String(accountsTotal)}
              detail={marketplaceBreakdown}
              icon="network"
            />
          </Card>
          <Card>
            <StatCard
              label="Tickets abertos"
              value={metrics === null ? '—' : String(asCount(metrics.openTickets))}
              detail={
                typeof metrics?.messagesLast24h === 'number'
                  ? `fila global · ${asCount(metrics.messagesLast24h)} mensagens em 24h`
                  : 'fila global de atendimento'
              }
              icon="chat"
            />
          </Card>
          <Card>
            <StatCard
              label="SLA em risco"
              value={metrics === null ? '—' : String(asCount(metrics.slaAtRisk))}
              detail={
                typeof metrics?.slaRiskHorizonMinutes === 'number'
                  ? `atendimentos com prazo em até ${asCount(metrics.slaRiskHorizonMinutes)} min`
                  : 'atendimentos próximos do prazo'
              }
              icon="clock"
            />
          </Card>
        </Grid>
      )}

      <Card
        title="Tenants"
        subtitle="Plano, uso e status de cada workspace. O filtro por nome/slug atua sobre os tenants carregados."
      >
        <div className="flex flex-col gap-3">
          <SearchField
            className="w-full sm:max-w-sm"
            label="Filtrar por nome"
            value={search}
            placeholder="Nome ou slug do tenant"
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
          />

          {filtering && !tenantsLoading && serverTotal > tenants.length ? (
            <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
              O filtro cobre os {tenants.length} tenants carregados (de {serverTotal}). Remova o
              filtro para navegar por todas as páginas.
            </p>
          ) : null}

          {tenantsLoading ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              {[0, 1, 2, 3, 4].map((index) => (
                <Skeleton key={index} className="h-8 w-full" />
              ))}
            </div>
          ) : tenantsError !== null ? (
            <Alert title="Não foi possível carregar os tenants" tone="danger">
              <div className="flex flex-col gap-2">
                <span>{tenantsError}</span>
                <div>
                  <Button size="sm" icon="pulse" onClick={retry}>
                    Tentar novamente
                  </Button>
                </div>
              </div>
            </Alert>
          ) : (
            <>
              {visibleTenants.length > 0 ? (
                <DataTable
                  caption={`Tenants da plataforma — ${displayedTotal} encontrado(s)`}
                  columns={columns}
                  rows={rows}
                />
              ) : (
                <EmptyState
                  icon="search"
                  title="Nenhum tenant encontrado"
                  description={
                    filtering
                      ? `Nenhum workspace corresponde a "${debouncedSearch}". Ajuste o filtro ou limpe a busca.`
                      : 'A plataforma ainda não tem tenants cadastrados.'
                  }
                  action={
                    filtering ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setSearch('');
                          setPage(1);
                        }}
                      >
                        Limpar filtro
                      </Button>
                    ) : undefined
                  }
                />
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
                  {displayedTotal} tenant(s) · página {safePage} de {filteredPages}
                </span>
                <Pagination
                  page={safePage}
                  total={filteredPages}
                  onPageChange={(next) => {
                    setPage(Math.min(Math.max(1, next), filteredPages));
                  }}
                />
              </div>
            </>
          )}
        </div>
      </Card>

      {editing ? (
        <EditTenantDialog
          tenant={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            // Re-read both endpoints: the PATCH response may be a partial row and
            // the global counters can change with the new quota.
            setReloadKey((key) => key + 1);
          }}
        />
      ) : null}
    </div>
  );
}
