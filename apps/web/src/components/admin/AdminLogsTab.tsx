import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DataTable, Pagination } from '@xploryng/convergencia';
import { api, ApiClientError } from '../../lib/api';
import {
  adminErrorMessage,
  auditActionLabel,
  compactId,
  endOfDayIso,
  formatAuditMetadata,
  startOfDayIso,
} from '../../lib/admin';
import { formatDateTimeSeconds } from '../../lib/format';
import type { AdminUser, AuditLogEntry } from '../../lib/types';
import { Alert, Button, Card, EmptyState, Input, Select, Skeleton } from '../ui';

const PER_PAGE = 25;

/** Fallback name when the API omits `Content-Disposition`: `auditoria-<YYYY-MM-DD>.csv`. */
function defaultExportName(): string {
  return `auditoria-${new Date().toISOString().slice(0, 10)}.csv`;
}

interface AppliedFilters {
  action: string;
  actorId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: AppliedFilters = { action: '', actorId: '', from: '', to: '' };

export interface AdminLogsTabProps {
  users: AdminUser[];
  /** A 403 anywhere turns the whole `/admin` page into "Acesso restrito". */
  onForbidden: () => void;
  /** Page-level refresh counter (the header "Atualizar" also reloads the logs). */
  refreshKey?: number;
}

/**
 * "Logs" tab of `/admin`: the administrative audit trail.
 *
 * Server-side filtering and pagination (`GET /admin/audit-logs?action=&actorId=
 * &page=&perPage=&from=&to=`). Dates are sent as ISO instants covering the whole
 * local day, and the actor is chosen from the workspace roster (a stable id),
 * never typed as free text. Metadata is expandable per row.
 */
export function AdminLogsTab({ users, onForbidden, refreshKey = 0 }: AdminLogsTabProps): JSX.Element {
  const [draft, setDraft] = useState<AppliedFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<AppliedFilters>(EMPTY_FILTERS);
  const [formError, setFormError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [perPage, setPerPage] = useState(PER_PAGE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, perPage)));
  const hasFilters =
    applied.action.length > 0 ||
    applied.actorId.length > 0 ||
    applied.from.length > 0 ||
    applied.to.length > 0;

  useEffect(() => {
    let active = true;

    async function load(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const result = await api.auditLogs({
          action: applied.action.length > 0 ? applied.action : undefined,
          actorId: applied.actorId.length > 0 ? applied.actorId : undefined,
          from: applied.from.length > 0 ? (startOfDayIso(applied.from) ?? undefined) : undefined,
          to: applied.to.length > 0 ? (endOfDayIso(applied.to) ?? undefined) : undefined,
          page,
          perPage: PER_PAGE,
        });
        if (!active) return;
        setItems(result.items);
        setTotal(result.total);
        setPerPage(result.perPage);
        setExpanded(new Set());
      } catch (failure) {
        if (!active) return;
        if (failure instanceof ApiClientError && failure.status === 403) {
          onForbidden();
          return;
        }
        setItems([]);
        setTotal(0);
        setError(adminErrorMessage(failure));
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [applied, onForbidden, page, refreshKey, reloadKey]);

  // A deleted last page (e.g. after a filter narrowed the result) must not leave
  // the paginator on a page that no longer exists.
  useEffect(() => {
    if (!loading && page > totalPages) setPage(totalPages);
  }, [loading, page, totalPages]);

  const actorOptions = useMemo(
    () => [
      { value: '', label: 'Todos os atores' },
      ...users.map((user) => ({
        value: user.id,
        label: `${user.name} · ${user.email}`,
      })),
    ],
    [users],
  );

  function applyFilters(): void {
    if (draft.from.length > 0 && draft.to.length > 0 && draft.from > draft.to) {
      setFormError('A data inicial precisa ser anterior ou igual à data final.');
      return;
    }
    if (
      (draft.from.length > 0 && startOfDayIso(draft.from) === null) ||
      (draft.to.length > 0 && endOfDayIso(draft.to) === null)
    ) {
      setFormError('Informe datas válidas no formato dia/mês/ano.');
      return;
    }
    setFormError(null);
    setExportError(null);
    setExportNotice(null);
    setPage(1);
    setApplied({ ...draft });
  }

  function clearFilters(): void {
    setFormError(null);
    setExportError(null);
    setExportNotice(null);
    setDraft(EMPTY_FILTERS);
    setPage(1);
    setApplied({ ...EMPTY_FILTERS });
  }

  function toggleExpanded(id: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Downloads the CSV of the **applied** filters (not just the visible page).
   *
   * The file is fetched with the bearer token and saved from a Blob, so the
   * authenticated route works without putting the JWT in the URL. The name comes
   * from `Content-Disposition` when the API sends it.
   */
  async function handleExport(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    setExportNotice(null);
    try {
      const file = await api.exportAuditLogsCsv({
        action: applied.action.length > 0 ? applied.action : undefined,
        actorId: applied.actorId.length > 0 ? applied.actorId : undefined,
        from: applied.from.length > 0 ? (startOfDayIso(applied.from) ?? undefined) : undefined,
        to: applied.to.length > 0 ? (endOfDayIso(applied.to) ?? undefined) : undefined,
      });
      const url = URL.createObjectURL(file.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.fileName ?? defaultExportName();
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setExportNotice(
        `Download iniciado: ${anchor.download}. ${
          hasFilters
            ? 'O arquivo respeita os filtros aplicados (todas as páginas do resultado).'
            : 'Sem filtros: a trilha completa do workspace foi solicitada.'
        }`,
      );
    } catch (failure) {
      if (failure instanceof ApiClientError && failure.status === 403) {
        onForbidden();
        return;
      }
      setExportError(adminErrorMessage(failure));
    } finally {
      setExporting(false);
    }
  }

  const columns = [
    { key: 'createdAt', label: 'Data' },
    { key: 'action', label: 'Ação' },
    { key: 'actor', label: 'Ator' },
    { key: 'resource', label: 'Recurso' },
    { key: 'ip', label: 'IP' },
    { key: 'metadata', label: 'Metadata' },
  ];

  const rows = useMemo<Record<string, ReactNode>[]>(
    () =>
      items.map((entry) => {
        const metadata = formatAuditMetadata(entry.metadata);
        const isExpanded = expanded.has(entry.id);
        return {
          createdAt: (
            <span className="sac-num" title={entry.createdAt}>
              {formatDateTimeSeconds(entry.createdAt)}
            </span>
          ),
          action: (
            <span className="sac-audit-action">
              <strong>{auditActionLabel(entry.action)}</strong>
              <span className="sac-num" title={entry.action}>
                {entry.action}
              </span>
            </span>
          ),
          actor: (
            <span className="sac-audit-actor" title={entry.actorId ?? undefined}>
              <span>{entry.actorEmail ?? '—'}</span>
              {entry.actorId !== null ? (
                <span className="sac-num">{compactId(entry.actorId)}</span>
              ) : null}
            </span>
          ),
          resource: (
            <span className="sac-audit-resource">
              <span>{entry.resourceType ?? '—'}</span>
              {entry.resourceId !== null ? (
                <span className="sac-num" title={entry.resourceId}>
                  {compactId(entry.resourceId)}
                </span>
              ) : null}
            </span>
          ),
          ip: <span className="sac-num">{entry.ip ?? '—'}</span>,
          metadata:
            metadata.length === 0 ? (
              <span className="text-[var(--cv-color-text-muted)]">—</span>
            ) : (
              <span className="sac-audit-metadata">
                <button
                  type="button"
                  className="sac-link-button"
                  aria-expanded={isExpanded}
                  aria-controls={`audit-meta-${entry.id}`}
                  onClick={() => toggleExpanded(entry.id)}
                >
                  {isExpanded ? 'Ocultar metadata' : 'Ver metadata'}
                </button>
                {isExpanded ? (
                  <pre className="sac-audit-json" id={`audit-meta-${entry.id}`}>
                    {metadata}
                  </pre>
                ) : null}
              </span>
            ),
        };
      }),
    [expanded, items],
  );

  return (
    <Card
      title="Trilha de auditoria"
      subtitle="Ações administrativas registradas pela API: quem fez, de onde, sobre qual recurso e com qual payload."
    >
      <div className="flex flex-col gap-4">
        <div className="sac-admin-filters">
          <Input
            label="Ação"
            value={draft.action}
            placeholder="ex.: user.role_changed"
            spellCheck={false}
            hint="Código exato registrado pela API."
            onChange={(event) => {
              setDraft((current) => ({ ...current, action: event.target.value }));
              setFormError(null);
            }}
          />
          <Select
            label="Ator"
            options={actorOptions}
            value={draft.actorId}
            hint="Operador que executou a ação."
            onChange={(event) => {
              setDraft((current) => ({ ...current, actorId: event.target.value }));
              setFormError(null);
            }}
          />
          <Input
            label="De"
            type="date"
            value={draft.from}
            max={draft.to.length > 0 ? draft.to : undefined}
            onChange={(event) => {
              setDraft((current) => ({ ...current, from: event.target.value }));
              setFormError(null);
            }}
          />
          <Input
            label="Até"
            type="date"
            value={draft.to}
            min={draft.from.length > 0 ? draft.from : undefined}
            onChange={(event) => {
              setDraft((current) => ({ ...current, to: event.target.value }));
              setFormError(null);
            }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon="search" onClick={applyFilters}>
            Aplicar filtros
          </Button>
          <Button variant="ghost" onClick={clearFilters}>
            Limpar
          </Button>
          <Button
            variant="ghost"
            icon="pulse"
            loading={loading}
            onClick={() => setReloadKey((key) => key + 1)}
          >
            Atualizar
          </Button>
          <Button
            variant="secondary"
            icon="file"
            loading={exporting}
            title="Baixa o CSV de todos os registros que correspondem aos filtros aplicados."
            onClick={() => void handleExport()}
          >
            Exportar CSV
          </Button>
          <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
            {hasFilters ? 'Filtros ativos · ' : ''}
            {loading ? 'consultando…' : `${total} registro(s)`}
          </span>
        </div>

        {formError !== null ? (
          <Alert title="Revise o período" tone="warning">
            {formError}
          </Alert>
        ) : null}

        {exportError !== null ? (
          <Alert title="Não foi possível exportar o CSV" tone="danger">
            <div className="flex flex-col gap-2">
              <span>{exportError}</span>
              <div>
                <Button size="sm" icon="file" loading={exporting} onClick={() => void handleExport()}>
                  Tentar novamente
                </Button>
              </div>
            </div>
          </Alert>
        ) : null}

        {exportNotice !== null ? (
          <Alert title="Exportação iniciada" tone="success">
            {exportNotice}
          </Alert>
        ) : null}

        {loading ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            {[0, 1, 2, 3, 4].map((index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        ) : error !== null ? (
          <Alert title="Não foi possível carregar os logs" tone="danger">
            <div className="flex flex-col gap-2">
              <span>{error}</span>
              <div>
                <Button size="sm" icon="pulse" onClick={() => setReloadKey((key) => key + 1)}>
                  Tentar novamente
                </Button>
              </div>
            </div>
          </Alert>
        ) : items.length === 0 ? (
          <EmptyState
            icon={hasFilters ? 'search' : 'list'}
            title={hasFilters ? 'Nenhum log para estes filtros' : 'Nenhum log registrado'}
            description={
              hasFilters
                ? 'Nenhuma ação administrativa corresponde aos filtros aplicados. Amplie o período ou limpe os filtros.'
                : 'Convites, mudanças de papel, ativações e revogações de sessão aparecem aqui assim que acontecem.'
            }
            action={
              hasFilters ? (
                <Button variant="secondary" onClick={clearFilters}>
                  Limpar filtros
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <DataTable
              caption={`Trilha de auditoria — ${total} registro(s), página ${page} de ${totalPages}`}
              columns={columns}
              rows={rows}
            />

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
                {total} registro(s) · página {page} de {totalPages} · {perPage} por página
              </span>
              <Pagination
                page={Math.min(page, totalPages)}
                total={totalPages}
                onPageChange={(next) => setPage(Math.min(Math.max(1, next), totalPages))}
              />
            </div>
          </>
        )}

        <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
          Chamadas: <span className="sac-num">GET /admin/audit-logs?action=&amp;actorId=&amp;page=&amp;perPage=&amp;from=&amp;to=</span>{' '}
          · <span className="sac-num">GET /admin/audit-logs/export.csv?action=&amp;actorId=&amp;from=&amp;to=</span>{' '}
          (download autenticado)
        </p>
      </div>
    </Card>
  );
}
