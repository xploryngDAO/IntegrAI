/**
 * Web Vitals reais no workspace autenticado (Puppeteer/Chromium).
 *
 * Uso: node scripts/web-vitals.mjs [webBase] [email] [password]
 *
 * Mede LCP, CLS, long tasks e tempo de carregamento inicial (FCP/TTFB/nav) na
 * landing anônima e, após login, no workspace e em /accounts. Serve como
 * evidência de UX real (o Lighthouse só cobre páginas públicas).
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const URL = (process.argv[2] ?? 'https://integrai-dev.vercel.app').replace(/\/+$/, '');
const EMAIL = process.argv[3] ?? 'admin@integr-ai.local';
const PASSWORD = process.argv[4] ?? 'IntegrAI-Prod-2026!';

const BROWSERS = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
const executablePath = BROWSERS.find((candidate) => existsSync(candidate));
if (executablePath === undefined) throw new Error('navegador não encontrado (BROWSER_PATH)');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const COLLECTOR = () => {
  const vitals = { lcp: 0, cls: 0, longTasks: 0, longTaskMs: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) vitals.lcp = Math.max(vitals.lcp, entry.startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) vitals.cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        vitals.longTasks += 1;
        vitals.longTaskMs += entry.duration;
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* observer types missing on old engines */
  }
  window.__vitals = vitals;
};

async function collect(page, label) {
  const values = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paint = performance.getEntriesByType('paint');
    return {
      ...(window.__vitals ?? { lcp: 0, cls: 0, longTasks: 0, longTaskMs: 0 }),
      ttfb: nav?.responseStart ?? null,
      domContentLoaded: nav?.domContentLoadedEventEnd ?? null,
      load: nav?.loadEventEnd ?? null,
      fcp: paint.find((entry) => entry.name === 'first-contentful-paint')?.startTime ?? null,
    };
  });
  const round = (value) => (typeof value === 'number' ? Math.round(value) : 'n/a');
  console.log(
    `${label}: LCP=${round(values.lcp)}ms · CLS=${values.cls.toFixed(3)} · FCP=${round(values.fcp)}ms · TTFB=${round(values.ttfb)}ms · DCL=${round(values.domContentLoaded)}ms · load=${round(values.load)}ms · longTasks=${values.longTasks} (${round(values.longTaskMs)}ms)`,
  );
  return { label, ...values };
}

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.evaluateOnNewDocument(COLLECTOR);

const results = [];
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60_000 });
await sleep(2000);
results.push(await collect(page, 'landing (anônima)'));

await page.goto(`${URL}/login`, { waitUntil: 'networkidle2', timeout: 60_000 });
await page.evaluate(COLLECTOR);
await page.type('input[type="email"]', EMAIL);
await page.type('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await sleep(8000);
results.push(await collect(page, 'workspace (pós-login)'));

await page.goto(`${URL}/accounts`, { waitUntil: 'networkidle2', timeout: 60_000 });
await page.evaluate(COLLECTOR);
await sleep(2500);
results.push(await collect(page, '/accounts'));

await browser.close();
const problems = results.filter((entry) => entry.lcp > 2500 || entry.cls > 0.1);
console.log(`\n${results.length - problems.length}/${results.length} medições dentro do alvo (LCP ≤ 2,5 s · CLS ≤ 0,1).`);
if (problems.length > 0) process.exitCode = 1;
