/**
 * Date/number/text formatting helpers. pt-BR output, tabular-friendly strings.
 */
import { format as formatDateFns, isValid } from 'date-fns';
import { ptBR } from 'date-fns/locale';

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return isValid(parsed) ? parsed : null;
}

/** `24/11 18:30` — used all over the UI. */
export function formatDateTime(iso: string | null): string {
  const date = toDate(iso);
  if (!date) return '—';
  return formatDateFns(date, 'dd/MM HH:mm', { locale: ptBR });
}

/** `24/11/2025`. */
export function formatDate(iso: string | null): string {
  const date = toDate(iso);
  if (!date) return '—';
  return formatDateFns(date, 'dd/MM/yyyy', { locale: ptBR });
}

/** `24/11 18:30:07` — timeline detail. */
export function formatDateTimeSeconds(iso: string | null): string {
  const date = toDate(iso);
  if (!date) return '—';
  return formatDateFns(date, 'dd/MM HH:mm:ss', { locale: ptBR });
}

/** `seg, 24/11` — day dividers in the timeline. */
export function formatDayLabel(iso: string | null): string {
  const date = toDate(iso);
  if (!date) return '—';
  return formatDateFns(date, "EEE, dd/MM", { locale: ptBR });
}

/** `R$ 249,90`. */
export function formatCurrency(value: number, currency = 'BRL'): string {
  if (!Number.isFinite(value)) return '—';
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/** `4h12` / `38min` / `—` for an SLA average. */
export function formatDurationMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins}min`;
  return `${hours}h${String(mins).padStart(2, '0')}`;
}

/** `1h58`, `2d 04h`, `VIOLADO`-style remaining clock (used by the queue). */
export function formatRemaining(msLeft: number): string {
  const totalSeconds = Math.max(0, Math.floor(msLeft / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}`;
  return `${minutes}m`;
}

/** `384 KB` — attachment chips. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/** `AR` for "Ana Ribeiro", `LA` for "Larissa". */
export function initials(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) return '?';
  const parts = clean.split(' ').filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  const first = parts[0][0] ?? '';
  const last = parts[parts.length - 1][0] ?? '';
  return `${first}${last}`.toUpperCase();
}

/** `#SAC-4F2A` protocol code from a ticket id. */
export function shortId(id: string): string {
  const compact = id.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return compact.slice(-4).padStart(4, '0');
}

/** Anonymous label for hidden PII (`•••`), never renders null as "null". */
export function orDash(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : '—';
}
