/**
 * Fase 2 onboarding bookkeeping (docs/PHASE2_ONBOARDING.md §1).
 *
 * The SPA decides *once* whether a freshly authenticated operator should be
 * taken to `/onboarding`. Two things gate that decision:
 *
 *  1. the tenant completion timestamp — `GET /tenants/me` returns
 *     `onboardingCompletedAt` (the gate also accepts it on the `/auth/me`
 *     payload when a deployment adds it); non-null means "already done";
 *  2. the local dismissal — `sac.onboarding.dismissed` keeps the tenant keys of
 *     workspaces where the operator either finished or chose "Pular por agora",
 *     so an API without the tenant flag never bounces the operator back.
 *
 * The dismissal list is versioned by tenant: changing workspace (or signing in
 * with another tenant in the same browser) does not inherit the decision.
 */

import type { IAgentSummary } from '@sac/shared';

import { api } from './api';
import type { TenantProfile } from './types';

/** Per-tenant dismissal list (JSON array of tenant keys). */
export const ONBOARDING_DISMISSED_KEY = 'sac.onboarding.dismissed';

/** Guards the automatic redirect to one attempt per browser tab. */
const ONBOARDING_REDIRECTED_KEY = 'sac.onboarding.redirected';

/** The dismissal list is capped so a long-lived browser cannot grow it forever. */
const MAX_REMEMBERED_TENANTS = 20;

/**
 * `/auth/me` extended with the tenant fields the gate and the welcome copy read.
 * They are optional because the current contract only returns `tenantId`.
 */
export type OnboardingAgent = IAgentSummary & {
  onboardingCompletedAt?: string | null;
  tenantName?: string | null;
  tenant?: { name?: string | null; onboardingCompletedAt?: string | null } | null;
};

/** Storage can be unavailable (private mode / blocked cookies): keep an in-memory mirror. */
const dismissedInMemory = new Set<string>();
let redirectClaimed = false;
let tenantProfileProbe: Promise<TenantProfile | null> | null = null;

function safeStorage(kind: 'local' | 'session'): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function readDismissed(): string[] {
  const storage = safeStorage('local');
  if (!storage) return [];
  try {
    const raw = storage.getItem(ONBOARDING_DISMISSED_KEY);
    if (raw === null || raw.trim() === '') return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === 'string');
    // Tolerate the 1-value form (`"tenant-id"`) written by older builds.
    return typeof parsed === 'string' && parsed.trim() !== '' ? [parsed] : [];
  } catch {
    return [];
  }
}

function writeDismissed(keys: string[]): void {
  const storage = safeStorage('local');
  if (!storage) return;
  try {
    storage.setItem(ONBOARDING_DISMISSED_KEY, JSON.stringify(keys.slice(-MAX_REMEMBERED_TENANTS)));
  } catch {
    // The in-memory mirror still prevents a redirect loop for this session.
  }
}

/**
 * Tenant key used by the local flags. A legacy operator without a tenant falls
 * back to the operator id so the decision is still scoped to somebody.
 */
export function onboardingKeyFor(agent: OnboardingAgent): string {
  const tenantId = (agent.tenantId ?? '').trim();
  return tenantId.length > 0 ? tenantId : `agent:${agent.id}`;
}

/** Tenant display name carried by the agent payload, when a deployment includes it. */
export function tenantDisplayName(agent: OnboardingAgent): string | null {
  const name = agent.tenant?.name?.trim() || agent.tenantName?.trim() || '';
  return name.length > 0 ? name : null;
}

/** True only when the API explicitly reports a completion timestamp. */
export function isOnboardingCompleted(agent: OnboardingAgent): boolean {
  const value = agent.tenant?.onboardingCompletedAt ?? agent.onboardingCompletedAt ?? null;
  return typeof value === 'string' && value.trim().length > 0;
}

/** Same test for the `GET /tenants/me` projection. */
export function isTenantProfileCompleted(profile: TenantProfile | null): boolean {
  return (
    profile !== null &&
    typeof profile.onboardingCompletedAt === 'string' &&
    profile.onboardingCompletedAt.trim().length > 0
  );
}

/**
 * Reads `/tenants/me` once per page load.
 *
 * Used by the gate (a tenant completed in another browser must not see the
 * wizard again) and by the welcome step (real workspace name). `null` means the
 * route is absent in this environment or the call failed — callers fall back to
 * the local decision and the generic copy.
 */
export function loadTenantProfile(): Promise<TenantProfile | null> {
  if (tenantProfileProbe === null) {
    tenantProfileProbe = api.tenantProfile().then(
      (profile) => profile,
      () => null,
    );
  }
  return tenantProfileProbe;
}

/** True when this tenant was finished or skipped in this browser. */
export function isOnboardingDismissed(agent: OnboardingAgent): boolean {
  const key = onboardingKeyFor(agent);
  return dismissedInMemory.has(key) || readDismissed().includes(key);
}

/**
 * Records "não mostrar de novo" for the tenant. Called by "Pular por agora"
 * (without completing) and by the completion step (even when the optional
 * `PATCH /tenants/me` is not deployed).
 */
export function dismissOnboarding(agent: OnboardingAgent): void {
  const key = onboardingKeyFor(agent);
  dismissedInMemory.add(key);

  const keys = readDismissed().filter((entry) => entry !== key);
  keys.push(key);
  writeDismissed(keys);
}

/** The automatic hand-off applies only to a tenant that is neither completed nor dismissed. */
export function shouldOfferOnboarding(agent: OnboardingAgent): boolean {
  return !isOnboardingCompleted(agent) && !isOnboardingDismissed(agent);
}

/**
 * Claims the single automatic redirect of this browser tab.
 *
 * StrictMode mounts effects twice, and a reload of the SPA would otherwise
 * bounce an operator who deliberately navigated to `/` — so the claim is
 * persisted in `sessionStorage` and mirrored in memory when storage is blocked.
 */
export function claimOnboardingRedirect(agent: OnboardingAgent): boolean {
  if (redirectClaimed) return false;

  const key = onboardingKeyFor(agent);
  const storage = safeStorage('session');
  if (storage) {
    try {
      if (storage.getItem(ONBOARDING_REDIRECTED_KEY) === key) return false;
      storage.setItem(ONBOARDING_REDIRECTED_KEY, key);
    } catch {
      // Fall through to the in-memory guard.
    }
  }

  redirectClaimed = true;
  return true;
}
