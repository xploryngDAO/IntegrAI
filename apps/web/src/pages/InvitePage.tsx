import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiClientError } from '../lib/api';
import {
  NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  describeFailure,
  fieldErrorsFromIssues,
  validationIssues,
} from '../lib/validation';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Alert, Button, Input, Spinner } from '../components/ui';

type InviteField = 'name' | 'password' | 'confirmation';

const INVITE_FIELDS: readonly InviteField[] = ['name', 'password', 'confirmation'];

interface InviteErrors {
  name?: string;
  password?: string;
  confirmation?: string;
}

interface InvitePageProps {
  /**
   * Same hook the credential gate uses. The API session is already persisted
   * by `api.acceptInvitation`, so the shell only has to switch to the
   * authenticated tree and boot the workspace.
   */
  onAuthenticated: () => void;
}

function validate(values: Record<InviteField, string>): InviteErrors {
  const errors: InviteErrors = {};
  const name = values.name.trim();

  if (name.length === 0) {
    errors.name = 'Informe seu nome completo.';
  } else if (name.length > NAME_MAX_LENGTH) {
    errors.name = `Use no máximo ${NAME_MAX_LENGTH} caracteres.`;
  }

  if (values.password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `Use pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  } else if (values.password.length > PASSWORD_MAX_LENGTH) {
    errors.password = `Use no máximo ${PASSWORD_MAX_LENGTH} caracteres.`;
  }

  if (values.confirmation !== values.password) {
    errors.confirmation = 'As senhas não conferem.';
  }

  return errors;
}

/**
 * The token is unknown, expired or already consumed (400 `INVALID_INVITATION_TOKEN`).
 * A truncated/pasted link additionally fails the body schema (token min 32) with a 422.
 */
function isInvalidTokenError(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  if (error.status === 400 || error.code === 'INVALID_INVITATION_TOKEN') return true;
  return error.status === 422 && validationIssues(error).some((issue) => issue.path === 'token');
}

/**
 * Service-level rejections (`InvitationService.assertPassword`/name length) carry
 * `details.field` instead of the zod `details.issues` list. Kept apart from
 * `validationIssues` so the zod contract stays untouched.
 */
function apiField(error: unknown): string | null {
  if (!(error instanceof ApiClientError) || error.status !== 422) return null;
  const details = error.details;
  if (typeof details !== 'object' || details === null) return null;
  const field = (details as { field?: unknown }).field;
  return typeof field === 'string' ? field : null;
}

/**
 * `/invite?token=…` — public acceptance of an operator invitation
 * (`POST /auth/accept-invitation` mails this link).
 *
 * The invitation proves ownership of the e-mail, so the screen asks only for a
 * name and the password of the new operator, and a success opens a real session
 * (`api.acceptInvitation` persists the JWT like `login()` does) that lands
 * straight in the workspace. The token stays valid until submitted, so expiry
 * is reported by the API itself (400) instead of a form that can never succeed.
 */
export function InvitePage({ onAuthenticated }: InvitePageProps): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = (searchParams.get('token') ?? '').trim();

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<InviteErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [invalidToken, setInvalidToken] = useState(token === '');

  function clearError(field: InviteField): void {
    setErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading || done) return;

    const validation = validate({ name, password, confirmation });
    setErrors(validation);
    setFormError(null);
    setEmailTaken(false);
    if (Object.keys(validation).length > 0) return;

    setLoading(true);
    try {
      await api.acceptInvitation({ token, name: name.trim(), password });
      setDone(true);
      // The session is live: switch the shell before navigating so the
      // workspace renders instead of flashing the anonymous gate.
      onAuthenticated();
      navigate('/', { replace: true });
    } catch (error) {
      if (isInvalidTokenError(error)) {
        setInvalidToken(true);
        return;
      }

      if (error instanceof ApiClientError && error.status === 409) {
        // Both "e-mail already has an account" and "workspace not active for
        // new operators" answer 409 CONFLICT; only the message distinguishes them.
        if (/already exists/i.test(error.message)) {
          setEmailTaken(true);
          return;
        }
        setFormError(
          'O workspace deste convite não está aceitando novos operadores. Peça um novo convite ao administrador.',
        );
        return;
      }

      const mapped = fieldErrorsFromIssues(validationIssues(error), INVITE_FIELDS);
      const field = apiField(error);
      if (Object.keys(mapped).length > 0) {
        setErrors(mapped);
        return;
      }
      if (field === 'name' || field === 'password') {
        setErrors(
          field === 'name'
            ? { name: `Informe seu nome completo (até ${NAME_MAX_LENGTH} caracteres).` }
            : { password: `Use pelo menos ${PASSWORD_MIN_LENGTH} caracteres.` },
        );
        return;
      }
      if (error instanceof ApiClientError && error.status === 422) {
        setFormError('A API recusou os dados informados. Revise os campos e tente novamente.');
        return;
      }
      setFormError(describeFailure(error, 'Não foi possível aceitar o convite'));
    } finally {
      setLoading(false);
    }
  }

  if (invalidToken) {
    return (
      <AuthLayout
        title="Convite inválido"
        description={
          token === ''
            ? 'Este endereço não trouxe um token de convite.'
            : 'O link de convite expirou ou já foi utilizado.'
        }
      >
        <Alert title="Não foi possível abrir o convite" tone="danger">
          Links de convite valem 7 dias e só podem ser usados uma vez. Peça ao administrador do
          workspace para enviar um novo convite.
        </Alert>

        <Button type="button" variant="primary" fullWidth onClick={() => navigate('/login')}>
          Ir para o login
        </Button>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout title="Convite aceito" description="Sua conta está pronta — abrindo o workspace…">
        <div className="flex flex-col items-center gap-3 py-2 text-[var(--cv-color-text-muted)]">
          <Spinner label="Abrindo o workspace" />
          <p className="m-0 text-[var(--cv-font-meta)]">Isso leva apenas um instante.</p>
        </div>

        <Button
          type="button"
          variant="secondary"
          fullWidth
          onClick={() => navigate('/', { replace: true })}
        >
          Entrar agora
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Aceitar convite"
      description="Defina seu nome e uma senha para entrar no workspace da sua equipe."
    >
      <form
        className="mt-1 flex flex-col gap-4"
        noValidate
        onSubmit={(event) => void handleSubmit(event)}
      >
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
          hint="Como você aparece para a equipe."
          placeholder="Nome e sobrenome"
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
            clearError('confirmation');
          }}
          error={errors.password}
          hint={`Mínimo de ${PASSWORD_MIN_LENGTH} caracteres.`}
          required
        />
        <Input
          label="Confirmar senha"
          type="password"
          autoComplete="new-password"
          value={confirmation}
          onChange={(event) => {
            setConfirmation(event.target.value);
            clearError('confirmation');
          }}
          error={errors.confirmation}
          required
        />

        {emailTaken ? (
          <Alert title="E-mail já cadastrado" tone="warning">
            Este convite é de um e-mail que já tem conta no SAC Hub.{' '}
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
          <Alert title="Não foi possível aceitar o convite" tone="danger">
            {formError}
          </Alert>
        ) : null}

        <Button type="submit" variant="primary" loading={loading} fullWidth>
          Aceitar convite
        </Button>

        <p className="m-0 text-center text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          Já tenho conta?{' '}
          <Link to="/login" className="cv-link underline">
            Entrar
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
