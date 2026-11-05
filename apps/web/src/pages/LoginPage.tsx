import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Heading, Text } from '@xploryng/convergencia';
import { api, ApiClientError } from '../lib/api';
import { useTheme } from '../lib/theme';
import { Alert, Avatar, Button, Card, IconButton, Input } from '../components/ui';

interface LoginPageProps {
  onAuthenticated: () => void;
  /** Real error raised while resolving the session (e.g. API unreachable). */
  initialError?: string;
}

/**
 * Credential gate for the real session, rendered with Convergência surfaces
 * (paper card on the cool background, indigo primary action).
 */
export function LoginPage({ onAuthenticated, initialError }: LoginPageProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const { theme, toggle } = useTheme();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      await api.login(email.trim(), password);
      onAuthenticated();
    } catch (loginError) {
      if (loginError instanceof ApiClientError) {
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
    <div className="relative flex h-full min-h-0 flex-1 items-center justify-center px-4 py-10">
      <div className="absolute right-5 top-5">
        <IconButton
          label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'}
          icon={theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          onClick={toggle}
        />
      </div>

      <div className="w-full max-w-[430px]">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-[var(--cv-radius-control)] bg-[var(--cv-color-accent)] font-mono text-[13px] font-semibold tracking-[0.06em] text-[var(--cv-color-on-accent)]">
            SH
          </span>
          <div>
            <div className="font-mono text-[15px] font-semibold tracking-[0.16em] text-[var(--cv-color-text)]">
              SAC HUB
            </div>
            <div className="text-[var(--cv-font-micro)] uppercase tracking-[0.1em] text-[var(--cv-color-text-muted)]">
              Central de atendimento omnichannel
            </div>
          </div>
        </div>

        <Card className="gap-4 p-6">
          <div className="flex flex-col gap-1">
            <Heading level={2}>Entrar no workspace</Heading>
            <Text muted>
              Acesso restrito à equipe de atendimento. As lojas e permissões vêm do seu usuário.
            </Text>
          </div>

          <form className="mt-1 flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
            <Input
              label="E-mail"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="voce@suaempresa.com.br"
              required
            />
            <Input
              label="Senha"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />

            {error ? (
              <Alert title="Não foi possível entrar" tone="danger">
                {error}
              </Alert>
            ) : null}

            <Button type="submit" variant="primary" loading={loading} fullWidth>
              Entrar
            </Button>
          </form>
        </Card>

        <div className="mt-6 flex items-center justify-center gap-2 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
          <Avatar name="SAC Hub" size="sm" />
          Amazon SP-API · Mercado Livre · Shopee Open Platform v2
        </div>
      </div>
    </div>
  );
}
