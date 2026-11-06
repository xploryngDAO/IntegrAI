/**
 * "Códigos de recuperação" — the 2FA one-time codes of `/settings`.
 *
 * `GET /auth/2fa/recovery-codes/count` is the only source of the number shown
 * here: the API never returns the codes themselves, and the console must not
 * invent how many are left. Regeneration happens in a password + code dialog
 * that displays the new set exactly once.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError } from '../../lib/api';
import { recoveryCodesErrorMessage, RECOVERY_CODE_COUNT } from '../../lib/twoFactor';
import { Alert, Button, Card, Pill, Skeleton } from '../ui';
import { RegenerateRecoveryCodesDialog } from './RegenerateRecoveryCodesDialog';

/** Tone of the counter: 0 is an access risk, ≤2 deserves attention. */
function remainingTone(remaining: number): 'ok' | 'warn' | 'danger' {
  if (remaining <= 0) return 'danger';
  if (remaining <= 2) return 'warn';
  return 'ok';
}

/**
 * "Não publicado" (404/405/501) and "2FA desativado" (409) are configuration
 * states, not failures of this screen: they warn instead of alarming.
 */
function errorToneOf(error: unknown): 'warning' | 'danger' {
  if (
    error instanceof ApiClientError &&
    (error.status === 404 ||
      error.status === 405 ||
      error.status === 409 ||
      error.status === 501)
  ) {
    return 'warning';
  }
  return 'danger';
}

export function RecoveryCodesCard(): JSX.Element {
  const [remaining, setRemaining] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorTone, setErrorTone] = useState<'warning' | 'danger'>('danger');
  const [reloadKey, setReloadKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);

  const retry = useCallback((): void => {
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => {
    let active = true;

    async function loadCount(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const result = await api.recoveryCodesCount();
        if (active) setRemaining(result.remaining);
      } catch (countError) {
        if (!active) return;
        setRemaining(null);
        // The card is opened next to a real 2FA state, so this failure can be a
        // 409 (2FA disabled), a 404 (endpoint not published) or a real 5xx.
        setErrorTone(errorToneOf(countError));
        setError(recoveryCodesErrorMessage(countError, 'count'));
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadCount();
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const tone = remaining === null ? 'neutral' : remainingTone(remaining);
  const countLabel =
    remaining === null
      ? 'Códigos de recuperação'
      : `${remaining} ${remaining === 1 ? 'código de recuperação restante' : 'códigos de recuperação restantes'}`;

  return (
    <Card
      title="Códigos de recuperação"
      subtitle="Códigos de uso único do 2FA · saldo disponível na sua conta."
      actions={remaining === null ? undefined : <Pill tone={tone}>{remaining}</Pill>}
    >
      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : error !== null ? (
        <div className="flex flex-col gap-3">
          <Alert title="Não foi possível ler a contagem de códigos" tone={errorTone}>
            <div className="flex flex-col gap-2">
              <span>{error}</span>
              <div>
                <Button size="sm" icon="pulse" onClick={retry}>
                  Tentar novamente
                </Button>
              </div>
            </div>
          </Alert>
          <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
            Sem a contagem da API não é possível afirmar quantos códigos restam. A geração de novos
            códigos continua disponível abaixo e reporta o resultado real da API.
          </p>
          <div>
            <Button variant="secondary" icon="lock" onClick={() => setDialogOpen(true)}>
              Gerar novos códigos
            </Button>
          </div>
        </div>
      ) : remaining !== null ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[var(--cv-font-control)] font-medium" aria-live="polite">
            <span className="sac-num">{countLabel}</span>
          </p>

          {remaining === 0 ? (
            <Alert title="Nenhum código restante" tone="danger">
              Sem códigos de recuperação, perder o app autenticador bloqueia o login. Gere um novo
              conjunto agora e guarde-o fora do navegador.
            </Alert>
          ) : remaining <= 2 ? (
            <Alert title="Estoque baixo de códigos" tone="warning">
              Restam poucos códigos de uso único. Gere um novo conjunto antes de ficar sem nenhum.
            </Alert>
          ) : null}

          <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            Cada código entra no lugar do código do app autenticador e deixa de valer após o primeiro
            uso. Gerar novos códigos invalida todos os atuais e emite {RECOVERY_CODE_COUNT} novos,
            exibidos uma única vez.
          </p>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button variant="primary" icon="lock" onClick={() => setDialogOpen(true)}>
              Gerar novos códigos
            </Button>
            <Button variant="secondary" icon="pulse" onClick={retry}>
              Atualizar contagem
            </Button>
          </div>
        </div>
      ) : null}

      {dialogOpen ? (
        <RegenerateRecoveryCodesDialog
          onClose={() => setDialogOpen(false)}
          onRegenerated={retry}
        />
      ) : null}
    </Card>
  );
}
