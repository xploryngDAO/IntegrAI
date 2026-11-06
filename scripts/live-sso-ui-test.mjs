/**
 * SSO corporativo pela UI publicada, usando o IdP OIDC de teste do repo:
 * tenant temporário -> PUT /tenants/me/sso (stub) -> /login -> "Entrar com Microsoft"
 * -> stub authorize -> callback -> sessão JIT. Limpa tenant e SSO no fim.
 *
 * Uso: node scripts/live-sso-ui-test.mjs [webBase] [apiBase]
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const WEB = (process.argv[2] ?? 'https://integrai-dev.vercel.app').replace(/\/+$/, '');
const API = (process.argv[3] ?? 'https://growth-voters-independent-rca.trycloudflare.com').replace(/\/+$/, '');
const MAILPIT = process.env.MAILPIT_URL ?? 'http://192.168.15.17:8025';
const STUB_PORT = Number(process.env.OIDC_STUB_PORT ?? 4310);
const STUB_ISSUER = `http://127.0.0.1:${STUB_PORT}`;
const STUB_EMAIL = process.env.OIDC_STUB_EMAIL ?? 'sso-live@integrai.test';

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
const email = `sso-admin-${tag}@integrai.test`;
const password = 'Teste-SSO-UI-2026!x9';

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

async function waitFor(checkFn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await checkFn();
      if (value) return value;
    } catch {
      // The page may be mid-navigation between the SPA, the API and the IdP;
      // the execution context is destroyed and recreated — just retry.
    }
    await sleep(intervalMs);
  }
  return null;
}

async function main() {
  const stub = spawn(process.execPath, ['scripts/oidc-stub.mjs', String(STUB_PORT)], {
    stdio: 'ignore',
    env: process.env,
  });
  let token = null;
  let tenantId = null;
  let slug = null;

  const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  try {
    const stubReady = await waitFor(async () => {
      try {
        const response = await fetch(`${STUB_ISSUER}/.well-known/openid-configuration`);
        return response.ok;
      } catch {
        return false;
      }
    }, 10_000);
    check('stub OIDC no ar', stubReady === true, STUB_ISSUER);
    if (!stubReady) throw new Error('stub OIDC não subiu');

    // 1) Tenant temporário com ADMIN.
    const signup = await api('/api/v1/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ companyName: `SSO UI ${tag}`, name: 'Admin SSO', email, password }),
    });
    check('workspace temporário criado', signup.status === 201, `HTTP ${signup.status}`);
    const verifyToken = await mailLink(/verify-email\?token=([A-Za-z0-9%._-]+)/, email);
    await api('/api/v1/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: verifyToken }) });
    const login = await api('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    token = login.body?.data?.token;
    check('login do ADMIN temporário', typeof token === 'string');
    const me = await api('/api/v1/tenants/me', { headers: { authorization: `Bearer ${token}` } });
    slug = me.body?.data?.slug ?? null;
    tenantId = me.body?.data?.id ?? null;

    // 2) Configura o SSO do workspace com o stub.
    const configured = await api('/api/v1/tenants/me/sso', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        provider: 'MICROSOFT',
        issuerUrl: STUB_ISSUER,
        clientId: 'stub-client',
        clientSecret: 'stub-secret',
        allowedDomains: ['integrai.test'],
        autoProvision: true,
        enabled: true,
      }),
    });
    check('SSO configurado no workspace', configured.status === 200, `HTTP ${configured.status}`);

    // 3) Login corporativo pela UI.
    await page.goto(`${WEB}/login`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.type('input[type="email"]', STUB_EMAIL);
    const clicked = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
        /Entrar com Microsoft/i.test(candidate.textContent ?? ''),
      );
      if (button) {
        button.click();
        return true;
      }
      return false;
    });
    check('botão "Entrar com Microsoft" acionado', clicked);

    const ssoToken = await waitFor(
      () =>
        page.evaluate(() => {
          try {
            return window.localStorage.getItem('sac.auth.token');
          } catch {
            return null;
          }
        }),
      35_000,
    );
    check('callback SSO cria a sessão', typeof ssoToken === 'string' && ssoToken.length > 100, page.url());
    const agent = await page.evaluate(async (api, bearer) => {
      const response = await fetch(`${api}/api/v1/auth/me`, { headers: { authorization: `Bearer ${bearer}` } });
      return response.ok ? (await response.json()).data : null;
    }, API, ssoToken);
    check('operador JIT criado pelo SSO', agent?.email?.toLowerCase() === STUB_EMAIL.toLowerCase(), agent?.email ?? 'n/a');
    check('sem erros de runtime', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  } finally {
    // 4) Cleanup: remove SSO, soft delete e purge.
    if (token !== null) {
      await api('/api/v1/tenants/me/sso', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }).catch(() => null);
      await api('/api/v1/tenants/me', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ password, confirmSlug: slug }),
      }).catch(() => null);
      const platform = await api('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'admin@integr-ai.local', password: 'IntegrAI-Prod-2026!' }),
      }).catch(() => null);
      if (platform?.body?.data?.token && tenantId !== null) {
        const purge = await api(`/api/v1/platform/tenants/${tenantId}/purge`, {
          method: 'POST',
          headers: { authorization: `Bearer ${platform.body.data.token}` },
        }).catch(() => null);
        check('cleanup do workspace temporário', purge?.status === 200 || purge?.status === 202, `HTTP ${purge?.status ?? 'n/a'}`);
      }
    }
    await browser.close();
    stub.kill();
  }

  console.log(`\n${passed}/${passed + failed} verificações passaram.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\nFalha:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
