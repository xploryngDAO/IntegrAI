/**
 * Controlled operational maintenance window (`MAINTENANCE_MODE`).
 *
 * The window is resolved once at boot (env -> `AppConfig`) and shared by the
 * HTTP guard and the realtime hub so both surfaces agree on the code, the
 * message and the retry hint:
 *
 *  - every `/api/v1` route answers `503 MAINTENANCE` (plus `Retry-After`)
 *    except the liveness/readiness probes, `/status` and the Prometheus scrape;
 *  - the marketplace webhooks (`/webhooks/*`, outside `/api/v1`) are untouched,
 *    otherwise the push events would be lost while the operators are locked out;
 *  - new Socket.IO handshakes are refused instead of polling an API that will
 *    answer every request with 503.
 *
 * These constants are the single source of truth: adapters/UI can import the
 * code without depending on the server package.
 */

/** Stable machine code rendered by the UI/support runbook (never localized). */
export const MAINTENANCE_ERROR_CODE = 'MAINTENANCE';

/** Default operator-facing message (env: `MAINTENANCE_MESSAGE`). */
export const DEFAULT_MAINTENANCE_MESSAGE =
  'Sistema em manutencao programada. Tente novamente em instantes.';

/** `Retry-After` advertised while the window is open (seconds, RFC 9110). */
export const MAINTENANCE_RETRY_AFTER_SECONDS = 60;

/** Resolved state of the maintenance window. */
export interface MaintenanceState {
  enabled: boolean;
  message: string;
}

/**
 * Normalizes a raw maintenance configuration.
 *
 * `message` is trimmed; an empty string falls back to the default so a
 * deployment that sets `MAINTENANCE_MESSAGE=` (or only spaces) still answers
 * something actionable instead of an empty 503 body.
 */
export function resolveMaintenanceState(
  input: { enabled?: boolean; message?: string } = {},
): MaintenanceState {
  const message = input.message?.trim() ?? '';
  return {
    enabled: input.enabled === true,
    message: message.length > 0 ? message : DEFAULT_MAINTENANCE_MESSAGE,
  };
}
