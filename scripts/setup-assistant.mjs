/**
 * Assistente de configuração do SAC Hub.
 *
 * Lê o `.env`, mostra o que está configurado/faltando por canal, gera segredos
 * locais opcionais (`--generate`) e imprime o próximo passo acionável de cada
 * marketplace. Nunca imprime valores secretos.
 *
 * Uso:
 *   node scripts/setup-assistant.mjs [--generate] [--json]
 *   npm run setup:assistant
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const ENV_PATH = '.env';
const args = new Set(process.argv.slice(2));
const generate = args.has('--generate');
const asJson = args.has('--json');

function parseEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^"(.*)"$/, '$1');
    values[key] = value;
  }
  return values;
}

function isSet(value) {
  return typeof value === 'string' && value.trim() !== '';
}

const CHANNELS = [
  {
    id: 'MERCADO_LIVRE',
    name: 'Mercado Livre',
    required: ['MELI_CLIENT_ID', 'MELI_CLIENT_SECRET', 'MELI_REDIRECT_URI'],
    optional: [],
    portal: 'https://developers.mercadolivre.com.br/devcenter',
    next: 'Abra o DevCenter, crie/reaprove o app, copie Client ID/Secret e configure o Redirect URI mostrado em /setup.',
  },
  {
    id: 'SHOPEE',
    name: 'Shopee',
    required: ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY', 'SHOPEE_REDIRECT_URI'],
    optional: ['SHOPEE_API_BASE'],
    portal: 'https://open.shopee.com/console/app',
    next: 'Crie o app no Open Platform, copie partner id/key, configure push URL <api>/webhooks/shopee e o Redirect URI de /setup.',
  },
  {
    id: 'AMAZON',
    name: 'Amazon',
    required: ['AMAZON_APP_ID', 'AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'AMAZON_APP_REDIRECT_URI'],
    optional: ['AMAZON_SES_INBOUND_SHARED_SECRET', 'SMTP_HOST', 'SMTP_FROM'],
    portal: 'https://sellercentral.amazon.com.br/apps-and-services/',
    next: 'Crie o app público SP-API, aceite o DPP, aguarde o security assessment e configure LWA/SES/relay no Seller Central.',
  },
  {
    id: 'BILLING',
    name: 'Billing (gateway)',
    required: ['BILLING_WEBHOOK_SECRET', 'BILLING_CHECKOUT_URL_TEMPLATE'],
    optional: ['BILLING_SUCCESS_URL', 'BILLING_CANCEL_URL'],
    portal: 'https://dashboard.stripe.com/apikeys',
    next: 'Configure a conta do gateway, o template de checkout e aponte o webhook para <api>/api/v1/billing/webhook.',
  },
];

if (!existsSync(ENV_PATH)) {
  console.error('✖ .env não encontrado. Rode `cp .env.example .env` antes.');
  process.exit(2);
}

let text = readFileSync(ENV_PATH, 'utf8');
const env = parseEnv(text);
const generated = [];

const AUTO_SECRETS = {
  BILLING_WEBHOOK_SECRET: () => randomBytes(32).toString('hex'),
  AMAZON_SES_INBOUND_SHARED_SECRET: () => randomBytes(24).toString('hex'),
};

if (generate) {
  for (const [key, make] of Object.entries(AUTO_SECRETS)) {
    if (!isSet(env[key])) {
      const value = make();
      if (new RegExp(`^${key}=.*$`, 'm').test(text)) {
        text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
      } else {
        text = `${text.trimEnd()}\n${key}=${value}\n`;
      }
      env[key] = value;
      generated.push(key);
    }
  }
  if (generated.length > 0) writeFileSync(ENV_PATH, text, 'utf8');
}

const apiBase = (env.APP_BASE_URL ?? '').replace(/\/+$/, '');
const webOrigin = (env.WEB_ORIGIN ?? '').split(',')[0]?.trim() ?? '';
const report = {
  generatedAt: new Date().toISOString(),
  apiBaseUrl: apiBase,
  webOrigin,
  generated,
  channels: [],
  smtp: {
    host: isSet(env.SMTP_HOST) ? env.SMTP_HOST : null,
    port: env.SMTP_PORT ?? null,
    from: isSet(env.SMTP_FROM) ? env.SMTP_FROM : null,
    configured: isSet(env.SMTP_HOST) && isSet(env.SMTP_FROM),
    loopback: ['localhost', '127.0.0.1', '::1'].includes(env.SMTP_HOST ?? ''),
  },
  storage: {
    endpoint: env.S3_ENDPOINT ?? null,
    bucket: env.S3_BUCKET ?? null,
    configured: isSet(env.S3_ENDPOINT) && isSet(env.S3_BUCKET) && isSet(env.S3_ACCESS_KEY_ID),
  },
};

for (const channel of CHANNELS) {
  const missing = channel.required.filter((key) => !isSet(env[key]));
  report.channels.push({
    id: channel.id,
    name: channel.name,
    configured: missing.length === 0,
    missing,
    optionalMissing: channel.optional.filter((key) => !isSet(env[key])),
    portal: channel.portal,
    next: channel.next,
  });
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('SAC Hub — assistente de configuração');
  console.log('─'.repeat(64));
  console.log(`API base : ${apiBase || '(APP_BASE_URL vazio)'}`);
  console.log(`WebOrigin: ${webOrigin || '(WEB_ORIGIN vazio)'}`);
  console.log(`SMTP     : ${report.smtp.configured ? `${report.smtp.host}:${report.smtp.port}` : 'NÃO configurado'}${report.smtp.loopback ? ' (loopback: em dev o link é logado)' : ''}`);
  console.log(`Storage  : ${report.storage.configured ? report.storage.endpoint : 'NÃO configurado'}`);
  if (generated.length > 0) console.log(`Segredos gerados agora: ${generated.join(', ')}`);
  console.log('');

  for (const channel of report.channels) {
    const status = channel.configured ? '✓ configurado' : '✕ pendente';
    console.log(`${channel.name.padEnd(20)} ${status}`);
    if (!channel.configured) {
      console.log(`  faltando: ${channel.missing.join(', ')}`);
      console.log(`  portal  : ${channel.portal}`);
      console.log(`  próximo : ${channel.next}`);
      if (apiBase) {
        const path = channel.id === 'BILLING' ? 'api/v1/billing/webhook' : `webhooks/${channel.id === 'AMAZON' ? 'amazon/ses' : channel.id === 'MERCADO_LIVRE' ? 'mercadolivre' : 'shopee'}`;
        console.log(`  webhook : ${apiBase}/${path}`);
      }
      console.log('');
    }
  }

  console.log('Guia interativo com valores copiáveis: /setup no painel (platform admin).');
  console.log('Status da infraestrutura e canais: npm run doctor · /status');
}

const coreReady = report.channels.find((channel) => channel.id === 'MERCADO_LIVRE')?.configured === true;
process.exitCode = coreReady ? 0 : 1;
