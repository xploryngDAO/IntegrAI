import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { AuthResponse } from '@sac/shared';
import { api } from '../lib/api';
import { ssoCodeMessage, ssoErrorMessage } from '../lib/sso';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Alert, Button, Spinner } from '../components/ui';

type CallbackState =
  | { status: 'exchanging' }
  | { status: 'success'; email: string }
  | { status: 'error'; message: string };

/**
 * One exchange per authorization code for the lifetime of the tab.
 *
 * The code is single use and React StrictMode mounts the effect twice; a second
 * POST would burn the code and show a false "código inválido". The promise is
 * shared while it is in flight and kept after a success (going back to this URL
 * must not turn a valid login into an error). A failure drops the entry so the
 * operator can start a new login.
 */
const exchanges = new Map<string, Promise<AuthResponse>>();

function exchangeOnce(code: string): Promise<AuthResponse> {
  const inFlight = exchanges.get(code);
  if (inFlight !== undefined) return inFlight;

  const promise = api.ssoExchange(code);
  exchanges.set(code, promise);
  promise.catch(() => {
    exchanges.delete(code);
  });
  return promise;
}

/** How long the success confirmation stays visible before the workspace opens. */
const SUCCESS_REDIRECT_MS = 1_800;

export interface SsoCallbackPageProps {
  /** Same hand-off the login page uses: flips the gate and boots the workspace. */
  onAuthenticated: () => void;
}

/**
 * `/auth/sso/callback?code=…` — the SPA half of the corporate login.
 *
 * The backend redirects the browser here after the IdP round-trip; this page
 * redeems the one-time `code` on `POST /auth/sso/exchange`, persists the session
 * (the API client stores the JWT, exactly like `login()`) and opens the
 * workspace. It is a session-free route and skips the `/auth/me` probe: a
 * callback opened from Microsoft must render even when no session exists yet.
 *
 * A failure is shown with the real API message — `401 INVALID_SSO_CODE` (expired
 * or replayed code), `SSO_REQUIRED`, `SSO_DOMAIN_NOT_ALLOWED`,
 * `SSO_PROVISIONING_DISABLED` — plus the way back to the credential gate.
 */
export function SsoCallbackPage({ onAuthenticated }: SsoCallbackPageProps): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const code = (searchParams.get('code') ?? '').trim();
  // The backend redirects failures after the state check here as
  // `?error=<stable code>` (SSO_DOMAIN_NOT_ALLOWED, SSO_CANCELLED, …); an IdP
  // may also append its own OAuth `error`/`error_description`.
  const errorCode = (searchParams.get('error') ?? '').trim();
  const errorDescription = (searchParams.get('error_description') ?? '').trim();

  const [state, setState] = useState<CallbackState>({ status: 'exchanging' });

  useEffect(() => {
    // Nothing to redeem: the render below explains it (no request is sent).
    if (code === '' || errorCode !== '') return;

    let active = true;
    setState({ status: 'exchanging' });

    exchangeOnce(code)
      .then((auth) => {
        if (!active) return;
        setState({ status: 'success', email: (auth.agent?.email ?? '').trim() });
        // Persist the authenticated state before the redirect below.
        onAuthenticated();
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({ status: 'error', message: ssoErrorMessage(error, 'exchange') });
      });

    return () => {
      active = false;
    };
  }, [code, errorCode, onAuthenticated]);

  // Success is a confirmation, not a dead end: the workspace opens by itself.
  useEffect(() => {
    if (state.status !== 'success') return;
    const timer = window.setTimeout(() => navigate('/', { replace: true }), SUCCESS_REDIRECT_MS);
    return () => window.clearTimeout(timer);
  }, [state.status, navigate]);

  if (state.status === 'exchanging' && code !== '' && errorCode === '') {
    return (
      <AuthLayout
        title="Concluindo o login corporativo"
        description="Validando a resposta do provedor de identidade e abrindo sua sessão."
      >
        <div className="flex flex-col items-center gap-3 py-2 text-[var(--cv-color-text-muted)]">
          <Spinner label="Concluindo login" />
          <p className="m-0 text-[var(--cv-font-meta)]">Isso leva apenas um instante.</p>
        </div>
      </AuthLayout>
    );
  }

  if (state.status === 'exchanging') {
    // No `code` and no error code: the URL was opened without the round-trip,
    // or the backend/IdP rejected the login before issuing the one-time code.
    const reason =
      errorCode !== ''
        ? (ssoCodeMessage(errorCode) ??
          (errorDescription.length > 0
            ? `O provedor de identidade recusou o login (${errorCode}): ${errorDescription}`
            : `O provedor de identidade recusou o login (${errorCode}).`))
        : 'O provedor não devolveu o código de autorização. Abra o login corporativo pelo botão "Entrar com Microsoft".';

    return (
      <AuthLayout
        title="Login corporativo incompleto"
        description="A autenticação não foi concluída neste navegador."
      >
        <Alert title="Não foi possível concluir o login" tone="danger">
          {reason}
        </Alert>

        <p className="m-0 text-center text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          <Link to="/login" className="cv-link underline">
            Voltar ao login
          </Link>
        </p>
      </AuthLayout>
    );
  }

  if (state.status === 'error') {
    return (
      <AuthLayout
        title="Não foi possível concluir o login"
        description="O retorno do provedor de identidade não abriu uma sessão neste workspace."
      >
        <Alert title="Falha ao entrar com a conta corporativa" tone="danger">
          {state.message}
        </Alert>

        <p className="m-0 text-center text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          <Link to="/login" className="cv-link underline">
            Voltar ao login
          </Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Login corporativo concluído"
      description="Sua sessão foi aberta com a conta do Microsoft Entra ID."
    >
      <Alert title="Tudo certo" tone="success">
        {state.email.length > 0
          ? `Entramos como ${state.email}. O workspace está sendo aberto…`
          : 'Sua sessão corporativa está ativa. O workspace está sendo aberto…'}
      </Alert>

      <Button
        type="button"
        variant="primary"
        icon="arrow"
        fullWidth
        onClick={() => navigate('/', { replace: true })}
      >
        Ir para o workspace
      </Button>
    </AuthLayout>
  );
}
