import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy } from 'lucide-react';
import {
  api,
  ApiClientError,
  TwoFactorRequiredError,
  TwoFactorSetupRequiredError,
} from '../lib/api';
import {
  isPlausibleTwoFactorCode,
  isSetupTokenExpiredError,
  isTotpCode,
  normalizeTwoFactorCode,
  recoveryCodesToClipboardText,
  twoFactorEnrollErrorMessage,
  twoFactorErrorMessage,
} from '../lib/twoFactor';
import { ssoErrorMessage, ssoStartUrl } from '../lib/sso';
import { isValidEmail } from '../lib/validation';
import type { TwoFactorEnrollSetupResult } from '../lib/types';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Alert, Button, IconButton, Input, Skeleton } from '../components/ui';

interface LoginPageProps {
  onAuthenticated: () => void;
  /** Real error raised while resolving the session (e.g. API unreachable). */
  initialError?: string;
}

/**
 * Copies one enrollment value (secret or `otpauth://` link).
 *
 * The credential gate is outside the workspace store, so the confirmation is
 * local and announced through `aria-live` instead of a toast; a failure tells
 * the operator to copy by hand instead of pretending it worked.
 */
function CopyEnrollmentValue({ value, label }: { value: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-none flex-col items-end gap-1">
      <IconButton
        label={`Copiar ${label}`}
        icon={copied ? <Check size={15} /> : <Copy size={15} />}
        onClick={() => void copy()}
      />
      <span
        className="text-[var(--cv-font-micro)] leading-none text-[var(--cv-color-text-muted)]"
        aria-live="polite"
      >
        {copied ? 'Copiado' : failed ? 'Copie manualmente' : ''}
      </span>
    </div>
  );
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
 * When the workspace policy requires TOTP and the operator has none, the API
 * answers 403 `TWO_FACTOR_SETUP_REQUIRED` with a short-lived `setupToken`. The
 * page then switches to the forced-enrollment step: it fetches the pending
 * secret (`/auth/2fa/enroll/setup`), shows the secret and `otpauth://` URI for
 * manual entry (no QR library), confirms the 6-digit code
 * (`/auth/2fa/enroll/verify`), which **persists the session**, and only mounts
 * the workspace after the one-time recovery codes are acknowledged.
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

  // Forced enrollment: the workspace policy requires TOTP and this operator has
  // none, so the API refused the password with a `setupToken` and no session.
  // The secret/URI live only in component state (the API returns them once).
  const [enrollmentToken, setEnrollmentToken] = useState<string | null>(null);
  const [enrollmentSetup, setEnrollmentSetup] = useState<TwoFactorEnrollSetupResult | null>(null);
  const [enrollmentLoading, setEnrollmentLoading] = useState(false);
  const [enrollmentError, setEnrollmentError] = useState<string | null>(null);
  const [enrollmentExpired, setEnrollmentExpired] = useState(false);
  const [enrollmentCode, setEnrollmentCode] = useState('');
  const [enrollmentVerifying, setEnrollmentVerifying] = useState(false);
  const [enrollmentVerifyError, setEnrollmentVerifyError] = useState<string | null>(null);
  const [enrollmentRecoveryCodes, setEnrollmentRecoveryCodes] = useState<string[] | null>(null);
  const [codesCopied, setCodesCopied] = useState(false);
  const [codesCopyFailed, setCodesCopyFailed] = useState(false);

  function backToCredentials(): void {
    if (challengeLoading) return;
    setChallengeToken(null);
    setChallengeCode('');
    setChallengeError(null);
    setPassword('');
  }

  /**
   * Exchanges the login `setupToken` for the pending TOTP secret.
   *
   * Called once when the forced-enrollment step opens and again from "Tentar
   * novamente": a timeout/network failure is retryable with the same token,
   * while an expired token is reported by `isSetupTokenExpiredError` and the
   * only way forward is restarting the login (the API issues a new token).
   */
  async function loadEnrollment(setupToken: string): Promise<void> {
    setEnrollmentLoading(true);
    setEnrollmentError(null);
    setEnrollmentExpired(false);
    try {
      const result = await api.twoFactorEnrollSetup(setupToken);
      setEnrollmentSetup(result);
      setEnrollmentCode('');
      setEnrollmentVerifyError(null);
    } catch (setupFailure) {
      setEnrollmentSetup(null);
      setEnrollmentError(twoFactorEnrollErrorMessage(setupFailure, 'setup'));
      setEnrollmentExpired(isSetupTokenExpiredError(setupFailure));
    } finally {
      setEnrollmentLoading(false);
    }
  }

  /** Opens the forced-enrollment step and immediately requests the secret. */
  function startEnrollment(setupToken: string): void {
    setChallengeToken(null);
    setChallengeCode('');
    setChallengeError(null);
    setEnrollmentToken(setupToken);
    setEnrollmentSetup(null);
    setEnrollmentError(null);
    setEnrollmentVerifyError(null);
    setEnrollmentRecoveryCodes(null);
    setEnrollmentExpired(false);
    setEnrollmentCode('');
    setCodesCopied(false);
    setCodesCopyFailed(false);
    setPassword('');
    void loadEnrollment(setupToken);
  }

  /** Leaves the forced-enrollment step without a session (password discarded). */
  function resetEnrollment(): void {
    if (enrollmentLoading || enrollmentVerifying) return;
    setEnrollmentToken(null);
    setEnrollmentSetup(null);
    setEnrollmentError(null);
    setEnrollmentVerifyError(null);
    setEnrollmentExpired(false);
    setEnrollmentCode('');
    setEnrollmentRecoveryCodes(null);
    setCodesCopied(false);
    setCodesCopyFailed(false);
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
      if (loginError instanceof TwoFactorSetupRequiredError) {
        // Policy requires TOTP and this operator has none: no session was
        // issued. Open the forced-enrollment step with the setup token.
        startEnrollment(loginError.setupToken);
        return;
      }
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
        if (loginError.code === 'TWO_FACTOR_SETUP_REQUIRED') {
          setError(
            'A API exige a ativação da verificação em duas etapas, mas não retornou o token de configuração. Tente entrar novamente.',
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

  async function handleEnrollmentSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (enrollmentVerifying || enrollmentToken === null) return;

    const normalized = normalizeTwoFactorCode(enrollmentCode);
    if (!isTotpCode(normalized)) {
      setEnrollmentVerifyError('Informe os 6 dígitos exibidos no app autenticador.');
      return;
    }

    setEnrollmentVerifying(true);
    setEnrollmentVerifyError(null);
    try {
      // `twoFactorEnrollVerify` persists the session before returning, exactly
      // like `login()`; the workspace only mounts after the codes below.
      const result = await api.twoFactorEnrollVerify(enrollmentToken, normalized);
      setEnrollmentSetup(null);
      setEnrollmentCode('');
      setEnrollmentExpired(false);
      setEnrollmentRecoveryCodes(result.recoveryCodes);
    } catch (verifyFailure) {
      setEnrollmentVerifyError(twoFactorEnrollErrorMessage(verifyFailure, 'verify'));
      setEnrollmentExpired(isSetupTokenExpiredError(verifyFailure));
    } finally {
      setEnrollmentVerifying(false);
    }
  }

  async function copyRecoveryCodes(): Promise<void> {
    if (enrollmentRecoveryCodes === null) return;
    try {
      await navigator.clipboard.writeText(recoveryCodesToClipboardText(enrollmentRecoveryCodes));
      setCodesCopied(true);
      setCodesCopyFailed(false);
      window.setTimeout(() => setCodesCopied(false), 1_500);
    } catch {
      setCodesCopied(false);
      setCodesCopyFailed(true);
    }
  }

  // Recovery codes are returned exactly once by the enrollment response. They
  // are rendered before the workspace mounts so they cannot be skipped, while
  // the session itself is already persisted by the API call.
  if (enrollmentRecoveryCodes !== null) {
    const codes = enrollmentRecoveryCodes;
    return (
      <AuthLayout
        title="Guarde seus códigos de recuperação"
        description="A verificação em duas etapas está ativa. Estes códigos aparecem uma única vez."
      >
        <div className="mt-1 flex flex-col gap-4">
          <Alert title="Guarde agora — não aparecem de novo" tone="warning">
            Cada código substitui o código do app autenticador uma única vez, se você perder o
            celular. Guarde fora do navegador: gerenciador de senhas ou cofre físico.
          </Alert>

          {codes.length > 0 ? (
            <ul
              className="m-0 grid list-none grid-cols-1 gap-1.5 p-0 sm:grid-cols-2"
              aria-label="Códigos de recuperação"
            >
              {codes.map((recoveryCode, index) => (
                <li
                  key={recoveryCode}
                  className="flex items-center justify-between gap-2 rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-2.5 py-1.5"
                >
                  <span className="sac-label m-0">{String(index + 1).padStart(2, '0')}</span>
                  <code className="sac-num select-all text-[var(--cv-font-control)]">
                    {recoveryCode}
                  </code>
                </li>
              ))}
            </ul>
          ) : (
            <Alert title="A API não retornou os códigos" tone="warning">
              A sessão foi criada, mas esta resposta não trouxe códigos de recuperação. Gere um novo
              conjunto em Configurações → Segurança assim que entrar no workspace.
            </Alert>
          )}

          {codes.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Button
                variant="secondary"
                icon={codesCopied ? <Check size={15} /> : <Copy size={15} />}
                onClick={() => void copyRecoveryCodes()}
                fullWidth
              >
                {codesCopied ? 'Códigos copiados' : 'Copiar os códigos'}
              </Button>
              {codesCopyFailed ? (
                <p
                  className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]"
                  aria-live="polite"
                >
                  Não foi possível copiar. Selecione os códigos na tela e copie manualmente.
                </p>
              ) : null}
            </div>
          ) : null}

          <Button variant="primary" fullWidth onClick={onAuthenticated}>
            Já guardei os códigos — entrar no workspace
          </Button>

          <p className="m-0 text-center text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
            A sessão já foi iniciada. Depois de entrar, os códigos não podem ser consultados novamente.
          </p>
        </div>
      </AuthLayout>
    );
  }

  if (enrollmentToken !== null) {
    return (
      <AuthLayout
        title="Ative a verificação em duas etapas"
        description="Este workspace exige um segundo fator para todos os operadores. Configure o app autenticador para liberar o acesso."
      >
        <div className="mt-1 flex flex-col gap-4">
          <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
            Entrando como{' '}
            <strong className="font-medium text-[var(--cv-color-text)]">{email.trim()}</strong>
          </p>

          {enrollmentLoading ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
                Gerando a chave de ativação…
              </p>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : enrollmentError !== null ? (
            <div className="flex flex-col gap-3">
              <Alert title="Não foi possível iniciar a ativação" tone="danger">
                {enrollmentError}
              </Alert>
              <Button
                variant="secondary"
                icon="pulse"
                fullWidth
                disabled={enrollmentLoading}
                onClick={() => void loadEnrollment(enrollmentToken)}
              >
                Tentar novamente
              </Button>
              <Button variant="ghost" fullWidth onClick={resetEnrollment}>
                {enrollmentExpired ? 'Recomeçar login' : 'Voltar ao login'}
              </Button>
            </div>
          ) : enrollmentSetup !== null ? (
            <>
              <Alert title="Adicione a chave manualmente no autenticador" tone="accent">
                Abra o app autenticador (Google Authenticator, 1Password, Authy…), escolha
                “Adicionar conta” → “Inserir chave manualmente” e cole o segredo abaixo. Esta tela
                não gera QR code.
              </Alert>

              <div className="flex flex-col gap-1.5">
                <span className="sac-label">Chave secreta (TOTP)</span>
                <div className="flex items-start justify-between gap-2 rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-2.5 py-2">
                  <code className="sac-num m-0 min-w-0 flex-1 select-all break-all text-[var(--cv-font-control)]">
                    {enrollmentSetup.secret}
                  </code>
                  <CopyEnrollmentValue value={enrollmentSetup.secret} label="chave secreta" />
                </div>
                <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
                  A chave aparece apenas nesta ativação. Não compartilhe com ninguém.
                </p>
              </div>

              {enrollmentSetup.otpauthUri.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <span className="sac-label">Link otpauth://</span>
                  <div className="flex items-start justify-between gap-2 rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-2.5 py-2">
                    <a
                      href={enrollmentSetup.otpauthUri}
                      className="cv-link m-0 min-w-0 flex-1 break-all text-[var(--cv-font-meta)] underline"
                      title="Abrir o link otpauth:// no app autenticador"
                    >
                      {enrollmentSetup.otpauthUri}
                    </a>
                    <CopyEnrollmentValue
                      value={enrollmentSetup.otpauthUri}
                      label="link otpauth://"
                    />
                  </div>
                  <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
                    Copie o link e abra no app se o navegador não oferecer o aplicativo.
                  </p>
                </div>
              ) : null}

              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => void handleEnrollmentSubmit(event)}
              >
                <Input
                  label="Código de 6 dígitos"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  spellCheck={false}
                  maxLength={6}
                  autoFocus
                  value={enrollmentCode}
                  placeholder="000000"
                  hint="Código gerado pelo app autenticador para esta conta."
                  error={enrollmentVerifyError ?? undefined}
                  onChange={(event) => {
                    setEnrollmentCode(event.target.value.replace(/\D/g, '').slice(0, 6));
                    setEnrollmentVerifyError(null);
                    setEnrollmentExpired(false);
                  }}
                  required
                />

                <Button
                  type="submit"
                  variant="primary"
                  loading={enrollmentVerifying}
                  disabled={!isTotpCode(enrollmentCode)}
                  fullWidth
                >
                  Confirmar e entrar
                </Button>
                <Button
                  variant="ghost"
                  fullWidth
                  disabled={enrollmentVerifying}
                  onClick={resetEnrollment}
                >
                  {enrollmentExpired ? 'Recomeçar login' : 'Voltar ao login'}
                </Button>
              </form>

              <p className="m-0 text-center text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
                A chave e o link são exibidos só nesta ativação. Se demorar, volte e entre novamente
                para gerar outra.
              </p>
            </>
          ) : null}
        </div>
      </AuthLayout>
    );
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
