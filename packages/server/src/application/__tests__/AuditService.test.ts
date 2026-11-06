import { describe, expect, it } from 'vitest';
import type { ILogger } from '@sac/shared';

import { AuditService } from '../AuditService';
import { InMemoryAuditEventRepository } from './adminFakes';

/**
 * AuditService contract:
 *  - writes are best effort (never throw, never block, logged and swallowed);
 *  - metadata is scrubbed before it reaches the store;
 *  - reads are tenant-scoped, filtered and paginated (perPage capped at 100).
 */

const silentLogger: ILogger = {
  child(): ILogger {
    return this;
  },
  trace(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

const T0 = new Date('2026-11-06T12:00:00.000Z');

function build() {
  const clock = { now: () => new Date(T0.getTime()) };
  const repo = new InMemoryAuditEventRepository(clock);
  const service = new AuditService({ logger: silentLogger, clock, repo });
  return { clock, repo, service };
}

describe('AuditService.record (best effort)', () => {
  it('never throws when the store rejects and flush still resolves', async () => {
    const { repo, service } = build();
    repo.failNextCreate = true;

    expect(() =>
      service.record({ action: 'auth.login.success', tenantId: 'tenant-1' }),
    ).not.toThrow();

    await expect(service.flush()).resolves.toBeUndefined();
    expect(repo.rows).toHaveLength(0);
  });

  it('writes in the background and flush waits for the queued insert', async () => {
    const { repo, service } = build();

    service.record({
      action: 'auth.logout',
      tenantId: 'tenant-1',
      actorId: 'agent-1',
      actorEmail: 'ana@acme.test',
    });

    // The fake repository yields before persisting: `record` did not block.
    expect(repo.rows).toHaveLength(0);

    await service.flush();
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({
      action: 'auth.logout',
      tenantId: 'tenant-1',
      actorId: 'agent-1',
      actorEmail: 'ana@acme.test',
    });
  });

  it('scrubs password/token/secret keys and redacts PII in metadata', async () => {
    const { repo, service } = build();

    service.record({
      action: 'admin.user.role_changed',
      tenantId: 'tenant-1',
      metadata: {
        password: 'correct-horse-battery',
        refreshToken: 'secret-refresh',
        secret: 'totp-secret',
        nested: {
          role: 'ADMIN',
          contact: 'ana@acme.test',
          recoveryCode: 'XXXX-XXXX',
        },
        tags: ['ADMIN', 'safe@acme.test'],
        count: 2,
      },
    });

    await service.flush();
    const metadata = repo.rows[0]?.metadata as Record<string, unknown>;

    expect(metadata).not.toHaveProperty('password');
    expect(metadata).not.toHaveProperty('refreshToken');
    expect(metadata).not.toHaveProperty('secret');
    expect(metadata.count).toBe(2);
    expect(metadata.tags).toEqual(['ADMIN', 'sa***@acme.test']);
    expect(metadata.nested).toMatchObject({
      role: 'ADMIN',
      contact: 'an***@acme.test',
    });
    expect(metadata.nested).not.toHaveProperty('recoveryCode');
  });

  it('records the full actor e-mail on its own column (contract)', async () => {
    const { repo, service } = build();

    service.record({
      action: 'auth.login.failure',
      actorEmail: 'someone@acme.test',
      metadata: { reason: 'invalid_password' },
    });
    await service.flush();

    expect(repo.rows[0]?.actorEmail).toBe('someone@acme.test');
    expect(repo.rows[0]?.metadata).toEqual({ reason: 'invalid_password' });
  });
});

describe('AuditService.list (tenant scope, filters, pagination)', () => {
  function seedRows() {
    const { repo, service, clock } = build();
    for (let index = 0; index < 5; index += 1) {
      repo.seed({
        id: `audit-${index}`,
        tenantId: 'tenant-1',
        action: index % 2 === 0 ? 'auth.login.success' : 'auth.login.failure',
        actorId: index < 3 ? 'agent-1' : 'agent-2',
        createdAt: new Date(T0.getTime() + index * 60_000),
      });
    }
    repo.seed({
      id: 'other-tenant',
      tenantId: 'tenant-2',
      action: 'auth.login.success',
      createdAt: new Date(T0.getTime()),
    });
    return { repo, service, clock };
  }

  it('returns only the caller tenant and paginates newest first', async () => {
    const { service } = seedRows();

    const page = await service.list('tenant-1', { page: 1, perPage: 2 });

    expect(page.total).toBe(5);
    expect(page.perPage).toBe(2);
    expect(page.page).toBe(1);
    expect(page.items.map((entry) => entry.id)).toEqual(['audit-4', 'audit-3']);
    expect(page.items.every((entry) => entry.tenantId === 'tenant-1')).toBe(true);
    expect(page.items[0]?.createdAt).toBe(
      new Date(T0.getTime() + 4 * 60_000).toISOString(),
    );
  });

  it('filters by action and actorId', async () => {
    const { service } = seedRows();

    const failures = await service.list('tenant-1', { action: 'auth.login.failure' });
    expect(failures.items.map((entry) => entry.id)).toEqual(['audit-3', 'audit-1']);

    const secondAgent = await service.list('tenant-1', { actorId: 'agent-2' });
    expect(secondAgent.items.map((entry) => entry.id)).toEqual(['audit-4', 'audit-3']);
  });

  it('applies the from/to window inclusively', async () => {
    const { service } = seedRows();

    const window = await service.list('tenant-1', {
      from: new Date(T0.getTime() + 60_000),
      to: new Date(T0.getTime() + 2 * 60_000),
    });

    expect(window.items.map((entry) => entry.id)).toEqual(['audit-2', 'audit-1']);
  });

  it('caps perPage at 100 defensively', async () => {
    const { service } = seedRows();

    const page = await service.list('tenant-1', { perPage: 500 });
    expect(page.perPage).toBe(100);
  });

  it('rejects an inverted date window with 422 VALIDATION_ERROR', async () => {
    const { service } = seedRows();

    await expect(
      service.list('tenant-1', {
        from: new Date(T0.getTime() + 60_000),
        to: new Date(T0.getTime()),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
  });
});

describe('AuditService.exportRows (CSV snapshot)', () => {
  function seedRows() {
    const { repo, service } = build();
    for (let index = 0; index < 3; index += 1) {
      repo.seed({
        id: `audit-${index}`,
        tenantId: 'tenant-1',
        action: index === 2 ? 'auth.login.failure' : 'auth.login.success',
        createdAt: new Date(T0.getTime() + index * 60_000),
      });
    }
    repo.seed({
      id: 'other-tenant',
      tenantId: 'tenant-2',
      action: 'auth.login.success',
      createdAt: new Date(T0.getTime() + 10 * 60_000),
    });
    return { repo, service };
  }

  it('applies the same tenant scope/filters, newest first, capped at 10k', async () => {
    const { repo, service } = seedRows();

    const rows = await service.exportRows('tenant-1', {
      action: 'auth.login.success',
    });

    expect(rows.map((entry) => entry.id)).toEqual(['audit-1', 'audit-0']);
    expect(rows.every((entry) => entry.tenantId === 'tenant-1')).toBe(true);
    expect(repo.lastFilter).toMatchObject({
      tenantId: 'tenant-1',
      offset: 0,
      limit: 10_000,
      action: 'auth.login.success',
    });
    expect(rows[0]?.createdAt).toBe(
      new Date(T0.getTime() + 60_000).toISOString(),
    );
  });

  it('honors a smaller limit and clamps a larger one to the hard cap', async () => {
    const { repo, service } = seedRows();

    await service.exportRows('tenant-1', {}, 2);
    expect(repo.lastFilter?.limit).toBe(2);

    await service.exportRows('tenant-1', {}, 50_000);
    expect(repo.lastFilter?.limit).toBe(10_000);
  });

  it('rejects an inverted date window with 422 VALIDATION_ERROR', async () => {
    const { service } = seedRows();

    await expect(
      service.exportRows('tenant-1', {
        from: new Date(T0.getTime() + 60_000),
        to: new Date(T0.getTime()),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 422 });
  });
});
