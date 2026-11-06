import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useWorkspace } from './lib/store';
import { ApiClientError, api } from './lib/api';
import {
  claimOnboardingRedirect,
  dismissOnboarding,
  isTenantProfileCompleted,
  loadTenantProfile,
  shouldOfferOnboarding,
} from './lib/onboarding';
import { isPlatformAdmin } from './lib/platform';
import { AppShell } from './components/layout/AppShell';
import { ToastViewport } from './components/layout/ToastViewport';
import { LoginPage } from './pages/LoginPage';
import { SignupPage } from './pages/SignupPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { InvitePage } from './pages/InvitePage';
import { StatusPage } from './pages/StatusPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { AccountsPage } from './pages/AccountsPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { PlatformPage } from './pages/PlatformPage';
import { SettingsPage } from './pages/SettingsPage';
import { BillingSuccessPage, BillingCancelPage } from './pages/BillingReturnPage';

type AuthState = 'checking' | 'authenticated' | 'anonymous';

/**
 * Session-free routes: the credential gate, the Fase 1 self-service screens
 * (the API mails `/verify-email?token=…`, `/reset-password?token=…` and
 * `/invite?token=…`), the public availability page (`/status`) and the hosted
 * checkout return URLs (`/billing/success`, `/billing/cancel`).
 */
const PUBLIC_PATHS = new Set([
  '/login',
  '/signup',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
  '/invite',
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
 */
const NO_PROBE_PATHS = new Set([
  '/signup',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
  '/invite',
  '/status',
  '/billing/success',
  '/billing/cancel',
]);

function normalizePath(pathname: string): string {
  const lower = pathname.toLowerCase();
  return lower.length > 1 && lower.endsWith('/') ? lower.replace(/\/+$/, '') : lower;
}

/**
 * Session probe shared by StrictMode's double mount: one `/auth/me` per boot
 * instead of two. A failure clears the cache so a later navigation retries.
 *
 * The summary is mirrored into the store before `boot()` runs: role-gated
 * navigation (Fase 4) and the topbar identity must not depend on every tenant
 * endpoint succeeding — a platform operator may not have tenant data at all.
 */
let sessionProbe: Promise<void> | null = null;

function probeSession(): Promise<void> {
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
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const path = normalizePath(pathname);
  const publicRoute = PUBLIC_PATHS.has(path);

  useEffect(() => {
    if (NO_PROBE_PATHS.has(path)) return;

    let active = true;

    async function resolveSession(): Promise<void> {
      try {
        await probeSession();
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

  if (publicRoute) {
    if (authState === 'authenticated' && (path === '/login' || path === '/signup')) {
      return <Navigate to="/" replace />;
    }

    return (
      <>
        <Routes>
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
          {/* Public availability page: no session, no probe (see NO_PROBE_PATHS). */}
          <Route path="/status" element={<StatusPage />} />
          {/* Hosted checkout return URLs: public, no probe. */}
          <Route path="/billing/success" element={<BillingSuccessPage />} />
          <Route path="/billing/cancel" element={<BillingCancelPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>

        <ToastViewport />
      </>
    );
  }

  if (authState === 'checking') {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 text-[var(--cv-color-text-muted)]">
        <span className="cv-spinner" />
        <p className="m-0 text-[var(--cv-font-meta)]">Carregando workspace…</p>
      </div>
    );
  }

  if (authState === 'anonymous') {
    return (
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
      </>
    );
  }

  return (
    <>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<WorkspacePage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          {/* Fase 4: both screens are guarded again by the API (403). */}
          <Route path="/platform" element={<PlatformPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>

      {/* Single global toast surface — features only call pushToast(). */}
      <ToastViewport />
    </>
  );
}
