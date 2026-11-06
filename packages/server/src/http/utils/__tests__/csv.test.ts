import { describe, expect, it } from 'vitest';
import type { AdminUserView, AuditEventView } from '@sac/shared';

import {
  ADMIN_USERS_CSV_COLUMNS,
  AUDIT_CSV_COLUMNS,
  adminUsersCsvFileName,
  auditCsvFileName,
  buildAdminUsersCsv,
  buildAuditCsv,
  countCsvDataRows,
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

/* ==========================================================================
 * Workspace users export (`GET /admin/users/export.csv`)
 * ========================================================================== */

function makeUser(overrides: Partial<AdminUserView> = {}): AdminUserView {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Bob',
    email: 'bob@acme.test',
    role: 'AGENT',
    isActive: true,
    lastLoginAt: '2026-11-05T10:00:00.000Z',
    createdAt: '2026-11-01T10:00:00.000Z',
    sessionsCount: 2,
    twoFactorEnabled: false,
    ...overrides,
  };
}

describe('buildAdminUsersCsv', () => {
  it('writes the stable header and CRLF-terminated records', () => {
    const csv = buildAdminUsersCsv([makeUser()]);

    expect(ADMIN_USERS_CSV_COLUMNS).toEqual([
      'name',
      'email',
      'role',
      'is_active',
      'last_login_at',
      'created_at',
      'sessions_count',
    ]);
    expect(csv).toBe(
      `${ADMIN_USERS_CSV_COLUMNS.join(',')}\r\n` +
        'Bob,bob@acme.test,AGENT,true,2026-11-05T10:00:00.000Z,2026-11-01T10:00:00.000Z,2\r\n',
    );
  });

  it('escapes hostile values and leaves last_login_at empty for a never-logged operator', () => {
    const csv = buildAdminUsersCsv([
      makeUser({
        name: 'Bob, "The Builder"',
        email: 'bob@acme.test',
        isActive: false,
        lastLoginAt: null,
        sessionsCount: 0,
      }),
    ]);

    expect(csv.split('\r\n')[1]).toBe(
      '"Bob, ""The Builder""",bob@acme.test,AGENT,false,,2026-11-01T10:00:00.000Z,0',
    );
  });

  it('returns only the header when there is nothing to export', () => {
    expect(buildAdminUsersCsv([])).toBe(`${ADMIN_USERS_CSV_COLUMNS.join(',')}\r\n`);
  });
});

describe('adminUsersCsvFileName', () => {
  it('formats the UTC day as usuarios-YYYY-MM-DD.csv', () => {
    expect(adminUsersCsvFileName(new Date('2026-11-06T23:59:59.000Z'))).toBe(
      'usuarios-2026-11-06.csv',
    );
    expect(adminUsersCsvFileName(new Date('2026-01-01T00:00:00.000Z'))).toBe(
      'usuarios-2026-01-01.csv',
    );
  });
});

/* ==========================================================================
 * Export audit row count (`rowCount` of the export event)
 * ========================================================================== */

describe('countCsvDataRows', () => {
  it('does not count the header', () => {
    expect(countCsvDataRows('name,email\r\n')).toBe(0);
    expect(countCsvDataRows(`${ADMIN_USERS_CSV_COLUMNS.join(',')}\r\n`)).toBe(0);
    expect(countCsvDataRows(buildAdminUsersCsv([]))).toBe(0);
    expect(countCsvDataRows(buildAuditCsv([]))).toBe(0);
  });

  it('counts every data record written by the builders', () => {
    expect(countCsvDataRows(buildAdminUsersCsv([makeUser()]))).toBe(1);
    expect(
      countCsvDataRows(
        buildAdminUsersCsv([makeUser(), makeUser({ email: 'ana@acme.test' })]),
      ),
    ).toBe(2);
    expect(countCsvDataRows(buildAuditCsv([makeRow()]))).toBe(1);
  });

  it('ignores blank lines and a trailing line break', () => {
    expect(countCsvDataRows('')).toBe(0);
    expect(countCsvDataRows('\r\n')).toBe(0);
    expect(countCsvDataRows('h1,h2\r\n\r\n')).toBe(0);
    expect(countCsvDataRows('h1,h2\r\n\r\na,b\r\n\r\nc,d\r\n\r\n')).toBe(2);
  });

  it('treats a quoted cell with CR/LF as ONE record (RFC 4180)', () => {
    expect(countCsvDataRows('h1,h2\r\n"a\r\nb",c\r\n')).toBe(1);
    expect(countCsvDataRows('h1,h2\r\n"a\nb",c\r\n"d\r\ne",f\r\n')).toBe(2);
  });

  it('does not mistake an escaped quote for the end of the cell', () => {
    expect(countCsvDataRows('h1,h2\r\n"a""b",c\r\n')).toBe(1);
    expect(countCsvDataRows('h1,h2\r\n"say ""hi""\r\nthere",c\r\n')).toBe(1);
  });

  it('counts a final record without a trailing line break', () => {
    expect(countCsvDataRows('h1,h2\r\n1,2')).toBe(1);
  });
});
