import type { ReactNode } from 'react';
import { Badge as CvBadge, cx, type Tone } from '@xploryng/convergencia';
import type { Marketplace, TicketType } from '@sac/shared';
import { formatSlaRemaining } from '../../lib/labels';

export type PillTone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger' | 'accent' | 'rose';

const TONE_MAP: Record<PillTone, Tone> = {
  neutral: 'neutral',
  info: 'accent',
  ok: 'success',
  warn: 'warning',
  danger: 'danger',
  accent: 'accent',
  rose: 'rose',
};

export interface PillProps {
  tone?: PillTone;
  className?: string;
  children: ReactNode;
  title?: string;
}

/** Small status pill on top of the Convergência badge. */
export function Pill({ tone = 'neutral', className, children, title }: PillProps) {
  return (
    <CvBadge tone={TONE_MAP[tone]} className={className} title={title}>
      {children}
    </CvBadge>
  );
}

const MARKET_LABEL: Record<Marketplace, string> = {
  AMAZON: 'Amazon',
  MERCADO_LIVRE: 'Mercado Livre',
  SHOPEE: 'Shopee',
};

const MARKET_SHORT: Record<Marketplace, string> = {
  AMAZON: 'AMZ',
  MERCADO_LIVRE: 'MELI',
  SHOPEE: 'SHOPEE',
};

/**
 * Marketplace identity chip. Uses the Convergência tone families instead of
 * brand hex values so it survives theme changes (docs: "no hex in the product").
 */
export function MarketplaceBadge({
  marketplace,
  compact = false,
}: {
  marketplace: Marketplace;
  compact?: boolean;
}) {
  const modifier =
    marketplace === 'AMAZON' ? 'amazon' : marketplace === 'MERCADO_LIVRE' ? 'meli' : 'shopee';
  return (
    <span className={cx('sac-market', `sac-market--${modifier}`)} title={MARKET_LABEL[marketplace]}>
      <span className="sac-market__dot" aria-hidden="true" />
      {compact ? MARKET_SHORT[marketplace] : MARKET_LABEL[marketplace]}
    </span>
  );
}

const TYPE_TONE: Record<TicketType, PillTone> = {
  PRE_SALE: 'neutral',
  POST_SALE_ORDER: 'accent',
  CLAIM_DISPUTE: 'danger',
  RETURN_REFUND: 'rose',
  CANCELLATION: 'danger',
  PROACTIVE: 'ok',
};

const TYPE_LABEL: Record<TicketType, string> = {
  PRE_SALE: 'Pré-venda',
  POST_SALE_ORDER: 'Pós-venda',
  CLAIM_DISPUTE: 'Reclamação',
  RETURN_REFUND: 'Devolução',
  CANCELLATION: 'Cancelamento',
  PROACTIVE: 'Proativo',
};

export function TypeBadge({
  ticketType,
  forceCritical = false,
}: {
  ticketType: TicketType;
  forceCritical?: boolean;
}) {
  const tone: PillTone = forceCritical ? 'danger' : TYPE_TONE[ticketType];
  return <Pill tone={tone}>{TYPE_LABEL[ticketType]}</Pill>;
}

/** SLA countdown pill. Ticks with the parent render (queue/header pass a clock). */
export function SlaClock({
  deadline,
  withDot = true,
  className,
  prefix,
}: {
  deadline: string;
  withDot?: boolean;
  className?: string;
  prefix?: string;
}) {
  const remaining = formatSlaRemaining(deadline);
  return (
    <span
      className={cx('sac-sla', className)}
      data-tone={remaining.tone}
      title={`Prazo: ${new Date(deadline).toLocaleString('pt-BR')}`}
    >
      {withDot && <span className="sac-sla__dot" aria-hidden="true" />}
      {prefix && <span className="font-normal">{prefix}</span>}
      {remaining.text}
      <span className="sr-only"> para o SLA</span>
    </span>
  );
}
