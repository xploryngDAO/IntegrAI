import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import {
  describeFailure,
  fieldErrorsFromIssues,
  isValidEmail,
  validationIssues,
} from '../lib/validation';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Alert, Button, Input } from '../components/ui';

/**
 * `/forgot-password` — asks the API for a reset link.
 *
 * `POST /auth/forgot-password` always answers 202, so the confirmation is shown
 * for every accepted request and never reveals whether the address exists. Only
 * transport/validation failures (network, 422, 429, 5xx) surface an error.
 */
export function ForgotPasswordPage(): JSX.Element {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) return;

    const value = email.trim();
    if (!isValidEmail(value)) {
      setFieldError('Informe o e-mail usado no cadastro.');
      return;
    }

    setFieldError(null);
    setFormError(null);
    setLoading(true);
    try {
      await api.forgotPassword(value);
      setSentTo(value);
    } catch (error) {
      const mapped = fieldErrorsFromIssues(validationIssues(error), ['email'] as const);
      if (mapped.email !== undefined) {
        setFieldError(mapped.email);
      } else {
        setFormError(describeFailure(error, 'Não foi possível enviar o link'));
      }
    } finally {
      setLoading(false);
    }
  }

  if (sentTo !== null) {
    return (
      <AuthLayout
        title="Verifique seu e-mail"
        description="Se houver uma conta com este endereço, o link de redefinição está a caminho."
      >
        <Alert title="Pedido recebido" tone="success">
          Se existir uma conta para <strong>{sentTo}</strong>, enviamos um link para criar uma nova
          senha. O link vale 30 minutos e só pode ser usado uma vez.
        </Alert>

        <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
          Não recebeu? Confira a caixa de spam. Por segurança, não informamos se um e-mail está
          cadastrado.
        </p>

        <Button type="button" variant="primary" fullWidth onClick={() => navigate('/login')}>
          Voltar ao login
        </Button>
        <Button
          type="button"
          variant="ghost"
          fullWidth
          onClick={() => {
            setSentTo(null);
            setEmail('');
          }}
        >
          Usar outro e-mail
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Recuperar senha"
      description="Informe o e-mail da conta e enviaremos um link para definir uma nova senha."
    >
      <form className="mt-1 flex flex-col gap-4" noValidate onSubmit={(event) => void handleSubmit(event)}>
        <Input
          label="E-mail"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setFieldError(null);
            setFormError(null);
          }}
          error={fieldError ?? undefined}
          hint="O link de redefinição vale 30 minutos."
          placeholder="voce@suaempresa.com.br"
          required
        />

        {formError !== null ? (
          <Alert title="Não foi possível enviar o link" tone="danger">
            {formError}
          </Alert>
        ) : null}

        <Button type="submit" variant="primary" loading={loading} fullWidth>
          Enviar link de redefinição
        </Button>

        <p className="m-0 text-center text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          <Link to="/login" className="cv-link underline">
            Voltar ao login
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
