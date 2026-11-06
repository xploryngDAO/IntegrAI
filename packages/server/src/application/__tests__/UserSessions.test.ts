import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import type { ILogger, IssuedSession } from '@sac/shared';

import { AuthSessionService } from '../AuthSessionService';
import { InMemorySessionRepository } from './authFakes';
import { StubAgentRepository } from './platformFakes';

/**
 * Self-service session management (`/auth/sessions`):
 *  - `listForUser` marks the current device from the access-token `sid` claim;
 *  - a rotation updates `lastUsedAt` and mints a token bound to the new session;
 *  - `revokeById` is scoped to the owner (a foreign id is a 404);
 *  - `revokeOthers` keeps the current session and revokes every other one.
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

const JWT_SECRET = 'unit-test-secret-with-32-characters!!';
const T0 = new Date('2026-11-06T12:00:00.000Z');

function build() {
  let current = new Date(T0.getTime());
  const clock = { now: () => new Date(current.getTime()) };
  const advance = (ms: number): void => {
    current = new Date(current.getTime() + ms);
  };
  const agents = new StubAgentRepository();
  const sessions = new InMemorySessionRepository(clock);
  const service = new AuthSessionService({
    logger: silentLogger,
    clock,
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '1h',
    repos: { agents, sessions },
  });
  return { clock, advance, agents, sessions, service };
}

function seedAgent(agents: StubAgentRepository, id: string): void {
  agents.seed({
    id,
    tenantId: 'tenant-1',
    email: `${id}@acme.test`,
    role: 'ADMIN',
    isActive: true,
  });
}

describe('AuthSessionService.listForUser', () => {
  it('lists live sessions newest first and marks the current one', async () => {
    const { service, agents, advance } = build();
    seedAgent(agents, 'agent-1');

    const first = await service.issue('agent-1', { userAgent: 'Chrome', ip: '203.0.113.7' });
    advance(1_000);
    const second = await service.issue('agent-1', { userAgent: 'Firefox', ip: '203.0.113.8' });

    const items = await service.listForUser('agent-1', second.sessionId);

    expect(items).toHaveLength(2);
    expect(items.map((entry) => entry.userAgent)).toEqual(['Firefox', 'Chrome']);
    expect(items[0]).toMatchObject({
      id: second.sessionId,
      userAgent: 'Firefox',
      ip: '203.0.113.8',
      current: true,
      lastUsedAt: null,
    });
    expect(items[1]).toMatchObject({ id: first.sessionId, current: false });
    expect(items[0]?.createdAt).toBe(new Date(T0.getTime() + 1_000).toISOString());
  });

  it('never lists sessions of another operator', async () => {
    const { service, agents } = build();
    seedAgent(agents, 'agent-1');
    seedAgent(agents, 'agent-2');

    await service.issue('agent-1');
    await service.issue('agent-2');

    const items = await service.listForUser('agent-1', undefined);
    expect(items).toHaveLength(1);
  });

  it('marks no row as current for a legacy token without sid', async () => {
    const { service, agents } = build();
    seedAgent(agents, 'agent-1');
    await service.issue('agent-1');

    const items = await service.listForUser('agent-1');
    expect(items.every((entry) => entry.current === false)).toBe(true);
  });
});

describe('AuthSessionService.rotate', () => {
  it('burns the presented session, records lastUsedAt and binds the new token', async () => {
    const { service, agents, sessions, advance } = build();
    seedAgent(agents, 'agent-1');

    const first = await service.issue('agent-1');
    advance(2_000);

    const rotated = await service.rotate(first.refreshToken);
    const decoded = jwt.verify(rotated.token, JWT_SECRET) as { sid?: string };

    expect(decoded.sid).toBeDefined();
    expect(decoded.sid).not.toBe(first.sessionId);
    expect(rotated.refreshToken).not.toBe(first.refreshToken);

    const old = sessions.rows.find((row) => row.id === first.sessionId);
    expect(old?.revokedAt).not.toBeNull();

    const active = await service.listForUser('agent-1', decoded.sid);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      id: decoded.sid,
      current: true,
      lastUsedAt: new Date(T0.getTime() + 2_000).toISOString(),
    });
  });
});

describe('AuthSessionService.revokeById', () => {
  it('revokes an own session and reports whether it was the current one', async () => {
    const { service, agents, sessions } = build();
    seedAgent(agents, 'agent-1');
    const issued = await service.issue('agent-1');

    const result = await service.revokeById(issued.sessionId!, 'agent-1', issued.sessionId);

    expect(result).toEqual({ revoked: true, current: true });
    expect(sessions.rows[0]?.revokedAt).not.toBeNull();
  });

  it('is idempotent for an already revoked own session', async () => {
    const { service, agents } = build();
    seedAgent(agents, 'agent-1');
    const issued = await service.issue('agent-1');
    await service.revokeById(issued.sessionId!, 'agent-1');

    await expect(
      service.revokeById(issued.sessionId!, 'agent-1'),
    ).resolves.toEqual({ revoked: false, current: false });
  });

  it('answers 404 for a session of another operator', async () => {
    const { service, agents } = build();
    seedAgent(agents, 'agent-1');
    seedAgent(agents, 'agent-2');
    const foreign = await service.issue('agent-2');

    await expect(
      service.revokeById(foreign.sessionId!, 'agent-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });

  it('answers 404 for an unknown id', async () => {
    const { service, agents } = build();
    seedAgent(agents, 'agent-1');

    await expect(service.revokeById('missing', 'agent-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
  });
});

describe('AuthSessionService.revokeOthers', () => {
  it('revokes every session except the current one', async () => {
    const { service, agents } = build();
    seedAgent(agents, 'agent-1');

    const current: IssuedSession = await service.issue('agent-1');
    await service.issue('agent-1', { userAgent: 'Other device' });
    await service.issue('agent-1', { userAgent: 'Third device' });

    const revoked = await service.revokeOthers('agent-1', current.sessionId);

    expect(revoked).toBe(2);
    const active = await service.listForUser('agent-1', current.sessionId);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ id: current.sessionId, current: true });
  });
});
