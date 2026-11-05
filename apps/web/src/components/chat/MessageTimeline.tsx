import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MessageView, TicketDetail } from '@sac/shared';
import { format, isToday, isYesterday, parseISO } from 'date-fns';
import { Button, EmptyState } from '../ui';
import { formatDayLabel } from '../../lib/format';
import { MessageBubble } from './MessageBubble';

interface DayGroup {
  key: string;
  label: string;
  messages: MessageView[];
}

function dayKeyOf(iso: string): string {
  return iso.slice(0, 10);
}

function dayLabelOf(iso: string): string {
  let date: Date;
  try {
    date = parseISO(iso);
  } catch {
    return iso;
  }
  if (isToday(date)) return `Hoje · ${format(date, 'dd/MM')}`;
  if (isYesterday(date)) return `Ontem · ${format(date, 'dd/MM')}`;
  return formatDayLabel(iso);
}

/**
 * `MessageView` does not expose `readAt`, so the unread divider is derived from
 * the ticket counter: the last `unreadCount` inbound buyer messages are unread.
 */
function unreadMessageIds(messages: MessageView[], unreadCount: number): Set<string> {
  const ids = new Set<string>();
  let remaining = Math.max(0, unreadCount);
  if (remaining === 0) return ids;
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = messages[index];
    if (message && !message.isInternalNote && message.direction === 'INBOUND_BUYER') {
      ids.add(message.id);
      remaining -= 1;
    }
  }
  return ids;
}

interface MessageTimelineProps {
  detail: TicketDetail;
}

/**
 * Scrollable conversation thread on `.sac-scroll` → `.sac-thread`.
 * Keeps the operator anchored at the bottom unless they scrolled up, and then
 * surfaces the "novas mensagens" pill.
 */
export function MessageTimeline({ detail }: MessageTimelineProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const lastTicketId = useRef<string | null>(null);
  const lastCount = useRef(0);

  const ordered = useMemo(
    () =>
      [...detail.messages].sort(
        (left, right) =>
          Date.parse(left.marketplaceCreatedAt) - Date.parse(right.marketplaceCreatedAt),
      ),
    [detail.messages],
  );

  const groups = useMemo(() => {
    const result: DayGroup[] = [];
    for (const message of ordered) {
      const key = dayKeyOf(message.marketplaceCreatedAt);
      const current = result[result.length - 1];
      if (current && current.key === key) {
        current.messages.push(message);
      } else {
        result.push({ key, label: dayLabelOf(message.marketplaceCreatedAt), messages: [message] });
      }
    }
    return result;
  }, [ordered]);

  const unreadIds = useMemo(
    () => unreadMessageIds(ordered, detail.ticket.unreadCount),
    [ordered, detail.ticket.unreadCount],
  );
  const firstUnreadId = useMemo(
    () => ordered.find((message) => unreadIds.has(message.id))?.id ?? null,
    [ordered, unreadIds],
  );

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = distanceToBottom <= 120;
    setPinned(atBottom);
    if (atBottom) setUnseen(false);
  }, []);

  // Keep the thread anchored unless the operator scrolled up to read history.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (lastTicketId.current !== detail.ticket.id) {
      lastTicketId.current = detail.ticket.id;
      lastCount.current = ordered.length;
      element.scrollTop = element.scrollHeight;
      setPinned(true);
      setUnseen(false);
      return;
    }
    if (ordered.length > lastCount.current) {
      if (pinned) {
        element.scrollTop = element.scrollHeight;
      } else {
        setUnseen(true);
      }
    }
    lastCount.current = ordered.length;
  }, [detail.ticket.id, ordered.length, pinned]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col max-[900px]:min-h-[160px]">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-label="Histórico da conversa"
        className="sac-scroll flex-1"
      >
        {groups.length === 0 ? (
          <div className="sac-pad">
            <EmptyState
              icon="chat"
              title="Nenhuma mensagem neste atendimento"
              description="Escreva a primeira resposta no compositor abaixo. O histórico aparece aqui em ordem cronológica."
            />
          </div>
        ) : (
          <div className="sac-thread">
            {groups.map((group) => (
              <section key={group.key} aria-label={group.label}>
                <div className="sac-daydiv sticky top-0 z-10 bg-panel">{group.label}</div>
                {group.messages.map((message) => (
                  <div key={message.id}>
                    {message.id === firstUnreadId ? (
                      <div
                        className="my-2 flex items-center gap-2.5 text-[var(--cv-font-micro)] uppercase tracking-[0.08em]"
                        style={{ color: 'var(--cv-color-accent-text)' }}
                        role="separator"
                        aria-label="Início das mensagens não lidas"
                      >
                        <span className="h-px flex-1 bg-accent/40" aria-hidden="true" />
                        Não lidas
                        <span className="h-px flex-1 bg-accent/40" aria-hidden="true" />
                      </div>
                    ) : null}
                    <MessageBubble message={message} />
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}
      </div>

      {unseen ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center">
          <Button
            variant="primary"
            size="sm"
            icon="down"
            className="pointer-events-auto shadow-floating"
            onClick={() => {
              const element = scrollRef.current;
              if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
              setUnseen(false);
              setPinned(true);
            }}
          >
            novas mensagens
          </Button>
        </div>
      ) : null}
    </div>
  );
}
