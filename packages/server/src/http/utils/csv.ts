import type { AdminUserView, AuditEventView } from '@sac/shared';

/**
 * RFC 4180 CSV serialization for `GET /admin/audit-logs/export.csv` and
 * `GET /admin/users/export.csv`.
 *
 * Kept framework-free so the escaping rules are unit-tested without HTTP:
 *  - fields are comma separated and records use CRLF;
 *  - a cell is quoted when it contains a comma, a double quote, CR or LF;
 *  - embedded double quotes are doubled (`""`), the RFC 4180 escape.
 *
 * `metadata` is intentionally omitted from the audit export: it is free-form
 * JSON and would need a second serialization layer; the seven columns below are
 * the stable, human-readable audit contract.
 */

export const AUDIT_CSV_COLUMNS = [
  'created_at',
  'action',
  'actor_email',
  'resource_type',
  'resource_id',
  'ip',
  'user_agent',
] as const;

export const ADMIN_USERS_CSV_COLUMNS = [
  'name',
  'email',
  'role',
  'is_active',
  'last_login_at',
  'created_at',
  'sessions_count',
] as const;

const CSV_RECORD_SEPARATOR = '\r\n';
const NEEDS_QUOTING = /[",\r\n]/;

/** Null/undefined become an empty (unquoted) cell. */
export function escapeCsvCell(value: string | null | undefined): string {
  const text = value ?? '';
  if (!NEEDS_QUOTING.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsvRecord(cells: readonly (string | null | undefined)[]): string {
  return cells.map(escapeCsvCell).join(',');
}

/** Serializes the header plus one record per audit row (newest first upstream). */
export function buildAuditCsv(rows: readonly AuditEventView[]): string {
  const lines: string[] = [AUDIT_CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(
      toCsvRecord([
        row.createdAt,
        row.action,
        row.actorEmail,
        row.resourceType,
        row.resourceId,
        row.ip,
        row.userAgent,
      ]),
    );
  }
  return `${lines.join(CSV_RECORD_SEPARATOR)}${CSV_RECORD_SEPARATOR}`;
}

/** `audit-logs-YYYY-MM-DD.csv` using the UTC day of the export instant. */
export function auditCsvFileName(at: Date): string {
  return `audit-logs-${at.toISOString().slice(0, 10)}.csv`;
}

/**
 * Serializes the header plus one record per workspace operator (ordered by
 * `createdAt` ascending upstream). `is_active` is written as `true`/`false` and
 * a null `last_login_at` becomes an empty cell.
 */
export function buildAdminUsersCsv(rows: readonly AdminUserView[]): string {
  const lines: string[] = [ADMIN_USERS_CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(
      toCsvRecord([
        row.name,
        row.email,
        row.role,
        row.isActive ? 'true' : 'false',
        row.lastLoginAt,
        row.createdAt,
        String(row.sessionsCount),
      ]),
    );
  }
  return `${lines.join(CSV_RECORD_SEPARATOR)}${CSV_RECORD_SEPARATOR}`;
}

/** `usuarios-YYYY-MM-DD.csv` using the UTC day of the export instant. */
export function adminUsersCsvFileName(at: Date): string {
  return `usuarios-${at.toISOString().slice(0, 10)}.csv`;
}

/**
 * Number of DATA rows of an already-serialized CSV (header excluded).
 *
 * Used by the export audit row (`rowCount`), so it must never be a naive
 * `split('\r\n')`:
 *  - the header is not a data row;
 *  - the trailing CRLF (and any blank line) produces no row;
 *  - a quoted cell may itself contain CR/LF (RFC 4180) and is still ONE row.
 *
 * The scan tracks the quote state and only counts record separators that fall
 * outside a quoted cell. A record made only of separators is skipped, so a CSV
 * with just the header (or an empty string) answers 0.
 */
export function countCsvDataRows(csv: string): number {
  let records = 0;
  let inQuotes = false;
  let recordHasContent = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];

    if (inQuotes) {
      if (char === '"') {
        // `""` inside a quoted cell is an escaped quote, not the closing one.
        if (csv[index + 1] === '"') index += 1;
        else inQuotes = false;
      }
      if (char !== '\r' && char !== '\n') recordHasContent = true;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      recordHasContent = true;
      continue;
    }

    if (char === '\r' || char === '\n') {
      // Swallow the LF of a CRLF pair so it does not open a second record.
      if (char === '\r' && csv[index + 1] === '\n') index += 1;
      if (recordHasContent) records += 1;
      recordHasContent = false;
      continue;
    }

    recordHasContent = true;
  }

  // Last record without a trailing line break.
  if (recordHasContent) records += 1;

  // The first record is the header; a CSV shorter than that has no data rows.
  return Math.max(0, records - 1);
}
