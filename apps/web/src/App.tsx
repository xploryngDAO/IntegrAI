import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useWorkspace } from './lib/store';
import {
  ApiClientError,
  DEFAULT_MAINTENANCE_MESSAGE,
  MAINTENANCE_ERROR_CODE,
  MAINTENANCE_EVENT,
  MAINTENANCE_RETRY_AFTER_SECONDS,
  currentRefreshToken,
  hasAuthToken,
  type MaintenanceEventDetail,
} from './lib/api';
import { onSessionEnded, probeSession } from './lib/session';
import {
  claimOnboardingRedirect,
  dismissOnboarding,
  isTenantProfileCompleted,
  loadTenantProfile,
  shouldOfferOnboarding,
} from './lib/onboarding';
import { isPlatformAdmin } from './lib/platform';
import { AppShell } from './components/layout/AppShell';
import { MaintenanceBanner } from './components/layout/MaintenanceBanner';
import { RouteFallback } from './components/layout/RouteFallback';
import { ToastViewport } from './components/layout/ToastViewport';
import { LoginPage } from './pages/LoginPage';
import { SignupPage } from './pages/SignupPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { InvitePage } from './pages/InvitePage';
import { StatusPage } from './pages/StatusPage';
import { LandingPage } from './pages/LandingPage';

type AuthState = 'checking' | 'authenticated' | 'anonymous';

/** Current maintenance window announced by the API client (`503 MAINTENANCE`). */
interface MaintenanceNotice {
  message: string;
  retryAfterSeconds: number;
}

/**
 * Session-free routes: the credential gate, the Fase 1 self-service screens
 * (the API mails `/verify-email?token=…`, `/reset-password?token=…` and
 * `/invite?token=…`), the Fase 5 corporate login return URL
 * (`/auth/sso/callback?code=…`), the public availability page (`/status`) and
 * the hosted checkout return URLs (`/billing/success`, `/billing/cancel`).
 */
const PUBLIC_PATHS = new Set([
  '/login',
  '/signup',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
  '/invite',
  '/auth/sso/callback',
  '/status',
  '/billing/success',
  '/billing/cancel',
]);

/**
 * Public routes that must render before — and without — the session probe: a
 * verification/invitation link opened from a mailbox cannot wait on `/auth/me`
 * (and must still work when the API session is unreachable). `/status` is here
 * for the same reason: the page that reports an outage cannot depend on the
 * session that may be failing. The checkout return URLs are here too: the
 * payment provider redirects the buyer to them with no guarantee about the API.
 *
 * `/auth/sso/callback` belongs here as well: the browser arrives from the
 * identity provider with a one-time `code` and no session yet, so probing
 * `/auth/me` first would only add a round-trip (and a 401) before the exchange.
 */
const NO_PROBE_PATHS = new Set([
  '/signup',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
  '/invite',
  '/auth/sso/callback',
  '/status',
  '/billing/success',
  '/billing/cancel',
]);

function normalizePath(pathname: string): string {
  const lower = pathname.toLowerCase();
  return lower.length > 1 && lower.endsWith('/') ? lower.replace(/\/+$/, '') : lower;
}

/**
 * Route-level code splitting.
 *
 * The public entry (landing + credential gate) is what an anonymous visitor
 * downloads first, so it stays eager: `LandingPage`, the credential screens and
 * `AuthLayout` ship in the entry chunk. Everything an authenticated operator
 * reaches later — the workspace/tickets/cockpit, admin, profile, settings,
 * accounts, platform, onboarding, setup, SSO return and checkout return — is a
 * dynamic import, so Rollup emits one chunk per page instead of folding the
 * whole app into `index-*.js`.
 *
 * The pages use named exports, hence the `.then` mapping. `BillingReturnPage`
 * exports two pages and is imported twice: Rollup resolves both imports to the
 * same chunk, so the module is still downloaded once.
 */
const WorkspacePage = lazy(() =>
  import('./pages/WorkspacePage').then((module) => ({ default: module.WorkspacePage })),
);
const AccountsPage = lazy(() =>
  import('./pages/AccountsPage').then((module) => ({ default: module.AccountsPage })),
);
const OnboardingPage = lazy(() =>
  import('./pages/OnboardingPage').then((module) => ({ default: module.OnboardingPage })),
);
const IntegrationSetupPage = lazy(() =>
  import('./pages/IntegrationSetupPage').then((module) => ({ default: module.IntegrationSetupPage })),
);
const PlatformPage = lazy(() =>
  import('./pages/PlatformPage').then((module) => ({ default: module.PlatformPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);
const ProfilePage = lazy(() =>
  import('./pages/ProfilePage').then((module) => ({ default: module.ProfilePage })),
);
const AdminPage = lazy(() =>
  import('./pages/AdminPage').then((module) => ({ default: module.AdminPage })),
);
const SsoCallbackPage = lazy(() =>
  import('./pages/SsoCallbackPage').then((module) => ({ default: module.SsoCallbackPage })),
);
const BillingSuccessPage = lazy(() =>
  import('./pages/BillingReturnPage').then((module) => ({ default: module.BillingSuccessPage })),
);
const BillingCancelPage = lazy(() =>
  import('./pages/BillingReturnPage').then((module) => ({ default: module.BillingCancelPage })),
);

/**
 * Single Suspense boundary for the routed content.
 *
 * It sits *inside* the router tree (under `AppShell` for the workspace, under
 * the root for the public screens), so only the page area is replaced while a
 * chunk loads: the shell and the toast viewport stay mounted. There is no cycle
 * back into the session gate — the lazy module resolves once and React caches
 * it for every later navigation.
 */
function SuspenseOutlet(): JSX.Element {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Outlet />
    </Suspense>
  );
}

/**
 * Session probe shared by StrictMode's double mount: one `/auth/me` per boot
 * instead of two. A failure clears the cache so a later navigation retries.
 *
 * The probe lives in `lib/session.ts` because logout must be able to forget the
 * cached promise — otherwise a logged-out tab would resurrect the previous
 * operator on the next `/login` boot.
 */

/**
 * App shell + routes.
 *
 * Session resolution:
 *  1. a valid API session (`GET /auth/me` succeeds) boots straight into the workspace;
 *  2. 401 shows the credential gate;
 *  3. any other failure shows the credential gate with the real error attached,
 *     so the operator sees what the API actually reported.
 *
 * The public routes above bypass the gate; an authenticated operator who lands
 * on `/login` or `/signup` is sent back to the workspace.
 *
 * Fase 2: the first authenticated visit to `/` hands a brand-new tenant to
 * `/onboarding` exactly once. The wizard never blocks the workspace — finishing
 * or skipping writes the per-tenant dismissal (`lib/onboarding.ts`) — and a deep
 * link straight to another page is left untouched.
 */
export default function App(): JSX.Element {
  const boot = useWorkspace((state) => state.boot);
  const currentAgent = useWorkspace((state) => state.currentAgent);
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [maintenance, setMaintenance] = useState<MaintenanceNotice | null>(null);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const path = normalizePath(pathname);
  const publicRoute = PUBLIC_PATHS.has(path);

  // The maintenance window is global state announced by `lib/api` when any
  // request receives `503 MAINTENANCE`. Registered before the probe effect
  // below so the very first `/auth/me` 503 is already captured; the listener is
  // removed on unmount and never traps the event for a later mount.
  useEffect(() => {
    function handleMaintenance(event: Event): void {
      const detail = (event as CustomEvent<MaintenanceEventDetail | undefined>).detail;
      if (detail === undefined || detail === null || typeof detail !== 'object') return;

      const message =
        typeof detail.message === 'string' && detail.message.trim().length > 0
          ? detail.message.trim()
          : DEFAULT_MAINTENANCE_MESSAGE;
      const seconds =
        typeof detail.retryAfterSeconds === 'number' &&
        Number.isFinite(detail.retryAfterSeconds) &&
        detail.retryAfterSeconds > 0
          ? Math.ceil(detail.retryAfterSeconds)
          : MAINTENANCE_RETRY_AFTER_SECONDS;

      setMaintenance({ message, retryAfterSeconds: seconds });
    }

    window.addEventListener(MAINTENANCE_EVENT, handleMaintenance);
    return () => window.removeEventListener(MAINTENANCE_EVENT, handleMaintenance);
  }, []);

  const dismissMaintenance = useCallback((): void => {
    setMaintenance(null);
  }, []);

  useEffect(() => {
    if (NO_PROBE_PATHS.has(path)) return;

    let active = true;

    async function resolveSession(): Promise<void> {
      try {
        await probeSession();
        // Anonymous visitor: no session to restore, so do not call the
        // authenticated workspace endpoints (they would 401 in the console).
        if (!hasAuthToken() && currentRefreshToken() === null) {
          if (active) setAuthState('anonymous');
          return;
        }
        await boot();
        if (active) setAuthState('authenticated');
      } catch (error) {
        if (!active) return;
        // Never demote a session that was just established (login, refresh).
        setAuthState((current) => (current === 'authenticated' ? current : 'anonymous'));
        if (error instanceof ApiClientError && error.status === 401) {
          setSessionError(null);
          return;
        }
        // A maintenance window is global state, not a session failure: the
        // banner already explains it, so the credential gate must not also
        // render the generic "API indisponível" message underneath it.
        if (error instanceof ApiClientError && error.code === MAINTENANCE_ERROR_CODE) {
          setSessionError(null);
          return;
        }
        const infrastructureFailure =
          error instanceof ApiClientError && (error.status === 0 || error.status >= 500);
        setSessionError(
          infrastructureFailure
            ? 'API indisponível ou não configurada. Defina VITE_API_BASE_URL apontando para a API publicada (passo 4 de docs/SETUP_PRODUCTION.md) e recarregue esta página.'
            : error instanceof Error && error.message
              ? error.message
              : 'Não foi possível verificar a sessão. Tente novamente.',
        );
      }
    }

    void resolveSession();
    return () => {
      active = false;
    };
  }, [boot, path]);

  const handleAuthenticated = useCallback((): void => {
    setSessionError(null);
    setAuthState('authenticated');
    void boot();
  }, [boot]);

  // Logout (user menu, rail button or /profile) ends the local session through
  // `lib/session`; this keeps the gate in sync without a full page reload.
  useEffect(
    () =>
      onSessionEnded(() => {
        setAuthState('anonymous');
        setSessionError(null);
      }),
    [],
  );

  // Fase 2 hand-off: only from the workspace landing (`/`), only for a tenant
  // that is neither completed nor locally dismissed, and only once per tab.
  // `currentAgent` is a dependency because a fresh login resolves the workspace
  // asynchronously (the store update is what re-runs this effect).
  //
  // `GET /tenants/me` is authoritative when available: a tenant finished in
  // another browser must not be sent back to the wizard. The probe is cached for
  // the page load and a failure keeps the local decision (older API deployments).
  useEffect(() => {
    if (authState !== 'authenticated') return;
    if (path !== '/') return;
    if (currentAgent === null) return;
    // Platform staff operate the console, not a tenant workspace: the guided
    // channel onboarding does not apply to them.
    if (isPlatformAdmin(currentAgent)) return;
    if (!shouldOfferOnboarding(currentAgent)) return;

    let cancelled = false;
    void loadTenantProfile().then((profile) => {
      if (cancelled) return;
      if (isTenantProfileCompleted(profile)) {
        dismissOnboarding(currentAgent);
        return;
      }
      // The operator may have navigated while the probe was in flight.
      if (window.location.pathname !== '/') return;
      if (!claimOnboardingRedirect(currentAgent)) return;
      navigate('/onboarding', { replace: true });
    });

    return () => {
      cancelled = true;
    };
  }, [authState, currentAgent, navigate, path]);

  const maintenanceBanner =
    maintenance === null ? null : (
      <MaintenanceBanner
        message={maintenance.message}
        retryAfterSeconds={maintenance.retryAfterSeconds}
        onDismiss={dismissMaintenance}
      />
    );

  /**
   * Puts the maintenance strip above whatever the current gate renders.
   *
   * Every branch returns through here, so the banner survives the transitions
   * landing → login → workspace: it is owned by `App` (never by a page) and a
   * dismissal only hides it until the API announces the window again.
   */
  function withMaintenance(content: JSX.Element): JSX.Element {
    return (
      <>
        {maintenanceBanner}
        {content}
      </>
    );
  }

  if (publicRoute) {
    if (authState === 'authenticated' && (path === '/login' || path === '/signup')) {
      return <Navigate to="/" replace />;
    }

    return withMaintenance(
      <>
        <Routes>
          {/* Suspense lives inside the route tree so the toast surface above
              keeps rendering while an on-demand page chunk loads. */}
          <Route element={<SuspenseOutlet />}>
            <Route
              path="/login"
              element={
                <LoginPage onAuthenticated={handleAuthenticated} initialError={sessionError ?? undefined} />
              }
            />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/verify-email" element={<VerifyEmailPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/invite" element={<InvitePage onAuthenticated={handleAuthenticated} />} />
            {/* Corporate login return URL: public, no probe (see NO_PROBE_PATHS). */}
            <Route
              path="/auth/sso/callback"
              element={<SsoCallbackPage onAuthenticated={handleAuthenticated} />}
            />
            {/* Public availability page: no session, no probe (see NO_PROBE_PATHS). */}
            <Route path="/status" element={<StatusPage />} />
            {/* Hosted checkout return URLs: public, no probe. */}
            <Route path="/billing/success" element={<BillingSuccessPage />} />
            <Route path="/billing/cancel" element={<BillingCancelPage />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Route>
        </Routes>

        <ToastViewport />
      </>,
    );
  }

  if (authState === 'checking') {
    // A visitor with no stored token on the marketing root sees the public
    // landing immediately; the probe still runs in the background and would
    // promote the tab if a session came back. Every other path keeps the
    // existing spinner (the credential gate must not flash).
    if (path === '/' && !hasAuthToken()) return withMaintenance(<LandingPage />);

    return withMaintenance(
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 text-[var(--cv-color-text-muted)]">
        <span className="cv-spinner" />
        <p className="m-0 text-[var(--cv-font-meta)]">Carregando workspace…</p>
      </div>,
    );
  }

  if (authState === 'anonymous') {
    // Public landing page for visitors at `/`; every other unauthenticated path
    // keeps the credential gate (deep links to /profile, /admin, … land on
    // /login after authentication).
    if (path === '/') return withMaintenance(<LandingPage />);

    return withMaintenance(
      <>
        <Routes>
          <Route
            path="*"
            element={
              <LoginPage onAuthenticated={handleAuthenticated} initialError={sessionError ?? undefined} />
            }
          />
        </Routes>
        <ToastViewport />
      </>,
    );
  }

  return withMaintenance(
    <>
      <Routes>
        <Route element={<AppShell />}>
          {/* Inside the shell: the rail/topbar stay painted while the page
              chunk downloads, so only the content column shows the fallback. */}
          <Route element={<SuspenseOutlet />}>
            <Route path="/" element={<WorkspacePage />} />
            <Route path="/accounts" element={<AccountsPage />} />
            <Route path="/onboarding" element={<OnboardingPage />} />
            {/* Fase 3: app setup screen (platform admin; the API answers 403). */}
            <Route path="/setup" element={<IntegrationSetupPage />} />
            {/* Fase 4: both screens are guarded again by the API (403). */}
            <Route path="/platform" element={<PlatformPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* Conta do operador + administração do workspace (ADMIN; 403 → restrito). */}
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Route>
      </Routes>

      {/* Single global toast surface — features only call pushToast(). */}
      <ToastViewport />
    </>,
  );
}
