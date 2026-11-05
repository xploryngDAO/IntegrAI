import { Icon } from '@xploryng/convergencia';
import { mockFallbackDetail } from '../../lib/api';
import { useWorkspace } from '../../lib/store';

/**
 * Thin demo-mode ribbon rendered under the topbar while the app runs on the
 * in-memory mock dataset (VITE_MOCK_MODE=true or API fallback).
 */
export function DemoModeBanner(): JSX.Element | null {
  const isMock = useWorkspace((state) => state.isMock);
  if (!isMock) return null;

  const reason = mockFallbackDetail();

  return (
    <div
      role="status"
      className="flex h-8 shrink-0 items-center gap-2 border-b px-4 text-[var(--cv-font-meta)]"
      style={{
        borderColor: 'color-mix(in srgb, var(--cv-color-warning) 28%, transparent)',
        background: 'var(--cv-color-warning-soft)',
        color: 'var(--cv-color-warning)',
      }}
    >
      <Icon name="bell" size={14} />
      <strong className="flex-none whitespace-nowrap font-semibold">Modo demonstração</strong>
      <span className="min-w-0 truncate opacity-80">
        dados simulados em memória; as alterações não persistem no servidor
      </span>
      <span className="ml-auto hidden flex-none font-mono text-[10px] opacity-60 lg:inline">
        {reason ? `origem: ${reason}` : 'fixtures locais ativas'}
      </span>
    </div>
  );
}
