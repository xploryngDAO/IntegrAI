/**
 * Field validation + API failure presentation for the public auth screens
 * (`/signup`, `/verify-email`, `/forgot-password`, `/reset-password`).
 *
 * The limits mirror the server contract (`packages/server/src/http/schemas/
 * auth.schema.ts`): 12-character password, 2..160 company name, 1..120 person
 * name and a 254-character e-mail. Client validation exists only for immediate
 * feedback — the API stays the source of truth and its `422` issues are mapped
 * back onto the same fields by `fieldErrorsFromIssues`.
 */
import { ApiClientError } from './api';

/** Fase 1 password policy (server: `PASSWORD_MIN_LENGTH = 12`). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;
export const COMPANY_NAME_MIN_LENGTH = 2;
export const COMPANY_NAME_MAX_LENGTH = 160;
export const NAME_MAX_LENGTH = 120;
export const EMAIL_MAX_LENGTH = 254;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  const email = value.trim();
  return email.length > 0 && email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email);
}

/** One entry of `details.issues` from a `422 VALIDATION_ERROR` response. */
export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

/**
 * Reads the `422` field issues the API attaches to `details.issues`.
 * Any other failure (network, 409, 5xx) yields an empty list.
 */
export function validationIssues(error: unknown): ValidationIssue[] {
  if (!(error instanceof ApiClientError) || error.status !== 422) return [];

  const details = error.details;
  if (typeof details !== 'object' || details === null) return [];

  const raw = (details as { issues?: unknown }).issues;
  if (!Array.isArray(raw)) return [];

  const issues: ValidationIssue[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const value = entry as { path?: unknown; code?: unknown; message?: unknown };
    issues.push({
      path: typeof value.path === 'string' ? value.path : '',
      code: typeof value.code === 'string' ? value.code : 'invalid',
      message: typeof value.message === 'string' ? value.message : '',
    });
  }
  return issues;
}

/**
 * Projects the API issues onto the page's field names. Unknown paths are
 * dropped; callers fall back to a form-level alert when nothing matches.
 */
export function fieldErrorsFromIssues<K extends string>(
  issues: readonly ValidationIssue[],
  fields: readonly K[],
): Partial<Record<K, string>> {
  const errors: Partial<Record<K, string>> = {};
  for (const issue of issues) {
    const field = fields.find((entry) => entry === issue.path);
    if (field !== undefined && errors[field] === undefined) {
      errors[field] = issue.message || 'Valor inválido.';
    }
  }
  return errors;
}

/**
 * Turns an API/network failure into a sentence the operator can act on.
 * Status 0 already carries the client's own PT-BR network/timeout message.
 */
export function describeFailure(error: unknown, fallback: string): string {
  if (!(error instanceof ApiClientError)) return fallback;
  if (error.status === 0) return error.message;
  if (error.status === 429) {
    return 'Muitas tentativas seguidas. Aguarde cerca de um minuto antes de tentar novamente.';
  }
  if (error.status >= 500) {
    return 'A API não conseguiu concluir a operação agora. Tente novamente em instantes.';
  }
  return `${fallback} (HTTP ${error.status}).`;
}
