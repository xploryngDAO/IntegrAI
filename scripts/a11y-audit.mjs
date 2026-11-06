/**
 * Auditoria de acessibilidade (WCAG 2.1 A/AA) com axe-core em navegador limpo.
 * Uso: node scripts/a11y-audit.mjs [url] [email] [password] [--dark]
 *
 * `--dark` fixa o tema escuro (`sac.hub.theme=dark`) antes do primeiro render,
 * cobrindo o segundo tema nas mesmas telas.
 */
import { existsSync, readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const ARGS = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const DARK = process.argv.includes('--dark');
const URL = (ARGS[0] ?? 'https://integrai-dev.vercel.app').replace(/\/$/, '');
const EMAIL = ARGS[1] ?? 'admin@integr-ai.local';
const PASSWORD = ARGS[2] ?? 'IntegrAI-Prod-2026!';
const AXE = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');

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

async function audit(page, name) {
  await page.evaluate(AXE);
  const result = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    return await axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
  });
  const violations = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.slice(0, 4).map((node) => node.target.join(' ')),
    count: violation.nodes.length,
  }));
  return { name: DARK ? `${name}-dark` : name, violations };
}

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
if (DARK) {
  await page.evaluateOnNewDocument(() => {
    try {
      window.localStorage.setItem('sac.hub.theme', 'dark');
    } catch {
      /* storage unavailable in private mode: audit runs in the default theme */
    }
  });
}

const reports = [];
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60_000 });
reports.push(await audit(page, 'landing'));

await page.goto(`${URL}/login`, { waitUntil: 'networkidle2', timeout: 60_000 });
reports.push(await audit(page, 'login'));

// Public pages reachable without a session: first-run signup, recovery, the
// "invalid token" states of invite/reset, billing returns and the SSO callback
// error state. They are part of the user-visible surface and were not audited
// before.
const PUBLIC_PAGES = [
  ['signup', '/signup'],
  ['forgot-password', '/forgot-password'],
  ['reset-invalid', '/reset-password'],
  ['invite-invalid', '/invite'],
  ['billing-success', '/billing/success'],
  ['billing-cancel', '/billing/cancel'],
  ['sso-callback-error', '/auth/sso/callback'],
];
for (const [name, path] of PUBLIC_PAGES) {
  await page.goto(`${URL}${path}`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  reports.push(await audit(page, name));
}

await page.goto(`${URL}/login`, { waitUntil: 'networkidle2', timeout: 60_000 });

await page.type('input[type="email"]', EMAIL);
await page.type('input[type="password"]', PASSWORD);
await Promise.all([page.click('button[type="submit"]'), new Promise((r) => setTimeout(r, 6000))]);
// A failed login would make every "authenticated" audit below silently audit
// the login page instead: treat it as a hard failure of the run.
const sessionToken = await page.evaluate(() => {
  try {
    return window.localStorage.getItem('sac.auth.token');
  } catch {
    return null;
  }
});
if (sessionToken === null) {
  console.error('Login falhou na auditoria: as telas autenticadas não seriam realmente auditadas (API errada ou credenciais inválidas).');
  await browser.close();
  process.exit(1);
}
await page.goto(`${URL}/admin`, { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 4000));
reports.push(await audit(page, 'admin'));

await page.goto(`${URL}/profile`, { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 3000));
reports.push(await audit(page, 'profile'));

await page.goto(`${URL}/accounts`, { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 3000));
reports.push(await audit(page, 'accounts'));

await page.goto(`${URL}/settings`, { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 3000));
reports.push(await audit(page, 'settings'));

// Platform console is only rendered for platform admins; the audit account is one.
await page.goto(`${URL}/platform`, { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 4000));
reports.push(await audit(page, 'platform'));

await page.goto(`${URL}/status`, { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 3000));
reports.push(await audit(page, 'status'));

// Mobile matters: the header hides some text at narrow widths, which can strip
// an element's accessible name (the landing brand link regressed exactly so).
await page.setViewport({ width: 390, height: 844 });
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 1500));
reports.push(await audit(page, 'landing-mobile'));

await page.goto(`${URL}/login`, { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 1500));
reports.push(await audit(page, 'login-mobile'));

console.log(JSON.stringify(reports, null, 2));
await browser.close();
const total = reports.reduce((sum, report) => sum + report.violations.length, 0);
if (total > 0) process.exitCode = 1;
