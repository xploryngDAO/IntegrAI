/**
 * Recuperação de senha pela UI publicada: signup real -> "Esqueci minha senha"
 * -> e-mail (Mailpit) -> /reset-password -> nova senha -> login -> cleanup.
 *
 * Uso: node scripts/live-reset-ui-test.mjs [webBase] [apiBase] [platformEmail] [platformPassword]
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const WEB = (process.argv[2] ?? 'https://integrai-dev.vercel.app').replace(/\/+$/, '');
const API = (process.argv[3] ?? 'https://growth-voters-independent-rca.trycloudflare.com').replace(/\/+$/, '');
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
if (executablePath === undefined) throw new Error('navegador não encontrado (BROWSER_PATH)');

const tag = randomUUID().slice(0, 8);
const email = `reset-ui-${tag}@integrai.test`;
const oldPassword = 'Teste-Reset-Antiga-2026!x9';
const newPassword = 'Teste-Reset-Nova-2026!x9';

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
      const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=50`)).json();
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
  // 1) Workspace temporário com ADMIN verificado.
  const signup = await api('/api/v1/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ companyName: `Reset UI ${tag}`, name: 'Admin Reset', email, password: oldPassword }),
  });
  check('workspace temporário criado', signup.status === 201, `HTTP ${signup.status}`);
  const verifyToken = await mailLink(/verify-email\?token=([A-Za-z0-9%._-]+)/, email);
  await api('/api/v1/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: verifyToken }) });

  const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  // 2) Pedido de recuperação pela UI.
  await page.goto(`${WEB}/forgot-password`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.type('input[type="email"]', email);
  await page.click('button[type="submit"]');
  await sleep(4000);
  const requested = await page.evaluate(() => /Verifique seu e-mail|Pedido recebido|link/i.test(document.body.innerText));
  check('pedido de recuperação confirmado na UI', requested);

  // 3) Link real do e-mail -> nova senha.
  const resetUrl = await mailLink(/(https:\/\/[^\s"'<>]+\/reset-password\?token=[A-Za-z0-9%._-]+)/, email);
  check('link de reset no deploy público', resetUrl.startsWith(`${WEB}/reset-password?token=`));
  await page.goto(resetUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(2500);
  const passwordInputs = await page.$$('input[type="password"]');
  check('página de nova senha abre', passwordInputs.length >= 2);
  await passwordInputs[0].type(newPassword);
  await passwordInputs[1].type(newPassword);
  await page.click('button[type="submit"]');
  await sleep(5000);
  const resetDone = await page.evaluate(() => /Senha redefinida|Tudo certo|redefinida com sucesso/i.test(document.body.innerText));
  check('senha redefinida na UI', resetDone);

  // 4) Login com a nova senha (e recusa da antiga).
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', newPassword);
  await page.click('button[type="submit"]');
  await sleep(7000);
  const session = await page.evaluate(() => ({ token: localStorage.getItem('sac.auth.token'), url: location.href }));
  check('login com a nova senha', typeof session.token === 'string' && session.token.length > 100, session.url);
  const oldLogin = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: oldPassword }),
  });
  check('senha antiga recusada (401)', oldLogin.status === 401, `HTTP ${oldLogin.status}`);

  // 5) Cleanup.
  const me = await api('/api/v1/tenants/me', { headers: { authorization: `Bearer ${session.token}` } });
  const slug = me.body?.data?.slug;
  const tenantId = me.body?.data?.id;
  const removed = await api('/api/v1/tenants/me', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ password: newPassword, confirmSlug: slug }),
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
  check('sem erros de runtime', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  await browser.close();

  console.log(`\n${passed}/${passed + failed} verificações passaram.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\nFalha:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
