import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiClientError } from '../lib/api';
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
 */
export function LoginPage({ onAuthenticated, initialError }: LoginPageProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [needsVerification, setNeedsVerification] = useState(false);

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
      if (loginError instanceof ApiClientError) {
        // Fase 1: a valid password on an unverified account answers 403, which
        // is a verification problem — not a credential problem.
        if (loginError.code === 'EMAIL_NOT_VERIFIED') {
          setNeedsVerification(true);
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

  return (
    <AuthLayout
      title="Entrar no workspace"
      description="Acesso restrito à equipe de atendimento. As lojas e permissões vêm do seu usuário."
    >
      <form className="mt-1 flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
        <Input
          label="E-mail"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setNeedsVerification(false);
            setError(null);
          }}
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
