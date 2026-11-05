import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiClientError } from '../lib/api';
import { describeFailure, isValidEmail, validationIssues } from '../lib/validation';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Alert, Button, Input, Spinner } from '../components/ui';

type VerificationState =
  | { status: 'verifying' }
  | { status: 'verified' }
  | { status: 'invalid'; message: string }
  | { status: 'failed'; message: string };

/**
 * One request per token for the lifetime of the tab.
 *
 * React StrictMode mounts the effect twice and `POST /auth/verify-email` burns
 * the token (single use), so a second POST would report a false "invalid link".
 * The promise is shared while it is in flight and kept after a success (a
 * verified address stays verified); a failure clears the entry so the retry
 * button can issue a real request again.
 */
const verifications = new Map<string, Promise<void>>();

function verifyOnce(token: string): Promise<void> {
  const inFlight = verifications.get(token);
  if (inFlight !== undefined) return inFlight;

  const promise = api.verifyEmail(token).then(() => undefined);
  verifications.set(token, promise);
  promise.catch(() => {
    verifications.delete(token);
  });
  return promise;
}

function isInvalidTokenError(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  // Expired, replayed or unknown token: 400 INVALID_VERIFICATION_TOKEN.
  if (error.status === 400 || error.code === 'INVALID_VERIFICATION_TOKEN') return true;
  // A truncated/corrupted link fails the schema (token min 32 chars) with a 422.
  return (
    error.status === 422 &&
    validationIssues(error).some((issue) => issue.path === 'token')
  );
}

/** Resend request for an address whose first link expired or was lost. */
function ResendVerificationForm({ initialEmail }: { initialEmail: string }): JSX.Element {
  const [email, setEmail] = useState(initialEmail);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (sending) return;

    const value = email.trim();
    if (!isValidEmail(value)) {
      setFieldError('Informe o e-mail usado no cadastro.');
      return;
    }

    setFieldError(null);
    setError(null);
    setSending(true);
    try {
      await api.resendVerification(value);
      setSent(true);
    } catch (resendError) {
      setError(describeFailure(resendError, 'Não foi possível reenviar a verificação'));
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <Alert title="Pedido recebido" tone="neutral">
        Se este e-mail tiver uma conta aguardando verificação, um novo link chega em instantes. O
        link anterior deixa de valer.
      </Alert>
    );
  }

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={(event) => void handleSubmit(event)}>
      <Input
        label="E-mail da conta"
        type="email"
        autoComplete="email"
        inputMode="email"
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
          setFieldError(null);
        }}
        error={fieldError ?? undefined}
        hint="Reenviamos apenas se houver uma conta pendente de verificação."
        placeholder="voce@suaempresa.com.br"
        required
      />

      {error !== null ? (
        <Alert title="Não foi possível reenviar" tone="danger">
          {error}
        </Alert>
      ) : null}

      <Button type="submit" variant="secondary" loading={sending} fullWidth>
        Reenviar verificação
      </Button>
    </form>
  );
}

/**
 * `/verify-email?token=…` — consumes the single-use link mailed by signup or by
 * an e-mail change. Without a token the same route becomes the resend screen
 * (also linked from the login gate when the API answers `EMAIL_NOT_VERIFIED`).
 */
export function VerifyEmailPage(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = (searchParams.get('token') ?? '').trim();
  const prefilledEmail = (searchParams.get('email') ?? '').trim();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<VerificationState>({ status: 'verifying' });

  useEffect(() => {
    // Without a token the page is the resend screen; nothing to verify.
    if (token === '') return;

    let active = true;
    setState({ status: 'verifying' });

    verifyOnce(token)
      .then(() => {
        if (active) setState({ status: 'verified' });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (isInvalidTokenError(error)) {
          setState({
            status: 'invalid',
            message: 'Este link de verificação é inválido, expirou ou já foi utilizado.',
          });
          return;
        }
        setState({
          status: 'failed',
          message: describeFailure(error, 'Não foi possível verificar o e-mail'),
        });
      });

    return () => {
      active = false;
    };
  }, [token, attempt]);

  if (token === '') {
    return (
      <AuthLayout
        title="Reenviar verificação"
        description="Informe o e-mail da conta para receber um novo link de verificação."
      >
        <ResendVerificationForm initialEmail={prefilledEmail} />
        <p className="m-0 text-center text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          <Link to="/login" className="cv-link underline">
            Voltar ao login
          </Link>
        </p>
      </AuthLayout>
    );
  }

  if (state.status === 'verifying') {
    return (
      <AuthLayout title="Verificando seu e-mail" description="Validando o link recebido…">
        <div className="flex flex-col items-center gap-3 py-2 text-[var(--cv-color-text-muted)]">
          <Spinner label="Verificando" />
          <p className="m-0 text-[var(--cv-font-meta)]">Isso leva apenas um instante.</p>
        </div>
      </AuthLayout>
    );
  }

  if (state.status === 'verified') {
    return (
      <AuthLayout title="E-mail verificado" description="Sua conta está liberada para entrar.">
        <Alert title="Tudo certo" tone="success">
          Confirmamos seu endereço de e-mail. Entre com o e-mail e a senha que você cadastrou.
        </Alert>

        <Button type="button" variant="primary" fullWidth onClick={() => navigate('/login')}>
          Entrar no workspace
        </Button>
      </AuthLayout>
    );
  }

  const failed = state.status === 'failed';

  return (
    <AuthLayout
      title={failed ? 'Não foi possível verificar' : 'Link de verificação inválido'}
      description={
        failed
          ? 'A verificação não foi concluída agora. Tente novamente ou peça um novo link.'
          : 'O link expirou, já foi usado ou o endereço foi alterado.'
      }
    >
      <Alert
        title={failed ? 'Falha ao verificar' : 'Não foi possível verificar'}
        tone="danger"
      >
        {state.message}
      </Alert>

      {failed ? (
        <Button
          type="button"
          variant="secondary"
          fullWidth
          onClick={() => setAttempt((current) => current + 1)}
        >
          Tentar novamente
        </Button>
      ) : null}

      <div className="sac-divider" />

      <ResendVerificationForm initialEmail={prefilledEmail} />

      <p className="m-0 text-center text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
        <Link to="/login" className="cv-link underline">
          Voltar ao login
        </Link>
      </p>
    </AuthLayout>
  );
}
