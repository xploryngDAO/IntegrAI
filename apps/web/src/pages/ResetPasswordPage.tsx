import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiClientError } from '../lib/api';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  describeFailure,
  fieldErrorsFromIssues,
  validationIssues,
} from '../lib/validation';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Alert, Button, Input } from '../components/ui';

interface ResetErrors {
  password?: string;
  confirmation?: string;
}

function isInvalidTokenError(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  // Expired, replayed or unknown token: 400 INVALID_RESET_TOKEN.
  if (error.status === 400 || error.code === 'INVALID_RESET_TOKEN') return true;
  // A truncated/corrupted link fails the schema (token min 32 chars) with a 422.
  return (
    error.status === 422 &&
    validationIssues(error).some((issue) => issue.path === 'token')
  );
}

/**
 * `/reset-password?token=…` — defines a new password with the single-use link
 * mailed by `/forgot-password`.
 *
 * The token is only sent to the API on submit, so an expired link is reported
 * by the API itself (400 `INVALID_RESET_TOKEN`) and the screen offers a fresh
 * link instead of a form that can never succeed.
 */
export function ResetPasswordPage(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = (searchParams.get('token') ?? '').trim();

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<ResetErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [invalidToken, setInvalidToken] = useState(token === '');

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) return;

    const validation: ResetErrors = {};
    if (password.length < PASSWORD_MIN_LENGTH) {
      validation.password = `Use pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`;
    } else if (password.length > PASSWORD_MAX_LENGTH) {
      validation.password = `Use no máximo ${PASSWORD_MAX_LENGTH} caracteres.`;
    }
    if (confirmation !== password) {
      validation.confirmation = 'As senhas não conferem.';
    }
    setErrors(validation);
    setFormError(null);
    if (Object.keys(validation).length > 0) return;

    setLoading(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (error) {
      if (isInvalidTokenError(error)) {
        setInvalidToken(true);
        return;
      }

      const mapped = fieldErrorsFromIssues(validationIssues(error), ['password'] as const);
      if (mapped.password !== undefined) {
        setErrors({ password: mapped.password });
        return;
      }
      if (error instanceof ApiClientError && error.status === 422) {
        setFormError('A API recusou a nova senha. Revise o campo e tente novamente.');
        return;
      }
      setFormError(describeFailure(error, 'Não foi possível redefinir a senha'));
    } finally {
      setLoading(false);
    }
  }

  if (invalidToken) {
    return (
      <AuthLayout
        title="Link inválido"
        description={
          token === ''
            ? 'Este endereço não trouxe um token de redefinição.'
            : 'O link de redefinição expirou ou já foi utilizado.'
        }
      >
        <Alert title="Não foi possível abrir o link" tone="danger">
          Links de redefinição valem 30 minutos e só podem ser usados uma vez. Peça um novo link
          para continuar.
        </Alert>

        <Button
          type="button"
          variant="primary"
          fullWidth
          onClick={() => navigate('/forgot-password')}
        >
          Pedir um novo link
        </Button>
        <Button type="button" variant="ghost" fullWidth onClick={() => navigate('/login')}>
          Voltar ao login
        </Button>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout
        title="Senha redefinida"
        description="Sua nova senha já está valendo."
      >
        <Alert title="Tudo certo" tone="success">
          Redefinimos sua senha e encerramos todas as sessões abertas. Entre novamente com a nova
          senha.
        </Alert>

        <Button type="button" variant="primary" fullWidth onClick={() => navigate('/login')}>
          Ir para o login
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Criar nova senha"
      description={`Escolha uma senha com pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`}
    >
      <form className="mt-1 flex flex-col gap-4" noValidate onSubmit={(event) => void handleSubmit(event)}>
        <Input
          label="Nova senha"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setErrors((current) => ({ ...current, password: undefined }));
          }}
          error={errors.password}
          hint={`Mínimo de ${PASSWORD_MIN_LENGTH} caracteres.`}
          required
        />
        <Input
          label="Confirmar nova senha"
          type="password"
          autoComplete="new-password"
          value={confirmation}
          onChange={(event) => {
            setConfirmation(event.target.value);
            setErrors((current) => ({ ...current, confirmation: undefined }));
          }}
          error={errors.confirmation}
          required
        />

        {formError !== null ? (
          <Alert title="Não foi possível redefinir a senha" tone="danger">
            {formError}
          </Alert>
        ) : null}

        <Button type="submit" variant="primary" loading={loading} fullWidth>
          Salvar nova senha
        </Button>

        <p className="m-0 text-center text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          <Link to="/forgot-password" className="cv-link underline">
            Pedir outro link
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
