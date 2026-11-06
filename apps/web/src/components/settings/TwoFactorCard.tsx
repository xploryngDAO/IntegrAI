import { useCallback, useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { api, ApiClientError } from '../../lib/api';
import { useWorkspace } from '../../lib/store';
import {
  isTotpCode,
  normalizeTwoFactorCode,
  recoveryCodesToClipboardText,
  twoFactorErrorMessage,
} from '../../lib/twoFactor';
import type { TwoFactorSetupResult } from '../../lib/types';
import { Alert, Button, Card, IconButton, Input, Pill, Skeleton } from '../ui';
import { DisableTwoFactorDialog } from './DisableTwoFactorDialog';

/** Clipboard action that reports the real outcome instead of failing silently. */
function CopyButton({
  value,
  label,
  compact = false,
}: {
  value: string;
  label: string;
  compact?: boolean;
}): JSX.Element {
  const pushToast = useWorkspace((state) => state.pushToast);
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
      pushToast({ tone: 'ok', title: 'Copiado', description: label });
    } catch {
      pushToast({
        tone: 'warn',
        title: 'Não foi possível copiar',
        description: 'Selecione o texto na tela e copie manualmente.',
      });
    }
  }

  if (compact) {
    return (
      <IconButton
        label={`Copiar ${label}`}
        icon={copied ? <Check size={14} /> : <Copy size={14} />}
        onClick={() => void copy()}
      />
    );
  }

  return (
    <Button
      variant="secondary"
      icon={copied ? <Check size={15} /> : <Copy size={15} />}
      onClick={() => void copy()}
    >
      {label}
    </Button>
  );
}

/**
 * "Segurança" section of `/settings`: real TOTP enrollment.
 *
 * State machine driven by `GET /auth/2fa/status`:
 *   - disabled → "Ativar 2FA" calls `POST /auth/2fa/setup` and reveals the
 *     secret + `otpauth://` link (copyable, no QR dependency);
 *   - the 6-digit code confirms with `POST /auth/2fa/verify`, whose response
 *     carries the 8 recovery codes — shown exactly once, never persisted;
 *   - enabled → `POST /auth/2fa/disable` behind a password + code dialog.
 *
 * The secret/recovery codes live only in component state, matching the API
 * contract (they are returned once and only their hashes are stored).
 */
export function TwoFactorCard(): JSX.Element {
  const pushToast = useWorkspace((state) => state.pushToast);

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [setup, setSetup] = useState<TwoFactorSetupResult | null>(null);
  const [startingSetup, setStartingSetup] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);

  const retry = useCallback((): void => {
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => {
    let active = true;

    async function loadStatus(): Promise<void> {
      setLoading(true);
      setStatusError(null);
      try {
        const result = await api.twoFactorStatus();
        if (!active) return;
        setEnabled(result.enabled);
        setSetupError(null);
      } catch (error) {
        if (!active) return;
        setEnabled(null);
        setStatusError(twoFactorErrorMessage(error, 'status'));
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadStatus();
    return () => {
      active = false;
    };
  }, [reloadKey]);

  async function startSetup(): Promise<void> {
    if (startingSetup) return;
    setStartingSetup(true);
    setSetupError(null);
    setVerifyError(null);
    try {
      const result = await api.twoFactorSetup();
      setSetup(result);
      setCode('');
    } catch (error) {
      setSetupError(twoFactorErrorMessage(error, 'setup'));
      // Another tab/operator may have enabled 2FA between the status read and
      // this click: refresh the status so the card stops offering enrollment.
      if (error instanceof ApiClientError && error.code === 'TWO_FACTOR_ALREADY_ENABLED') {
        setReloadKey((key) => key + 1);
      }
    } finally {
      setStartingSetup(false);
    }
  }

  function cancelSetup(): void {
    if (verifying) return;
    setSetup(null);
    setCode('');
    setVerifyError(null);
    setSetupError(null);
  }

  async function confirmCode(): Promise<void> {
    if (verifying) return;
    const normalized = normalizeTwoFactorCode(code);
    if (!isTotpCode(normalized)) {
      setVerifyError('Informe os 6 dígitos exibidos no app autenticador.');
      return;
    }

    setVerifying(true);
    setVerifyError(null);
    try {
      const result = await api.twoFactorVerify(normalized);
      const codes = result.recoveryCodes.filter((entry) => entry.trim().length > 0);
      setEnabled(true);
      setSetup(null);
      setCode('');
      if (codes.length > 0) {
        setRecoveryCodes(codes);
        pushToast({
          tone: 'ok',
          title: 'Verificação em duas etapas ativada',
          description: 'Guarde os códigos de recuperação exibidos agora — eles não aparecem de novo.',
        });
      } else {
        pushToast({
          tone: 'warn',
          title: 'Verificação ativada, mas sem códigos de recuperação',
          description: 'A API não retornou os códigos. Desative e ative novamente para gerá-los.',
        });
      }
    } catch (error) {
      setVerifyError(twoFactorErrorMessage(error, 'verify'));
    } finally {
      setVerifying(false);
    }
  }

  function handleDisabled(): void {
    setDisableOpen(false);
    setEnabled(false);
    setSetup(null);
    setCode('');
    setSetupError(null);
    setVerifyError(null);
    setRecoveryCodes(null);
    pushToast({
      tone: 'ok',
      title: 'Verificação em duas etapas desativada',
      description: 'O próximo login pede somente e-mail e senha.',
    });
  }

  const statusPill =
    enabled === true ? (
      <Pill tone="ok">Ativada</Pill>
    ) : enabled === false ? (
      <Pill tone="neutral">Desativada</Pill>
    ) : null;

  return (
    <Card
      title="Verificação em duas etapas"
      subtitle="TOTP com app autenticador · estado real de GET /auth/2fa/status."
      actions={statusPill}
    >
      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : statusError !== null ? (
        <Alert title="Não foi possível ler o status da verificação" tone="danger">
          <div className="flex flex-col gap-2">
            <span>{statusError}</span>
            <div>
              <Button size="sm" icon="pulse" onClick={retry}>
                Tentar novamente
              </Button>
            </div>
          </div>
        </Alert>
      ) : recoveryCodes !== null ? (
        <div className="flex flex-col gap-3">
          <Alert title="Guarde estes 8 códigos agora" tone="warning">
            Eles são exibidos uma única vez e cada um entra no lugar do código do app autenticador.
            Um código deixa de funcionar depois do primeiro uso. Guarde-os fora do navegador — em um
            gerenciador de senhas ou cofre físico.
          </Alert>

          <ul
            className="m-0 grid list-none grid-cols-1 gap-1.5 p-0 sm:grid-cols-2"
            aria-label="Códigos de recuperação"
          >
            {recoveryCodes.map((recovery, index) => (
              <li
                key={recovery}
                className="flex items-center justify-between gap-2 rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-2.5 py-1.5"
              >
                <span className="sac-label m-0">{String(index + 1).padStart(2, '0')}</span>
                <code className="sac-num select-all text-[var(--cv-font-control)]">{recovery}</code>
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <CopyButton
              value={recoveryCodesToClipboardText(recoveryCodes)}
              label="Copiar os 8 códigos"
            />
            <Button variant="primary" icon="check" onClick={() => setRecoveryCodes(null)}>
              Já guardei os códigos
            </Button>
          </div>

          <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
            Depois de fechar esta confirmação os códigos não podem ser consultados de novo. Se
            perder todos, desative e ative a verificação para gerar um novo conjunto.
          </p>
        </div>
      ) : enabled === true ? (
        <div className="flex flex-col gap-3">
          <dl className="m-0 flex flex-col gap-1.5">
            <div className="sac-kv">
              <span>Situação</span>
              <strong>Ativada</strong>
            </div>
            <div className="sac-kv">
              <span>Método</span>
              <strong>TOTP · app autenticador</strong>
            </div>
            <div className="sac-kv">
              <span>Códigos de recuperação</span>
              <strong>8 códigos de uso único</strong>
            </div>
          </dl>

          <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            A partir de agora o login desta conta pede a senha e um código de 6 dígitos (ou um
            código de recuperação). Se você perder o acesso ao app, use um dos códigos guardados.
          </p>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button variant="danger" icon="close" onClick={() => setDisableOpen(true)}>
              Desativar 2FA
            </Button>
            <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
              Exige a senha da conta e um código válido.
            </span>
          </div>
        </div>
      ) : setup !== null ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            Abra o app autenticador (Google Authenticator, 1Password, Authy…) e adicione esta conta
            com a chave abaixo — ou copie o link <span className="sac-num">otpauth://</span> e abra
            no app. Depois digite os 6 dígitos para confirmar.
          </p>

          <div className="flex flex-col gap-1.5">
            <span className="sac-label">Chave secreta (TOTP)</span>
            <div className="flex items-start justify-between gap-2 rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-2.5 py-2">
              <code className="sac-num m-0 min-w-0 flex-1 select-all break-all text-[var(--cv-font-control)]">
                {setup.secret}
              </code>
              <CopyButton value={setup.secret} label="chave secreta" compact />
            </div>
            <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
              A chave aparece apenas nesta ativação. Não compartilhe com ninguém.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="sac-label">Link otpauth://</span>
            <div className="flex items-start justify-between gap-2 rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-2.5 py-2">
              <a
                href={setup.otpauthUrl}
                className="cv-link m-0 min-w-0 flex-1 break-all text-[var(--cv-font-meta)] underline"
                title="Abrir o link otpauth:// no app autenticador"
              >
                {setup.otpauthUrl}
              </a>
              <CopyButton value={setup.otpauthUrl} label="link otpauth://" compact />
            </div>
            <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
              Sem câmera para ler um QR? Copie o link e abra diretamente no app.
            </p>
          </div>

          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void confirmCode();
            }}
          >
            <Input
              label="Código de 6 dígitos"
              autoComplete="one-time-code"
              inputMode="numeric"
              spellCheck={false}
              maxLength={6}
              value={code}
              placeholder="000000"
              hint="Código gerado pelo app autenticador para esta conta."
              error={verifyError ?? undefined}
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
                setVerifyError(null);
              }}
            />

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button type="submit" variant="primary" loading={verifying} disabled={!isTotpCode(code)}>
                Confirmar e ativar
              </Button>
              <Button variant="ghost" onClick={cancelSetup} disabled={verifying}>
                Cancelar
              </Button>
            </div>
          </form>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            A verificação em duas etapas adiciona um segundo fator no login: além da senha, a API
            passa a exigir um código gerado por um app autenticador (TOTP). Recomendada para ADMIN
            e operadores com acesso a dados de clientes.
          </p>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button variant="primary" icon="lock" loading={startingSetup} onClick={() => void startSetup()}>
              Ativar 2FA
            </Button>
            <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
              A chave e o link otpauth:// aparecem antes da confirmação.
            </span>
          </div>

          {setupError !== null ? (
            <Alert title="Não foi possível iniciar a ativação" tone="danger">
              {setupError}
            </Alert>
          ) : null}
        </div>
      )}

      {disableOpen ? (
        <DisableTwoFactorDialog
          onClose={() => setDisableOpen(false)}
          onDisabled={handleDisabled}
        />
      ) : null}
    </Card>
  );
}
