/**
 * Fluxo público completo **pela UI publicada** (Vercel): signup → e-mail →
 * verificação → login → cleanup (soft delete + purge).
 *
 * Uso: node scripts/live-signup-ui-test.mjs [webBase] [apiBase] [platformEmail] [platformPassword]
 * Requer Mailpit acessível (MAILPIT_URL) e Edge instalado (ou BROWSER_PATH).
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
const email = `ui-${tag}@integrai.test`;
const company = `UI Teste ${tag}`;
const password = 'Teste-UI-2026!x9';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? (passed += 1) : (failed += 1);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        if (match) return { url: match[1], token: match[2] };
      }
    } catch {
      /* mailpit warming up */
    }
    await sleep(1000);
  }
  throw new Error(`e-mail para ${recipient} não encontrado`);
}

async function main() {
  const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const appErrors = [];
  page.on('pageerror', (error) => appErrors.push(String(error)));

  await page.goto(`${WEB}/signup`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.type('input[placeholder="Sua loja Ltda"]', company);
  await page.type('input[placeholder="Nome e sobrenome"]', 'Admin UI Teste');
  await page.type('input[placeholder="voce@suaempresa.com.br"]', email);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => /Verifique seu e-mail/i.test(document.body.innerText), { timeout: 25_000 });
  check('signup pela UI', true, email);

  const verify = await mailLink(/(https:\/\/[^\s"'<>]+\/verify-email\?token=([A-Za-z0-9%._-]+))/, email);
  check('e-mail de verificação com link no deploy', verify.url.startsWith(`${WEB}/verify-email?token=`));

  await page.goto(verify.url, { waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(2500);
  const verifyText = await page.evaluate(() => document.body.innerText);
  check('página de verificação abre', /verific|confirmad|entrar/i.test(verifyText));

  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await sleep(8000);
  const session = await page.evaluate(() => ({
    token: window.localStorage.getItem('sac.auth.token'),
    url: window.location.href,
    text: document.body.innerText.slice(0, 200),
  }));
  check('login do novo ADMIN pela UI', typeof session.token === 'string' && session.token.length > 100, session.url);

  // Cleanup through the API (same account): tenant profile, soft delete, purge.
  const profile = await page.evaluate(async (api, token) => {
    const response = await fetch(`${api}/api/v1/tenants/me`, { headers: { authorization: `Bearer ${token}` } });
    return response.ok ? (await response.json()).data : null;
  }, API, session.token);
  check('GET /tenants/me do workspace criado', profile !== null && typeof profile.slug === 'string', profile?.slug);
  const tenantId = profile?.id;
  const slug = profile?.slug;

  const removed = await page.evaluate(async (api, token, body) => {
    const response = await fetch(`${api}/api/v1/tenants/me`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.status;
  }, API, session.token, { password, confirmSlug: slug });
  check('soft delete do workspace de teste', removed === 202 || removed === 200, `HTTP ${removed}`);

  const platform = await (await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: PLATFORM_EMAIL, password: PLATFORM_PASSWORD }),
  })).json();
  const platformToken = platform?.data?.token;
  const purge = await fetch(`${API}/api/v1/platform/tenants/${tenantId}/purge`, {
    method: 'POST',
    headers: { authorization: `Bearer ${platformToken}` },
  });
  check('purge do workspace de teste', purge.status === 200 || purge.status === 202, `HTTP ${purge.status}`);

  check('sem erros de runtime no console', appErrors.length === 0, appErrors.slice(0, 2).join(' | '));

  await browser.close();
  console.log(`\n${passed}/${passed + failed} verificações passaram.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\nFalha:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
