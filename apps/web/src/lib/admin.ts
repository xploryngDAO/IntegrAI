/**
 * Helpers of the account/admin surfaces (`/profile`, `/admin`).
 *
 * Pure formatting + PT-BR error mapping: the pages must show the API's real
 * message while still explaining what the operator can do next. Roles come from
 * `@sac/shared` (`ADMIN | SUPERVISOR | AGENT`) and an unknown role is preserved
 * verbatim — never coerced into AGENT.
 */
import { ApiClientError } from './api';
import { MARKETPLACE_LABEL, MARKETPLACE_ORDER } from './labels';

/* ==========================================================================
 * Roles
 * ========================================================================== */

export interface RoleOption {
  value: string;
  label: string;
}

export const ROLE_OPTIONS: readonly RoleOption[] = [
  { value: 'ADMIN', label: 'Administrador' },
  { value: 'SUPERVISOR', label: 'Supervisor' },
  { value: 'AGENT', label: 'Agente' },
];

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrador',
  SUPERVISOR: 'Supervisor',
  AGENT: 'Agente',
  PLATFORM_ADMIN: 'Operador da plataforma',
  PLATFORM_OWNER: 'Operador da plataforma',
};

export function roleLabel(role: string | null | undefined): string {
  const value = (role ?? '').trim();
  if (value.length === 0) return '—';
  return ROLE_LABEL[value.toUpperCase()] ?? value;
}

export type RoleTone = 'accent' | 'info' | 'neutral';

export function roleTone(role: string | null | undefined): RoleTone {
  switch ((role ?? '').trim().toUpperCase()) {
    case 'ADMIN':
      return 'accent';
    case 'SUPERVISOR':
      return 'info';
    default:
      return 'neutral';
  }
}

/**
 * Options for the role select. A role the UI does not know yet stays selectable
 * so opening the dialog never silently rewrites it to a known role.
 */
export function roleOptionsFor(current: string | null | undefined): RoleOption[] {
  const options: RoleOption[] = ROLE_OPTIONS.map((entry) => ({ ...entry }));
  const value = (current ?? '').trim();
  if (value.length > 0 && !ROLE_OPTIONS.some((entry) => entry.value === value.toUpperCase())) {
    options.push({ value, label: roleLabel(value) });
  }
  return options;
}

/* ==========================================================================
 * Workspace overview (`GET /admin/overview`)
 * ========================================================================== */

/** One marketplace row of the accounts breakdown of the overview. */
export interface AdminOverviewMarketplace {
  /** Marketplace code as returned by the API (`AMAZON`, `MERCADO_LIVRE`, …). */
  key: string;
  /** PT-BR label of the known channel; the raw code when it is unknown. */
  label: string;
  /** Accounts of that channel (`>= 0`). */
  count: number;
}

/**
 * Rows of the accounts breakdown, in the canonical channel order.
 *
 * The three marketplaces the product supports always come first (Amazon,
 * Mercado Livre, Shopee — `MARKETPLACE_ORDER`), followed by any extra code the
 * API returned: a deployment ahead of this UI shows its new channel instead of
 * hiding it. An unknown code keeps its raw label — the operator needs the exact
 * channel name, not an invented one.
 *
 * `api.adminOverview` already guarantees the known keys and non-negative
 * integers; the clamp here keeps a call site that builds the record by hand from
 * rendering a negative count.
 */
export function adminOverviewMarketplaces(
  byMarketplace: Record<string, number>,
): AdminOverviewMarketplace[] {
  const known = MARKETPLACE_ORDER as readonly string[];
  const labels = MARKETPLACE_LABEL as Record<string, string>;
  const extras = Object.keys(byMarketplace)
    .filter((key) => !known.includes(key))
    .sort((left, right) => left.localeCompare(right, 'pt-BR'));
  return [...known, ...extras].map((key) => ({
    key,
    label: labels[key] ?? key,
    count: Math.max(0, Math.trunc(byMarketplace[key] ?? 0)),
  }));
}

/* ==========================================================================
 * Workspace users (`GET /admin/users` filters + export)
 * ========================================================================== */

/**
 * Status values accepted by `GET /admin/users?status=`.
 *
 * The API enums of this project are uppercase (`ADMIN`/`SUPERVISOR`/`AGENT`,
 * `ACTIVE`/`SUSPENDED`, invitation statuses), so the filter follows the same
 * convention instead of inventing a lowercase query dialect.
 */
export const ADMIN_USER_STATUS_OPTIONS: readonly RoleOption[] = [
  { value: 'ACTIVE', label: 'Ativo' },
  { value: 'INACTIVE', label: 'Inativo' },
];

/** Page sizes offered by the Users tab (`perPage`; the API caps at 100). */
export const ADMIN_USERS_PAGE_SIZES: readonly number[] = [25, 50, 100];

/**
 * `1–25 de 40` for the current page.
 *
 * `visible` is the number of rows the page actually holds, so the range never
 * claims rows the API did not return; `total` is the filtered set size. An
 * empty page renders `0 de N`.
 */
export function adminUsersRangeLabel(
  page: number,
  perPage: number,
  total: number,
  visible: number,
): string {
  const rows = Math.max(0, Math.trunc(visible));
  // The rows on screen exist even if a deployment under-reported `total`, so
  // the range is never narrower than what the operator is looking at.
  const safeTotal = Math.max(0, Math.trunc(total), rows);
  if (rows === 0) return `0 de ${safeTotal}`;
  const size = Math.max(1, Math.trunc(perPage));
  const start = (Math.max(1, Math.trunc(page)) - 1) * size + 1;
  const end = Math.min(safeTotal, start + rows - 1);
  return `${start}–${end} de ${safeTotal}`;
}

/**
 * `usuarios-YYYY-MM-DD.csv` — fallback name when the API omits
 * `Content-Disposition`. The server name always wins; this mirrors the API's
 * own name (`adminUsersCsvFileName`, UTC day) so both spellings agree.
 */
export function adminUsersExportName(date: Date = new Date()): string {
  return `usuarios-${date.toISOString().slice(0, 10)}.csv`;
}

/* ==========================================================================
 * Errors
 * ========================================================================== */

function serverCode(error: ApiClientError): string {
  return error.code && error.code !== 'HTTP_ERROR' ? ` (${error.code})` : '';
}

/** Failure of the profile/session endpoints (self-service). */
export function accountErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401) {
      return 'Sua sessão expirou. Entre novamente para continuar.';
    }
    if (error.status === 403) {
      return 'Sua conta não tem permissão para esta ação.';
    }
    if (error.status === 404) {
      return 'O recurso não foi encontrado. Ele pode ter sido removido; atualize a página.';
    }
    if (error.status === 409) {
      return `${error.message} (HTTP 409). Atualize os dados e tente novamente.`;
    }
    if (error.status === 422) {
      return `${error.message} Revise o valor enviado e tente novamente.`;
    }
    if (error.status === 0) return error.message;
    return `${error.message}${serverCode(error)} (HTTP ${error.status})`;
  }
  return error instanceof Error && error.message
    ? error.message
    : 'Não foi possível falar com a API. Tente novamente.';
}

/** Failure of the `/admin/*` endpoints (workspace administration). */
export function adminErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401) {
      return 'Sua sessão expirou. Entre novamente para administrar a equipe.';
    }
    if (error.status === 403) {
      return 'Somente um ADMIN do workspace pode executar esta ação (HTTP 403).';
    }
    if (error.status === 404) {
      return 'Usuário não encontrado (HTTP 404). Ele pode ter sido removido; atualize a lista.';
    }
    if (error.status === 409) {
      return `${error.message} (HTTP 409). A equipe mudou em outra sessão; atualize a lista e tente novamente.`;
    }
    if (error.status === 422) {
      return `${error.message} Revise os dados enviados e tente novamente.`;
    }
    if (error.status === 0) return error.message;
    return `${error.message}${serverCode(error)} (HTTP ${error.status})`;
  }
  return error instanceof Error && error.message
    ? error.message
    : 'Não foi possível falar com a API. Tente novamente.';
}

/**
 * Failure of `GET /admin/overview` (the counters above the `/admin` tabs).
 *
 * A 404 here never means "record not found": the overview is a page-level
 * aggregate with no id, so the only honest reading is that this deployment does
 * not expose the route yet (the SPA can ship before the API). Reusing
 * `adminErrorMessage` would tell the operator that a *user* was not found, which
 * is not what happened. Every other status keeps the shared mapping.
 */
export function adminOverviewErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.status === 404) {
    return 'Esta versão da API não expõe a visão geral (HTTP 404 em /admin/overview). Confirme se a API está atualizada; os contadores voltam a aparecer quando o endpoint estiver disponível.';
  }
  return adminErrorMessage(error);
}

/**
 * Failure of `DELETE /admin/sessions/:id` (revocation of one operator session).
 *
 * `409 CANNOT_REVOKE_CURRENT_SESSION` is the refusal to revoke the session that
 * issued the current access token: the API's own message is shown first and the
 * hint says how to end it (the "Sair" action, not this table).
 */
export function adminSessionErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 404) {
      return 'Sessão não encontrada (HTTP 404). Ela pode ter expirado, sido revogada ou ter saído em outro dispositivo; atualize a lista antes de tentar de novo.';
    }
    if (error.status === 409) {
      const message = error.message.trim();
      const detail = message.length === 0 ? '' : /[.!?]$/.test(message) ? message : `${message}.`;
      const prefix = detail.length > 0 ? `${detail} ` : '';
      if (error.code === 'CANNOT_REVOKE_CURRENT_SESSION') {
        return `${prefix}A sessão atual não pode ser revogada por aqui: use "Sair" no menu da conta para encerrá-la neste navegador.`;
      }
      return `${prefix}A sessão mudou em outra aba ou dispositivo (HTTP 409); atualize a lista e tente novamente.`;
    }
    if (error.status === 401) {
      return 'Sua sessão expirou. Entre novamente para administrar as sessões.';
    }
    if (error.status === 403) {
      return 'Somente um ADMIN do workspace pode revogar sessões (HTTP 403).';
    }
  }
  return adminErrorMessage(error);
}

/**
 * Failure of `POST /admin/users/:id/reset-2fa` (administrative 2FA reset).
 *
 * The API's own message is shown first — it is the truth of *why* the reset was
 * refused — and the hint after it says what the operator can do next:
 *  - `409 CANNOT_RESET_OWN_2FA`: self-service disable lives in `/settings`;
 *  - `409 TWO_FACTOR_NOT_ENABLED`: the row was stale, so the list is re-read;
 *  - `404`: the operator does not exist in this tenant (or was removed).
 */
export function resetUserTwoFactorErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    const message = error.message.trim();
    // The API answers PT-BR sentences, but a proxy may drop the final
    // punctuation; the hint is appended as a new sentence either way.
    const detail = message.length === 0 ? '' : /[.!?]$/.test(message) ? message : `${message}.`;
    const prefix = detail.length > 0 ? `${detail} ` : '';

    switch (error.code) {
      case 'CANNOT_RESET_OWN_2FA':
        return `${prefix}Sua própria verificação em duas etapas não pode ser redefinida por aqui: use Configurações → Segurança para desativá-la com a senha e um código.`;
      case 'TWO_FACTOR_NOT_ENABLED':
        return `${prefix}Este operador já está sem a verificação em duas etapas; a lista foi atualizada com o estado real. Nenhuma sessão foi encerrada por esta tentativa.`;
      default:
        break;
    }

    if (error.status === 404) {
      return 'Usuário não encontrado (HTTP 404). Ele pode ter sido removido ou pertencer a outro workspace; atualize a lista antes de tentar de novo.';
    }
    if (error.status === 409) {
      return `${prefix}O estado do 2FA mudou em outra sessão (HTTP 409); atualize a lista e tente novamente.`;
    }
    if (error.status === 401) {
      return 'Sua sessão expirou. Entre novamente para redefinir a verificação em duas etapas.';
    }
    if (error.status === 403) {
      return 'Somente um ADMIN do workspace pode redefinir o 2FA de outro operador (HTTP 403).';
    }
    if (error.status === 422) {
      return `${error.message} Revise o operador escolhido e tente novamente.`;
    }
    if (error.status === 0) return error.message;
  }
  return adminErrorMessage(error);
}

/** Failure of `DELETE /admin/invitations/:id` (revocation of a pending invite). */
export function invitationErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 404) {
      return 'Convite não encontrado (HTTP 404). Ele pode ter sido revogado ou removido; atualize a lista.';
    }
    if (error.status === 409) {
      // The API's message is the truth (e.g. "Invitation has already been
      // accepted"). It is shown first; the hint below explains what to do next.
      if (error.code === 'INVITATION_ALREADY_ACCEPTED') {
        const message = error.message.trim();
        const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
        return `${sentence} Atualize a lista: convites aceitos não podem ser revogados.`;
      }
      return `${error.message} (HTTP 409). O convite mudou em outra sessão; atualize a lista e tente novamente.`;
    }
    if (error.status === 401) {
      return 'Sua sessão expirou. Entre novamente para administrar os convites.';
    }
    if (error.status === 403) {
      return 'Somente um ADMIN do workspace pode revogar convites (HTTP 403).';
    }
  }
  return adminErrorMessage(error);
}

/**
 * Failure of `POST /admin/invitations/:id/resend` (re-send of the invite e-mail).
 *
 * The API's own message is shown first; the hint after it says what to do next.
 * `502 EMAIL_SEND_FAILED` is the mail-provider failure: the link may not have
 * been delivered, so the operator retries — and, when it persists, checks the
 * workspace SMTP with another ADMIN.
 */
export function resendInvitationErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    const message = error.message.trim();
    // The API answers PT-BR sentences, but a proxy may send one without the
    // final punctuation; the hint is appended as a new sentence either way.
    const detail = message.length === 0 ? '' : /[.!?]$/.test(message) ? message : `${message}.`;
    const prefix = detail.length > 0 ? `${detail} ` : '';

    if (error.code === 'EMAIL_SEND_FAILED' || error.status === 502) {
      return `${prefix}O e-mail do convite não foi entregue (HTTP 502). Tente reenviar em instantes; se o erro persistir, peça a um ADMIN para conferir o SMTP do workspace.`;
    }
    if (error.status === 404) {
      return 'Convite não encontrado (HTTP 404). Ele pode ter sido aceito ou removido; atualize a lista antes de tentar de novo.';
    }
    if (error.status === 409) {
      if (error.code === 'INVITATION_ALREADY_ACCEPTED') {
        return `${prefix}Convites aceitos não podem ser reenviados. Atualize a lista: o convite já gerou um operador.`;
      }
      return `${prefix}O convite mudou em outra sessão (HTTP 409); atualize a lista e tente novamente.`;
    }
    if (error.status === 401) {
      return 'Sua sessão expirou. Entre novamente para administrar os convites.';
    }
    if (error.status === 403) {
      return 'Somente um ADMIN do workspace pode reenviar convites (HTTP 403).';
    }
  }
  return adminErrorMessage(error);
}

/* ==========================================================================
 * Invitations (`GET /admin/invitations`)
 * ========================================================================== */

export type InvitationStatusTone = 'ok' | 'warn' | 'danger' | 'neutral';

/** PT-BR label of an invitation status; an unknown code is kept verbatim. */
export function invitationStatusLabel(status: string | null | undefined): string {
  const value = (status ?? '').trim();
  switch (value.toUpperCase()) {
    case 'PENDING':
      return 'Pendente';
    case 'ACCEPTED':
      return 'Aceito';
    case 'EXPIRED':
      return 'Expirado';
    default:
      return value.length > 0 ? value : '—';
  }
}

export function invitationStatusTone(status: string | null | undefined): InvitationStatusTone {
  switch ((status ?? '').trim().toUpperCase()) {
    case 'PENDING':
      return 'warn';
    case 'ACCEPTED':
      return 'ok';
    case 'EXPIRED':
      return 'danger';
    default:
      // An unknown status is neither success nor failure: neutral, raw label.
      return 'neutral';
  }
}

/** Only a PENDING invitation can be revoked (`DELETE /admin/invitations/:id`). */
export function isInvitationPending(status: string | null | undefined): boolean {
  return (status ?? '').trim().toUpperCase() === 'PENDING';
}

/** Whether the single-use link of the invitation has already expired. */
export function isInvitationExpired(status: string | null | undefined): boolean {
  return (status ?? '').trim().toUpperCase() === 'EXPIRED';
}

/**
 * Whether the invitation can be re-sent (`POST /admin/invitations/:id/resend`).
 *
 * PENDING and EXPIRED invites can be re-sent; an ACCEPTED invite already created
 * the operator and must never be offered here. An unknown status is not assumed
 * resendable — the UI waits for a status it actually understands.
 */
export function canResendInvitation(status: string | null | undefined): boolean {
  const value = (status ?? '').trim().toUpperCase();
  return value === 'PENDING' || value === 'EXPIRED';
}

/* ==========================================================================
 * Audit trail
 * ========================================================================== */

/**
 * PT-BR labels of the action codes the API records. Unknown codes are rendered
 * raw (an operator investigating an incident needs the exact code, not a guess).
 */
const AUDIT_ACTION_LABEL: Record<string, string> = {
  'auth.login': 'Login',
  'auth.logout': 'Logout',
  'auth.login.failed': 'Tentativa de login falhou',
  'auth.password.reset': 'Senha redefinida',
  'auth.password.changed': 'Senha alterada',
  'auth.2fa.enabled': '2FA ativado',
  'auth.2fa.disabled': '2FA desativado',
  'auth.sso.updated': 'SSO atualizado',
  'auth.sso.removed': 'SSO removido',
  'user.invited': 'Convite enviado',
  'user.created': 'Usuário criado',
  'user.updated': 'Usuário atualizado',
  'user.role_changed': 'Papel alterado',
  'user.deactivated': 'Usuário desativado',
  'user.reactivated': 'Usuário reativado',
  'user.sessions_revoked': 'Sessões revogadas',
  'session.revoked': 'Sessão revogada',
  'sessions.revoked': 'Sessões revogadas',
  'tenant.updated': 'Workspace atualizado',
  'tenant.deleted': 'Workspace excluído',
  'tenant.exported': 'Dados exportados',
  'billing.updated': 'Cobrança atualizada',
};

export function auditActionLabel(action: string | null | undefined): string {
  const value = (action ?? '').trim();
  if (value.length === 0) return '—';
  return AUDIT_ACTION_LABEL[value.toLowerCase()] ?? 'Ação administrativa';
}

/** Pretty JSON of the metadata payload; empty string when there is nothing. */
export function formatAuditMetadata(metadata: unknown): string {
  if (metadata === null || metadata === undefined) return '';
  if (typeof metadata === 'string') return metadata.trim();
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return String(metadata);
  }
}

/** `9f1c2a30…4be1` — keeps long ids readable inside table cells. */
export function compactId(value: string | null | undefined): string {
  const id = (value ?? '').trim();
  if (id.length === 0) return '—';
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/* ==========================================================================
 * Date range (`<input type="date">` → ISO instants)
 * ========================================================================== */

/** `YYYY-MM-DD` → local start of that day as an ISO instant. */
export function startOfDayIso(value: string): string | null {
  const parts = parseDateInput(value);
  if (parts === null) return null;
  const date = new Date(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** `YYYY-MM-DD` → local end of that day (23:59:59.999) as an ISO instant. */
export function endOfDayIso(value: string): string | null {
  const parts = parseDateInput(value);
  if (parts === null) return null;
  const date = new Date(parts.year, parts.month - 1, parts.day, 23, 59, 59, 999);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function parseDateInput(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(year, month - 1, day);
  // Reject impossible dates such as 2026-02-31 (Date would roll them over).
  if (
    probe.getFullYear() !== year ||
    probe.getMonth() !== month - 1 ||
    probe.getDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}
