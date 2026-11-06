/**
 * Convite de operador pela UI publicada: ADMIN convida em /admin → e-mail real
 * → /invite?token=… → aceite → login do AGENT. Cria um workspace temporário e
 * remove tudo no fim (soft delete + purge).
 *
 * Uso: node scripts/live-invite-ui-test.mjs [webBase] [apiBase] [...admin creds]
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const WEB = (process.argv[2] ?? 'https://integrai-dev.vercel.app').replace(/\/$/, '');
const API = (process.argv[3] ?? 'https://growth-voters-independent-rca.trycloudflare.com').replace(/\/$/, '');
const PLATFORM_EMAIL = process.argv[4] ?? 'admin@integr-ai.local';
const PLATFORM_PASSWORD = process.argv[5] ?? 'IntegrAI-Prod-2026!';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://192.168.15.17:8025';

const BROWSERS = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
const executablePath = BROWSERS.find((candidate) => existsSync(candidate));
if (!executablePath) throw new Error('navegador não encontrado (defina BROWSER_PATH)');

const tag = randomUUID().slice(0, 8);
const adminEmail = `invite-admin-${tag}@integrai.test`;
const agentEmail = `invite-agent-${tag}@integrai.test`;
const password = 'Teste-UI-2026!x9';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? (passed += 1) : (failed += 1);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

async function mailLink(pattern, recipient) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=250`)).json();
      for (const message of list.messages ?? []) {
        const to = (message.To ?? []).map((entry) => (entry.Address ?? '').toLowerCase());
        if (!to.includes(recipient.toLowerCase())) continue;
        const detail = await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json();
        const match = `${detail.Text ?? ''}\n${detail.HTML ?? ''}`.match(pattern);
        if (match) return match[1];
      }
    } catch {
      /* retry */
    }
    await sleep(1000);
  }
  throw new Error(`e-mail para ${recipient} não encontrado`);
}

async function main() {
  // 1) Temporary workspace (API): signup → verify → login.
  const signup = await api('/api/v1/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ companyName: `Convite UI ${tag}`, name: 'Admin Convite', email: adminEmail, password }),
  });
  check('workspace temporário criado', signup.status === 201, `HTTP ${signup.status}`);
  const verifyToken = await mailLink(/verify-email\?token=([A-Za-z0-9%._-]+)/, adminEmail);
  await api('/api/v1/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: verifyToken }) });
  const adminLogin = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: adminEmail, password }) });
  const adminToken = adminLogin.body?.data?.token;
  check('login do admin temporário', typeof adminToken === 'string');
  const me = await api('/api/v1/tenants/me', { headers: { authorization: `Bearer ${adminToken}` } });
  const slug = me.body?.data?.slug;
  const tenantId = me.body?.data?.id;
  check('workspace temporário identificado', typeof slug === 'string' && typeof tenantId === 'string', slug);

  // 2) UI: ADMIN convida o operador.
  const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.type('input[type="email"]', adminEmail);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await sleep(7000);
  await page.goto(`${WEB}/admin`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(5000);
  const openedDialog = await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find((candidate) => /Convidar/i.test(candidate.textContent ?? ''));
    if (button) {
      button.click();
      return true;
    }
    return false;
  });
  await sleep(1500);
  check('diálogo de convite abre em /admin', openedDialog);
  await page.type('input[placeholder="nome@suaempresa.com.br"]', agentEmail);
  const clicked = await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find((candidate) => /Enviar convite/i.test(candidate.textContent ?? ''));
    if (button) {
      button.click();
      return true;
    }
    return false;
  });
  await sleep(5000);
  const dialogGone = await page.evaluate(() => !/Convidar operador/i.test(document.body.innerText) || !document.querySelector('input[placeholder="nome@suaempresa.com.br"]'));
  check('convite enviado pela UI', clicked && dialogGone);

  // 3) E-mail real → página de aceite → login do AGENT.
  const inviteUrl = await mailLink(/(https:\/\/[^\s"'<>]+\/invite\?token=[A-Za-z0-9%._-]+)/, agentEmail);
  check('link do convite no deploy público', inviteUrl.startsWith(`${WEB}/invite?token=`));
  await page.goto(inviteUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(2000);
  await page.type('input[placeholder="Nome e sobrenome"]', 'Agente UI');
  const passwordInputs = await page.$$('input[type="password"]');
  await passwordInputs[0].type(password);
  await passwordInputs[1].type(password);
  await page.click('button[type="submit"]');
  await sleep(8000);
  const agentSession = await page.evaluate(() => ({ token: window.localStorage.getItem('sac.auth.token'), url: window.location.href }));
  check('aceite do convite e sessão do AGENT', typeof agentSession.token === 'string' && agentSession.token.length > 100, agentSession.url);
  const agentMe = await page.evaluate(async (api, token) => {
    const response = await fetch(`${api}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    return response.ok ? (await response.json()).data : null;
  }, API, agentSession.token);
  check('papel do convidado = AGENT', agentMe?.role === 'AGENT', agentMe?.role);
  check('sem erros de runtime no console', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  await browser.close();

  // 4) Cleanup (soft delete + purge).
  const removed = await api('/api/v1/tenants/me', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ password, confirmSlug: slug }),
  });
  check('soft delete do workspace temporário', removed.status === 202 || removed.status === 200, `HTTP ${removed.status}`);
  const platform = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: PLATFORM_EMAIL, password: PLATFORM_PASSWORD }),
  });
  const purge = await api(`/api/v1/platform/tenants/${tenantId}/purge`, {
    method: 'POST',
    headers: { authorization: `Bearer ${platform.body?.data?.token}` },
  });
  check('purge do workspace temporário', purge.status === 200 || purge.status === 202, `HTTP ${purge.status}`);

  console.log(`\n${passed}/${passed + failed} verificações passaram.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\nFalha:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
