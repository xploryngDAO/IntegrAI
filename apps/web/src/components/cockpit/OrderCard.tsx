import type { OrderView, TicketListItem } from '@sac/shared';
import { cx } from '@xploryng/convergencia';
import { Copy, ExternalLink, Package } from 'lucide-react';
import { formatCurrency, formatDateTime } from '../../lib/labels';
import { useWorkspace } from '../../lib/store';
import { Button, Card, IconButton, Pill, Tooltip } from '../ui';

const ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendente',
  PAID: 'Pago',
  PROCESSED: 'Processado',
  INVOICED: 'Faturado',
  READY_TO_SHIP: 'Pronto para envio',
  TO_SHIP: 'A enviar',
  SHIPPED: 'Enviado',
  SHIPPING: 'Em trânsito',
  DELIVERED: 'Entregue',
  CANCELLED: 'Cancelado',
  IN_CANCEL: 'Em cancelamento',
  RETURNED: 'Devolvido',
};

const FULFILLMENT_LABEL: Record<string, string> = {
  FBA: 'FBA',
  FBM: 'FBM',
  MERCADO_ENVIOS: 'Mercado Envios',
  MERCADO_ENVIOS_FULL: 'Mercado Envios Full',
  SHOPEE_XPRESS: 'Shopee Xpress',
  SHOPEE_STANDARD: 'Shopee Standard',
};

function itemIdentifiers(item: OrderView['items'][number]): string[] {
  const identifiers: string[] = [];
  if (item.sku) identifiers.push(`SKU ${item.sku}`);
  if (item.asin) identifiers.push(`ASIN ${item.asin}`);
  if (item.mlb) identifiers.push(item.mlb);
  if (item.itemId) identifiers.push(`ITEM ${item.itemId}`);
  return identifiers;
}

interface OrderCardProps {
  order: OrderView | null;
  ticket: TicketListItem;
  className?: string;
}

/** Cockpit card 1 — order summary with the items snapshot. */
export function OrderCard({ order, ticket, className }: OrderCardProps) {
  const pushToast = useWorkspace((state) => state.pushToast);

  async function copyOrderId(): Promise<void> {
    if (!order) return;
    try {
      await navigator.clipboard.writeText(order.externalOrderId);
      pushToast({ tone: 'ok', title: 'Pedido copiado', description: order.externalOrderId });
    } catch {
      pushToast({
        tone: 'warn',
        title: 'Não foi possível copiar',
        description: order.externalOrderId,
      });
    }
  }

  if (!order) {
    return (
      <Card
        title="Pedido"
        className={cx('flex flex-col', className)}
        style={{ gap: 10 }}
      >
        <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          Pedido ainda não sincronizado para este atendimento.
          {ticket.externalOrderId ? (
            <>
              {' '}
              Referência:{' '}
              <span className="sac-num text-[var(--cv-color-text)]">{ticket.externalOrderId}</span>
            </>
          ) : null}
        </p>
      </Card>
    );
  }

  const statusLabel = ORDER_STATUS_LABEL[order.orderStatus] ?? order.orderStatus;
  const fulfillment = order.fulfillmentType
    ? (FULFILLMENT_LABEL[order.fulfillmentType] ?? order.fulfillmentType)
    : null;

  return (
    <Card
      title="Pedido"
      actions={
        <IconButton
          label="Copiar número do pedido"
          icon={<Copy size={15} />}
          size="sm"
          onClick={() => void copyOrderId()}
        />
      }
      className={cx('flex flex-col', className)}
      style={{ gap: 10 }}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Pill tone="neutral" className="whitespace-nowrap">
          {statusLabel}
        </Pill>
        {fulfillment ? (
          <Pill tone="accent" className="whitespace-nowrap">
            {fulfillment}
          </Pill>
        ) : null}
        <strong className="sac-num ml-auto whitespace-nowrap text-[var(--cv-font-lead)] font-semibold">
          {formatCurrency(order.totalAmount, order.currency)}
        </strong>
      </div>

      <div className="sac-kv min-w-0">
        <span>Pedido</span>
        <strong className="sac-num min-w-0 truncate" title={order.externalOrderId}>
          {order.externalOrderId}
        </strong>
      </div>
      {order.packId ? (
        <div className="sac-kv min-w-0">
          <span>Pack</span>
          <strong className="sac-num min-w-0 truncate" title={order.packId}>
            {order.packId}
          </strong>
        </div>
      ) : null}

      <div>
        {order.items.slice(0, 3).map((item, index) => (
          <div key={`${item.sku ?? item.itemId ?? item.title}-${index}`} className="sac-item-row">
            <span className="sac-item-thumb" aria-hidden="true">
              <Package size={16} />
            </span>
            <div className="sac-item-body min-w-0">
              <strong className="line-clamp-2" title={item.title}>
                {item.title}
              </strong>
              <small className="block truncate" title={itemIdentifiers(item).join(' · ')}>
                {itemIdentifiers(item).join(' · ')}
              </small>
              <p className="m-0 mt-1 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
                {item.quantity} × {formatCurrency(item.unitPrice, order.currency)}
              </p>
            </div>
          </div>
        ))}
        {order.items.length > 3 ? (
          <p className="m-0 mt-1 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
            + {order.items.length - 3} item(ns) não exibido(s)
          </p>
        ) : null}
      </div>

      <div className="sac-kv min-w-0">
        <span>Previsão de entrega</span>
        <strong className="sac-num min-w-0 truncate" title={formatDateTime(order.estimatedDeliveryAt)}>
          {formatDateTime(order.estimatedDeliveryAt)}
        </strong>
      </div>
      <div className="sac-kv min-w-0">
        <span>Enviado em</span>
        <strong className="sac-num min-w-0 truncate" title={formatDateTime(order.shippedAt)}>
          {formatDateTime(order.shippedAt)}
        </strong>
      </div>

      <Tooltip label="Integração não configurada para esta conta">
        <span className="inline-flex min-w-0">
          <Button
            variant="ghost"
            size="sm"
            icon={<ExternalLink size={14} />}
            disabled
            fullWidth
          >
            Ver no canal
          </Button>
        </span>
      </Tooltip>
    </Card>
  );
}
