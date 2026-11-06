/**
 * Auditoria de acessibilidade (WCAG 2.1 A/AA) com axe-core em navegador limpo.
 * Uso: node scripts/a11y-audit.mjs [url] [email] [password]
 */
import { existsSync, readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const URL = (process.argv[2] ?? 'https://integrai-dev.vercel.app').replace(/\/$/, '');
const EMAIL = process.argv[3] ?? 'admin@integr-ai.local';
const PASSWORD = process.argv[4] ?? 'IntegrAI-Prod-2026!';
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
  return { name, violations };
}

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const reports = [];
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60_000 });
reports.push(await audit(page, 'landing'));

await page.goto(`${URL}/login`, { waitUntil: 'networkidle2', timeout: 60_000 });
reports.push(await audit(page, 'login'));

await page.type('input[type="email"]', EMAIL);
await page.type('input[type="password"]', PASSWORD);
await Promise.all([page.click('button[type="submit"]'), new Promise((r) => setTimeout(r, 6000))]);
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

console.log(JSON.stringify(reports, null, 2));
await browser.close();
const total = reports.reduce((sum, report) => sum + report.violations.length, 0);
if (total > 0) process.exitCode = 1;
