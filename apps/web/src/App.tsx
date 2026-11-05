import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useWorkspace } from './lib/store';
import { ApiClientError, api, isMockMode } from './lib/api';
import { AppShell } from './components/layout/AppShell';
import { DemoModeBanner } from './components/layout/DemoModeBanner';
import { ToastViewport } from './components/layout/ToastViewport';
import { LoginPage } from './pages/LoginPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { AccountsPage } from './pages/AccountsPage';

type AuthState = 'checking' | 'authenticated' | 'anonymous';

/**
 * App shell + routes.
 *
 * Boot sequence:
 *  1. offline/demo session (`VITE_MOCK_MODE=true` or API unreachable) boots with
 *     the mock agent, no credential wall;
 *  2. a reachable API with a valid token boots straight into the workspace;
 *  3. a reachable API answering 401 shows the credential gate.
 */
export default function App(): JSX.Element {
  const boot = useWorkspace((state) => state.boot);
  const [authState, setAuthState] = useState<AuthState>('checking');

  useEffect(() => {
    let cancelled = false;

    async function resolveSession(): Promise<void> {
      if (isMockMode()) {
        await boot();
        if (!cancelled) setAuthState('authenticated');
        return;
      }
      try {
        await api.me();
        await boot();
        if (!cancelled) setAuthState('authenticated');
      } catch (error) {
        if (isMockMode()) {
          await boot();
          if (!cancelled) setAuthState('authenticated');
          return;
        }
        if (error instanceof ApiClientError && error.status === 401) {
          if (!cancelled) setAuthState('anonymous');
          return;
        }
        await boot();
        if (!cancelled) setAuthState('authenticated');
      }
    }

    void resolveSession();
    return () => {
      cancelled = true;
    };
  }, [boot]);

  const handleAuthenticated = useCallback((): void => {
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
        <LoginPage onAuthenticated={handleAuthenticated} />
        <ToastViewport />
      </>
    );
  }

  return (
    <>
      <Routes>
        <Route element={<AppShell banner={<DemoModeBanner />} />}>
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
