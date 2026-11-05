import type { CustomerView, OrderView, TicketListItem } from '@sac/shared';
import { cx } from '@xploryng/convergencia';
import { ClipboardPaste, Copy, MapPin } from 'lucide-react';
import { formatDateTime } from '../../lib/labels';
import { useWorkspace } from '../../lib/store';
import { Button, Card, IconButton, Pill, Tooltip } from '../ui';
import { setComposerDraft } from '../chat/Composer';
import { fillMacroTemplate } from '../chat/MacroBar';
import { CockpitTimeline, type TimelineEntry } from './CockpitTimeline';

function readTrackingEvents(
  shipping: Record<string, unknown> | null | undefined,
): Array<{ label: string; at: string | null; location: string | null }> {
  if (!shipping) return [];
  const rawEvents = shipping.events ?? shipping.history ?? shipping.tracking_events ?? shipping.timeline;
  if (!Array.isArray(rawEvents)) return [];
  const events: Array<{ label: string; at: string | null; location: string | null }> = [];
  for (const entry of rawEvents) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const label =
      typeof record.description === 'string'
        ? record.description
        : typeof record.status === 'string'
          ? record.status
          : typeof record.message === 'string'
            ? record.message
            : typeof record.label === 'string'
              ? record.label
              : null;
    if (!label) continue;
    const rawAt =
      record.at ?? record.timestamp ?? record.date ?? record.created_at ?? record.datetime ?? record.updated_at;
    events.push({
      label,
      at: typeof rawAt === 'string' ? rawAt : null,
      location: typeof record.location === 'string' ? record.location : null,
    });
  }
  return events;
}

interface TrackingCardProps {
  order: OrderView | null;
  customer: CustomerView;
  ticket: TicketListItem;
  className?: string;
}

/** Cockpit card 3 — carrier, tracking code, shipping events and copy-to-chat. */
export function TrackingCard({ order, customer, ticket, className }: TrackingCardProps) {
  const pushToast = useWorkspace((state) => state.pushToast);
  const trackingNumber = order?.trackingNumber ?? null;
  const rawEvents = readTrackingEvents(order?.shipping);
  const buyerName = customer.displayName ?? ticket.buyerDisplayName ?? '';
  const orderSn = order?.externalOrderId ?? ticket.externalOrderId ?? '';

  const timelineItems: TimelineEntry[] = rawEvents.map((event, index) => ({
    title: event.label,
    detail: event.location,
    time: formatDateTime(event.at),
    tone: index === rawEvents.length - 1 ? 'accent' : 'neutral',
  }));

  async function copyTracking(): Promise<void> {
    if (!trackingNumber) return;
    try {
      await navigator.clipboard.writeText(trackingNumber);
      pushToast({ tone: 'ok', title: 'Rastreio copiado', description: trackingNumber });
    } catch {
      pushToast({
        tone: 'warn',
        title: 'Não foi possível copiar',
        description: trackingNumber,
      });
    }
  }

  function pasteTrackingIntoChat(): void {
    const template =
      'Olá {{buyer_name}}, seu pedido {{order_sn}} está em trânsito. Rastreio: {{tracking_number}}.';
    setComposerDraft(
      fillMacroTemplate(template, {
        buyerName,
        orderSn,
        trackingNumber: trackingNumber ?? '',
      }),
    );
    pushToast({
      tone: 'info',
      title: 'Rastreio colado no compositor',
      description: 'Revise a mensagem antes de enviar.',
    });
  }

  return (
    <Card
      title="Rastreio"
      actions={
        trackingNumber ? (
          <IconButton
            label="Copiar código de rastreio"
            icon={<Copy size={15} />}
            size="sm"
            onClick={() => void copyTracking()}
          />
        ) : undefined
      }
      className={cx('flex flex-col', className)}
      style={{ gap: 10 }}
    >
      {order ? (
        <>
          <div className="sac-row min-w-0">
            <Pill tone="neutral" className="flex-none whitespace-nowrap">
              {order.carrierName ?? 'Transportadora não informada'}
            </Pill>
            <span
              className="sac-num ml-auto min-w-0 truncate text-right"
              title={trackingNumber ?? 'sem código de rastreio'}
            >
              {trackingNumber ?? 'sem código'}
            </span>
          </div>

          <div className="sac-kv min-w-0">
            <span>Postado em</span>
            <strong className="sac-num min-w-0 truncate" title={formatDateTime(order.shippedAt)}>
              {formatDateTime(order.shippedAt)}
            </strong>
          </div>
          <div className="sac-kv min-w-0">
            <span>Entregue em</span>
            <strong className="sac-num min-w-0 truncate" title={formatDateTime(order.deliveredAt)}>
              {formatDateTime(order.deliveredAt)}
            </strong>
          </div>
          <div className="sac-kv min-w-0">
            <span>Previsão de entrega</span>
            <strong
              className="sac-num min-w-0 truncate"
              title={formatDateTime(order.estimatedDeliveryAt)}
            >
              {formatDateTime(order.estimatedDeliveryAt)}
            </strong>
          </div>

          <div className="sac-col" style={{ gap: 8 }}>
            <span className="sac-label">Eventos de rastreio</span>
            {timelineItems.length > 0 ? (
              <CockpitTimeline items={timelineItems} />
            ) : (
              <p className="sac-row m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
                <MapPin size={13} aria-hidden="true" />
                Sem eventos de rastreio sincronizados.
              </p>
            )}
          </div>

          {trackingNumber ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<ClipboardPaste size={15} />}
              onClick={pasteTrackingIntoChat}
              fullWidth
            >
              Colar rastreio no chat
            </Button>
          ) : (
            <Tooltip label="Este pedido ainda não tem código de rastreio sincronizado.">
              <span className="inline-flex w-full">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<ClipboardPaste size={15} />}
                  disabled
                  fullWidth
                >
                  Colar rastreio no chat
                </Button>
              </span>
            </Tooltip>
          )}
        </>
      ) : (
        <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          Rastreio indisponível — pedido não sincronizado.
        </p>
      )}
    </Card>
  );
}
