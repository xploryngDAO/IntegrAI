/**
 * Teste E2E real do 2FA: signup → e-mail (Mailpit) → verify → setup → verify
 * TOTP → login com challenge → disable. Limpa o tenant temporário no final.
 *
 * Uso: node scripts/live-2fa-test.mjs [apiBase] [mailpitBase]
 */
import { createHmac, randomBytes } from 'node:crypto';
import 'dotenv/config';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../packages/server/dist/generated/prisma/client.js');
const { PrismaPg } = require('@prisma/adapter-pg');

const API = (process.argv[2] ?? 'https://growth-voters-independent-rca.trycloudflare.com').replace(/\/$/, '');
const MAILPIT = (process.argv[3] ?? 'http://127.0.0.1:8025').replace(/\/$/, '');
const prisma = new PrismaClient({
  adapter: new PrismaPg(
    { connectionString: process.env.DATABASE_URL },
    { schema: 'public' },
  ),
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const post = async (path, body, headers = {}) => {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, body: json };
};

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret, offsetSteps = 0) {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30) + offsetSteps;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

async function waitForEmail(email) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const list = await fetch(`${MAILPIT}/api/v1/messages?limit=30`).then((r) => r.json()).catch(() => null);
    const message = list?.messages?.find((entry) => entry.To?.some((to) => to.Address === email));
    if (message) {
      const full = await fetch(`${MAILPIT}/api/v1/message/${message.ID}`).then((r) => r.json());
      const text = `${full.HTML ?? ''}${full.Text ?? ''}`;
      const token = /verify-email\?token=([a-f0-9]{64})/.exec(text)?.[1];
      if (token) return token;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

let tenantSlug = null;
let tenantId = null;
let userId = null;

async function cleanup() {
  if (!tenantId || !userId) return;
  await prisma.$transaction([
    prisma.emailVerification.deleteMany({ where: { userId } }),
    prisma.session.deleteMany({ where: { userId } }),
    prisma.agent.deleteMany({ where: { id: userId } }),
    prisma.tenant.deleteMany({ where: { id: tenantId } }),
  ]).catch(() => undefined);
}

async function main() {
  const stamp = Date.now();
  const email = `live-2fa-${stamp}@integrai.test`;
  const password = 'SenhaForte-2026!';
  const companyName = `Live 2FA ${stamp}`;

  const signup = await post('/api/v1/auth/signup', { companyName, name: 'Admin 2FA', email, password });
  check('signup 201', signup.status === 201, `status ${signup.status}`);
  if (signup.status !== 201) throw new Error('signup falhou');

  const token = await waitForEmail(email);
  check('e-mail de verificação recebido', Boolean(token));
  if (!token) throw new Error('e-mail não chegou');

  const verify = await post('/api/v1/auth/verify-email', { token });
  check('verify-email', verify.status === 200);

  const login = await post('/api/v1/auth/login', { email, password });
  check('login sem 2FA', login.status === 200 && Boolean(login.body?.data?.token));
  const headers = { authorization: `Bearer ${login.body.data.token}` };
  const agentRow = await prisma.agent.findUnique({ where: { email } });
  userId = agentRow?.id ?? null;
  tenantId = agentRow?.tenantId ?? null;
  tenantSlug = tenantId ? (await prisma.tenant.findUnique({ where: { id: tenantId } }))?.slug ?? null : null;

  const setup = await post('/api/v1/auth/2fa/setup', {}, headers);
  const secret = setup.body?.data?.secret;
  check('2fa setup', setup.status === 200 && typeof secret === 'string');

  const verify2fa = await post('/api/v1/auth/2fa/verify', { code: totp(secret) }, headers);
  const recoveryCodes = verify2fa.body?.data?.recoveryCodes ?? [];
  check('2fa verify + recovery codes', verify2fa.status === 200 && recoveryCodes.length === 8);

  const blocked = await post('/api/v1/auth/login', { email, password });
  const challengeToken = blocked.body?.challengeToken;
  check('login bloqueado exige 2FA', blocked.status === 401 && Boolean(challengeToken), `status ${blocked.status}`);

  const challenged = await post('/api/v1/auth/2fa/challenge', { challengeToken, code: totp(secret, 1) });
  check('challenge TOTP emite sessão', challenged.status === 200 && Boolean(challenged.body?.data?.token));
  const sessionHeaders = { authorization: `Bearer ${challenged.body.data.token}` };

  const disabled = await post('/api/v1/auth/2fa/disable', { password, code: recoveryCodes[0] }, sessionHeaders);
  check('disable com recovery code', disabled.status === 200);

  const finalLogin = await post('/api/v1/auth/login', { email, password });
  check('login volta a funcionar', finalLogin.status === 200 && Boolean(finalLogin.body?.data?.token));

  await cleanup();
  const leftovers = tenantId ? await prisma.tenant.count({ where: { id: tenantId } }) : 0;
  check('cleanup', leftovers === 0);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificações passaram.`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch(async (error) => {
    console.error('Falha:', error instanceof Error ? error.message : error);
    await cleanup();
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
