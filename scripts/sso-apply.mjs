/**
 * Aplica a configuração de SSO corporativo no workspace a partir do
 * `.entra-app.json` gerado por `scripts/entra-provision.mjs` (ou de args).
 *
 * Uso:
 *   node scripts/sso-apply.mjs [--api=<url>] [--email=admin] [--password=...]
 *                              [--domains=empresa.com,empresa.com.br]
 *                              [--enforce] [--test-only] [--file=.entra-app.json]
 *
 * Requer um ADMIN do workspace. Salva a conexão (`PUT /tenants/me/sso`) e roda
 * `POST /tenants/me/sso/test`, imprimindo os checks. Nenhum segredo é exibido.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.join('=')];
  }),
);

const API = (args.get('api') ?? process.env.API_BASE_URL ?? 'https://growth-voters-independent-rca.trycloudflare.com').replace(/\/+$/, '');
const EMAIL = args.get('email') ?? process.env.ADMIN_EMAIL ?? 'admin@integr-ai.local';
const PASSWORD = args.get('password') ?? process.env.ADMIN_PASSWORD ?? 'IntegrAI-Prod-2026!';
const FILE = args.get('file') ?? '.entra-app.json';
const DOMAINS = (args.get('domains') ?? '')
  .split(',')
  .map((domain) => domain.trim())
  .filter((domain) => domain.length > 0);

function readApp() {
  if (args.has('test-only')) return null;
  let raw;
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch {
    console.error(`Não encontrei ${FILE}. Rode primeiro: node scripts/entra-provision.mjs --redirect=<api>/api/v1/auth/sso/callback`);
    process.exit(2);
  }
  const app = JSON.parse(raw);
  for (const field of ['issuer', 'clientId', 'clientSecret', 'redirectUri']) {
    if (typeof app[field] !== 'string' || app[field].length === 0) {
      console.error(`${FILE} sem o campo obrigatório "${field}".`);
      process.exit(2);
    }
  }
  return app;
}

async function call(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

async function main() {
  const login = await call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const token = login.body?.data?.token;
  if (login.status !== 200 || typeof token !== 'string') {
    console.error(`Login falhou (HTTP ${login.status}). Confira --email/--password e se a conta é ADMIN.`);
    process.exitCode = 1;
    return;
  }
  const auth = { authorization: `Bearer ${token}` };
  const app = readApp();

  if (app !== null) {
    const body = {
      provider: 'MICROSOFT',
      issuerUrl: app.issuer,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      redirectUri: app.redirectUri,
      autoProvision: true,
      enabled: true,
      ...(DOMAINS.length > 0 ? { allowedDomains: DOMAINS } : {}),
      ...(args.has('enforce') ? { enforceSso: true } : {}),
    };
    const saved = await call('/api/v1/tenants/me/sso', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify(body),
    });
    if (saved.status !== 200) {
      console.error(`PUT /tenants/me/sso falhou (HTTP ${saved.status}):`, JSON.stringify(saved.body?.error ?? saved.body));
      process.exitCode = 1;
      return;
    }
    console.log(`[ok] conexão SSO salva: ${app.issuer} · client ${app.clientId}`);
    console.log(`[ok] redirect: ${app.redirectUri}${DOMAINS.length > 0 ? ` · domínios: ${DOMAINS.join(', ')}` : ''}`);
  }

  const tested = await call('/api/v1/tenants/me/sso/test', {
    method: 'POST',
    headers: auth,
    body: '{}',
  });
  const checks = tested.body?.data?.checks ?? [];
  const failed = checks.filter((check) => check.ok === false);
  const healthy = tested.status === 200 && checks.length > 0 && failed.length === 0;
  console.log(`\n${healthy ? '[ok]' : '[falha]'} test-connection HTTP ${tested.status} · ${checks.length} checks, ${failed.length} falha(s)`);
  for (const check of checks) {
    console.log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.id ?? check.name}${check.detail ? ` — ${String(check.detail).slice(0, 120)}` : ''}`);
  }
  if (!healthy) {
    console.log('\nA conexão não está saudável: salve a configuração em /settings → Autenticação corporativa (ou rode este script sem --test-only) e corrija os itens acima.');
    process.exitCode = 1;
    return;
  }
  console.log('\nSSO pronto. Teste o login real em /login → "Entrar com Microsoft".');
}

main().catch((error) => {
  console.error('Falha:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
