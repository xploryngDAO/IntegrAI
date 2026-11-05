import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useWorkspace } from './lib/store';
import { ApiClientError, api } from './lib/api';
import { AppShell } from './components/layout/AppShell';
import { ToastViewport } from './components/layout/ToastViewport';
import { LoginPage } from './pages/LoginPage';
import { SignupPage } from './pages/SignupPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { AccountsPage } from './pages/AccountsPage';

type AuthState = 'checking' | 'authenticated' | 'anonymous';

/**
 * Session-free routes: the credential gate plus the Fase 1 self-service screens
 * (the API mails `/verify-email?token=…` and `/reset-password?token=…`).
 */
const PUBLIC_PATHS = new Set([
  '/login',
  '/signup',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
]);

/**
 * Public routes that must render before — and without — the session probe: a
 * verification link opened from a mailbox cannot wait on `/auth/me` (and must
 * still work when the API session is unreachable).
 */
const NO_PROBE_PATHS = new Set([
  '/signup',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
]);

function normalizePath(pathname: string): string {
  const lower = pathname.toLowerCase();
  return lower.length > 1 && lower.endsWith('/') ? lower.replace(/\/+$/, '') : lower;
}

/**
 * Session probe shared by StrictMode's double mount: one `/auth/me` per boot
 * instead of two. A failure clears the cache so a later navigation retries.
 */
let sessionProbe: Promise<void> | null = null;

function probeSession(): Promise<void> {
  if (sessionProbe === null) {
    sessionProbe = api.me().then(() => undefined);
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
 */
export default function App(): JSX.Element {
  const boot = useWorkspace((state) => state.boot);
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [sessionError, setSessionError] = useState<string | null>(null);
  const { pathname } = useLocation();
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>

      {/* Single global toast surface — features only call pushToast(). */}
      <ToastViewport />
    </>
  );
}
