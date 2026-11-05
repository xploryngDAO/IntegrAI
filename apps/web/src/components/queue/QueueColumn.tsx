import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../../lib/store';
import type { QueueKey } from '../../lib/types';
import { Button, EmptyState, Kbd, SearchField, Skeleton } from '../ui';
import { QueueFilters } from './QueueFilters';
import { TicketCard } from './TicketCard';
import { useNow } from './useNow';

const SEARCH_DEBOUNCE_MS = 350;

/* ==========================================================================
 * Loading placeholder (six dense cards, no layout jump)
 * ========================================================================== */

function QueueSkeleton() {
  return (
    <ul className="sac-ticket-list" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, index) => (
        <li key={index}>
          <div className="sac-ticket">
            <div className="sac-ticket__row">
              <Skeleton className="w-[64px]" />
              <Skeleton className="w-[84px]" />
              <span className="ml-auto">
                <Skeleton className="w-[56px]" />
              </span>
            </div>
            <Skeleton className="w-1/2" />
            <Skeleton />
            <Skeleton className="w-3/4" />
            <div className="sac-ticket__row">
              <Skeleton className="w-[120px]" />
              <span className="ml-auto">
                <Skeleton className="w-[22px]" />
              </span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ==========================================================================
 * Stat row
 * ========================================================================== */

function QueueStats() {
  const stats = useWorkspace((state) => state.stats);
  const totalTickets = useWorkspace((state) => state.totalTickets);
  const tickets = useWorkspace((state) => state.tickets);
  const filters = useWorkspace((state) => state.filters);

  const filtering =
    filters.queueKey !== 'ALL' ||
    filters.search.trim().length > 0 ||
    filters.marketplaces.length > 0 ||
    filters.accountId !== null;

  // While a filter/search is active the stat row describes the visible list;
  // otherwise it reports the global queue telemetry (same as the topbar).
  const total = filtering ? tickets.length : (stats?.total ?? totalTickets);
  const atRisk = filtering
    ? tickets.filter((ticket) => ticket.slaState === 'AT_RISK').length
    : (stats?.atRisk ?? tickets.filter((ticket) => ticket.slaState === 'AT_RISK').length);
  const breached = filtering
    ? tickets.filter((ticket) => ticket.slaState === 'BREACHED' || ticket.slaBreached).length
    : (stats?.breached ?? tickets.filter((ticket) => ticket.slaState === 'BREACHED').length);
  const unread = filtering
    ? tickets.reduce((sum, ticket) => sum + ticket.unreadCount, 0)
    : (stats?.unread ?? tickets.reduce((sum, ticket) => sum + ticket.unreadCount, 0));

  return (
    <div className="sac-queue__stats" aria-label="Resumo da fila">
      <div className="sac-stat">
        <span>Abertos</span>
        <strong>{total}</strong>
      </div>
      <div className="sac-stat" data-tone="warning">
        <span>Em risco</span>
        <strong>{atRisk}</strong>
      </div>
      <div className="sac-stat" data-tone="danger">
        <span>Violados</span>
        <strong>{breached}</strong>
      </div>
      <div className="sac-stat">
        <span>Não lidas</span>
        <strong>{unread}</strong>
      </div>
    </div>
  );
}

/* ==========================================================================
 * Queue column
 * ========================================================================== */

/**
 * Left column — unified intelligent queue (docs/UI_SPEC.md §3 /
 * docs/CONVERGENCIA_ADOPTION.md §6): search, segmented filters, stat row and a
 * live SLA ticket list with j/k// keyboard navigation.
 */
export function QueueColumn() {
  const tickets = useWorkspace((state) => state.tickets);
  const totalTickets = useWorkspace((state) => state.totalTickets);
  const filters = useWorkspace((state) => state.filters);
  const setFilters = useWorkspace((state) => state.setFilters);
  const selectedTicketId = useWorkspace((state) => state.selectedTicketId);
  const selectTicket = useWorkspace((state) => state.selectTicket);
  const loadingQueue = useWorkspace((state) => state.loadingQueue);

  const now = useNow(1000);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const [query, setQuery] = useState(filters.search);

  // Keep the field in sync when filters are reset elsewhere (topbar/Escape).
  useEffect(() => {
    setQuery(filters.search);
  }, [filters.search]);

  useEffect(
    () => () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    },
    [],
  );

  // Bring the keyboard-selected ticket into view.
  useEffect(() => {
    if (!selectedTicketId) return;
    const element = document.getElementById(`ticket-${selectedTicketId}`);
    element?.scrollIntoView({ block: 'nearest' });
  }, [selectedTicketId]);

  function focusSearch(): void {
    searchContainerRef.current?.querySelector('input')?.focus();
  }

  function handleQueryChange(value: string): void {
    setQuery(value);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      setFilters({ search: value });
    }, SEARCH_DEBOUNCE_MS);
  }

  function handleFilterChange(key: QueueKey): void {
    setFilters({ queueKey: key });
  }

  function clearFilters(): void {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setQuery('');
    setFilters({ queueKey: 'ALL', search: '', marketplaces: [], accountId: null });
  }

  // Keyboard: j/k next/prev, / or ⌘K focus search, Esc clear/blur.
  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    }

    function moveSelection(step: number): void {
      const state = useWorkspace.getState();
      if (state.tickets.length === 0) return;
      const currentIndex = state.tickets.findIndex(
        (ticket) => ticket.id === state.selectedTicketId,
      );
      const baseIndex = currentIndex === -1 ? (step > 0 ? -1 : 0) : currentIndex;
      const nextIndex = Math.min(state.tickets.length - 1, Math.max(0, baseIndex + step));
      const target = state.tickets[nextIndex];
      if (target && target.id !== state.selectedTicketId) state.selectTicket(target.id);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        focusSearch();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === '/' && !isTypingTarget(event.target)) {
        event.preventDefault();
        focusSearch();
        return;
      }

      if (event.key === 'Escape') {
        if (isTypingTarget(event.target)) (event.target as HTMLElement).blur();
        if (useWorkspace.getState().filters.search) {
          setQuery('');
          useWorkspace.getState().setFilters({ search: '' });
        }
        return;
      }

      if (isTypingTarget(event.target)) return;

      if (event.key === 'j') {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === 'k') {
        event.preventDefault();
        moveSelection(-1);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const showSkeleton = loadingQueue && tickets.length === 0;
  const showEmpty = !loadingQueue && tickets.length === 0;

  return (
    <section className="sac-panel sac-queue-panel" aria-label="Fila unificada de atendimentos">
      <div className="sac-panel__head">
        <div className="sac-col">
          <h2>Fila unificada</h2>
          <span className="sac-panel__sub">{totalTickets} abertos</span>
        </div>
        <span className="whitespace-nowrap text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
          SLA mais próximo
        </span>
      </div>

      <div className="sac-queue__tools">
        <div ref={searchContainerRef}>
          <SearchField
            label="Buscar na fila"
            value={query}
            onChange={handleQueryChange}
            placeholder="Pedido, CPF, nome ou protocolo…"
          />
        </div>
        <QueueFilters value={filters.queueKey} onChange={handleFilterChange} />
      </div>

      <QueueStats />

      <div className="sac-scroll flex-1">
        {showSkeleton ? <QueueSkeleton /> : null}

        {showEmpty ? (
          <div className="sac-pad">
            <EmptyState
              icon="list"
              title="Nenhum atendimento com esses filtros"
              description="Ajuste a busca ou limpe os filtros para ver toda a fila unificada."
              action={
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Limpar filtros
                </Button>
              }
            />
          </div>
        ) : null}

        {!showSkeleton && tickets.length > 0 ? (
          <ul className="sac-ticket-list" aria-label="Atendimentos da fila">
            {tickets.map((ticket) => (
              <TicketCard
                key={ticket.id}
                ticket={ticket}
                selected={ticket.id === selectedTicketId}
                now={now}
                onSelect={selectTicket}
              />
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-none items-center gap-3 border-t border-[var(--cv-color-border)] px-4 py-2 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
        <span className="sac-row">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd>
          navegar
        </span>
        <span className="sac-row">
          <Kbd>/</Kbd>
          buscar
        </span>
        <span className="sac-row ml-auto">
          <Kbd>esc</Kbd>
          limpar
        </span>
      </div>
    </section>
  );
}
