/**
 * Runtime configuration of the SPA.
 *
 * The API/WebSocket endpoints are **not** owned by the bundle: the MVP backend
 * runs on a developer machine behind a Cloudflare quick tunnel whose hostname
 * changes whenever the tunnel restarts. Baking that hostname at build time
 * would break every already-published Vercel deployment on the next restart
 * (and force a redeploy just to fix an env value, consuming the deployment
 * quota). Instead the deployed SPA resolves the endpoints at boot from a
 * stable, public `runtime-config.json` (GitHub raw of this repository):
 *
 *     https://raw.githubusercontent.com/xploryngDAO/IntegrAI/main/apps/web/runtime-config.json
 *
 * Precedence, highest first:
 *   1. `runtime-config.json` fetched at boot (2 s cap);
 *   2. the last successful config cached in `localStorage` (offline/GitHub
 *      outage keeps the app usable);
 *   3. `VITE_API_BASE_URL` / `VITE_WS_URL` baked at build time;
 *   4. same-origin `/api/v1` and `window.location.origin` (self-hosted stack).
 *
 * Updating the tunnel URL is therefore a JSON edit — no Vercel deployment is
 * needed: `node scripts/tunnel-sync.mjs <https://new-tunnel>` rewrites the file.
 *
 * The fetch is deliberately short and never throws: when GitHub is slow or
 * unreachable the app still boots with the build-time values.
 */

/** Default location of the mutable runtime config (public repo, CORS `*`). */
const DEFAULT_CONFIG_URL =
  'https://raw.githubusercontent.com/xploryngDAO/IntegrAI/main/apps/web/runtime-config.json';

/** The boot sequence waits at most this long for the config before rendering. */
const FETCH_TIMEOUT_MS = 2_000;

/** Last successful config, so a GitHub outage does not break the next load. */
const STORAGE_KEY = 'sac.runtime-config.v1';

export interface RuntimeConfig {
  /** Absolute API base, already stripped of the trailing slash (`.../api/v1`). */
  apiBaseUrl: string | null;
  /** Socket.IO origin (no path), or null when the config does not publish one. */
  wsUrl: string | null;
}

const EMPTY: RuntimeConfig = { apiBaseUrl: null, wsUrl: null };

let loaded: RuntimeConfig = EMPTY;

/**
 * Accepts only absolute http(s) URLs and removes the trailing slash.
 *
 * A relative value is rejected on purpose: the deployed SPA has no API on its
 * own origin, so a relative base would silently hit Vercel's `index.html`
 * fallback instead of the API. Anything invalid becomes `null` and the caller
 * keeps the previous value.
 */
function normalizeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Last config persisted by a previous successful boot (never throws). */
function readCache(): RuntimeConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return EMPTY;
    const record = parsed as { apiBaseUrl?: unknown; wsUrl?: unknown };
    return {
      apiBaseUrl: normalizeUrl(record.apiBaseUrl),
      wsUrl: normalizeUrl(record.wsUrl),
    };
  } catch {
    return EMPTY;
  }
}

function writeCache(config: RuntimeConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Private mode / storage disabled: the in-memory value is enough.
  }
}

/**
 * Resolves the runtime endpoints once, before React renders.
 *
 * Never rejects: on timeout, network failure, invalid JSON or an empty object
 * the cached (or build-time) values stay in place and the app boots normally.
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  // Hermetic builds (CI/local E2E) must honor the baked API base: the remote
  // JSON would otherwise point the preview at the tunnel and silently bypass
  // the local stack (making authenticated audits pass against the wrong API).
  if (import.meta.env.VITE_RUNTIME_CONFIG_DISABLE === 'true') {
    loaded = EMPTY;
    return loaded;
  }

  const cached = readCache();

  const configured = (import.meta.env.VITE_RUNTIME_CONFIG_URL as string | undefined)?.trim();
  const configUrl = configured !== undefined && configured.length > 0 ? configured : DEFAULT_CONFIG_URL;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller === null ? null : window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // The unique query string bypasses GitHub's 5-minute CDN cache: a tunnel
    // restart must be visible on the next page load, not "up to 5 min later".
    const separator = configUrl.includes('?') ? '&' : '?';
    const response = await fetch(`${configUrl}${separator}t=${Date.now()}`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== 'object') throw new Error('invalid config body');
    const record = payload as { apiBaseUrl?: unknown; wsUrl?: unknown };
    const next: RuntimeConfig = {
      apiBaseUrl: normalizeUrl(record.apiBaseUrl),
      wsUrl: normalizeUrl(record.wsUrl),
    };
    if (next.apiBaseUrl === null && next.wsUrl === null) throw new Error('empty config');

    // Merge with the cache so a partial config never drops a known endpoint.
    loaded = {
      apiBaseUrl: next.apiBaseUrl ?? cached.apiBaseUrl,
      wsUrl: next.wsUrl ?? cached.wsUrl,
    };
    writeCache(loaded);
    return loaded;
  } catch {
    loaded = cached;
    return loaded;
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

/** API base resolved from the runtime config, or null when it is not known. */
export function runtimeApiBase(): string | null {
  return loaded.apiBaseUrl;
}

/** Socket.IO origin resolved from the runtime config, or null. */
export function runtimeWsUrl(): string | null {
  return loaded.wsUrl;
}
