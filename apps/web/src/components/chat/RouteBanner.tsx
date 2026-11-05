import type { Marketplace, RouteDecision } from '@sac/shared';
import { AlertTriangle, Route } from 'lucide-react';
import { MARKETPLACE_LABEL, ROUTE_LABEL } from '../../lib/labels';
import { Tooltip } from '../ui';

interface RouteBannerProps {
  decision: RouteDecision;
  marketplace: Marketplace;
  /** Amazon SP-API only: whether `actionName` is whitelisted for the order. */
  actionNameAllowed?: boolean | null;
}

/**
 * Server-decided outbound route on `.sac-composer__route`. The "Trocar"
 * affordance is informational — the server always owns routing.
 */
export function RouteBanner({
  decision,
  marketplace,
  actionNameAllowed,
}: RouteBannerProps): JSX.Element {
  const blocked = decision.blocked;
  const isSpApi = decision.route === 'AMAZON_SP_API_MESSAGING';
  const actionNotAllowed =
    isSpApi && Boolean(decision.actionName) && actionNameAllowed === false;

  return (
    <div
      className="sac-composer__route min-w-0"
      role="status"
      aria-live="polite"
      style={
        blocked
          ? {
              borderColor: 'var(--cv-color-danger)',
              background: 'var(--cv-color-danger-soft)',
            }
          : undefined
      }
    >
      <Route
        size={16}
        aria-hidden="true"
        style={{
          flex: 'none',
          color: blocked ? 'var(--cv-color-danger)' : 'var(--cv-color-accent-text)',
        }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            Rota automática: <strong>{ROUTE_LABEL[decision.route]}</strong>
          </span>
          {isSpApi && decision.actionName ? (
            <span className="cv-badge sac-num">{decision.actionName}</span>
          ) : null}
          <Tooltip label="A rota é definida pelo servidor a partir do tipo de atendimento e das políticas do canal.">
            <button
              type="button"
              className="cv-link text-[var(--cv-font-micro)]"
              style={{ background: 'none', border: 0, padding: 0, cursor: 'help' }}
            >
              Trocar
            </button>
          </Tooltip>
        </div>
        <span className="block">
          {blocked
            ? decision.blockedReason ?? 'Rota bloqueada para este atendimento.'
            : decision.reason}
        </span>
        {actionNotAllowed ? (
          <span
            className="mt-1 flex items-start gap-1"
            style={{ color: 'var(--cv-color-warning)' }}
          >
            <AlertTriangle size={12} aria-hidden="true" style={{ marginTop: 2, flex: 'none' }} />
            A ação <span className="sac-num">{decision.actionName}</span> não está liberada para
            este pedido — o marketplace pode recusar o envio.
          </span>
        ) : null}
      </div>
      <span className="sac-label flex-none">{MARKETPLACE_LABEL[marketplace]}</span>
    </div>
  );
}
