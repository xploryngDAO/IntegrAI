/**
 * 2FA pela UI publicada: signup real -> /settings -> ativar TOTP -> logout ->
 * login com código TOTP -> cleanup. O tenant é temporário e removido no fim.
 *
 * Uso: node scripts/live-2fa-ui-test.mjs [webBase] [apiBase] [platformEmail] [platformPassword]
 * Requer Mailpit (MAILPIT_URL) e Edge/Chrome (BROWSER_PATH).
 */
import { createHmac, randomUUID } from 'node:crypto';
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
const email = `2fa-ui-${tag}@integrai.test`;
const password = 'Teste-2FA-UI-2026!x9';

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

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret, offsetSteps = 0) {
  const counter = Math.floor(Date.now() / 1000 / 30) + offsetSteps;
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

async function main() {
  // 1) Tenant temporário com ADMIN verificado.
  const signup = await api('/api/v1/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ companyName: `2FA UI ${tag}`, name: 'Admin 2FA', email, password }),
  });
  check('workspace temporário criado', signup.status === 201, `HTTP ${signup.status}`);
  const verifyToken = await mailLink(/verify-email\?token=([A-Za-z0-9%._-]+)/, email);
  await api('/api/v1/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: verifyToken }) });

  // 2) Ativação do TOTP pela UI.
  const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await sleep(7000);
  await page.goto(`${WEB}/settings`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(4000);

  const clicked = await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
      /^Ativar 2FA$/i.test((candidate.textContent ?? '').trim()),
    );
    if (button) {
      button.click();
      return true;
    }
    return false;
  });
  await sleep(2500);
  check('botão "Ativar 2FA" abre o setup', clicked);

  const secret = await page.evaluate(() => {
    const codes = Array.from(document.querySelectorAll('code'));
    const candidate = codes.map((node) => (node.textContent ?? '').trim()).find((text) => /^[A-Z2-7]{16,64}$/.test(text.replace(/\s/g, '')));
    return candidate ?? null;
  });
  check('chave TOTP exibida na UI', typeof secret === 'string');
  if (typeof secret !== 'string') throw new Error('chave TOTP não encontrada');

  await page.type('input[autocomplete="one-time-code"]', totp(secret));
  await page.click('button[type="submit"]');
  await sleep(4000);
  const enabled = await page.evaluate(() => /2FA ativado|Códigos de recuperação|Verificação em duas etapas ativada/i.test(document.body.innerText));
  check('confirmação do código ativa o 2FA', enabled);

  // 3) Logout + login com TOTP.
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(2500);
  await page.evaluate(() => document.querySelector('.sac-user__trigger')?.click());
  await sleep(800);
  await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('button, a')).find((element) => /Sair|Encerrar sessão/i.test(element.textContent ?? ''));
    if (item) item.click();
  });
  await sleep(6000);
  check('logout encerra a sessão', (await page.evaluate(() => localStorage.getItem('sac.auth.token'))) === null);

  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await sleep(5000);
  const challengeVisible = await page.evaluate(() => /Verificação em duas etapas|Código/i.test(document.body.innerText));
  check('login pede o código TOTP', challengeVisible, page.url());

  await page.type('input[autocomplete="one-time-code"]', totp(secret));
  await page.click('button[type="submit"]');
  await sleep(7000);
  const token = await page.evaluate(() => localStorage.getItem('sac.auth.token'));
  check('login com TOTP cria a sessão', typeof token === 'string' && token.length > 100);
  check('sem erros de runtime', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  // 4) Cleanup: perfil, soft delete e purge.
  const me = await api('/api/v1/tenants/me', { headers: { authorization: `Bearer ${token}` } });
  const slug = me.body?.data?.slug;
  const tenantId = me.body?.data?.id;
  await api('/api/v1/tenants/me', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ password, confirmSlug: slug }),
  });
  const platform = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: PLATFORM_EMAIL, password: PLATFORM_PASSWORD }),
  });
  const purge = await api(`/api/v1/platform/tenants/${tenantId}/purge`, {
    method: 'POST',
    headers: { authorization: `Bearer ${platform.body?.data?.token}` },
  });
  check('cleanup do workspace temporário', purge.status === 200 || purge.status === 202, `HTTP ${purge.status}`);
  await browser.close();

  console.log(`\n${passed}/${passed + failed} verificações passaram.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\nFalha:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
