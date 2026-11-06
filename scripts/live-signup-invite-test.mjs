/**
 * Fluxo público completo: signup → verificação de e-mail → convite → aceite,
 * com limpeza total (soft delete + purge via platform admin).
 *
 * Uso:
 *   node scripts/live-signup-invite-test.mjs [apiBase] [platformEmail] [platformPassword]
 */
import { randomUUID } from 'node:crypto';

const API = (process.argv[2] ?? 'https://growth-voters-independent-rca.trycloudflare.com').replace(/\/$/, '');
const PLATFORM_EMAIL = process.argv[3] ?? 'admin@integr-ai.local';
const PLATFORM_PASSWORD = process.argv[4] ?? 'IntegrAI-Prod-2026!';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://192.168.15.17:8025';

const tag = randomUUID().slice(0, 8);
const adminEmail = `signup-${tag}@integrai.test`;
const agentEmail = `agent-${tag}@integrai.test`;
const password = 'Teste-Fluxo-2026!x';
const company = `Teste Fluxo ${tag}`;

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function mailToken(pattern, recipient) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=50`)).json();
      const messages = Array.isArray(list.messages) ? list.messages : [];
      for (const message of messages) {
        const to = (message.To ?? []).map((entry) => (entry.Address ?? '').toLowerCase());
        if (!to.includes(recipient.toLowerCase())) continue;
        const detail = await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json();
        const haystack = `${detail.Text ?? ''}\n${detail.HTML ?? ''}`;
        const match = haystack.match(pattern);
        if (match) return decodeURIComponent(match[1]);
      }
    } catch {
      /* Mailpit still warming up; retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`e-mail para ${recipient} não encontrado (Mailpit ${MAILPIT})`);
}

async function main() {
  const signup = await request('/api/v1/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ companyName: company, name: 'Admin Teste', email: adminEmail, password }),
  });
  check('signup 201', signup.status === 201, `HTTP ${signup.status}`);
  const tenantId = signup.body?.data?.tenantId;
  check('signup devolve tenant', typeof tenantId === 'string' && tenantId.length > 0);

  const verifyToken = await mailToken(/verify-email\?token=([^"'&\s<>]+)/, adminEmail);
  check('e-mail de verificação entregue', verifyToken.length > 20);
  const verify = await request('/api/v1/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token: verifyToken }),
  });
  check('verify-email 200', verify.status === 200, `HTTP ${verify.status}`);

  const adminLogin = await request('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: adminEmail, password }),
  });
  check('login do novo ADMIN', adminLogin.status === 200 && typeof adminLogin.body?.data?.token === 'string');
  const adminToken = adminLogin.body?.data?.token;
  const auth = { Authorization: `Bearer ${adminToken}` };

  const me = await request('/api/v1/tenants/me', { headers: auth });
  check('GET /tenants/me do novo workspace', me.status === 200 && me.body?.data?.slug?.length > 0);
  const slug = me.body?.data?.slug;

  const invite = await request('/api/v1/invitations', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ email: agentEmail, role: 'AGENT' }),
  });
  check('convite criado', invite.status === 201 || invite.status === 200, `HTTP ${invite.status}`);

  const inviteToken = await mailToken(/invite\?token=([^"'&\s<>]+)/, agentEmail);
  check('e-mail de convite entregue', inviteToken.length > 20);
  const accept = await request('/api/v1/auth/accept-invitation', {
    method: 'POST',
    body: JSON.stringify({ token: inviteToken, name: 'Agente Teste', password }),
  });
  check('aceite do convite', accept.status === 201 || accept.status === 200, `HTTP ${accept.status}`);

  const agentLogin = await request('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: agentEmail, password }),
  });
  const agentToken = agentLogin.body?.data?.token;
  check('login do convidado', agentLogin.status === 200 && typeof agentToken === 'string');
  const agentMe = await request('/api/v1/auth/me', { headers: { Authorization: `Bearer ${agentToken}` } });
  check('papel do convidado = AGENT', agentMe.body?.data?.role === 'AGENT', agentMe.body?.data?.role);
  const agentTenant = await request('/api/v1/tenants/me', { headers: { Authorization: `Bearer ${agentToken}` } });
  check('convidado no mesmo workspace', agentTenant.body?.data?.slug === slug, agentTenant.body?.data?.slug);

  const removed = await request('/api/v1/tenants/me', {
    method: 'DELETE',
    headers: auth,
    body: JSON.stringify({ password, confirmSlug: slug }),
  });
  check('soft delete do workspace', removed.status === 202 || removed.status === 200, `HTTP ${removed.status}`);

  const platformLogin = await request('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: PLATFORM_EMAIL, password: PLATFORM_PASSWORD }),
  });
  const platformToken = platformLogin.body?.data?.token;
  if (typeof platformToken === 'string') {
    const purge = await request(`/api/v1/platform/tenants/${tenantId}/purge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${platformToken}` },
    });
    check('purge do workspace de teste', purge.status === 200 || purge.status === 202, `HTTP ${purge.status}`);
  } else {
    check('login do platform admin', false, 'sem token');
  }

  console.log(`\n${passed}/${passed + failed} verificações passaram.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\nFalha:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
