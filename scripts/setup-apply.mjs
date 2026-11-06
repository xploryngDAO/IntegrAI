/**
 * Aplica credenciais de integração no `.env` de forma segura (sem ecoar segredos).
 *
 * Uso:
 *   node scripts/setup-apply.mjs --marketplace=shopee \
 *     --partner-id=123456 --partner-key=SEGREDO \
 *     [--api-base=https://api.exemplo.com] [--redirect-uri=...] [--dry-run]
 *
 *   node scripts/setup-apply.mjs --from-file=credenciais.env [--dry-run]
 *
 * O arquivo aceita linhas KEY=VALUE (as mesmas do .env.example). Sempre cria
 * backup .env.bak-<timestamp> antes de gravar e imprime valores mascarados.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const ENV_PATH = '.env';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function flag(name) {
  const prefix = `--${name}=`;
  const entry = args.find((arg) => arg.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
}

const MARKETPLACE_KEYS = {
  meli: ['MELI_CLIENT_ID', 'MELI_CLIENT_SECRET', 'MELI_REDIRECT_URI'],
  shopee: ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY', 'SHOPEE_API_BASE', 'SHOPEE_REDIRECT_URI'],
  amazon: [
    'AMAZON_APP_ID',
    'AMAZON_LWA_CLIENT_ID',
    'AMAZON_LWA_CLIENT_SECRET',
    'AMAZON_APP_REDIRECT_URI',
    'AMAZON_OAUTH_AUTHORIZE_URL',
    'AMAZON_SES_INBOUND_SHARED_SECRET',
  ],
  billing: ['BILLING_WEBHOOK_SECRET', 'BILLING_CHECKOUT_URL_TEMPLATE', 'BILLING_SUCCESS_URL', 'BILLING_CANCEL_URL'],
};

function readEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

function mask(value) {
  if (!value) return '(vazio)';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
}

function validate(key, value) {
  if (!value || value.trim() === '') return 'valor vazio';
  if (key.endsWith('_URL') || key.endsWith('_URI') || key.endsWith('_TEMPLATE')) {
    try {
      const parsed = new URL(value.replace(/\{.*?\}/g, 'placeholder'));
      if (!['http:', 'https:'].includes(parsed.protocol)) return 'precisa ser http(s)';
    } catch {
      return 'URL inválida';
    }
  }
  if (key === 'SHOPEE_PARTNER_ID' && !/^\d+$/.test(value.trim())) return 'partner id deve ser numérico';
  if (key === 'BILLING_WEBHOOK_SECRET' && value.trim().length < 32) return 'segredo deve ter >= 32 caracteres';
  if (key === 'AMAZON_APP_ID' && !/^amzn1\.application\.[A-Za-z0-9-]+$/.test(value.trim())) {
    return 'formato esperado amzn1.application.XXXX';
  }
  return null;
}

if (!existsSync(ENV_PATH)) {
  console.error('✖ .env não encontrado.');
  process.exit(2);
}

let envText = readFileSync(ENV_PATH, 'utf8');
const current = readEnv(envText);
const changes = {};
const errors = [];

const fromFile = flag('from-file');
if (fromFile) {
  if (!existsSync(fromFile)) {
    console.error(`✖ arquivo não encontrado: ${fromFile}`);
    process.exit(2);
  }
  const parsed = readEnv(readFileSync(fromFile, 'utf8'));
  const allowed = new Set(Object.values(MARKETPLACE_KEYS).flat());
  for (const [key, value] of Object.entries(parsed)) {
    if (!allowed.has(key)) continue;
    const error = validate(key, value);
    if (error) errors.push(`${key}: ${error}`);
    else changes[key] = value.trim();
  }
} else {
  const marketplace = (flag('marketplace') ?? '').toLowerCase();
  const keys = MARKETPLACE_KEYS[marketplace];
  if (!keys) {
    console.error(`✖ --marketplace deve ser um de: ${Object.keys(MARKETPLACE_KEYS).join(', ')}`);
    process.exit(2);
  }
  const provided = {
    meli: { MELI_CLIENT_ID: flag('client-id'), MELI_CLIENT_SECRET: flag('client-secret'), MELI_REDIRECT_URI: flag('redirect-uri') },
    shopee: { SHOPEE_PARTNER_ID: flag('partner-id'), SHOPEE_PARTNER_KEY: flag('partner-key'), SHOPEE_API_BASE: flag('api-base'), SHOPEE_REDIRECT_URI: flag('redirect-uri') },
    amazon: {
      AMAZON_APP_ID: flag('app-id'),
      AMAZON_LWA_CLIENT_ID: flag('lwa-client-id'),
      AMAZON_LWA_CLIENT_SECRET: flag('lwa-client-secret'),
      AMAZON_APP_REDIRECT_URI: flag('redirect-uri'),
      AMAZON_OAUTH_AUTHORIZE_URL: flag('authorize-url'),
      AMAZON_SES_INBOUND_SHARED_SECRET: flag('ses-secret'),
    },
    billing: {
      BILLING_WEBHOOK_SECRET: flag('webhook-secret'),
      BILLING_CHECKOUT_URL_TEMPLATE: flag('checkout-template'),
      BILLING_SUCCESS_URL: flag('success-url'),
      BILLING_CANCEL_URL: flag('cancel-url'),
    },
  }[marketplace];
  for (const [key, value] of Object.entries(provided)) {
    if (!value) continue;
    const error = validate(key, value);
    if (error) errors.push(`${key}: ${error}`);
    else changes[key] = value.trim();
  }
  if (Object.keys(changes).length === 0 && errors.length === 0) {
    console.error('✖ nenhum valor informado. Passe as flags (veja o cabeçalho do script) ou use --from-file.');
    process.exit(2);
  }
}

if (errors.length > 0) {
  console.error('✖ Validação falhou:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(2);
}

console.log(dryRun ? 'Modo dry-run (nada será gravado)' : 'Aplicando configuração no .env');
for (const [key, value] of Object.entries(changes)) {
  const previous = current[key];
  console.log(`  ${key}: ${previous ? mask(previous) : '(vazio)'} → ${mask(value)}`);
}

if (!dryRun) {
  const backup = `${ENV_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(ENV_PATH, backup);
  for (const [key, value] of Object.entries(changes)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(envText)) envText = envText.replace(pattern, `${key}=${value}`);
    else envText = `${envText.trimEnd()}\n${key}=${value}\n`;
  }
  writeFileSync(ENV_PATH, envText, 'utf8');
  console.log(`\n✓ .env atualizado (backup: ${backup})`);
  console.log('→ Reinicie a API para carregar as variáveis e recarregue /setup para conferir o status.');
} else {
  console.log('\n(dry-run) Nenhum arquivo alterado.');
}
