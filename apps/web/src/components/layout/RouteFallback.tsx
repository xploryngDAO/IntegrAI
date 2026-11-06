/**
 * Loading surface for route-level `React.lazy` chunks.
 *
 * Every routed page is loaded on demand (see `App.tsx`); while a chunk is in
 * flight the router renders this instead of the page. It is intentionally
 * neutral: the shell (rail + topbar) or the auth card frame stays mounted
 * around it, so the operator only sees the content area settle — never a white
 * screen and never a layout jump.
 *
 * Accessibility: `role="status"` + `aria-live="polite"` announce the wait once
 * (the spinner itself is decorative), and `aria-busy` marks the region as busy
 * until the page replaces it.
 */
export interface RouteFallbackProps {
  /** Announced/visible label; keeps the copy consistent with the session gate. */
  label?: string;
}

export function RouteFallback({ label = 'Carregando…' }: RouteFallbackProps): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex min-h-[180px] flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-[var(--cv-color-text-muted)]"
    >
      <span className="cv-spinner" aria-hidden="true" />
      <p className="m-0 text-[var(--cv-font-meta)]">{label}</p>
    </div>
  );
}
