/**
 * E2E real do SSO OIDC contra o stub local (`scripts/oidc-stub.mjs`).
 * Configura SSO no tenant integrai, percorre discover → start → authorize →
 * callback → exchange, valida a sessão e limpa tudo.
 *
 * Uso: node scripts/live-sso-test.mjs [apiBase] [oidcStubBase]
 */
import { PrismaClient } from '@prisma/client';

const API = (process.argv[2] ?? 'https://growth-voters-independent-rca.trycloudflare.com').replace(/\/$/, '');
const IDP = (process.argv[3] ?? 'http://127.0.0.1:4310').replace(/\/$/, '');
const EMAIL = 'sso-live@integrai.test';
const prisma = new PrismaClient();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const call = async (path, options = {}) => {
  const response = await fetch(`${API}${path}`, {
    redirect: 'manual',
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, location: response.headers.get('location'), body };
};

async function main() {
  const login = await call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@integr-ai.local', password: 'IntegrAI-Prod-2026!' }),
  });
  const token = login.body?.data?.token;
  check('login platform admin', login.status === 200 && Boolean(token), `status ${login.status}`);
  if (!token) throw new Error('sem token admin');
  const headers = { authorization: `Bearer ${token}` };

  const saved = await call('/api/v1/tenants/me/sso', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      provider: 'MICROSOFT',
      issuerUrl: IDP,
      clientId: 'stub-client',
      clientSecret: 'stub-secret',
      allowedDomains: ['integrai.test'],
      autoProvision: true,
      defaultRole: 'AGENT',
      enabled: true,
      enforceSso: false,
    }),
  });
  check('configura SSO do tenant', saved.status === 200, `status ${saved.status}`);

  const discover = await call(`/api/v1/auth/sso/discover?email=${encodeURIComponent(EMAIL)}`);
  check('discover reconhece o domínio', discover.status === 200 && discover.body?.data?.enabled === true);

  const start = await call(`/api/v1/auth/sso/start?email=${encodeURIComponent(EMAIL)}`);
  const authorizeUrl = start.location;
  check('start redireciona ao IdP', start.status === 302 && Boolean(authorizeUrl), `status ${start.status}`);

  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  const callbackUrl = authorize.headers.get('location');
  check('authorize redireciona ao callback', authorize.status === 302 && Boolean(callbackUrl));

  const callback = await fetch(callbackUrl, { redirect: 'manual' });
  const spaRedirect = callback.headers.get('location') ?? '';
  const code = /[?&]code=([A-Za-z0-9_-]{16,})/.exec(spaRedirect)?.[1];
  check('callback emite código one-time', callback.status === 302 && Boolean(code), `status ${callback.status}`);

  const exchange = await call('/api/v1/auth/sso/exchange', { method: 'POST', body: JSON.stringify({ code }) });
  const session = exchange.body?.data;
  check(
    'exchange autentica e cria usuário JIT',
    exchange.status === 200 && Boolean(session?.token) && session?.agent?.email === EMAIL,
    `status ${exchange.status}, role ${session?.agent?.role}`,
  );

  const replay = await call('/api/v1/auth/sso/exchange', { method: 'POST', body: JSON.stringify({ code }) });
  check('replay do código é rejeitado', replay.status === 401, `status ${replay.status}`);

  const tenant = await prisma.tenant.findFirst({ where: { slug: 'integrai' } });
  const ssoUser = await prisma.agent.findFirst({ where: { email: EMAIL } });
  check('usuário JIT no tenant correto', Boolean(tenant) && ssoUser?.tenantId === tenant?.id);

  await call('/api/v1/tenants/me/sso', { method: 'DELETE', headers });
  if (tenant) {
    await prisma.session.deleteMany({ where: { userId: ssoUser?.id ?? '' } }).catch(() => undefined);
    await prisma.agent.deleteMany({ where: { email: EMAIL } }).catch(() => undefined);
  }
  const leftover = await prisma.agent.count({ where: { email: EMAIL } });
  check('cleanup', leftover === 0);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificações passaram.`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('Falha:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
