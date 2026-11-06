import { useEffect, useState } from 'react';
import { Alert, Button } from '../ui';

export interface MaintenanceBannerProps {
  /** Operator-facing text sent by the API in the 503 body. */
  message: string;
  /** `Retry-After` of the 503, in seconds (already normalised by `lib/api`). */
  retryAfterSeconds: number;
  /** Hides the banner for this maintenance session. */
  onDismiss: () => void;
}

/**
 * Global banner for the controlled maintenance window (`503 MAINTENANCE`).
 *
 * It is rendered by `App` above the route tree, so the same surface appears on
 * the public landing, the credential gate and the authenticated workspace. It
 * sits in the normal flow at the very top of the app column: the content below
 * shrinks instead of being covered, which keeps the topbar, the `#sac-main`
 * skip target and keyboard focus order untouched.
 *
 * Convergência `Alert` owns the visual language. `tone="danger"` is deliberate:
 * it is the only tone whose DS contract sets `role="alert"` (the others render
 * `role="status"`), and a full outage of `/api/v1` is an assertive incident —
 * wrapping a `warning` alert in a second live region would announce everything
 * twice.
 */
export function MaintenanceBanner({
  message,
  retryAfterSeconds,
  onDismiss,
}: MaintenanceBannerProps): JSX.Element {
  const total = Math.max(0, Math.ceil(retryAfterSeconds));
  const [remaining, setRemaining] = useState(total);

  // A newer 503 can advertise a different window: restart from its value.
  useEffect(() => {
    setRemaining(total);
  }, [total]);

  // One timeout per second instead of an interval: the countdown stops by
  // itself at zero, and no timer survives the banner being dismissed.
  useEffect(() => {
    if (remaining <= 0) return;
    const timeout = window.setTimeout(() => {
      setRemaining((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearTimeout(timeout);
  }, [remaining]);

  return (
    <div className="sac-maintenance">
      <Alert title="Manutenção programada" tone="danger">
        <p className="sac-maintenance__message">{message}</p>
        {/* The countdown changes every second: `aria-live="off"` keeps the
            assertive alert from re-announcing each tick while still exposing
            the current value to assistive technology. */}
        <p className="sac-maintenance__retry" aria-live="off">
          {remaining > 0 ? (
            <>
              Tente novamente em <span className="sac-num">{remaining}s</span>.
            </>
          ) : (
            'Você já pode tentar novamente.'
          )}
        </p>
      </Alert>
      <Button
        variant="secondary"
        size="sm"
        className="sac-maintenance__dismiss"
        aria-label="Dispensar aviso de manutenção"
        onClick={onDismiss}
      >
        Dispensar
      </Button>
    </div>
  );
}
