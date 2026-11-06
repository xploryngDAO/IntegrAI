import { describe, expect, it } from 'vitest';
import type { AuditEventView } from '@sac/shared';

import {
  AUDIT_CSV_COLUMNS,
  auditCsvFileName,
  buildAuditCsv,
  escapeCsvCell,
} from '../csv';

/**
 * RFC 4180 serialization contract of the audit CSV export.
 *
 * The escaping rules are the risky part (a comma or a quote in the user agent
 * must not break the column alignment), so they are pinned here independently
 * from the HTTP route.
 */

function makeRow(overrides: Partial<AuditEventView> = {}): AuditEventView {
  return {
    id: 'audit-1',
    tenantId: 'tenant-1',
    actorId: 'agent-1',
    actorEmail: 'ana@acme.test',
    action: 'auth.login.success',
    resourceType: 'user',
    resourceId: 'agent-1',
    ip: '203.0.113.7',
    userAgent: 'Chrome',
    metadata: { secret: 'ignored' },
    createdAt: '2026-11-06T12:00:00.000Z',
    ...overrides,
  };
}

describe('escapeCsvCell', () => {
  it('leaves plain cells untouched and maps null to an empty cell', () => {
    expect(escapeCsvCell('Chrome')).toBe('Chrome');
    expect(escapeCsvCell('')).toBe('');
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('quotes commas and doubles embedded double quotes', () => {
    expect(escapeCsvCell('Acme, Inc.')).toBe('"Acme, Inc."');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes CR and LF so a record never breaks in the middle', () => {
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvCell('line1\r\nline2')).toBe('"line1\r\nline2"');
  });
});

describe('buildAuditCsv', () => {
  it('writes the stable header and CRLF-terminated records', () => {
    const csv = buildAuditCsv([makeRow()]);

    expect(csv).toBe(
      `${AUDIT_CSV_COLUMNS.join(',')}\r\n` +
        '2026-11-06T12:00:00.000Z,auth.login.success,ana@acme.test,user,agent-1,203.0.113.7,Chrome\r\n',
    );
    // `metadata` is intentionally not part of the export.
    expect(csv).not.toContain('tenantId');
    expect(csv).not.toContain('secret');
  });

  it('escapes hostile values and emits an empty cell for null columns', () => {
    const csv = buildAuditCsv([
      makeRow({
        actorEmail: 'ana,ln@acme.test',
        resourceType: 'user "quoted"',
        resourceId: null,
        ip: null,
        userAgent: 'Agent\nwith a line break',
      }),
    ]);

    const [, record] = csv.split('\r\n');
    expect(record).toContain('"ana,ln@acme.test"');
    expect(record).toContain('"user ""quoted"""');
    expect(record).toContain(',,,"Agent'); // resourceId + ip are empty cells
    expect(record).toContain('"Agent\nwith a line break"');
  });

  it('returns only the header when there are no rows', () => {
    expect(buildAuditCsv([])).toBe(`${AUDIT_CSV_COLUMNS.join(',')}\r\n`);
  });
});

describe('auditCsvFileName', () => {
  it('formats the UTC day as audit-logs-YYYY-MM-DD.csv', () => {
    expect(auditCsvFileName(new Date('2026-11-06T23:59:59.000Z'))).toBe(
      'audit-logs-2026-11-06.csv',
    );
    expect(auditCsvFileName(new Date('2026-01-01T00:00:00.000Z'))).toBe(
      'audit-logs-2026-01-01.csv',
    );
  });
});
