import { useEffect, useState } from 'react';
import type { TicketDetail, TicketStatus } from '@sac/shared';
import {
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Lock,
  MoreHorizontal,
  StickyNote,
  UserPlus,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useWorkspace } from '../../lib/store';
import { PRESENCE_LABEL, STATUS_LABEL, formatDateTime } from '../../lib/labels';
import {
  Avatar,
  Button,
  ConfirmDialog,
  IconButton,
  MarketplaceBadge,
  Modal,
  Pill,
  SlaClock,
  Textarea,
  TypeBadge,
} from '../ui';

const STATUS_ORDER: readonly TicketStatus[] = [
  'UNREAD',
  'OPEN_WAITING_AGENT',
  'WAITING_BUYER',
  'MEDIATION',
  'RESOLVED',
];

const PRESENCE_DOT: Record<string, string> = {
  ONLINE: 'var(--cv-color-success)',
  PAUSED: 'var(--cv-color-warning)',
  OFFLINE: 'var(--cv-color-text-muted)',
};

type MenuView = 'root' | 'agents' | 'status' | 'note';

const MENU_BUTTON_CLASS = 'justify-start';

/**
 * Conversation header on `.sac-panel__head`: buyer identity, channel/type
 * badges, claim chip, protocol/order in `.sac-num`, the live SLA clock and the
 * actions menu (assign / status / resolve / internal note).
 */
export function ChatHeader({ detail }: { detail: TicketDetail }): JSX.Element {
  const ticket = detail.ticket;
  const agents = useWorkspace((state) => state.agents);
  const assignTo = useWorkspace((state) => state.assignTo);
  const changeStatus = useWorkspace((state) => state.changeStatus);
  const refreshDetail = useWorkspace((state) => state.refreshDetail);
  const pushToast = useWorkspace((state) => state.pushToast);

  // Force a re-render every second so the SlaClock countdown stays live.
  const [, setNow] = useState(() => Date.now());
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<MenuView>('root');
  const [noteText, setNoteText] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmResolve, setConfirmResolve] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
    setView('root');
    setNoteText('');
    setConfirmResolve(false);
  }, [ticket.id]);

  const buyerName = ticket.buyerDisplayName ?? detail.customer.displayName ?? 'Comprador';
  const nick = detail.customer.displayName;
  const showNick = Boolean(nick) && nick !== buyerName;
  const queueLabel = ticket.assignedQueue?.replace(/^SAC::/, '') ?? null;
  const rdtProtected =
    detail.customer.piiProtection === 'RDT_30D_PURGE' ||
    ticket.channelMetadata.rdt_protected === true;

  function closeMenu(): void {
    setMenuOpen(false);
    setView('root');
  }

  async function handleAssign(agentId: string): Promise<void> {
    setBusy(true);
    try {
      // Success/failure toasts belong to the store.
      await assignTo(agentId);
      closeMenu();
    } finally {
      setBusy(false);
    }
  }

  async function handleStatus(status: TicketStatus): Promise<void> {
    setBusy(true);
    try {
      await changeStatus(status);
      closeMenu();
    } finally {
      setBusy(false);
    }
  }

  async function handleResolve(): Promise<void> {
    setConfirmResolve(false);
    setBusy(true);
    try {
      await changeStatus('RESOLVED');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveNote(): Promise<void> {
    const text = noteText.trim();
    if (!text) return;
    setNoteSaving(true);
    try {
      await api.addNote(ticket.id, text);
      await refreshDetail(ticket.id);
      pushToast({
        tone: 'ok',
        title: 'Nota interna adicionada',
        description: 'Registrada no histórico — não foi enviada ao comprador.',
      });
      setNoteText('');
      closeMenu();
    } catch {
      pushToast({ tone: 'danger', title: 'Não foi possível salvar a nota' });
    } finally {
      setNoteSaving(false);
    }
  }

  const footer =
    view === 'note' ? (
      <>
        <Button onClick={() => setView('root')} disabled={noteSaving}>
          Voltar
        </Button>
        <Button
          variant="primary"
          loading={noteSaving}
          disabled={noteText.trim().length === 0}
          onClick={() => void handleSaveNote()}
        >
          Salvar nota
        </Button>
      </>
    ) : (
      <>
        {view !== 'root' ? <Button onClick={() => setView('root')}>Voltar</Button> : null}
        <Button onClick={closeMenu}>Fechar</Button>
      </>
    );

  return (
    <>
      <header className="sac-panel__head max-[900px]:sticky max-[900px]:top-0 max-[900px]:z-20 max-[900px]:bg-panel">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Avatar name={buyerName} size="md" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <h2 className="sac-clip" title={buyerName}>
                {buyerName}
              </h2>
              {showNick ? <span className="sac-label">@{nick}</span> : null}
              <MarketplaceBadge marketplace={ticket.marketplace} compact />
              <TypeBadge ticketType={ticket.ticketType} />
              {ticket.hasActiveClaim ? (
                <Pill tone="danger">
                  <span className="uppercase tracking-[0.06em]">Claim ativo</span>
                </Pill>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
              <span className="sac-num whitespace-nowrap" title="Protocolo interno">
                #SAC-{ticket.id.slice(0, 8)}
              </span>
              {ticket.externalOrderId ? (
                <span className="sac-num whitespace-nowrap" title="Pedido">
                  {ticket.externalOrderId}
                </span>
              ) : null}
              {queueLabel ? (
                <span className="sac-clip" title="Fila">
                  {queueLabel}
                </span>
              ) : null}
              <span className="whitespace-nowrap">{STATUS_LABEL[ticket.status]}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-none items-center gap-2 self-start whitespace-nowrap">
          <SlaClock deadline={ticket.slaDeadlineAt} />
          <span
            className="sac-num text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]"
            title={`Prazo exato: ${formatDateTime(ticket.slaDeadlineAt)}`}
          >
            até {formatDateTime(ticket.slaDeadlineAt)}
          </span>
          <IconButton
            label="Mais ações do atendimento"
            icon={<MoreHorizontal size={18} />}
            onClick={() => {
              setView('root');
              setMenuOpen(true);
            }}
          />
        </div>
      </header>

      {rdtProtected ? (
        <div
          className="flex items-center gap-2 border-b border-subtle px-4 py-1.5 text-[var(--cv-font-micro)]"
          style={{ background: 'var(--cv-color-warning-soft)', color: 'var(--cv-color-warning)' }}
        >
          <Lock size={12} aria-hidden="true" />
          <span>Dados do comprador protegidos por RDT · expiram em 30 dias</span>
        </div>
      ) : null}

      <Modal
        open={menuOpen}
        onClose={closeMenu}
        title="Ações do atendimento"
        description="Atribua a um agente, mude o status, resolva ou registre uma nota interna."
        footer={footer}
      >
        {view === 'root' ? (
          <div className="flex flex-col gap-1.5">
            <Button
              variant="ghost"
              fullWidth
              className={MENU_BUTTON_CLASS}
              icon={<UserPlus size={16} />}
              onClick={() => setView('agents')}
            >
              <span className="flex w-full items-center justify-between gap-2">
                Atribuir atendimento
                <ChevronRight size={16} aria-hidden="true" />
              </span>
            </Button>
            <Button
              variant="ghost"
              fullWidth
              className={MENU_BUTTON_CLASS}
              icon={<CircleDot size={16} />}
              onClick={() => setView('status')}
            >
              <span className="flex w-full items-center justify-between gap-2">
                Mudar status
                <ChevronRight size={16} aria-hidden="true" />
              </span>
            </Button>
            <Button
              variant="ghost"
              fullWidth
              className={MENU_BUTTON_CLASS}
              icon={<CheckCircle2 size={16} />}
              onClick={() => {
                setMenuOpen(false);
                setConfirmResolve(true);
              }}
            >
              Resolver atendimento
            </Button>
            <Button
              variant="ghost"
              fullWidth
              className={MENU_BUTTON_CLASS}
              icon={<StickyNote size={16} />}
              onClick={() => setView('note')}
            >
              Adicionar nota interna
            </Button>
          </div>
        ) : null}

        {view === 'agents' ? (
          <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {agents.length === 0 ? (
              <p className="sac-label m-0">Nenhum agente disponível.</p>
            ) : (
              agents.map((agent) => (
                <Button
                  key={agent.id}
                  variant="ghost"
                  fullWidth
                  disabled={busy}
                  className={MENU_BUTTON_CLASS}
                  onClick={() => void handleAssign(agent.id)}
                >
                  <span className="flex w-full items-center gap-2">
                    <Avatar name={agent.name} size="sm" />
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                      <span className="sac-clip">{agent.name}</span>
                      <span className="sac-label">
                        {PRESENCE_LABEL[agent.presence]} · {agent.activeTickets} ativo(s)
                      </span>
                    </span>
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        background: PRESENCE_DOT[agent.presence] ?? 'var(--cv-color-text-muted)',
                      }}
                      aria-hidden="true"
                    />
                  </span>
                </Button>
              ))
            )}
          </div>
        ) : null}

        {view === 'status' ? (
          <div className="flex flex-col gap-1">
            {STATUS_ORDER.map((status) => (
              <Button
                key={status}
                variant="ghost"
                fullWidth
                disabled={busy || status === ticket.status}
                className={MENU_BUTTON_CLASS}
                onClick={() => void handleStatus(status)}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  {STATUS_LABEL[status]}
                  {status === ticket.status ? <Pill tone="accent">atual</Pill> : null}
                </span>
              </Button>
            ))}
          </div>
        ) : null}

        {view === 'note' ? (
          <Textarea
            label="Nota interna"
            hint="Visível apenas para o time; nunca é enviada ao comprador."
            rows={5}
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            placeholder="Ex.: comprador pediu prazo; retorno combinado para amanhã 10h."
          />
        ) : null}
      </Modal>

      <ConfirmDialog
        open={confirmResolve}
        title="Resolver atendimento?"
        description="O SLA será encerrado e a conversa sai da fila ativa. O comprador não recebe nenhuma mensagem com esta ação."
        confirmLabel="Resolver"
        tone="primary"
        onConfirm={() => void handleResolve()}
        onClose={() => setConfirmResolve(false)}
      />
    </>
  );
}
