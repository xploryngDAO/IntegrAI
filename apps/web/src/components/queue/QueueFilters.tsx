import type { QueueKey } from '../../lib/types';
import { SegmentedControl } from '../ui';

const FILTER_OPTIONS: ReadonlyArray<{ value: QueueKey; label: string }> = [
  { value: 'ALL', label: 'Todos' },
  { value: 'SLA_CRITICAL', label: 'SLA' },
  { value: 'CLAIMS', label: 'Claims' },
  { value: 'PRE_SALE', label: 'Pré' },
  { value: 'WAITING_ME', label: 'Meus' },
  { value: 'UNASSIGNED', label: 'Livres' },
];

export interface QueueFiltersProps {
  value: QueueKey;
  onChange: (key: QueueKey) => void;
  className?: string;
}

/**
 * Queue filter switch backed by the Convergência segmented control.
 * Compact labels keep all six queue keys reachable inside the 320px column;
 * the DS control scrolls horizontally when the column is narrower.
 */
export function QueueFilters({ value, onChange, className }: QueueFiltersProps) {
  return (
    <div
      className={
        className
          ? `[&_button]:!min-h-[32px] [&_button]:!px-1.5 [&_button]:!text-[11px] ${className}`
          : '[&_button]:!min-h-[32px] [&_button]:!px-1.5 [&_button]:!text-[11px]'
      }
    >
      <SegmentedControl
        label="Filtrar fila"
        options={FILTER_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
        value={value}
        onChange={(next) => onChange(next as QueueKey)}
      />
    </div>
  );
}
