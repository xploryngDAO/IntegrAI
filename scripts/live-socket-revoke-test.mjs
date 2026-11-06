/**
 * Valida que o handshake do Socket.IO respeita o denylist de access token:
 * conecta, faz logout e tenta conectar de novo com o mesmo token (deve falhar).
 *
 * Uso: node scripts/live-socket-revoke-test.mjs [apiBase]
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.resolve('apps/web/package.json'));
const { io } = require('socket.io-client');

const API = (process.argv[2] ?? 'https://growth-voters-independent-rca.trycloudflare.com').replace(/\/$/, '');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const login = async () => {
  const response = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@integr-ai.local', password: 'IntegrAI-Prod-2026!' }),
  });
  const body = await response.json();
  return body?.data;
};

function connect(token) {
  return new Promise((resolve) => {
    const socket = io(API, {
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
      timeout: 8000,
    });
    const done = (result) => {
      socket.close();
      resolve(result);
    };
    socket.on('connect', () => done({ ok: true }));
    socket.on('connect_error', (error) => done({ ok: false, message: error.message }));
    setTimeout(() => done({ ok: false, message: 'timeout' }), 9000);
  });
}

async function main() {
  const session = await login();
  check('login', Boolean(session?.token));
  if (!session?.token) throw new Error('sem token');

  const before = await connect(session.token);
  check('socket conecta com token válido', before.ok, before.message);

  const logout = await fetch(`${API}/api/v1/auth/logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
  check('logout', logout.status === 204, `status ${logout.status}`);

  const after = await connect(session.token);
  check('socket rejeita token revogado', after.ok === false, after.message);

  const fresh = await login();
  const freshSocket = await connect(fresh.token);
  check('novo login conecta normalmente', freshSocket.ok, freshSocket.message);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificações passaram.`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Falha:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
