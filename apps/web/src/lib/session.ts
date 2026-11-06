/**
 * Session lifecycle shared by the app gate, the user menu and the profile page.
 *
 * Responsibilities:
 *  - the single `/auth/me` probe per boot (shared with StrictMode's double mount);
 *  - a small end-of-session event so `App` can leave the authenticated state
 *    without a full page reload;
 *  - `endSession()`, which calls `POST /auth/logout`, always clears the local
 *    credentials and workspace slices, and reports whether the API confirmed.
 *
 * The server remains the source of truth: clearing the browser is enough to
 * leave this tab, but only the API can revoke a leaked refresh token — hence
 * the honest `serverOk` flag surfaced by the callers.
 */
import { flushSync } from 'react-dom';

import { api, ApiClientError, clearSessionTokens, currentRefreshToken } from './api';
import { resetWorkspaceSession, useWorkspace } from './store';

/* ==========================================================================
 * Session probe (`GET /auth/me` once per page load)
 * ========================================================================== */

let sessionProbe: Promise<void> | null = null;

/**
 * Resolves the current operator and mirrors the summary into the store before
 * `boot()` runs. Role-gated navigation and the topbar identity must not depend
 * on every tenant endpoint succeeding — a platform operator may have no tenant
 * data at all.
 */
export function probeSession(): Promise<void> {
  if (sessionProbe === null) {
    sessionProbe = api.me().then((agent) => {
      useWorkspace.setState({ currentAgent: agent });
    });
    sessionProbe.catch(() => {
      sessionProbe = null;
    });
  }
  return sessionProbe;
}

/**
 * Forgets the cached probe. Called when the session ends so the next `/login`
 * boot cannot resurrect the previous operator from a resolved promise.
 */
export function resetSessionProbe(): void {
  sessionProbe = null;
}

/* ==========================================================================
 * End-of-session event
 * ========================================================================== */

type SessionEndListener = () => void;
const sessionEndListeners = new Set<SessionEndListener>();

/** Subscribes to local session termination. Returns the unsubscribe function. */
export function onSessionEnded(listener: SessionEndListener): () => void {
  sessionEndListeners.add(listener);
  return () => {
    sessionEndListeners.delete(listener);
  };
}

function notifySessionEnded(): void {
  for (const listener of sessionEndListeners) {
    try {
      listener();
    } catch {
      // A broken listener must never block the logout itself.
    }
  }
}

/* ==========================================================================
 * Logout
 * ========================================================================== */

export type LogoutScope = 'current' | 'everywhere';

export interface EndSessionOptions {
  /**
   * `current` names the refresh token of this device (single-device logout);
   * `everywhere` omits it so the API revokes every session of the operator.
   */
  scope?: LogoutScope;
}

export interface EndSessionResult {
  /** Whether the API answered `POST /auth/logout` successfully. */
  serverOk: boolean;
  /** Operator-facing reason when the server call failed (null on success). */
  error: string | null;
}

function logoutErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 0) return error.message;
    if (error.status === 401) {
      return 'A API já não reconhecia esta sessão. Nenhum dado local foi mantido.';
    }
    if (error.status === 403) return 'A API recusou o encerramento desta sessão.';
    return `${error.message} (HTTP ${error.status})`;
  }
  return error instanceof Error && error.message
    ? error.message
    : 'Não foi possível confirmar o encerramento com a API.';
}

/**
 * Ends the session in this browser and (best effort) on the server.
 *
 * Order matters: the server call runs first so it still has the refresh token,
 * then every local credential/state is dropped, then the app is notified
 * synchronously (`flushSync`) — this way the router never renders one frame of
 * "authenticated" UI on top of `/login`.
 *
 * Never throws: a network/API failure still ends the local session, which is
 * exactly what the user asked for.
 */
export async function endSession(options: EndSessionOptions = {}): Promise<EndSessionResult> {
  const scope: LogoutScope = options.scope ?? 'current';
  const refreshToken = scope === 'current' ? currentRefreshToken() : null;

  let serverOk = true;
  let error: string | null = null;
  try {
    await api.logout(refreshToken);
  } catch (logoutError) {
    serverOk = false;
    error = logoutErrorMessage(logoutError);
  }

  // The local session ends regardless of the server answer.
  clearSessionTokens();
  resetSessionProbe();
  resetWorkspaceSession();
  flushSync(() => {
    notifySessionEnded();
  });

  return { serverOk, error };
}

/* ==========================================================================
 * Device description (sessions list)
 * ========================================================================== */

/**
 * Compact, human-readable device label for a raw user-agent:
 * `Chrome · Windows`, `Firefox · Linux`, or the raw string when nothing matches.
 * It deliberately avoids claiming a device model the UA did not state.
 */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').trim();
  if (ua.length === 0) return 'Dispositivo desconhecido';

  const browser =
    /\bEdg\//i.test(ua)
      ? 'Edge'
      : /\bOPR\/|\bOpera\b/i.test(ua)
        ? 'Opera'
        : /\bFirefox\//i.test(ua)
          ? 'Firefox'
          : /\bChrome\/|\bCriOS\//i.test(ua)
            ? 'Chrome'
            : /\bSafari\//i.test(ua)
              ? 'Safari'
              : null;

  const os =
    /\bWindows\b/i.test(ua)
      ? 'Windows'
      : /\bAndroid\b/i.test(ua)
        ? 'Android'
        : /\biPhone\b|\biPad\b|\biPod\b/i.test(ua)
          ? 'iOS'
          : /\bMac OS X\b|\bMacintosh\b/i.test(ua)
            ? 'macOS'
            : /\bLinux\b/i.test(ua)
              ? 'Linux'
              : null;

  if (browser !== null && os !== null) return `${browser} · ${os}`;
  if (browser !== null) return browser;
  if (os !== null) return os;
  return ua.length > 48 ? `${ua.slice(0, 48)}…` : ua;
}
