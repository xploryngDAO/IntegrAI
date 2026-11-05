import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiClientError } from '../lib/api';
import {
  COMPANY_NAME_MAX_LENGTH,
  COMPANY_NAME_MIN_LENGTH,
  NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  describeFailure,
  fieldErrorsFromIssues,
  isValidEmail,
  validationIssues,
} from '../lib/validation';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Alert, Button, Input } from '../components/ui';

type SignupField = 'companyName' | 'name' | 'email' | 'password';

const SIGNUP_FIELDS: readonly SignupField[] = ['companyName', 'name', 'email', 'password'];

interface SignupErrors {
  companyName?: string;
  name?: string;
  email?: string;
  password?: string;
}

function validate(values: Record<SignupField, string>): SignupErrors {
  const errors: SignupErrors = {};
  const companyName = values.companyName.trim();
  const name = values.name.trim();

  if (companyName.length < COMPANY_NAME_MIN_LENGTH) {
    errors.companyName = 'Informe o nome da empresa (mínimo de 2 caracteres).';
  } else if (companyName.length > COMPANY_NAME_MAX_LENGTH) {
    errors.companyName = `Use no máximo ${COMPANY_NAME_MAX_LENGTH} caracteres.`;
  }

  if (name.length === 0) {
    errors.name = 'Informe seu nome completo.';
  } else if (name.length > NAME_MAX_LENGTH) {
    errors.name = `Use no máximo ${NAME_MAX_LENGTH} caracteres.`;
  }

  if (!isValidEmail(values.email)) {
    errors.email = 'Informe um e-mail válido (ex.: voce@suaempresa.com.br).';
  }

  if (values.password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `Use pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  } else if (values.password.length > PASSWORD_MAX_LENGTH) {
    errors.password = `Use no máximo ${PASSWORD_MAX_LENGTH} caracteres.`;
  }

  return errors;
}

/**
 * Self-service account creation (`POST /auth/signup`).
 *
 * The API answers 201 with `emailVerificationRequired: true` and mails a
 * verification link, so success swaps the form for the "check your inbox"
 * state instead of issuing a session.
 */
export function SignupPage(): JSX.Element {
  const navigate = useNavigate();
  const [companyName, setCompanyName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<SignupErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [createdEmail, setCreatedEmail] = useState<string | null>(null);

  function clearError(field: SignupField): void {
    setErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function changeEmail(value: string): void {
    setEmail(value);
    clearError('email');
    setEmailTaken(false);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) return;

    const values: Record<SignupField, string> = { companyName, name, email, password };
    const validation = validate(values);
    setErrors(validation);
    setFormError(null);
    setEmailTaken(false);
    if (Object.keys(validation).length > 0) return;

    const normalized = {
      companyName: companyName.trim(),
      name: name.trim(),
      email: email.trim(),
      password,
    };

    setLoading(true);
    try {
      await api.signup(normalized);
      setCreatedEmail(normalized.email);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 409) {
        // The API does not expose which tenant owns the address — only that the
        // global unique e-mail constraint is taken.
        setEmailTaken(true);
        return;
      }

      const mapped = fieldErrorsFromIssues(validationIssues(error), SIGNUP_FIELDS);
      if (Object.keys(mapped).length > 0) {
        setErrors(mapped);
        return;
      }
      if (error instanceof ApiClientError && error.status === 422) {
        setFormError('A API recusou os dados informados. Revise os campos e tente novamente.');
        return;
      }
      setFormError(describeFailure(error, 'Não foi possível criar a conta'));
    } finally {
      setLoading(false);
    }
  }

  if (createdEmail !== null) {
    return (
      <AuthLayout
        title="Verifique seu e-mail"
        description="Falta um passo para ativar o workspace da sua empresa."
      >
        <Alert title="Conta criada" tone="success">
          Enviamos um link de verificação para <strong>{createdEmail}</strong>. Abra a mensagem e
          confirme o endereço para liberar o login.
        </Alert>

        <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
          O link vale 24 horas e só pode ser usado uma vez. Não recebeu? Confira a caixa de spam ou{' '}
          <Link
            to={`/verify-email?email=${encodeURIComponent(createdEmail)}`}
            className="cv-link underline"
          >
            reenvie a verificação
          </Link>
          .
        </p>

        <Button type="button" variant="primary" fullWidth onClick={() => navigate('/login')}>
          Ir para o login
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Criar conta"
      description="Comece a atender Amazon, Mercado Livre e Shopee em um único workspace."
    >
      <form className="mt-1 flex flex-col gap-4" noValidate onSubmit={(event) => void handleSubmit(event)}>
        <Input
          label="Empresa"
          type="text"
          autoComplete="organization"
          value={companyName}
          onChange={(event) => {
            setCompanyName(event.target.value);
            clearError('companyName');
          }}
          error={errors.companyName}
          hint="Como aparece para sua equipe (mínimo de 2 caracteres)."
          placeholder="Sua loja Ltda"
          required
        />
        <Input
          label="Seu nome"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            clearError('name');
          }}
          error={errors.name}
          placeholder="Nome e sobrenome"
          required
        />
        <Input
          label="E-mail"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(event) => changeEmail(event.target.value)}
          error={errors.email}
          hint="Você receberá o link de verificação neste endereço."
          placeholder="voce@suaempresa.com.br"
          required
        />
        <Input
          label="Senha"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            clearError('password');
          }}
          error={errors.password}
          hint={`Mínimo de ${PASSWORD_MIN_LENGTH} caracteres.`}
          required
        />

        {emailTaken ? (
          <Alert title="E-mail já cadastrado" tone="warning">
            Já existe uma conta com <strong>{email.trim()}</strong>.{' '}
            <Link to="/login" className="cv-link underline">
              Entrar
            </Link>{' '}
            ou{' '}
            <Link to="/forgot-password" className="cv-link underline">
              recuperar a senha
            </Link>
            .
          </Alert>
        ) : formError !== null ? (
          <Alert title="Não foi possível criar a conta" tone="danger">
            {formError}
          </Alert>
        ) : null}

        <Button type="submit" variant="primary" loading={loading} fullWidth>
          Criar conta
        </Button>

        <p className="m-0 text-center text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          Já tem conta?{' '}
          <Link to="/login" className="cv-link underline">
            Entrar
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
