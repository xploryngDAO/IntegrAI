import { useEffect, useState } from 'react';
import { useWorkspace } from '../lib/store';
import { SegmentedControl } from '../components/ui';
import { QueueColumn } from '../components/queue/QueueColumn';
import { ChatPanel } from '../components/chat/ChatPanel';
import { Cockpit } from '../components/cockpit/Cockpit';

type MobileView = 'queue' | 'chat' | 'details';

const MOBILE_OPTIONS = [
  { value: 'queue', label: 'Fila' },
  { value: 'chat', label: 'Conversa' },
  { value: 'details', label: 'Pedido' },
];

function useIsCompact(): boolean {
  const [compact, setCompact] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(max-width: 900px)').matches,
  );

  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const handleChange = () => setCompact(media.matches);
    handleChange();
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  return compact;
}

/**
 * Three-column operational workspace (docs/CONVERGENCIA_ADOPTION.md §layout):
 * queue (320px) · conversation (fluid) · cockpit (310px, the DS inspector width).
 *
 * Panels stay mounted across breakpoints; below 900px a segmented control picks
 * which one is visible, so a ticket selection never refetches.
 */
export function WorkspacePage(): JSX.Element {
  const selectedTicketId = useWorkspace((state) => state.selectedTicketId);
  const isCompact = useIsCompact();
  const [view, setView] = useState<MobileView>('chat');

  useEffect(() => {
    if (!isCompact) return;
    if (!selectedTicketId) setView('queue');
  }, [isCompact, selectedTicketId]);

  return (
    <div className="sac-workspace" data-view={view}>
      {isCompact ? (
        <div className="sac-mobile-view">
          <SegmentedControl
            label="Painel visível"
            options={MOBILE_OPTIONS}
            value={view}
            onChange={(value) => setView(value as MobileView)}
          />
        </div>
      ) : null}

      <QueueColumn />
      <ChatPanel />
      <Cockpit />
    </div>
  );
}
