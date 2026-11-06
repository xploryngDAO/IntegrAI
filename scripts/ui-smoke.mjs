/**
 * Smoke E2E do shell autenticado (puppeteer), para CI e validação local.
 *
 * Uso: node scripts/ui-smoke.mjs [baseUrl] [email] [password]
 *
 * Cobre: login real, navegação pelas telas principais, logout pelo menu e
 * ausência de erros de runtime. Não depende de dados de marketplace.
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const URL = (process.argv[2] ?? 'http://127.0.0.1:4173').replace(/\/+$/, '');
const EMAIL = process.argv[3] ?? 'admin@integr-ai.local';
const PASSWORD = process.argv[4] ?? 'IntegrAI-CI-2026!';

const BROWSERS = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
const executablePath = BROWSERS.find((candidate) => existsSync(candidate));
if (executablePath === undefined) {
  console.error('navegador não encontrado (defina BROWSER_PATH).');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? (passed += 1) : (failed += 1);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

const token = () =>
  page.evaluate(() => {
    try {
      return window.localStorage.getItem('sac.auth.token');
    } catch {
      return null;
    }
  });
const text = () => page.evaluate(() => document.body.innerText);

try {
  await page.goto(`${URL}/login`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.type('input[type="email"]', EMAIL);
  await page.type('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await sleep(7000);
  check('login cria sessão', typeof (await token()) === 'string');

  const routes = [
    ['/admin', /Equipe|Usuários|Convites/i, 'admin'],
    ['/accounts', /Canais conectados/i, 'contas'],
    ['/settings', /Configurações|Workspace/i, 'configurações'],
    ['/profile', /Meu perfil/i, 'perfil'],
  ];
  for (const [path, pattern, label] of routes) {
    await page.goto(`${URL}${path}`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await sleep(3000);
    const body = await text();
    check(`${label} carrega autenticado`, pattern.test(body), path);
  }

  // Back to the workspace and use the identity menu to sign out.
  await page.goto(`${URL}/`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(3000);
  const opened = await page.evaluate(() => {
    const trigger = document.querySelector('.sac-user__trigger');
    if (trigger instanceof HTMLElement) {
      trigger.click();
      return true;
    }
    return false;
  });
  await sleep(1000);
  const loggedOut = opened
    ? await page.evaluate(() => {
        const item = Array.from(document.querySelectorAll('button, a')).find((element) =>
          /Sair|Encerrar sessão/i.test(element.textContent ?? ''),
        );
        if (item instanceof HTMLElement) {
          item.click();
          return true;
        }
        return false;
      })
    : false;
  await sleep(5000);
  const finalState = await page.evaluate(() => ({
    url: window.location.href,
    token: (() => {
      try {
        return window.localStorage.getItem('sac.auth.token');
      } catch {
        return null;
      }
    })(),
  }));
  check('logout pelo menu encerra a sessão', loggedOut && finalState.token === null, finalState.url);
  check('sem erros de runtime', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
} catch (error) {
  failed += 1;
  console.error('Falha inesperada:', error instanceof Error ? error.message : error);
} finally {
  await browser.close();
}

console.log(`\n${passed}/${passed + failed} verificações passaram.`);
if (failed > 0) process.exitCode = 1;
