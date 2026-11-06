import type { AuditEventView } from '@sac/shared';

/**
 * RFC 4180 CSV serialization for `GET /admin/audit-logs/export.csv`.
 *
 * Kept framework-free so the escaping rules are unit-tested without HTTP:
 *  - fields are comma separated and records use CRLF;
 *  - a cell is quoted when it contains a comma, a double quote, CR or LF;
 *  - embedded double quotes are doubled (`""`), the RFC 4180 escape.
 *
 * `metadata` is intentionally omitted from the export: it is free-form JSON and
 * would need a second serialization layer; the seven columns below are the
 * stable, human-readable audit contract.
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
