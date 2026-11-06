import { useState } from 'react';
import { api } from '../../lib/api';
import {
  isPlausibleTwoFactorCode,
  normalizeTwoFactorCode,
  twoFactorErrorMessage,
} from '../../lib/twoFactor';
import { Alert, Button, Input, Modal } from '../ui';

export interface DisableTwoFactorDialogProps {
  onClose: () => void;
  /** Called after the API confirms the deactivation (the card refreshes). */
  onDisabled: () => void;
}

/**
 * `POST /auth/2fa/disable` — the API requires the account password AND a valid
 * TOTP/recovery code, so both fields are mandatory here (the schema-level
 * optional `code` exists only so the service can answer `INVALID_TOTP`).
 *
 * Recovery codes become invalid when 2FA is disabled, which is why the dialog
 * says so before the operator commits.
 */
export function DisableTwoFactorDialog({
  onClose,
  onDisabled,
}: DisableTwoFactorDialogProps): JSX.Element {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);

  const canSubmit = password.length > 0 && isPlausibleTwoFactorCode(code) && !disabling;

  async function handleDisable(): Promise<void> {
    if (disabling) return;
    if (password.length === 0) {
      setError('Informe a senha da sua conta para confirmar a desativação.');
      return;
    }
    const normalizedCode = normalizeTwoFactorCode(code);
    if (!isPlausibleTwoFactorCode(normalizedCode)) {
      setError('Informe os 6 dígitos do app autenticador ou um código de recuperação.');
      return;
    }

    setDisabling(true);
    setError(null);
    try {
      await api.twoFactorDisable({ password, code: normalizedCode });
      onDisabled();
    } catch (disableError) {
      setError(twoFactorErrorMessage(disableError, 'disable'));
      setDisabling(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!disabling) onClose();
      }}
      title="Desativar verificação em duas etapas"
      description="Confirme com a senha da conta e um código do app autenticador (ou um código de recuperação)."
      footer={
        <>
          <Button onClick={onClose} disabled={disabling}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            icon="close"
            loading={disabling}
            disabled={!canSubmit}
            onClick={() => void handleDisable()}
          >
            Desativar 2FA
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Alert title="O login volta a pedir somente e-mail e senha" tone="warning">
          Os 8 códigos de recuperação atuais são invalidados. Você pode ativar novamente quando
          quiser, mas receberá um novo secret e novos códigos.
        </Alert>

        <Input
          label="Senha da conta"
          type="password"
          autoComplete="current-password"
          value={password}
          placeholder="Sua senha atual"
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
          hint="6 dígitos do app autenticador ou um código de recuperação de uso único."
          onChange={(event) => {
            setCode(event.target.value);
            setError(null);
          }}
        />

        {error !== null ? (
          <Alert title="Não foi possível desativar a verificação" tone="danger">
            {error}
          </Alert>
        ) : null}

        <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
          Chamada executada:{' '}
          <span className="sac-num">POST /api/v1/auth/2fa/disable</span> · a API revalida a senha
          (bcrypt) e o código antes de desativar.
        </p>
      </div>
    </Modal>
  );
}
