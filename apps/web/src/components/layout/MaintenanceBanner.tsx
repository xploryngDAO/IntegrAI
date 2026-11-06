import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { IconButton } from '../ui';

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
 * One compact strip instead of an alert card plus a loose button — on a 390px
 * phone the previous stack became four bands (title, message, retry, button).
 * The strip keeps the DS tone contract (`cv-tone--danger` + `--tone-soft`) and
 * the assertive `role="alert"`; the title is the short noun "Manutenção" and
 * the API message follows it, clamped to two lines on phones.
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
    <div className="sac-maintenance cv-tone--danger" role="alert">
      <AlertTriangle className="sac-maintenance__icon" size={17} aria-hidden="true" />
      <div className="sac-maintenance__body">
        <div className="sac-maintenance__head">
          <span className="sac-maintenance__title">Manutenção</span>
          {/* The countdown changes every second: `aria-live="off"` keeps the
              assertive alert from re-announcing each tick while still exposing
              the current value to assistive technology. */}
          <span className="sac-maintenance__retry" aria-live="off">
            {remaining > 0 ? `em ${remaining}s` : 'agora'}
          </span>
        </div>
        <p className="sac-maintenance__message" title={message}>
          {message}
        </p>
      </div>
      <IconButton
        label="Dispensar aviso de manutenção"
        icon={<X size={16} aria-hidden="true" />}
        onClick={onDismiss}
        className="sac-maintenance__dismiss"
      />
    </div>
  );
}
