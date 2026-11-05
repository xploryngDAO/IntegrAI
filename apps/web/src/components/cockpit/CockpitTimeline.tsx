export type TimelineTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'rose';

export interface TimelineEntry {
  title: string;
  detail?: string | null;
  time: string;
  tone?: TimelineTone;
}

/**
 * Convergência timeline composition (`.cv-timeline`).
 *
 * The product UI kit does not re-export the DS `Timeline` primitive yet; this
 * local composition renders the exact DS markup and tone classes so the visual
 * contract (dot, title, detail, time) holds without importing the package
 * directly from a feature folder.
 */
export function CockpitTimeline({ items }: { items: TimelineEntry[] }) {
  return (
    <ol className="cv-timeline">
      {items.map((item, index) => (
        <li key={`${item.title}-${index}`}>
          <span
            className={`cv-timeline-dot cv-tone--${item.tone ?? 'accent'}`}
            aria-hidden="true"
          />
          <div>
            <strong>{item.title}</strong>
            {item.detail ? <p className="cv-text cv-muted">{item.detail}</p> : null}
            <time>{item.time}</time>
          </div>
        </li>
      ))}
    </ol>
  );
}
