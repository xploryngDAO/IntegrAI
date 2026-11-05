import { afterEach, describe, expect, it } from 'vitest';
import type { DiagnosisCheck } from '@sac/shared';
import { MercadoLivreChannelAdapter } from '../MercadoLivreChannelAdapter';
import { createFakeDeps, jsonResponse, type FakeHttpHandler } from './fakeDeps';

const PROBE_ENV = 'MELI_DIAGNOSE_PROBE';

afterEach(() => {
  delete process.env[PROBE_ENV];
});

function checkById(checks: DiagnosisCheck[], id: string): DiagnosisCheck {
  const found = checks.find((check) => check.id === id);
  if (!found) throw new Error(`missing diagnosis check ${id}`);
  return found;
}

const happyHandler: FakeHttpHandler = (request) => {
  if (request.url.endsWith('/oauth/token')) {
    return jsonResponse({
      access_token: 'AT-1',
      refresh_token: 'RT2',
      expires_in: 21_600,
      token_type: 'Bearer',
    });
  }
  if (request.url.endsWith('/users/me')) {
    return jsonResponse({ id: 42, nickname: 'LOJA TESTE', site_id: 'MLB' });
  }
  if (request.url.endsWith('/users/42')) {
    return jsonResponse({
      id: 42,
      nickname: 'LOJA TESTE',
      site_id: 'MLB',
      status: { site_status: 'active' },
    });
  }
  if (request.url.includes('/items/search')) {
    return jsonResponse({ paging: { total: 1 }, results: [{ id: 'MLB1' }] });
  }
  throw new Error(`unexpected ${request.method} ${request.url}`);
};

describe('meli diagnose mapping (stubbed deps.http)', () => {
  it('maps config/token/identity as ok and items as skipped by default', async () => {
    const fake = createFakeDeps({ httpHandler: happyHandler });
    const adapter = new MercadoLivreChannelAdapter(fake.deps);

    const checks = await adapter.diagnose({ accountId: 'acc-1' });

    expect(checks.map((check) => check.id)).toEqual([
      'meli.config',
      'meli.token',
      'meli.identity',
      'meli.items',
    ]);
    expect(checks.map((check) => check.status)).toEqual(['ok', 'ok', 'ok', 'skipped']);

    const token = checkById(checks, 'meli.token');
    expect(token.latencyMs).toBeTypeOf('number');
    expect(token.detail).toContain('Bearer');
    expect(token.detail).toContain('expira em');

    const identity = checkById(checks, 'meli.identity');
    expect(identity.detail).toContain('seller_id=42');
    expect(identity.detail).toContain('site_id=MLB');
    expect(identity.detail).toContain('status=active');
    expect(identity.latencyMs).toBeTypeOf('number');

    expect(checkById(checks, 'meli.items').detail).toContain(PROBE_ENV);

    // Real read-only calls only: token exchange + GET /users/me + GET /users/42.
    expect(fake.httpCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://api.mercadolibre.com/oauth/token',
      'GET https://api.mercadolibre.com/users/me',
      'GET https://api.mercadolibre.com/users/42',
    ]);
  });

  it('runs the items probe when MELI_DIAGNOSE_PROBE=true', async () => {
    process.env[PROBE_ENV] = 'true';
    const fake = createFakeDeps({ httpHandler: happyHandler });
    const adapter = new MercadoLivreChannelAdapter(fake.deps);

    const checks = await adapter.diagnose({ accountId: 'acc-1' });

    const items = checkById(checks, 'meli.items');
    expect(items.status).toBe('ok');
    expect(items.detail).toContain('total=1');
    const probeCall = fake.httpCalls.find((call) => call.url.includes('/items/search'));
    expect(probeCall?.query).toMatchObject({ search_type: 'scan', limit: 1 });
  });

  it('maps invalid_grant to a fail check with reauthorize remediation and skips the rest', async () => {
    const fake = createFakeDeps({
      httpHandler: () =>
        jsonResponse({ message: 'invalid_grant', error: 'invalid_grant', status: 400 }, 400),
    });
    const adapter = new MercadoLivreChannelAdapter(fake.deps);

    const checks = await adapter.diagnose({ accountId: 'acc-1' });

    expect(checkById(checks, 'meli.config').status).toBe('ok');
    const token = checkById(checks, 'meli.token');
    expect(token.status).toBe('fail');
    expect(token.remediation).toContain('Reautorize a loja Mercado Livre em /accounts');
    expect(checkById(checks, 'meli.identity').status).toBe('skipped');
    expect(checkById(checks, 'meli.items').status).toBe('skipped');
    expect(fake.account.status).toBe('TOKEN_EXPIRED');
  });

  it('warns when the token authenticates a different seller than the connected account', async () => {
    const fake = createFakeDeps({
      httpHandler: (request) => {
        if (request.url.endsWith('/oauth/token')) {
          return jsonResponse({ access_token: 'AT-1', refresh_token: 'RT2', expires_in: 21_600 });
        }
        if (request.url.endsWith('/users/me')) {
          return jsonResponse({ id: 99, nickname: 'OUTRA LOJA', site_id: 'MLB' });
        }
        if (request.url.endsWith('/users/42')) {
          return jsonResponse({ id: 42, nickname: 'LOJA TESTE', site_id: 'MLB' });
        }
        throw new Error(`unexpected ${request.method} ${request.url}`);
      },
    });
    const adapter = new MercadoLivreChannelAdapter(fake.deps);

    const checks = await adapter.diagnose({ accountId: 'acc-1' });

    const identity = checkById(checks, 'meli.identity');
    expect(identity.status).toBe('warn');
    expect(identity.detail).toContain('token autentica usuário 99');
    expect(identity.remediation).toContain('/accounts');
  });

  it('maps a 403 items probe to a warning (scopes)', async () => {
    process.env[PROBE_ENV] = 'true';
    const fake = createFakeDeps({
      httpHandler: (request) => {
        if (request.url.endsWith('/oauth/token')) {
          return jsonResponse({ access_token: 'AT-1', refresh_token: 'RT2', expires_in: 21_600 });
        }
        if (request.url.endsWith('/users/me')) return jsonResponse({ id: 42 });
        if (request.url.endsWith('/users/42')) {
          return jsonResponse({ id: 42, site_id: 'MLB', status: { site_status: 'active' } });
        }
        if (request.url.includes('/items/search')) {
          return jsonResponse({ message: 'forbidden_error' }, 403);
        }
        throw new Error(`unexpected ${request.method} ${request.url}`);
      },
    });
    const adapter = new MercadoLivreChannelAdapter(fake.deps);

    const checks = await adapter.diagnose({ accountId: 'acc-1' });

    const items = checkById(checks, 'meli.items');
    expect(items.status).toBe('warn');
    expect(items.remediation).toContain('escopos');
  });

  it('fails the config check and skips network checks when the account is unknown', async () => {
    const fake = createFakeDeps({ accounts: [] });
    const adapter = new MercadoLivreChannelAdapter(fake.deps);

    const checks = await adapter.diagnose({ accountId: 'acc-1' });

    expect(checkById(checks, 'meli.config').status).toBe('fail');
    expect(checkById(checks, 'meli.token').status).toBe('skipped');
    expect(checkById(checks, 'meli.identity').status).toBe('skipped');
    expect(checkById(checks, 'meli.items').status).toBe('skipped');
    expect(fake.httpCalls).toHaveLength(0);
  });
});
