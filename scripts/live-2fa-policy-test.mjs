/**
 * E2E real da política "exigir 2FA por workspace": signup -> verificação por
 * e-mail -> ativa política -> login bloqueado -> enrollment TOTP -> sessão.
 * Limpa o tenant temporário no final (Postgres local via Prisma).
 *
 * Uso: node scripts/live-2fa-policy-test.mjs [apiBase] [mailpitBase]
 */
import { createHmac } from 'node:crypto';
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
/** Tenant temporário; declarado cedo para o catch conseguir limpar. */
let tenantId = null;
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

function totp(secret) {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

async function waitForVerificationToken(email) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const list = await fetch(`${MAILPIT}/api/v1/messages?limit=250`).then((r) => r.json()).catch(() => null);
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

async function cleanup(tenantId) {
  if (!tenantId) return;
  const statements = [
    `delete from sessions where tenant_id = '${tenantId}'`,
    `delete from email_verifications where user_id in (select id from agents where tenant_id = '${tenantId}')`,
    `delete from two_factor_recovery_codes where agent_id in (select id from agents where tenant_id = '${tenantId}')`,
    `delete from invitations where tenant_id = '${tenantId}'`,
    `delete from audit_events where tenant_id = '${tenantId}'`,
    `delete from agents where tenant_id = '${tenantId}'`,
    `delete from tenants where id = '${tenantId}'`,
  ];
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement).catch(() => undefined);
  }
}

async function main() {
  const stamp = Date.now();
  const email = `policy-2fa-${stamp}@integrai.test`;
  const password = 'Politica-2FA-2026!';
  tenantId = null;

  const signup = await post('/api/v1/auth/signup', {
    companyName: `Politica 2FA ${stamp}`,
    name: 'Admin 2FA Policy',
    email,
    password,
  });
  check('signup', signup.status === 201, `status ${signup.status}`);
  const verificationToken = await waitForVerificationToken(email);
  check('e-mail de verificação', Boolean(verificationToken));
  const verify = await post('/api/v1/auth/verify-email', { token: verificationToken });
  check('verify-email', verify.status === 200);

  const firstLogin = await post('/api/v1/auth/login', { email, password });
  const token = firstLogin.body?.data?.token;
  check('login inicial', firstLogin.status === 200 && Boolean(token));
  if (!token) throw new Error('sem token');
  tenantId = firstLogin.body.data.agent.tenantId ?? null;
  const headers = { authorization: `Bearer ${token}` };

  const profile = await fetch(`${API}/api/v1/tenants/me`, { headers });
  const profileBody = await profile.json();
  check('require2fa desligado por padrão', profileBody?.data?.require2fa === false);

  const enable = await fetch(`${API}/api/v1/tenants/me`, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ require2fa: true }),
  });
  const enableBody = await enable.json();
  check('ativa política require2fa', enable.status === 200 && enableBody?.data?.require2fa === true);

  const blocked = await post('/api/v1/auth/login', { email, password });
  const setupToken = blocked.body?.error?.details?.setupToken;
  check(
    'login bloqueado exige enrollment',
    blocked.status === 403 && blocked.body?.error?.code === 'TWO_FACTOR_SETUP_REQUIRED' && Boolean(setupToken),
    `status ${blocked.status}`,
  );

  const enrollSetup = await post('/api/v1/auth/2fa/enroll/setup', {}, { authorization: `Bearer ${setupToken}` });
  const secret = enrollSetup.body?.data?.secret;
  check('enroll setup', enrollSetup.status === 200 && typeof secret === 'string');

  const verifyEnroll = await post(
    '/api/v1/auth/2fa/enroll/verify',
    { code: totp(secret) },
    { authorization: `Bearer ${setupToken}` },
  );
  const session = verifyEnroll.body?.data;
  check(
    'enroll verify emite sessão',
    verifyEnroll.status === 200 && Boolean(session?.token) && (session?.recoveryCodes?.length ?? 0) === 8,
    `status ${verifyEnroll.status}`,
  );

  const me = await fetch(`${API}/api/v1/auth/me`, { headers: { authorization: `Bearer ${session?.token}` } });
  const meBody = await me.json();
  check(
    'sessão do enrollment funciona',
    me.status === 200 && meBody?.data?.email === email,
    `status ${me.status}`,
  );

  const replay = await post(
    '/api/v1/auth/2fa/enroll/verify',
    { code: totp(secret) },
    { authorization: `Bearer ${setupToken}` },
  );
  check('replay do setup token é rejeitado', replay.status === 401, `status ${replay.status}`);

  const challenge = await post('/api/v1/auth/login', { email, password });
  check(
    'login passa a exigir TOTP',
    challenge.status === 401 && challenge.body?.code === 'TWO_FACTOR_REQUIRED',
    `status ${challenge.status}`,
  );

  await cleanup(tenantId);
  const leftover = tenantId ? await prisma.tenant.count({ where: { id: tenantId } }) : 0;
  check('cleanup', leftover === 0);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificações passaram.`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch(async (error) => {
    console.error('Falha:', error instanceof Error ? error.message : error);
    await cleanup(tenantId);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
