import { useWorkspace } from '../../lib/store';
import { Button, EmptyState, Skeleton } from '../ui';
import { ChatHeader } from './ChatHeader';
import { MessageTimeline } from './MessageTimeline';
import { Composer } from './Composer';

function ChatSkeleton(): JSX.Element {
  return (
    <>
      <header className="sac-panel__head">
        <div className="flex min-w-0 items-center gap-3" aria-hidden="true">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="flex min-w-0 flex-col gap-2">
            <Skeleton className="w-44" />
            <Skeleton className="w-64" />
          </div>
        </div>
        <div className="flex flex-none items-center gap-2" aria-hidden="true">
          <Skeleton className="w-24" />
          <Skeleton className="h-9 w-9" />
        </div>
      </header>
      <div className="sac-scroll" aria-busy="true">
        <div className="sac-thread">
          <div className="flex justify-start">
            <Skeleton className="w-3/5" />
          </div>
          <div className="flex justify-end">
            <Skeleton className="w-2/5" />
          </div>
          <div className="flex justify-start">
            <Skeleton className="w-1/2" />
          </div>
          <div className="flex justify-end">
            <Skeleton className="w-1/3" />
          </div>
        </div>
      </div>
      <div className="sac-composer">
        <Skeleton className="w-52" />
        <Skeleton className="w-full" />
        <Skeleton className="w-32" />
      </div>
    </>
  );
}

/**
 * Center column of the workspace: conversation header, thread and the adaptive
 * composer. Contract: `<section className="sac-panel sac-chat-panel">` with
 * `.sac-panel__head`, `.sac-scroll`/`.sac-thread` and `.sac-composer`
 * (docs/CONVERGENCIA_ADOPTION.md §6).
 */
export function ChatPanel(): JSX.Element {
  const selectedTicketId = useWorkspace((state) => state.selectedTicketId);
  const detail = useWorkspace((state) => state.detail);
  const loadingDetail = useWorkspace((state) => state.loadingDetail);
  const refreshDetail = useWorkspace((state) => state.refreshDetail);

  const activeDetail = detail && detail.ticket.id === selectedTicketId ? detail : null;

  return (
    <section
      className="sac-panel sac-chat-panel max-[900px]:overflow-y-auto max-[900px]:[scrollbar-width:none] max-[900px]:[&::-webkit-scrollbar]:hidden"
      aria-label="Conversa do atendimento"
    >
      {!selectedTicketId ? (
        <>
          <header className="sac-panel__head">
            <h2>Conversa</h2>
            <span className="sac-panel__sub">Nenhum atendimento selecionado</span>
          </header>
          <div className="sac-scroll flex min-h-0 flex-1">
            <div className="flex min-h-full w-full items-center justify-center p-6">
              <div className="w-full max-w-md">
                <EmptyState
                  icon="chat"
                  title="Selecione um atendimento na fila"
                  description="Abra uma conversa na coluna Fila para ver o histórico, o pedido e responder com os guardrails do canal."
                />
              </div>
            </div>
          </div>
        </>
      ) : activeDetail ? (
        <>
          <ChatHeader detail={activeDetail} />
          <MessageTimeline detail={activeDetail} />
          <Composer />
        </>
      ) : loadingDetail ? (
        <ChatSkeleton />
      ) : (
        <>
          <header className="sac-panel__head">
            <h2>Conversa</h2>
          </header>
          <div className="sac-scroll flex min-h-0 flex-1">
            <div className="flex min-h-full w-full items-center justify-center p-6">
              <div className="w-full max-w-md">
                <EmptyState
                  icon="bell"
                  title="Não foi possível carregar a conversa"
                  description="A conexão com a API falhou ou o atendimento não existe mais. Tente novamente."
                  action={
                    <Button
                      variant="secondary"
                      onClick={() => {
                        if (selectedTicketId) void refreshDetail(selectedTicketId);
                      }}
                    >
                      Tentar novamente
                    </Button>
                  }
                />
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
