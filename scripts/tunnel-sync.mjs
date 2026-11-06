#!/usr/bin/env node
/**
 * Keeps the MVP tunnel wiring consistent.
 *
 * The API runs on the developer machine behind a Cloudflare quick tunnel. The
 * public hostname changes whenever cloudflared restarts, so the deployed SPA
 * must learn the new address without a new Vercel deployment: it reads
 * `apps/web/runtime-config.json` at boot (see apps/web/src/lib/runtimeConfig.ts).
 *
 * This script:
 *   1. validates `<url>/api/v1/health/ready` (nothing is written when the API
 *      is unreachable, so the published app is never pointed at a dead host);
 *   2. rewrites `apps/web/runtime-config.json` (apiBaseUrl + wsUrl);
 *   3. rewrites the `.env` keys that derive from the public URL
 *      (`APP_BASE_URL` and the OAuth redirect URIs).
 *
 * Usage:
 *   node scripts/tunnel-sync.mjs                                  # current .env URL
 *   node scripts/tunnel-sync.mjs https://new-name.trycloudflare.com
 *   node scripts/tunnel-sync.mjs https://... --force              # skip health check
 *
 * After running it:
 *   - restart the API so `.env` (APP_BASE_URL/redirect URIs) is applied;
 *   - commit + push `apps/web/runtime-config.json` (no Vercel deploy needed for
 *     that file — the published bundle fetches it at runtime).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const RUNTIME_CONFIG_PATH = join(ROOT, 'apps', 'web', 'runtime-config.json');

const args = process.argv.slice(2);
const force = args.includes('--force');
const urlArg = args.find((arg) => !arg.startsWith('--'));

function fail(message) {
  console.error(`\n[erro] ${message}\n`);
  process.exit(1);
}

function normalizeUrl(raw) {
  const trimmed = String(raw ?? '').trim();
  if (trimmed.length === 0) fail('URL do túnel vazia.');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    fail(`URL inválida: ${trimmed}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail(`URL precisa ser http(s): ${trimmed}`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

/** Reads `KEY=value` from `.env` without interpreting quotes/dotenv syntax. */
function readDotEnv(path) {
  if (!existsSync(path)) fail(`.env não encontrado em ${path}`);
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const values = new Map();
  for (const line of lines) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2].trim());
  }
  return values;
}

/** Rewrites the given keys in `.env`, appending the ones that are missing. */
function updateDotEnv(path, updates) {
  const original = readFileSync(path, 'utf8');
  const lines = original.split(/\r?\n/);
  const seen = new Set();

  const next = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!Object.hasOwn(updates, key)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }

  writeFileSync(path, next.join('\n'), 'utf8');
}

async function checkHealth(baseUrl) {
  const target = `${baseUrl}/api/v1/health/ready`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(target, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) {
      fail(`A API respondeu HTTP ${response.status} em ${target}.`);
    }
    const body = await response.json().catch(() => null);
    if (body === null || body.status !== 'ready') {
      fail(`A API não está pronta em ${target} (resposta inesperada).`);
    }
    return body;
  } catch (error) {
    if (error?.code === 'ABORT_ERR') fail(`Timeout ao verificar ${target}.`);
    fail(`Não foi possível alcançar ${target}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

const env = readDotEnv(ENV_PATH);
const baseUrl = normalizeUrl(urlArg ?? env.get('APP_BASE_URL'));

if (!force) {
  const health = await checkHealth(baseUrl);
  console.log(`[ok] API pronta em ${baseUrl} (checks: ${Object.keys(health.checks ?? {}).join(', ')})`);
} else {
  console.log('[aviso] health check ignorado (--force).');
}

const runtimeConfig = {
  apiBaseUrl: `${baseUrl}/api/v1`,
  wsUrl: baseUrl,
  updatedAt: new Date().toISOString(),
};
writeFileSync(RUNTIME_CONFIG_PATH, `${JSON.stringify(runtimeConfig, null, 2)}\n`, 'utf8');
console.log(`[ok] ${RUNTIME_CONFIG_PATH.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`);
console.log(`     apiBaseUrl=${runtimeConfig.apiBaseUrl}`);
console.log(`     wsUrl=${runtimeConfig.wsUrl}`);

const previousBase = normalizeUrl(env.get('APP_BASE_URL'));
const updates = {
  APP_BASE_URL: baseUrl,
  MELI_REDIRECT_URI: `${baseUrl}/api/v1/accounts/oauth/mercadolivre/callback`,
  SHOPEE_REDIRECT_URI: `${baseUrl}/api/v1/accounts/oauth/shopee/callback`,
};
updateDotEnv(ENV_PATH, updates);
console.log('[ok] .env atualizado (APP_BASE_URL, MELI_REDIRECT_URI, SHOPEE_REDIRECT_URI)');

if (previousBase !== baseUrl) {
  console.log('\nPróximos passos:');
  console.log('  1. reinicie a API para aplicar APP_BASE_URL/redirects (túnel atual: ' + baseUrl + ')');
  console.log('  2. git add apps/web/runtime-config.json && git commit && git push');
  console.log('     (o SPA publicado passa a usar a nova URL no próximo carregamento —');
  console.log('      não é necessário um novo deploy na Vercel)');
} else {
  console.log('\n[ok] URL sem mudanças: nada a reiniciar no app publicado;');
  console.log('     commite apps/web/runtime-config.json só se ele tiver sido criado/alterado.');
}
