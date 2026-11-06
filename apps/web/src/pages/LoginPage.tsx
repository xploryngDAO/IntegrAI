import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiClientError, TwoFactorRequiredError } from '../lib/api';
import {
  isPlausibleTwoFactorCode,
  normalizeTwoFactorCode,
  twoFactorErrorMessage,
} from '../lib/twoFactor';
import { ssoErrorMessage, ssoStartUrl } from '../lib/sso';
import { isValidEmail } from '../lib/validation';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Alert, Button, Input } from '../components/ui';

interface LoginPageProps {
  onAuthenticated: () => void;
  /** Real error raised while resolving the session (e.g. API unreachable). */
  initialError?: string;
}

/**
 * Credential gate for the real session, rendered with Convergência surfaces
 * (paper card on the cool background, indigo primary action).
 *
 * The screen is also the hub of the Fase 1 self-service flows: account creation
 * (`/signup`), password recovery (`/forgot-password`) and, when the API answers
 * `EMAIL_NOT_VERIFIED`, the resend link for the verification e-mail.
 *
 * When the API answers `TWO_FACTOR_REQUIRED` (401/403) with a `challengeToken`,
 * no session exists yet: the same page switches to the 2FA step, redeems the
 * challenge on `POST /auth/2fa/challenge` and only then calls `onAuthenticated`.
 *
 * Fase 5: "Entrar com Microsoft" asks `GET /auth/sso/discover` for the typed
 * e-mail. When the domain is covered by SSO the browser navigates to
 * `/auth/sso/start` (302 to the IdP) and comes back on `/auth/sso/callback`;
 * otherwise the page states that SSO is not configured for the domain.
 */
export function LoginPage({ onAuthenticated, initialError }: LoginPageProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [needsVerification, setNeedsVerification] = useState(false);

  // Corporate login (Microsoft Entra ID). The button reuses the e-mail typed
  // above: `/auth/sso/discover` decides per domain whether the workspace has
  // SSO, and only then does the browser leave the SPA for `sso/start`.
  const [emailError, setEmailError] = useState<string | null>(null);
  const [ssoLoading, setSsoLoading] = useState(false);
  const [ssoNotice, setSsoNotice] = useState<{ tone: 'warning' | 'danger'; text: string } | null>(
    null,
  );

  // Second step: the password was accepted but the account has 2FA enabled, so
  // the API issued a short-lived challenge token instead of a session.
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [challengeCode, setChallengeCode] = useState('');
  const [challengeLoading, setChallengeLoading] = useState(false);
  const [challengeError, setChallengeError] = useState<string | null>(null);

  function backToCredentials(): void {
    if (challengeLoading) return;
    setChallengeToken(null);
    setChallengeCode('');
    setChallengeError(null);
    setPassword('');
  }

  // Coming back from the IdP (browser back / bfcache) must not leave the SSO
  // button spinning: a restored page keeps the React state from before the
  // full navigation, so the busy flag is cleared whenever the page is shown.
  useEffect(() => {
    function resetSsoBusy(): void {
      setSsoLoading(false);
    }
    window.addEventListener('pageshow', resetSsoBusy);
    return () => window.removeEventListener('pageshow', resetSsoBusy);
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    setNeedsVerification(false);
    try {
      await api.login(email.trim(), password);
      onAuthenticated();
    } catch (loginError) {
      if (loginError instanceof TwoFactorRequiredError) {
        // No session was issued: drop the password and ask for the code.
        setChallengeToken(loginError.challengeToken);
        setChallengeCode('');
        setChallengeError(null);
        setPassword('');
        return;
      }
      if (loginError instanceof ApiClientError) {
        // Fase 1: a valid password on an unverified account answers 403, which
        // is a verification problem — not a credential problem.
        if (loginError.code === 'EMAIL_NOT_VERIFIED') {
          setNeedsVerification(true);
          return;
        }
        if (loginError.code === 'TWO_FACTOR_REQUIRED') {
          setError(
            'A API pediu a verificação em duas etapas, mas não retornou o token do desafio. Tente entrar novamente.',
          );
          return;
        }
        // Fase 5: the workspace enforces SSO, so the password path is closed.
        // The server only reveals it after a valid password (no enumeration).
        if (loginError.code === 'SSO_REQUIRED') {
          setError(
            'Este workspace exige login corporativo: a senha está desabilitada. Use o botão "Entrar com Microsoft".',
          );
          return;
        }
        setError(
          loginError.status === 401 || loginError.status === 422
            ? 'Credenciais inválidas. Verifique e-mail e senha e tente novamente.'
            : loginError.status === 0
              ? loginError.message
              : `Falha ao autenticar (HTTP ${loginError.status}): ${loginError.message}`,
        );
      } else {
        setError('Não foi possível falar com a API. Verifique a conexão e tente novamente.');
      }
    } finally {
      setLoading(false);
    }
  }

  /**
   * Corporate login step 1: discovery.
   *
   * The e-mail is the key — the API resolves the tenant/domain from it. When the
   * domain is not covered by SSO the page says so explicitly (no silent no-op).
   * When it is, the browser performs a full navigation to `/auth/sso/start`,
   * which answers 302 to the IdP; the session is only created after the backend
   * redirects back to `/auth/sso/callback`.
   */
  async function handleSsoLogin(): Promise<void> {
    if (ssoLoading) return;

    const value = email.trim();
    if (!isValidEmail(value)) {
      setEmailError(
        value.length === 0
          ? 'Informe o e-mail corporativo no campo acima para entrar com a Microsoft.'
          : 'Informe um e-mail válido para descobrir o SSO do domínio.',
      );
      setSsoNotice(null);
      document.getElementById('login-sso-email')?.focus();
      return;
    }

    setEmailError(null);
    setSsoNotice(null);
    setError(null);
    setNeedsVerification(false);
    setSsoLoading(true);

    try {
      const discovery = await api.ssoDiscover(value);
      if (!discovery.enabled) {
        setSsoNotice({
          tone: 'warning',
          text: 'SSO não configurado para este domínio. Entre com e-mail e senha ou peça a um ADMIN do workspace para habilitar o login corporativo.',
        });
        setSsoLoading(false);
        return;
      }
      // Full navigation on purpose: the API answers 302 to the IdP, which a
      // fetch() cannot follow across origins. The button stays busy while the
      // browser leaves the SPA.
      window.location.assign(ssoStartUrl(value));
    } catch (ssoError) {
      setSsoNotice({ tone: 'danger', text: ssoErrorMessage(ssoError, 'discover') });
      setSsoLoading(false);
    }
  }

  async function handleChallengeSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (challengeLoading || challengeToken === null) return;

    const normalized = normalizeTwoFactorCode(challengeCode);
    if (!isPlausibleTwoFactorCode(normalized)) {
      setChallengeError('Informe os 6 dígitos do app autenticador ou um código de recuperação.');
      return;
    }

    setChallengeLoading(true);
    setChallengeError(null);
    try {
      // Persists the JWT returned by the challenge (same session as login).
      await api.twoFactorChallenge(challengeToken, normalized);
      onAuthenticated();
    } catch (challengeFailure) {
      setChallengeError(twoFactorErrorMessage(challengeFailure, 'challenge'));
    } finally {
      setChallengeLoading(false);
    }
  }

  if (challengeToken !== null) {
    return (
      <AuthLayout
        title="Verificação em duas etapas"
        description="Sua conta está protegida por um código adicional. Confirme para concluir o login."
      >
        <form
          className="mt-1 flex flex-col gap-4"
          onSubmit={(event) => void handleChallengeSubmit(event)}
        >
          <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
            Entrando como{' '}
            <strong className="font-medium text-[var(--cv-color-text)]">{email.trim()}</strong>
          </p>

          <Input
            label="Código de verificação"
            autoComplete="one-time-code"
            spellCheck={false}
            maxLength={32}
            autoFocus
            value={challengeCode}
            placeholder="123456 ou ABCD-2345"
            hint="6 dígitos do app autenticador ou um código de recuperação de uso único."
            onChange={(event) => {
              setChallengeCode(event.target.value);
              setChallengeError(null);
            }}
            required
          />

          {challengeError !== null ? (
            <Alert title="Não foi possível verificar o código" tone="danger">
              {challengeError}
            </Alert>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            loading={challengeLoading}
            disabled={!isPlausibleTwoFactorCode(challengeCode)}
            fullWidth
          >
            Verificar e entrar
          </Button>

          <Button variant="ghost" fullWidth onClick={backToCredentials} disabled={challengeLoading}>
            Voltar ao login
          </Button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Entrar no workspace"
      description="Acesso restrito à equipe de atendimento. As lojas e permissões vêm do seu usuário."
    >
      <form className="mt-1 flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
        <Input
          id="login-sso-email"
          label="E-mail"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setNeedsVerification(false);
            setError(null);
            setEmailError(null);
            setSsoNotice(null);
          }}
          error={emailError ?? undefined}
          placeholder="voce@suaempresa.com.br"
          required
        />
        <Input
          label="Senha"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setNeedsVerification(false);
            setError(null);
          }}
          required
        />

        <div className="-mt-1 flex justify-end">
          <Link
            to="/forgot-password"
            className="cv-link text-[var(--cv-font-meta)] underline"
          >
            Esqueci minha senha
          </Link>
        </div>

        {needsVerification ? (
          <Alert title="E-mail não verificado" tone="warning">
            Confirme seu endereço antes de entrar.{' '}
            <Link
              to={`/verify-email?email=${encodeURIComponent(email.trim())}`}
              className="cv-link underline"
            >
              Reenviar o link de verificação
            </Link>
            .
          </Alert>
        ) : error !== null ? (
          <Alert title="Não foi possível entrar" tone="danger">
            {error}
          </Alert>
        ) : null}

        <Button type="submit" variant="primary" loading={loading} fullWidth>
          Entrar
        </Button>

        <div className="flex items-center gap-3" role="presentation">
          <span className="sac-divider flex-1" />
          <span className="sac-label">ou</span>
          <span className="sac-divider flex-1" />
        </div>

        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="secondary"
            icon="lock"
            loading={ssoLoading}
            fullWidth
            onClick={() => void handleSsoLogin()}
          >
            Entrar com Microsoft
          </Button>
          <p className="m-0 text-center text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
            SSO corporativo · usa o e-mail acima para descobrir o provedor do domínio.
          </p>
        </div>

        {ssoNotice !== null ? (
          <Alert
            title={ssoNotice.tone === 'warning' ? 'SSO não configurado' : 'Não foi possível verificar o SSO'}
            tone={ssoNotice.tone}
          >
            {ssoNotice.text}
          </Alert>
        ) : null}

        <p className="m-0 text-center text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          Ainda não tem conta?{' '}
          <Link to="/signup" className="cv-link underline">
            Criar conta
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
