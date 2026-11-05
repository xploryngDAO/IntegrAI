import { useWorkspace } from '../../lib/store';
import { MARKETPLACE_LABEL, TICKET_TYPE_LABEL } from '../../lib/labels';
import { Card, EmptyState, Skeleton } from '../ui';
import { OrderCard } from './OrderCard';
import { CustomerCard } from './CustomerCard';
import { TrackingCard } from './TrackingCard';
import { ActionsPanel } from './ActionsPanel';
import { EventTimeline } from './EventTimeline';

function CockpitSkeleton() {
  return (
    <div className="sac-cockpit" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((index) => (
        <Card key={index}>
          <div className="sac-col" style={{ gap: 10 }}>
            <Skeleton className="w-1/3" />
            <Skeleton />
            <Skeleton className="w-2/3" />
          </div>
        </Card>
      ))}
    </div>
  );
}

/**
 * Right column — Cockpit 360º (docs/UI_SPEC.md §5 /
 * docs/CONVERGENCIA_ADOPTION.md §6): order, buyer, tracking, post-sale actions
 * and the event history of the selected ticket.
 */
export function Cockpit() {
  const selectedTicketId = useWorkspace((state) => state.selectedTicketId);
  const detail = useWorkspace((state) => state.detail);
  const loadingDetail = useWorkspace((state) => state.loadingDetail);

  const activeDetail = detail && detail.ticket.id === selectedTicketId ? detail : null;

  return (
    <section className="sac-panel sac-inspector-panel" aria-label="Cockpit 360º do atendimento">
      <div className="sac-panel__head">
        <div className="sac-col">
          <h2>Cockpit 360º</h2>
          <span className="sac-panel__sub">
            {activeDetail
              ? `${MARKETPLACE_LABEL[activeDetail.ticket.marketplace]} · ${TICKET_TYPE_LABEL[activeDetail.ticket.ticketType]}`
              : 'Pedido, cliente e ações do atendimento'}
          </span>
        </div>
      </div>

      <div className="sac-scroll flex-1">
        {activeDetail ? (
          <div className="sac-cockpit">
            <OrderCard order={activeDetail.order} ticket={activeDetail.ticket} />
            <CustomerCard customer={activeDetail.customer} ticket={activeDetail.ticket} />
            <TrackingCard
              order={activeDetail.order}
              customer={activeDetail.customer}
              ticket={activeDetail.ticket}
            />
            <ActionsPanel
              actions={activeDetail.allowedActions}
              marketplace={activeDetail.ticket.marketplace}
              crr={activeDetail.crr}
              ticketId={activeDetail.ticket.id}
            />
            <EventTimeline events={activeDetail.events} />
          </div>
        ) : loadingDetail && selectedTicketId ? (
          <CockpitSkeleton />
        ) : (
          <div className="sac-pad">
            <EmptyState
              icon="grid"
              title="Nenhum atendimento selecionado"
              description="O contexto do pedido, do comprador e as ações de pós-venda aparecem aqui."
            />
          </div>
        )}
      </div>
    </section>
  );
}
