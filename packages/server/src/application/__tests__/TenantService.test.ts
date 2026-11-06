import { describe, expect, it, vi } from 'vitest';

import type {
  CreateTenantInput,
  IAuditService,
  IClock,
  ITenantRepository,
  TenantRecord,
  UpdateTenantInput,
} from '@sac/shared';
import { AUDIT_ACTIONS, NotFoundError, ValidationError } from '@sac/shared';

import { TenantService } from '../TenantService';
import { FrozenClock, silentLogger } from './accountFakes';

class InMemoryTenantRepository implements ITenantRepository {
  readonly rows: TenantRecord[] = [];
  private sequence = 0;

  constructor(private readonly clock: IClock) {}

  seed(input: { slug: string; name?: string; onboardingCompletedAt?: Date | null }): TenantRecord {
    const at = this.clock.now();
    const row: TenantRecord = {
      id: `tenant-${(this.sequence += 1)}`,
      slug: input.slug,
      name: input.name ?? input.slug,
      status: 'ACTIVE',
      plan: 'FREE',
      maxAccounts: 1,
      maxAgents: 3,
      billingStatus: 'TRIALING',
      trialEndsAt: null,
      billingEmail: null,
      onboardingCompletedAt: input.onboardingCompletedAt ?? null,
      require2fa: false,
      deletedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    this.rows.push(row);
    return row;
  }

  async create(input: CreateTenantInput): Promise<TenantRecord> {
    return this.seed(input);
  }

  async findBySlug(slug: string): Promise<TenantRecord | null> {
    return this.rows.find((row) => row.slug === slug) ?? null;
  }

  async findById(id: string): Promise<TenantRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async update(id: string, input: UpdateTenantInput): Promise<TenantRecord> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`Tenant not found: ${id}`);
    if (input.name !== undefined) row.name = input.name;
    if (input.onboardingCompletedAt !== undefined) {
      row.onboardingCompletedAt = input.onboardingCompletedAt;
    }
    if (input.require2fa !== undefined) row.require2fa = input.require2fa;
    row.updatedAt = this.clock.now();
    return row;
  }

  async delete(id: string): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

const NOW = new Date('2026-11-05T12:00:00.000Z');

function createHarness() {
  const clock = new FrozenClock(NOW);
  const tenants = new InMemoryTenantRepository(clock);
  const service = new TenantService({ logger: silentLogger, clock, repos: { tenants } });
  return { clock, tenants, service };
}

describe('TenantService.get', () => {
  it('returns the workspace projection (id, slug, name, onboardingCompletedAt)', async () => {
    const { tenants, service } = createHarness();
    const row = tenants.seed({
      slug: 'acme',
      name: 'Acme Ltda',
      onboardingCompletedAt: new Date('2026-11-05T10:00:00.000Z'),
    });

    await expect(service.get(row.id)).resolves.toEqual({
      id: row.id,
      slug: 'acme',
      name: 'Acme Ltda',
      onboardingCompletedAt: new Date('2026-11-05T10:00:00.000Z'),
      require2fa: false,
    });
  });

  it('returns 404 for an unknown workspace', async () => {
    const { service } = createHarness();

    const failure = await service.get('missing').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NotFoundError);
    expect(failure).toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });
});

describe('TenantService.update', () => {
  it('renames the workspace', async () => {
    const { tenants, service } = createHarness();
    const row = tenants.seed({ slug: 'acme', name: 'Old name' });

    const updated = await service.update(row.id, { name: '  Acme Omnichannel  ' });

    expect(updated.name).toBe('Acme Omnichannel');
    expect(updated.onboardingCompletedAt).toBeNull();
  });

  it('stamps onboardingCompletedAt exactly once and clears it on restart', async () => {
    const { clock, tenants, service } = createHarness();
    const row = tenants.seed({ slug: 'acme' });

    const completed = await service.update(row.id, { onboardingCompleted: true });
    expect(completed.onboardingCompletedAt).toEqual(NOW);

    // A wizard rerun must not move the historical completion timestamp.
    clock.set(new Date('2026-11-06T08:00:00.000Z'));
    const rerun = await service.update(row.id, { onboardingCompleted: true });
    expect(rerun.onboardingCompletedAt).toEqual(NOW);

    const restarted = await service.update(row.id, { onboardingCompleted: false });
    expect(restarted.onboardingCompletedAt).toBeNull();
  });

  it('applies name + onboardingCompleted in the same request', async () => {
    const { tenants, service } = createHarness();
    const row = tenants.seed({ slug: 'acme', name: 'Old' });

    const updated = await service.update(row.id, {
      name: 'New',
      onboardingCompleted: true,
    });

    expect(updated).toMatchObject({ name: 'New', onboardingCompletedAt: NOW });
  });

  it('rejects an empty command before touching the repository', async () => {
    const { tenants, service } = createHarness();
    const row = tenants.seed({ slug: 'acme', name: 'Old' });

    await expect(service.update(row.id, {})).rejects.toBeInstanceOf(ValidationError);
    expect(tenants.rows[0]?.name).toBe('Old');
  });

  it('rejects a blank or oversized name', async () => {
    const { tenants, service } = createHarness();
    const row = tenants.seed({ slug: 'acme' });

    for (const name of ['   ', 'x'.repeat(161)]) {
      await expect(service.update(row.id, { name })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        httpStatus: 422,
      });
    }
  });

  it('only updates the caller tenant', async () => {
    const { tenants, service } = createHarness();
    const tenantA = tenants.seed({ slug: 'tenant-a', name: 'A' });
    const tenantB = tenants.seed({ slug: 'tenant-b', name: 'B' });

    await service.update(tenantA.id, { name: 'A renamed', onboardingCompleted: true });

    expect(tenants.rows.find((row) => row.id === tenantB.id)).toMatchObject({
      name: 'B',
      onboardingCompletedAt: null,
    });
    expect(tenants.rows.find((row) => row.id === tenantA.id)).toMatchObject({
      name: 'A renamed',
      onboardingCompletedAt: NOW,
    });
  });

  it('returns 404 instead of creating a workspace for an unknown id', async () => {
    const { service } = createHarness();

    await expect(service.update('missing', { name: 'X' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('flips the 2FA policy and audits before/after with the acting ADMIN', async () => {
    const { clock, tenants } = createHarness();
    const row = tenants.seed({ slug: 'acme' });
    const record = vi.fn();
    const service = new TenantService({
      logger: silentLogger,
      clock,
      audit: { record } as unknown as IAuditService,
      repos: { tenants },
    });

    const updated = await service.update(
      row.id,
      { require2fa: true },
      {
        id: 'agent-1',
        email: 'admin@acme.test',
        tenantId: row.id,
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (test)',
      },
    );

    expect(updated.require2fa).toBe(true);
    expect(tenants.rows[0]?.require2fa).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTIONS.tenant2faPolicyChanged,
        tenantId: row.id,
        actorId: 'agent-1',
        actorEmail: 'admin@acme.test',
        resourceType: 'tenant',
        resourceId: row.id,
        ip: '203.0.113.7',
        metadata: { field: 'require2fa', before: false, after: true },
      }),
    );
  });

  it('does not audit when the policy value is unchanged', async () => {
    const { clock, tenants } = createHarness();
    const row = tenants.seed({ slug: 'acme' });
    const record = vi.fn();
    const service = new TenantService({
      logger: silentLogger,
      clock,
      audit: { record } as unknown as IAuditService,
      repos: { tenants },
    });

    await service.update(row.id, { require2fa: false }, { id: 'agent-1' });
    expect(record).not.toHaveBeenCalled();
  });

  it('applies name + require2fa in the same request', async () => {
    const { tenants, service } = createHarness();
    const row = tenants.seed({ slug: 'acme', name: 'Old' });

    const updated = await service.update(row.id, { name: 'New', require2fa: true });

    expect(updated).toMatchObject({ name: 'New', require2fa: true });
  });
});
