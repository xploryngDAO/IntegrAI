import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useWorkspace } from './lib/store';
import { ApiClientError, api } from './lib/api';
import { AppShell } from './components/layout/AppShell';
import { ToastViewport } from './components/layout/ToastViewport';
import { LoginPage } from './pages/LoginPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { AccountsPage } from './pages/AccountsPage';

type AuthState = 'checking' | 'authenticated' | 'anonymous';

/**
 * App shell + routes.
 *
 * Session resolution:
 *  1. a valid API session (`GET /auth/me` succeeds) boots straight into the workspace;
 *  2. 401 shows the credential gate;
 *  3. any other failure shows the credential gate with the real error attached,
 *     so the operator sees what the API actually reported.
 */
export default function App(): JSX.Element {
  const boot = useWorkspace((state) => state.boot);
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function resolveSession(): Promise<void> {
      try {
        await api.me();
        await boot();
        if (!cancelled) setAuthState('authenticated');
      } catch (error) {
        if (cancelled) return;
        setAuthState('anonymous');
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
      cancelled = true;
    };
  }, [boot]);

  const handleAuthenticated = useCallback((): void => {
    setSessionError(null);
    setAuthState('authenticated');
    void boot();
  }, [boot]);

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
        <LoginPage onAuthenticated={handleAuthenticated} initialError={sessionError ?? undefined} />
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
