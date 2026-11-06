#!/usr/bin/env node
/**
 * Diagnóstico do relay SMTP transacional.
 *
 * Valida host/porta/TLS/credenciais reais e, opcionalmente, envia um e-mail de
 * teste. É o passo que confirma "as credenciais que eu passei funcionam" antes
 * de qualquer cadastro/convite/reset depender do relay.
 *
 * Uso:
 *   npm run smtp:doctor                      # verifica conexão/credenciais
 *   npm run smtp:doctor -- --to eu@dominio   # verifica e envia teste
 *   npm run smtp:doctor -- --verify-only     # não envia nada
 *
 * As credenciais são lidas do `.env` (ou do ambiente, que tem precedência).
 * NUNCA imprimimos a senha: apenas o usuário e o tamanho do segredo.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');

/** Loads `.env` for keys that are not already in `process.env`. */
function loadDotEnv() {
  if (!existsSync(ENV_PATH)) return;
  const text = readFileSync(ENV_PATH, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim();
  }
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

/** Hints for the most common bootstrap mistakes, keyed by provider host. */
function providerHint(host) {
  const value = host.toLowerCase();
  if (value.includes('resend')) {
    return 'Resend: smtp.resend.com, porta 465 (SMTP_SECURE=true) ou 587 (false), usuário "resend", senha = API key; o domínio remetente precisa estar verificado.';
  }
  if (value.includes('brevo')) {
    return 'Brevo: smtp-relay.brevo.com, porta 587 (SMTP_SECURE=false), usuário = login da conta, senha = chave SMTP; valide o remetente.';
  }
  if (value.includes('sendgrid')) {
    return 'SendGrid: smtp.sendgrid.net, porta 587 (SMTP_SECURE=false), usuário "apikey", senha = API key; valide Single Sender/domínio.';
  }
  if (value.includes('amazonaws') || value.includes('ses')) {
    return 'Amazon SES: email-smtp.<região>.amazonaws.com, porta 587 (SMTP_SECURE=false), credenciais SMTP do IAM; no sandbox só envia para destinatários verificados.';
  }
  if (value.includes('gmail')) {
    return 'Gmail: smtp.gmail.com, porta 587 (SMTP_SECURE=false), senha de app (não a senha da conta).';
  }
  if (['localhost', '127.0.0.1', '::1'].includes(value)) {
    return 'Mailpit local: porta 1025, sem autenticação — não entrega e-mails para caixas reais (uso apenas em desenvolvimento).';
  }
  return 'Confira host/porta/TLS em SMTP_HOST/SMTP_PORT/SMTP_SECURE e se o remetente (SMTP_FROM) está verificado no provedor.';
}

/** Maps a nodemailer error to an actionable message. */
function explain(error) {
  const code = error?.code ?? 'UNKNOWN';
  const base = error instanceof Error ? error.message : String(error);
  if (code === 'EAUTH') {
    return `credenciais rejeitadas (EAUTH): ${base}\n  → usuário/senha do SMTP estão corretos? Em provedores que usam API key (Resend/SendGrid/Brevo), a senha é a chave, não a senha da conta.`;
  }
  if (code === 'ESOCKET') {
    return `falha de socket/TLS (ESOCKET): ${base}\n  → porta e SMTP_SECURE batem? 465 exige secure=true; 587 usa secure=false (STARTTLS).`;
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || code === 'ECONNREFUSED') {
    return `não foi possível conectar (${code}): ${base}\n  → host/porta corretos? Firewall/rede bloqueando saída SMTP?`;
  }
  if (code === 'EDNS' || code === 'ENOTFOUND') {
    return `host não resolve (${code}): ${base}\n  → confira SMTP_HOST (sem protocolo nem espaços).`;
  }
  if (code === 'EENVELOPE') {
    return `remetente/destinatário recusado (EENVELOPE): ${base}\n  → SMTP_FROM e destinatário têm domínio autorizado no provedor?`;
  }
  return `${code}: ${base}`;
}

loadDotEnv();

const host = (process.env.SMTP_HOST ?? '').trim();
const port = Number(process.env.SMTP_PORT ?? '587');
const secure = truthy(process.env.SMTP_SECURE);
const user = (process.env.SMTP_USER ?? '').trim();
const password = process.env.SMTP_PASSWORD ?? '';
const from = (process.env.SMTP_FROM ?? '').trim();
const to = (argValue('--to') ?? process.env.ADMIN_EMAIL ?? '').trim();
const verifyOnly = process.argv.includes('--verify-only') || to.length === 0;

const issues = [];
if (host.length === 0) issues.push('SMTP_HOST vazio');
if (!Number.isInteger(port) || port < 1 || port > 65_535) issues.push(`SMTP_PORT inválido (${port})`);
if (from.length === 0) issues.push('SMTP_FROM vazio');
if (user.length > 0 && password.length === 0) issues.push('SMTP_USER definido sem SMTP_PASSWORD');
if (/seudominio|exemplo|example\.com/i.test(from)) {
  issues.push(`SMTP_FROM parece placeholder ("${from}")`);
}

console.log('SMTP efetivo:');
console.log(`  host:     ${host || '(vazio)'}`);
console.log(`  porta:    ${port}  secure=${secure}`);
console.log(`  usuário:  ${user.length > 0 ? user : '(sem autenticação)'}`);
console.log(`  senha:    ${password.length > 0 ? `${password.length} caracteres` : '(vazia)'}`);
console.log(`  remetente:${from ? ` ${from}` : ' (vazio)'}`);
console.log(`  destino:  ${to || '(apenas verificação)'}`);

if (issues.length > 0) {
  console.error(`\n[erro] configuração incompleta:\n  - ${issues.join('\n  - ')}`);
  console.error(`\nDica: ${providerHint(host)}`);
  process.exit(2);
}

if (port === 465 && !secure) {
  console.warn('\n[aviso] porta 465 normalmente exige SMTP_SECURE=true.');
}
if (port === 587 && secure) {
  console.warn('\n[aviso] porta 587 normalmente usa SMTP_SECURE=false (STARTTLS).');
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  ...(user.length > 0 ? { auth: { user, pass: password } } : {}),
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 20_000,
});

try {
  await transporter.verify();
  console.log('\n[ok] conexão e autenticação aceitas pelo servidor SMTP.');
} catch (error) {
  console.error(`\n[erro] verificação falhou: ${explain(error)}`);
  console.error(`\nDica: ${providerHint(host)}`);
  process.exit(1);
}

if (verifyOnly) {
  console.log('\n[ok] --verify-only: nenhum e-mail enviado. Use --to <endereço> para testar a entrega.');
  process.exit(0);
}

try {
  const info = await transporter.sendMail({
    from,
    to,
    subject: 'IntegrAI — teste de SMTP',
    text: `Este é um e-mail de teste do IntegrAI.\n\nSe você recebeu, o relay SMTP está configurado corretamente.\n\nRemetente: ${from}`,
    html: `<p>Este é um e-mail de teste do <strong>IntegrAI</strong>.</p><p>Se você recebeu, o relay SMTP está configurado corretamente.</p><p>Remetente: <code>${from}</code></p>`,
  });
  const accepted = Array.isArray(info.accepted) ? info.accepted : [];
  const rejected = Array.isArray(info.rejected) ? info.rejected : [];
  console.log(`\n[ok] e-mail de teste aceito pelo relay (messageId: ${info.messageId ?? '—'}).`);
  console.log(`     destinatários aceitos: ${accepted.length}; recusados: ${rejected.length}`);
  if (rejected.length > 0) {
    console.error(`[erro] destinatários recusados: ${rejected.join(', ')}`);
    process.exit(1);
  }
  console.log('     Confira a caixa de entrada (e o spam). Se não chegou, revise SPF/DKIM do domínio remetente.');
} catch (error) {
  console.error(`\n[erro] envio de teste falhou: ${explain(error)}`);
  process.exit(1);
}
