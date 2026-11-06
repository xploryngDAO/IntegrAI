/**
 * `POST /auth/2fa/recovery-codes/regenerate` — replaces the whole code set.
 *
 * The API requires the account password AND a valid TOTP/recovery code, so both
 * fields are mandatory here (the server re-checks both). The 8 new codes come
 * back once: they are shown in a single, non-repeatable step and are only kept
 * in component state. Real failures (400/401/409/429, …) keep the server text —
 * a 409 means the state changed elsewhere, a 429 means rate limited.
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { api } from '../../lib/api';
import { useWorkspace } from '../../lib/store';
import {
  isPlausibleTwoFactorCode,
  normalizeTwoFactorCode,
  RECOVERY_CODE_COUNT,
  recoveryCodesErrorMessage,
  recoveryCodesToClipboardText,
} from '../../lib/twoFactor';
import { Alert, Button, Input, Modal } from '../ui';

export interface RegenerateRecoveryCodesDialogProps {
  onClose: () => void;
  /** Called after the API confirmed the new set (the card re-reads the count). */
  onRegenerated: () => void;
}

type Phase = 'form' | 'codes';

export function RegenerateRecoveryCodesDialog({
  onClose,
  onRegenerated,
}: RegenerateRecoveryCodesDialogProps): JSX.Element {
  const pushToast = useWorkspace((state) => state.pushToast);

  const [phase, setPhase] = useState<Phase>('form');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  const [emptyResult, setEmptyResult] = useState(false);
  const [copied, setCopied] = useState(false);

  const canSubmit = password.length > 0 && isPlausibleTwoFactorCode(code) && !saving;

  async function handleRegenerate(): Promise<void> {
    if (saving) return;
    if (password.length === 0) {
      setError('Informe a senha da sua conta para confirmar a troca dos códigos.');
      return;
    }
    const normalizedCode = normalizeTwoFactorCode(code);
    if (!isPlausibleTwoFactorCode(normalizedCode)) {
      setError('Informe os 6 dígitos do app autenticador ou um código de recuperação.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await api.regenerateRecoveryCodes({ password, code: normalizedCode });
      setPassword('');
      setCode('');
      setCodes(result.recoveryCodes);
      setEmptyResult(result.recoveryCodes.length === 0);
      setPhase('codes');
      // The server is the authority on how many codes remain, even when the
      // response came back without the fresh list.
      onRegenerated();
    } catch (regenerateError) {
      setError(recoveryCodesErrorMessage(regenerateError, 'regenerate'));
    } finally {
      setSaving(false);
    }
  }

  async function copyCodes(): Promise<void> {
    try {
      await navigator.clipboard.writeText(recoveryCodesToClipboardText(codes));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
      pushToast({
        tone: 'ok',
        title: 'Copiado',
        description: 'Códigos de recuperação na área de transferência.',
      });
    } catch {
      pushToast({
        tone: 'warn',
        title: 'Não foi possível copiar',
        description: 'Selecione os códigos na tela e copie manualmente.',
      });
    }
  }

  const formFooter = (
    <>
      <Button onClick={onClose} disabled={saving}>
        Cancelar
      </Button>
      <Button
        variant="primary"
        icon="lock"
        loading={saving}
        disabled={!canSubmit}
        onClick={() => void handleRegenerate()}
      >
        Gerar novos códigos
      </Button>
    </>
  );

  const codesFooter = (
    <>
      {codes.length > 0 ? (
        <Button
          variant="secondary"
          icon={copied ? <Check size={15} /> : <Copy size={15} />}
          onClick={() => void copyCodes()}
        >
          Copiar os {codes.length} códigos
        </Button>
      ) : (
        <Button variant="secondary" onClick={onClose}>
          Fechar
        </Button>
      )}
      <Button variant="primary" icon="check" onClick={onClose}>
        Já guardei os códigos
      </Button>
    </>
  );

  return (
    <Modal
      open
      onClose={() => {
        // The codes exist only while the dialog is open: closing discards them.
        if (!saving) onClose();
      }}
      title="Gerar novos códigos de recuperação"
      description={`A troca invalida todos os códigos atuais e emite ${RECOVERY_CODE_COUNT} novos códigos de uso único.`}
      footer={phase === 'form' ? formFooter : codesFooter}
    >
      {phase === 'form' ? (
        <div className="flex flex-col gap-3">
          <Alert title="Os códigos atuais deixam de funcionar" tone="warning">
            Todos os códigos de recuperação existentes são invalidados imediatamente. O novo conjunto
            aparece uma única vez, logo depois da confirmação — guarde-o fora do navegador.
          </Alert>

          <Input
            label="Senha da conta"
            type="password"
            autoComplete="current-password"
            value={password}
            placeholder="Sua senha atual"
            disabled={saving}
            hint="A API revalida a senha (bcrypt) antes de trocar os códigos."
            onChange={(event) => {
              setPassword(event.target.value);
              setError(null);
            }}
          />

          <Input
            label="Código de verificação"
            autoComplete="one-time-code"
            inputMode="numeric"
            spellCheck={false}
            maxLength={32}
            value={code}
            placeholder="123456 ou ABCD-2345"
            disabled={saving}
            hint="6 dígitos do app autenticador ou um código de recuperação de uso único."
            onChange={(event) => {
              setCode(event.target.value);
              setError(null);
            }}
          />

          {error !== null ? (
            <Alert title="Não foi possível gerar os códigos" tone="danger">
              {error}
            </Alert>
          ) : null}

          <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
            Chamada executada:{' '}
            <span className="sac-num">POST /api/v1/auth/2fa/recovery-codes/regenerate</span>
          </p>
        </div>
      ) : emptyResult ? (
        <Alert title="A API não retornou os novos códigos" tone="warning">
          A troca foi confirmada, mas a resposta veio sem a lista. Os códigos anteriores já não
          funcionam. Gere novamente para receber um conjunto novo e guarde-o imediatamente.
        </Alert>
      ) : (
        <div className="flex flex-col gap-3">
          <Alert title="Guarde estes códigos agora" tone="warning">
            Eles são exibidos uma única vez e cada um substitui o código do app autenticador. Um
            código deixa de funcionar depois do primeiro uso. Guarde-os em um gerenciador de senhas
            ou cofre físico.
          </Alert>

          <ul
            className="m-0 grid list-none grid-cols-1 gap-1.5 p-0 sm:grid-cols-2"
            aria-label="Novos códigos de recuperação"
          >
            {codes.map((recovery, index) => (
              <li
                key={recovery}
                className="flex items-center justify-between gap-2 rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-2.5 py-1.5"
              >
                <span className="sac-label m-0">{String(index + 1).padStart(2, '0')}</span>
                <code className="sac-num select-all text-[var(--cv-font-control)]">{recovery}</code>
              </li>
            ))}
          </ul>

          <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
            Depois de fechar esta confirmação os códigos não podem ser consultados de novo.
          </p>
        </div>
      )}
    </Modal>
  );
}
