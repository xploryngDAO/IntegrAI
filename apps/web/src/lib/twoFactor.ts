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

/* ==========================================================================
 * Recovery codes (list how many are left / regenerate the whole set)
 *
 *   GET  /auth/2fa/recovery-codes/count      -> { remaining }
 *   POST /auth/2fa/recovery-codes/regenerate -> { recoveryCodes } (8, once)
 * ========================================================================== */

/** Codes issued per generation (server contract). */
export const RECOVERY_CODE_COUNT = 8;

/** Only changes how a shared failure is explained. */
export type RecoveryCodesOperation = 'count' | 'regenerate';

/** `details.retryAfterMs` of a `429 RATE_LIMITED`, when the API sends it. */
function retryAfterHint(error: ApiClientError): string {
  const details = error.details;
  if (typeof details !== 'object' || details === null) return '';
  const raw = (details as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return '';
  const seconds = Math.max(1, Math.ceil(raw / 1_000));
  return ` Tente novamente em ~${seconds}s.`;
}

/**
 * Operator-facing message for a real failure of the recovery-code endpoints.
 *
 * Failures are never swallowed: a 409/400/401/429 keeps the server text and
 * adds what the operator can do. `404/405/501` means the API predates these
 * routes, which is reported as "não publicado" instead of "erro interno".
 */
export function recoveryCodesErrorMessage(
  error: unknown,
  operation: RecoveryCodesOperation,
): string {
  if (!(error instanceof ApiClientError)) {
    return error instanceof Error && error.message
      ? error.message
      : 'Não foi possível falar com a API. Verifique a conexão e tente novamente.';
  }

  switch (error.code) {
    case 'INVALID_PASSWORD':
      return 'Senha incorreta. Confira a senha da sua conta e tente novamente.';
    case 'INVALID_TOTP':
      return 'Código do app autenticador inválido ou expirado. Gere um novo código e tente novamente.';
    case 'INVALID_RECOVERY_CODE':
      return 'Código de recuperação inválido ou já utilizado. Cada código vale uma única vez.';
    case 'TWO_FACTOR_NOT_ENABLED':
      return 'A verificação em duas etapas não está ativada nesta conta. Ative o 2FA antes de gerar códigos de recuperação.';
    case 'TWO_FACTOR_SECRET_UNREADABLE':
      return 'O secret do 2FA não pôde ser lido pela API. Desative e ative a verificação em duas etapas novamente.';
    case 'RATE_LIMITED':
      return `Muitas tentativas em pouco tempo para gerar códigos de recuperação (HTTP 429).${retryAfterHint(error)}`;
    default:
      break;
  }

  if (error.status === 404 || error.status === 405 || error.status === 501) {
    return operation === 'count'
      ? 'A contagem de códigos de recuperação não está publicada nesta API.'
      : 'A geração de novos códigos de recuperação não está publicada nesta API.';
  }
  if (error.status === 400) {
    return `A API recusou o pedido (HTTP 400): ${error.message}`;
  }
  if (error.status === 422) {
    return `A API recusou o pedido (HTTP 422): ${error.message}`;
  }
  if (error.status === 401) {
    return 'Sessão expirada ou credenciais inválidas. Entre novamente e repita a operação.';
  }
  if (error.status === 403) {
    return 'Sua conta não tem permissão para gerenciar os códigos de recuperação.';
  }
  if (error.status === 409) {
    return `${error.message} (HTTP 409). O estado da verificação mudou em outra sessão; feche este painel, atualize a página e tente novamente.`;
  }
  if (error.status === 429) {
    return `Muitas tentativas em pouco tempo (HTTP 429).${retryAfterHint(error)} Aguarde antes de tentar novamente.`;
  }
  if (error.status === 0) return error.message;

  return `${error.message} (HTTP ${error.status})`;
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
