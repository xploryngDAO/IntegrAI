#!/usr/bin/env node
/**
 * Publishes the SPA to Vercel wired to the tunnel that is alive right now.
 *
 * The project is Git-connected, so a push already triggers a production build.
 * This script is the *deliberate* path: it reads the current tunnel from
 * `apps/web/runtime-config.json`, verifies the API through it, and passes the
 * same values as build-time envs (`VITE_API_BASE_URL`/`VITE_WS_URL`) so the
 * bundle fallback is never stale. The runtime config remains the source of
 * truth at boot, so a later tunnel restart does not break the published app.
 *
 * Usage:
 *   node scripts/deploy-vercel.mjs
 *   node scripts/deploy-vercel.mjs --skip-health   # emergency only
 *
 * Requires the Vercel CLI logged in (`npx vercel whoami`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_CONFIG_PATH = join(ROOT, 'apps', 'web', 'runtime-config.json');
const SITE_URL = 'https://integrai-dev.vercel.app';

const skipHealth = process.argv.includes('--skip-health');

function fail(message) {
  console.error(`\n[erro] ${message}\n`);
  process.exit(1);
}

function readRuntimeConfig() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, 'utf8'));
  } catch (error) {
    fail(`não foi possível ler ${RUNTIME_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const apiBaseUrl = typeof parsed.apiBaseUrl === 'string' ? parsed.apiBaseUrl.replace(/\/+$/, '') : '';
  const wsUrl = typeof parsed.wsUrl === 'string' ? parsed.wsUrl.replace(/\/+$/, '') : '';
  if (!/^https?:\/\//.test(apiBaseUrl) || !/^https?:\/\//.test(wsUrl)) {
    fail('runtime-config.json sem apiBaseUrl/wsUrl absolutos. Rode `npm run tunnel:sync` primeiro.');
  }
  return { apiBaseUrl, wsUrl };
}

async function checkHealth(apiBaseUrl) {
  const target = `${apiBaseUrl}/health/ready`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(target, { signal: controller.signal, cache: 'no-store' });
    const body = await response.json().catch(() => null);
    if (!response.ok || body === null || body.status !== 'ready') {
      fail(`API não está pronta em ${target} (HTTP ${response.status}). Suba a API/túnel antes de publicar.`);
    }
    console.log(`[ok] API pronta em ${target}`);
  } catch (error) {
    if (error?.code === 'ABORT_ERR') fail(`Timeout ao verificar ${target}.`);
    fail(`Não foi possível alcançar ${target}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

const { apiBaseUrl, wsUrl } = readRuntimeConfig();
console.log(`[info] API:     ${apiBaseUrl}`);
console.log(`[info] WebSocket: ${wsUrl}`);

if (!skipHealth) await checkHealth(apiBaseUrl);

console.log('\n[info] Publicando na Vercel (deploy de produção)...\n');
const result = spawnSync(
  'npx',
  [
    'vercel',
    'deploy',
    '--prod',
    '--yes',
    '--build-env',
    `VITE_API_BASE_URL=${apiBaseUrl}`,
    '--build-env',
    `VITE_WS_URL=${wsUrl}`,
  ],
  { cwd: ROOT, stdio: 'inherit', shell: true },
);

if (result.status !== 0) {
  fail(
    'o deploy falhou. Se a mensagem for "Deployment rate limited" / ' +
      '"api-deployments-free-per-day", a cota diária do plano Hobby (100 deploys) ' +
      'foi atingida: aguarde o reset (~24 h) ou faça upgrade para o Pro.',
  );
}

// The deployment is asynchronous; give it a few seconds and confirm the alias.
await new Promise((resolvePromise) => setTimeout(resolvePromise, 8_000));
try {
  const response = await fetch(`${SITE_URL}/`, { cache: 'no-store' });
  console.log(`\n[ok] ${SITE_URL} respondeu HTTP ${response.status}`);
} catch (error) {
  console.warn(
    `\n[aviso] deploy concluído, mas ${SITE_URL} ainda não respondeu: ${error instanceof Error ? error.message : String(error)}`,
  );
}
console.log('[ok] publicado. O runtime config continua valendo para o próximo restart do túnel.');
