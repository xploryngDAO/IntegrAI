import type { TicketDetail } from '@sac/shared';
import { cx } from '@xploryng/convergencia';
import { formatDateTime } from '../../lib/labels';
import { Card } from '../ui';
import { CockpitTimeline, type TimelineEntry, type TimelineTone } from './CockpitTimeline';

const EVENT_LABEL: Record<string, string> = {
  TICKET_CREATED: 'Atendimento criado',
  STATUS_CHANGED: 'Status alterado',
  ASSIGNED: 'Atribuído',
  TICKET_ASSIGNED: 'Atribuído',
  TICKET_UNASSIGNED: 'Devolvido à fila',
  ASSIGNMENT_CHANGED: 'Atribuição alterada',
  SLA_WARNING: 'Aviso de SLA',
  SLA_BREACHED: 'SLA violado',
  SLA_UPDATED: 'SLA atualizado',
  MESSAGE_SENT: 'Mensagem enviada',
  MESSAGE_RECEIVED: 'Mensagem recebida',
  ACTION_EXECUTED: 'Ação executada',
  CLAIM_OPENED: 'Reclamação aberta',
  CLAIM_UPDATED: 'Reclamação atualizada',
  RETURN_REQUESTED: 'Devolução solicitada',
  DISPUTE_OPENED: 'Disputa aberta',
  CLOSED_WITHOUT_RESPONSE: 'Finalizado sem resposta',
  TICKET_READ: 'Conversa marcada como lida',
  CRR_WARNING: 'Risco de CRR',
  CRR_RISK: 'Risco de CRR',
  CRR_PROTECTED: 'CRR protegido',
  NOTE_ADDED: 'Nota interna',
  INTERNAL_NOTE: 'Nota interna',
  TICKET_RESOLVED: 'Atendimento resolvido',
  PII_PURGED: 'PII purgada (RDT)',
  OPT_OUT_DETECTED: 'Opt-out detectado',
};

function eventLabel(eventType: string): string {
  return EVENT_LABEL[eventType] ?? eventType.replace(/_/g, ' ').toLowerCase();
}

function eventSummary(payload: Record<string, unknown>): string | null {
  const from = typeof payload.from === 'string' ? payload.from : null;
  const to = typeof payload.to === 'string' ? payload.to : null;
  if (from && to) return `${from} → ${to}`;
  const status = typeof payload.status === 'string' ? payload.status : null;
  if (status) return status;
  const agent = typeof payload.agent === 'string' ? payload.agent : null;
  if (agent) return agent;
  const reason = typeof payload.reason === 'string' ? payload.reason : null;
  if (reason) return reason;
  const route = typeof payload.routeUsed === 'string' ? payload.routeUsed : null;
  if (route) return route;
  return null;
}

function toneFor(eventType: string): TimelineTone {
  if (eventType === 'SLA_BREACHED') return 'danger';
  if (eventType === 'SLA_WARNING' || eventType === 'CRR_WARNING' || eventType === 'CRR_RISK') {
    return 'warning';
  }
  if (eventType === 'TICKET_RESOLVED') return 'success';
  return 'accent';
}

interface EventTimelineProps {
  events: TicketDetail['events'];
  className?: string;
}

/** Cockpit card 5 — compact ticket event history on the DS timeline. */
export function EventTimeline({ events, className }: EventTimelineProps) {
  const items: TimelineEntry[] = events.map((event) => {
    const summary = eventSummary(event.payload);
    const actor = event.actorLabel;
    return {
      title: eventLabel(event.eventType),
      detail: summary ?? actor,
      time: `${formatDateTime(event.createdAt)}${actor && summary ? ` · ${actor}` : ''}`,
      tone: toneFor(event.eventType),
    };
  });

  return (
    <Card title="Histórico" className={cx('flex flex-col', className)} style={{ gap: 10 }}>
      {items.length === 0 ? (
        <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          Sem eventos registrados para este atendimento.
        </p>
      ) : (
        <CockpitTimeline items={items} />
      )}
    </Card>
  );
}
