import { useMemo, useState } from 'react';
import type { AvailableActionView, CrrStatusView, Marketplace } from '@sac/shared';
import { cx } from '@xploryng/convergencia';
import {
  CheckCheck,
  PackageCheck,
  Play,
  RotateCcw,
  Scale,
  ShieldAlert,
  Undo2,
  XCircle,
} from 'lucide-react';
import { MARKETPLACE_LABEL, ROUTE_LABEL } from '../../lib/labels';
import { useWorkspace } from '../../lib/store';
import { Button, Card, ConfirmDialog, Pill, Tooltip } from '../ui';

const SOURCE_LABEL: Record<string, string> = {
  allowed_actions: 'Ações liberadas pelo canal',
  spapi_messaging_actions: 'SP-API Messaging',
  post_purchase: 'Pós-compra Mercado Livre',
  returns: 'Devoluções Shopee',
  sellerchat: 'Shopee Chat',
  messages: 'Mercado Livre Messages',
  claims: 'Mercado Livre Claims',
  questions: 'Perguntas Mercado Livre',
  shopee: 'Shopee Open Platform',
  system: 'Sistema',
};

function sourceLabel(source: string, marketplace: Marketplace): string {
  if (SOURCE_LABEL[source]) return SOURCE_LABEL[source];
  if (!source) return MARKETPLACE_LABEL[marketplace];
  return source.replace(/_/g, ' ');
}

function ActionIcon({ action }: { action: AvailableActionView }) {
  const kind = action.kind;
  if (kind.includes('REFUND') || kind.includes('RETURN')) return <RotateCcw size={15} aria-hidden="true" />;
  if (kind.includes('ALLOW_RETURN')) return <Undo2 size={15} aria-hidden="true" />;
  if (kind.includes('DISPUTE') || kind.includes('MEDIATION')) return <Scale size={15} aria-hidden="true" />;
  if (kind.includes('CANCEL')) return <XCircle size={15} aria-hidden="true" />;
  if (kind.includes('MARK_READ')) return <CheckCheck size={15} aria-hidden="true" />;
  if (kind.includes('WARRANTY') || kind.includes('DELIVERY')) return <PackageCheck size={15} aria-hidden="true" />;
  if (action.destructive) return <ShieldAlert size={15} aria-hidden="true" />;
  return <Play size={15} aria-hidden="true" />;
}

interface ActionsPanelProps {
  actions: AvailableActionView[];
  marketplace: Marketplace;
  crr: CrrStatusView | null;
  ticketId: string;
  className?: string;
}

/**
 * Cockpit card 4 — dynamic post-sale actions driven by `allowedActions`.
 * Destructive actions ask for confirmation and show the exact API call.
 */
export function ActionsPanel({
  actions,
  marketplace,
  crr,
  ticketId,
  className,
}: ActionsPanelProps) {
  const runAction = useWorkspace((state) => state.runAction);
  const [confirmAction, setConfirmAction] = useState<AvailableActionView | null>(null);
  const [runningKind, setRunningKind] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const result = new Map<string, AvailableActionView[]>();
    for (const action of actions) {
      const key = sourceLabel(action.source, marketplace);
      const bucket = result.get(key) ?? [];
      bucket.push(action);
      result.set(key, bucket);
    }
    return [...result.entries()];
  }, [actions, marketplace]);

  async function execute(action: AvailableActionView): Promise<void> {
    setConfirmAction(null);
    setRunningKind(action.kind);
    try {
      // `runAction` owns the result toast and the detail refresh.
      await runAction({ kind: action.kind });
    } finally {
      setRunningKind(null);
    }
  }

  function requestAction(action: AvailableActionView): void {
    if (!action.enabled || runningKind !== null) return;
    if (action.requiresConfirmation || action.destructive) {
      setConfirmAction(action);
      return;
    }
    void execute(action);
  }

  const confirmDescription = confirmAction
    ? `${confirmAction.description} Chamada de API: POST /api/v1/tickets/${ticketId}/actions com { "kind": "${confirmAction.kind}" }. Rota: ${ROUTE_LABEL[confirmAction.route]}.`
    : '';

  return (
    <Card
      title="Ações de pós-venda"
      className={cx('flex flex-col', className)}
      style={{ gap: 10 }}
    >
      {marketplace === 'SHOPEE' && crr ? (
        <div className="sac-kv">
          <span>Status CRR</span>
          <Pill tone={crr.safe ? 'ok' : 'warn'}>{crr.safe ? 'CRR: OK' : 'CRR: EM RISCO'}</Pill>
        </div>
      ) : null}

      {actions.length === 0 ? (
        <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          Nenhuma ação de pós-venda disponível para este atendimento.
        </p>
      ) : (
        <div className="sac-col" style={{ gap: 14 }}>
          {grouped.map(([groupName, groupActions]) => (
            <section key={groupName} aria-label={groupName} className="sac-col" style={{ gap: 8 }}>
              <span className="sac-label">{groupName}</span>
              {groupActions.map((action) => {
                const button = (
                  <Button
                    variant={action.destructive ? 'danger' : 'secondary'}
                    size="sm"
                    icon={<ActionIcon action={action} />}
                    disabled={!action.enabled || runningKind !== null}
                    loading={runningKind === action.kind}
                    onClick={() => requestAction(action)}
                    fullWidth
                  >
                    {action.label}
                  </Button>
                );
                return (
                  <div key={action.kind} className="sac-col" style={{ gap: 4 }}>
                    {action.enabled ? (
                      button
                    ) : (
                      <Tooltip label="Indisponível: a ação não foi liberada pelo canal para este pedido.">
                        <span className="inline-flex w-full">{button}</span>
                      </Tooltip>
                    )}
                    <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
                      {action.description}
                    </p>
                    <span
                      className="sac-num text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]"
                      title={`Rota: ${ROUTE_LABEL[action.route]}`}
                    >
                      rota: {ROUTE_LABEL[action.route]}
                    </span>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction?.label ?? 'Confirmar ação'}
        description={confirmDescription}
        confirmLabel="Confirmar ação"
        tone={confirmAction?.destructive ? 'danger' : 'primary'}
        onConfirm={() => {
          if (confirmAction) void execute(confirmAction);
        }}
        onClose={() => setConfirmAction(null)}
      />
    </Card>
  );
}
