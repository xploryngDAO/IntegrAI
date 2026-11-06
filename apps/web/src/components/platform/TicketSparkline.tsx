/**
 * `ticketsLast14d` sparkline — pure inline SVG, no chart dependency.
 *
 * Every colour comes from Convergência tokens through inline CSS properties
 * (`style`), which is what makes the same markup work in the light and dark
 * themes. The chart is decorative for layout purposes but exposes a text
 * summary (`role="img"` + `aria-label`/`<title>`) and visible min/max/total.
 */
import { asCount } from '../../lib/platform';
import type { PlatformDailyTickets } from '../../lib/types';

const VIEW_WIDTH = 320;
const VIEW_HEIGHT = 76;
const PAD_X = 4;
const PAD_TOP = 8;
const PAD_BOTTOM = 8;

/** `2026-11-05` (or an ISO timestamp) → `05/11`. */
function dayLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (match) return `${match[3]}/${match[2]}`;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '—';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(parsed.getDate())}/${pad(parsed.getMonth() + 1)}`;
}

interface Point {
  date: string;
  count: number;
}

/** Drops malformed buckets instead of rendering a misleading line. */
function normalizePoints(points: readonly PlatformDailyTickets[] | undefined): Point[] {
  if (!Array.isArray(points)) return [];
  return points
    .filter((point): point is PlatformDailyTickets => typeof point === 'object' && point !== null)
    .filter((point) => typeof point.date === 'string' && point.date.trim().length > 0)
    .map((point) => ({ date: point.date.trim(), count: asCount(point.count) }));
}

export interface TicketSparklineProps {
  points: readonly PlatformDailyTickets[] | undefined;
  /** Context for the accessible name, e.g. the tenant name. */
  label: string;
}

export function TicketSparkline({ points, label }: TicketSparklineProps): JSX.Element {
  const data = normalizePoints(points);
  const counts = data.map((point) => point.count);
  const max = counts.length > 0 ? Math.max(...counts) : 0;
  const min = counts.length > 0 ? Math.min(...counts) : 0;
  const total = counts.reduce((sum, count) => sum + count, 0);

  // The baseline is always zero: a flat day near the bottom is honest about
  // volume, and a quiet week never looks like a peak.
  const ceiling = Math.max(1, max);
  const plotHeight = VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const stepX = data.length > 1 ? (VIEW_WIDTH - PAD_X * 2) / (data.length - 1) : 0;
  const yFor = (count: number) => VIEW_HEIGHT - PAD_BOTTOM - (count / ceiling) * plotHeight;

  const coordinates = data.map((point, index) => ({
    x: data.length > 1 ? PAD_X + index * stepX : (VIEW_WIDTH - PAD_X * 2) / 2,
    y: yFor(point.count),
  }));

  const singlePoint = coordinates.length === 1 ? coordinates[0] : null;
  let linePath = '';
  if (coordinates.length > 1) {
    linePath = coordinates
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(' ');
  } else if (singlePoint !== null) {
    linePath = `M ${PAD_X} ${singlePoint.y.toFixed(2)} L ${VIEW_WIDTH - PAD_X} ${singlePoint.y.toFixed(2)}`;
  }

  let areaPath = '';
  if (coordinates.length > 1) {
    const baseline = VIEW_HEIGHT - PAD_BOTTOM;
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    areaPath =
      `M ${first.x.toFixed(2)} ${baseline} ` +
      coordinates.map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ') +
      ` L ${last.x.toFixed(2)} ${baseline} Z`;
  }

  const summary =
    data.length === 0
      ? `${label}: sem série diária de tickets.`
      : `${label}: ${total} ticket(s) em ${data.length} dia(s); mínimo ${min}, máximo ${max}.`;
  const last = coordinates.length > 0 ? coordinates[coordinates.length - 1] : null;
  const baseline = VIEW_HEIGHT - PAD_BOTTOM;

  return (
    <figure className="m-0 flex flex-col gap-2">
      <svg
        className="h-20 w-full"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
      >
        <title>{summary}</title>

        {/* Quiet guides at the top and at the zero baseline. */}
        <line
          x1={PAD_X}
          x2={VIEW_WIDTH - PAD_X}
          y1={PAD_TOP}
          y2={PAD_TOP}
          strokeWidth={1}
          strokeDasharray="2 4"
          style={{ stroke: 'var(--cv-color-border)' }}
        />
        <line
          x1={PAD_X}
          x2={VIEW_WIDTH - PAD_X}
          y1={baseline}
          y2={baseline}
          strokeWidth={1}
          style={{ stroke: 'var(--cv-color-border)' }}
        />

        {areaPath.length > 0 ? <path d={areaPath} style={{ fill: 'var(--cv-color-accent-soft)' }} /> : null}

        {linePath.length > 0 ? (
          <path
            d={linePath}
            fill="none"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{ stroke: 'var(--cv-color-accent)' }}
          />
        ) : null}

        {last !== null ? (
          <line
            x1={last.x}
            x2={last.x}
            y1={last.y}
            y2={baseline}
            strokeWidth={1}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
            style={{ stroke: 'var(--cv-color-accent)' }}
          />
        ) : null}
      </svg>

      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
        <span className="sac-num">{data.length > 0 ? dayLabel(data[0].date) : '—'}</span>
        <span>
          mínimo <strong className="sac-num">{min}</strong> · máximo{' '}
          <strong className="sac-num">{max}</strong> · total <strong className="sac-num">{total}</strong>
        </span>
        <span className="sac-num">{data.length > 0 ? dayLabel(data[data.length - 1].date) : '—'}</span>
      </figcaption>
    </figure>
  );
}
