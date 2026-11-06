/**
 * Verificação ponta a ponta do SAC Hub publicado, em um navegador LIMPO
 * (Edge headless via puppeteer-core) — sem extensões que interceptem API.
 *
 * Uso:
 *   node scripts/verify-live.mjs [url] [email] [password]
 *
 * Roda: login real -> workspace real -> /accounts -> "Diagnosticar canais"
 * e salva capturas em screenshots/.
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'https://integrai-dev.vercel.app';
const EMAIL = process.argv[3] ?? process.env.ADMIN_EMAIL;
const PASSWORD = process.argv[4] ?? process.env.ADMIN_PASSWORD;

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function findEdge() {
  const found = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Microsoft Edge não encontrado');
  return found;
}

if (!EMAIL || !PASSWORD) {
  console.error('ADMIN_EMAIL/ADMIN_PASSWORD ausentes');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: findEdge(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 },
});

const result = { url: URL, steps: {} };
try {
  const page = await browser.newPage();
  const apiResponses = [];
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/v1/')) {
      apiResponses.push({ url: url.replace(/^https?:\/\/[^/]+/, ''), status: response.status() });
    }
  });

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45_000 });
  result.steps.landingVisible = await page.evaluate(() => document.body.innerText.includes('Criar conta'));
  const loginOnRoot = await page.evaluate(() => Boolean(document.querySelector('input[type="email"]')));
  if (!loginOnRoot) {
    await page.goto(`${URL}/login`, { waitUntil: 'networkidle2', timeout: 45_000 });
  }

  const loginVisible = await page.evaluate(() => Boolean(document.querySelector('input[type="email"]')));
  result.steps.loginVisible = loginVisible;

  if (loginVisible) {
    await page.type('input[type="email"]', EMAIL, { delay: 10 });
    await page.type('input[type="password"]', PASSWORD, { delay: 10 });
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForFunction(() => document.body.innerText.includes('Fila unificada'), { timeout: 30_000 }),
    ]);
  }

  result.steps.authenticated = await page.evaluate(
    () => !document.body.innerText.includes('Entrar no workspace'),
  );
  result.steps.topbar = await page.evaluate(() => {
    const text = document.body.innerText;
    const accounts = text.match(/(\d+) lojas conectadas/);
    const queue = text.match(/(\d+)\s*\n?\s*NA FILA/i);
    return { accounts: accounts ? accounts[1] : null, queue: queue ? queue[1] : null };
  });
  result.steps.localStorageToken = await page.evaluate(
    () => Boolean(window.localStorage.getItem('sac.auth.token')),
  );
  await page.screenshot({ path: 'screenshots/live-workspace.png' });

  await page.goto(`${URL.replace(/\/$/, '')}/accounts`, { waitUntil: 'networkidle2', timeout: 45_000 });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  result.steps.accountsBody = await page.evaluate(() => document.body.innerText.slice(0, 300));
  await page.screenshot({ path: 'screenshots/live-accounts-debug.png' });
  try {
    await page.waitForFunction(() => document.body.innerText.includes('Canais conectados'), { timeout: 20_000 });
    result.steps.accountsPage = true;
  } catch {
    result.steps.accountsPage = false;
  }

  const diagnoseButton = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('button')).find((button) =>
      /Diagnosticar canais/i.test(button.textContent ?? ''),
    ),
  );
  const hasDiagnoseButton = Boolean(await diagnoseButton.asElement());
  result.steps.diagnoseButton = hasDiagnoseButton;

  if (hasDiagnoseButton) {
    await diagnoseButton.asElement().click();
    await page.waitForFunction(
      () => /Diagnóstico/i.test(document.body.innerText) && /INFRAESTRUTURA|Infraestrutura/i.test(document.body.innerText),
      { timeout: 60_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    result.steps.diagnosisDialog = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]') ?? document.body;
      const text = dialog.innerText ?? '';
      return {
        hasPostgresOk: /PostgreSQL[\s\S]{0,80}ok/i.test(text),
        hasRedisOk: /Redis[\s\S]{0,80}ok/i.test(text),
        hasS3Ok: /storage|S3\/MinIO/i.test(text),
        excerpt: text.slice(0, 600),
      };
    });
    await page.screenshot({ path: 'screenshots/live-diagnostics.png' });
  }

  await page.goto(`${URL.replace(/\/$/, '')}/profile`, { waitUntil: 'networkidle2', timeout: 45_000 });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  result.steps.profilePage = await page.evaluate(() => {
    const text = document.body.innerText;
    return { sessions: /Sessões ativas/i.test(text), logoutAll: /Sair de todos/i.test(text) };
  });

  await page.goto(`${URL.replace(/\/$/, '')}/admin`, { waitUntil: 'networkidle2', timeout: 45_000 });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  result.steps.adminPage = await page.evaluate(() => {
    const text = document.body.innerText;
    return { users: /Usuários/i.test(text), logs: /Logs/i.test(text), forbidden: /Acesso restrito/i.test(text) };
  });
  await page.screenshot({ path: 'screenshots/live-admin.png' });

  const accountMenuButton = await page.evaluateHandle(() =>
    document.querySelector('button[aria-haspopup="menu"]'),
  );
  if (await accountMenuButton.asElement()) {
    await accountMenuButton.asElement().click();
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  const logoutButton = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('button,[role="menuitem"]')).find((button) =>
      /^Sair(\s+de\s+todos)?$/i.test((button.textContent ?? '').trim()),
    ),
  );
  if (await logoutButton.asElement()) {
    await logoutButton.asElement().click();
    try {
      await page.waitForFunction(() => window.location.pathname === '/login', { timeout: 20_000 });
    } catch {
      // fall through: loggedOut below reports the real state
    }
  }
  result.steps.loggedOut = await page.evaluate(() => ({
    onLogin: window.location.pathname === '/login',
    tokenCleared: !window.localStorage.getItem('sac.auth.token'),
  }));

  result.api = apiResponses.slice(-14);
} finally {
  await browser.close();
}

console.log(JSON.stringify(result, null, 2));
