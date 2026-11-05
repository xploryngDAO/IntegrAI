import { Gavel } from 'lucide-react';
import type { TicketListItem } from '@sac/shared';
import { formatSlaRemaining } from '../../lib/labels';
import { Avatar, MarketplaceBadge, Pill, SlaClock, TypeBadge } from '../ui';

export interface TicketCardProps {
  ticket: TicketListItem;
  selected: boolean;
  /** Shared ticking clock (ms) so the SLA state updates every second. */
  now: number;
  onSelect: (id: string) => void;
}

function queueShortName(queue: string | null): string | null {
  if (!queue) return null;
  return queue.replace('SAC::', '').replace('COMERCIAL::', '');
}

/**
 * Dense queue card on the Convergência surface.
 * SLA state drives the 3px side marker (`data-sla`); selection is expressed by
 * `aria-current` — the DS stylesheet owns both visuals.
 */
export function TicketCard({ ticket, selected, now, onSelect }: TicketCardProps) {
  const sla = formatSlaRemaining(ticket.slaDeadlineAt, now);
  const breached = ticket.slaBreached || ticket.slaState === 'BREACHED' || sla.msLeft <= 0;
  const atRisk = !breached && (ticket.slaState === 'AT_RISK' || sla.tone === 'warn');
  const slaState = breached ? 'BREACHED' : atRisk ? 'AT_RISK' : 'ON_TRACK';

  const disputeN2 = ticket.tags.includes('DISPUTA N2');
  const orderRef = ticket.externalOrderId ?? ticket.externalReferenceId;
  const queue = queueShortName(ticket.assignedQueue);
  const buyer = ticket.buyerDisplayName ?? ticket.buyerAnonymizedEmail ?? 'Comprador';

  return (
    <li>
      <button
        id={`ticket-${ticket.id}`}
        type="button"
        className="sac-ticket"
        data-sla={slaState}
        aria-current={selected ? 'true' : undefined}
        aria-label={`${buyer} — ${ticket.subject ?? 'atendimento'}`}
        onClick={() => onSelect(ticket.id)}
      >
        <span className="sac-ticket__row">
          <span className="flex-none">
            <MarketplaceBadge marketplace={ticket.marketplace} compact />
          </span>
          <span className="flex-none whitespace-nowrap">
            <TypeBadge ticketType={ticket.ticketType} forceCritical={disputeN2} />
          </span>
          {ticket.hasActiveClaim && !disputeN2 ? (
            <Gavel
              size={13}
              role="img"
              aria-label="Claim ativo"
              className="flex-none text-[var(--cv-color-danger)]"
            />
          ) : null}
          <span className="ml-auto flex-none">
            <SlaClock deadline={ticket.slaDeadlineAt} />
          </span>
        </span>

        <span className="sac-ticket__row min-w-0">
          <span className="sac-ticket__name min-w-0 flex-1">{buyer}</span>
          {disputeN2 ? (
            <span className="flex-none whitespace-nowrap">
              <Pill tone="danger">N2</Pill>
            </span>
          ) : null}
          {ticket.unreadCount > 0 ? (
            <span className="ml-auto flex-none">
              <Pill tone="accent" title={`${ticket.unreadCount} mensagem(ns) não lida(s)`}>
                {ticket.unreadCount}
              </Pill>
            </span>
          ) : null}
        </span>

        <span className="sac-ticket__preview">{ticket.subject ?? 'Sem assunto'}</span>

        <span className="sac-ticket__meta">
          <span
            className="sac-num sac-clip min-w-0 flex-1"
            title={`${orderRef}${ticket.hasActiveClaim ? ' · claim ativo' : ''}${queue ? ` · ${queue}` : ''}`}
          >
            {orderRef}
          </span>
          <span className="inline-flex flex-none items-center gap-1">
            {ticket.assignedAgentName ? (
              <Avatar name={ticket.assignedAgentName} size="sm" />
            ) : (
              <Pill tone="neutral" className="flex-none">
                Livre
              </Pill>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}
