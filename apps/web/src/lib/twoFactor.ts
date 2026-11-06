/**
 * Fase 1 — verificação em duas etapas (TOTP): helpers shared by `/settings`
 * and `/login`.
 *
 * The API answers stable error codes (`INVALID_TOTP`, `INVALID_PASSWORD`,
 * `TWO_FACTOR_SETUP_REQUIRED`, …), so the UI maps them to recovery-oriented
 * messages instead of leaking "Invalid two-factor code" to the operator.
 */
import { ApiClientError } from './api';

/** The request being executed — only changes how a shared code is explained. */
export type TwoFactorOperation = 'status' | 'setup' | 'verify' | 'disable' | 'challenge';

/** Length of a TOTP code (`Google Authenticator`, `1Password`, …). */
export const TOTP_CODE_LENGTH = 6;

/**
 * Codes are pasted from an authenticator (sometimes with spaces) and recovery
 * codes are case-insensitive on the server; normalise before validating/sending.
 * Hyphens are preserved — the server removes them when hashing recovery codes.
 */
export function normalizeTwoFactorCode(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

/** Exactly the 6 digits of a TOTP code. */
export function isTotpCode(value: string): boolean {
  return /^\d{6}$/.test(normalizeTwoFactorCode(value));
}

/**
 * A TOTP code or a recovery code (`XXXX-XXXX`). This is a shape check used to
 * disable a submit button — the API remains the authority on validity.
 */
export function isPlausibleTwoFactorCode(value: string): boolean {
  const code = normalizeTwoFactorCode(value);
  return /^\d{6}$/.test(code) || /^[A-Z0-9][A-Z0-9-]{6,31}$/.test(code);
}

/** 8 one-time recovery codes, formatted one per line for the clipboard. */
export function recoveryCodesToClipboardText(codes: readonly string[]): string {
  return codes.join('\n');
}

/**
 * Operator-facing message for a real API failure. The server text is preserved
 * when no specific guidance exists (never a generic "algo deu errado").
 */
export function twoFactorErrorMessage(error: unknown, operation: TwoFactorOperation): string {
  if (!(error instanceof ApiClientError)) {
    return error instanceof Error && error.message
      ? error.message
      : 'Não foi possível falar com a API. Verifique a conexão e tente novamente.';
  }

  switch (error.code) {
    case 'INVALID_TOTP':
      return operation === 'challenge'
        ? 'Código inválido ou já utilizado. Gere um novo código no app autenticador e tente novamente. Um código de recuperação também funciona, mas cada um vale uma única vez.'
        : 'Código inválido ou expirado. Confira os 6 dígitos exibidos no app autenticador e tente novamente.';
    case 'INVALID_CHALLENGE_TOKEN':
      return 'A verificação expirou ou já foi usada. Volte e faça login novamente para gerar um novo desafio.';
    case 'INVALID_PASSWORD':
      return 'Senha incorreta. Confira a senha da sua conta e tente novamente.';
    case 'TWO_FACTOR_SETUP_REQUIRED':
      return 'A ativação não foi iniciada nesta conta. Gere um novo secret antes de confirmar o código.';
    case 'TWO_FACTOR_ALREADY_ENABLED':
      return 'A verificação em duas etapas já está ativada nesta conta. Atualize o status para continuar.';
    case 'TWO_FACTOR_NOT_ENABLED':
      return 'A verificação em duas etapas já está desativada nesta conta.';
    case 'TWO_FACTOR_SECRET_UNREADABLE':
      return 'O secret salvo não pôde ser lido pela API. Desative e ative a verificação em duas etapas novamente.';
    default:
      break;
  }

  if (error.status === 404 || error.status === 405 || error.status === 501) {
    return 'A verificação em duas etapas não está publicada nesta API.';
  }
  if (error.status === 401) {
    return 'Sessão expirada ou credenciais inválidas. Entre novamente e repita a operação.';
  }
  if (error.status === 403) {
    return 'Sua conta não tem permissão para alterar a verificação em duas etapas.';
  }
  if (error.status === 0) return error.message;

  return `${error.message} (HTTP ${error.status})`;
}
