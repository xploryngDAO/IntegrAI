/**
 * Sonda de segurança (pentest interno leve) contra a API publicada.
 * Somente leitura/abuso controlado de um workspace de teste; limpa os buckets
 * de rate limit ao final. Não substitui um pentest externo.
 *
 * Uso: node scripts/security-probe.mjs [apiBase] [email] [password]
 */
const API = (process.argv[2] ?? 'https://growth-voters-independent-rca.trycloudflare.com').replace(/\/$/, '');
const EMAIL = process.argv[3] ?? 'admin@integr-ai.local';
const PASSWORD = process.argv[4] ?? 'IntegrAI-Prod-2026!';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const raw = (path, options = {}) =>
  fetch(`${API}${path}`, { ...options, headers: { accept: 'application/json', ...(options.headers ?? {}) } });

const json = async (path, options = {}) => {
  const response = await raw(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
};

async function main() {
  const login = await json('/api/v1/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  const token = login.body?.data?.token;
  check('login de controle', login.status === 200 && Boolean(token), `status ${login.status}`);
  if (!token) throw new Error('sem token de controle');
  const auth = { authorization: `Bearer ${token}` };

  // 1. Cabeçalhos de segurança
  const health = await raw('/api/v1/health');
  const csp = health.headers.get('content-security-policy') ?? '';
  check('CSP restritiva na API', csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'"));
  check('X-Frame-Options DENY', health.headers.get('x-frame-options') === 'DENY');
  check('COOP same-origin', health.headers.get('cross-origin-opener-policy') === 'same-origin');
  check('nosniff', health.headers.get('x-content-type-options') === 'nosniff');

  // 2. Autenticação obrigatória
  for (const path of ['/api/v1/auth/me', '/api/v1/admin/users', '/api/v1/accounts', '/api/v1/tenants/me']) {
    const unauthenticated = await json(path);
    check(`401 sem token: ${path}`, unauthenticated.status === 401, `status ${unauthenticated.status}`);
  }

  // 3. JWT adulterado / alg none
  const tampered = `${token.slice(0, -2)}xx`;
  const tamperedResponse = await json('/api/v1/auth/me', { headers: { authorization: `Bearer ${tampered}` } });
  check('JWT adulterado rejeitado', tamperedResponse.status === 401);

  const [header, payload] = token.split('.');
  const nonePayload = Buffer.from(JSON.stringify({ sub: '00000000-0000-4000-8000-000000000001' })).toString('base64url');
  const algNone = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${nonePayload}.`;
  const algNoneResponse = await json('/api/v1/auth/me', { headers: { authorization: `Bearer ${algNone}` } });
  check('JWT alg=none rejeitado', algNoneResponse.status === 401, `status ${algNoneResponse.status}`);

  // 4. CORS fail-closed
  const cors = await raw('/api/v1/health', { headers: { origin: 'https://evil.example' } });
  check('CORS nega origem desconhecida', cors.headers.get('access-control-allow-origin') === null);

  // 5. Content-Type guard
  const wrongType = await raw('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'user=admin',
  });
  check('415 para content-type inválido', wrongType.status === 415, `status ${wrongType.status}`);

  // 6. JSON malformado não vaza stack
  const malformed = await raw('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"email":',
  });
  const malformedText = await malformed.text();
  check(
    'JSON malformado sem stack trace',
    malformed.status >= 400 && malformed.status < 500 && !malformedText.includes('at '),
    `status ${malformed.status}`,
  );

  // 7. Injeção em filtros (search) não altera a semântica
  const injection = await json(
    `/api/v1/admin/users?search=${encodeURIComponent("' OR 1=1; DROP TABLE agents;--")}`,
    { headers: auth },
  );
  check(
    'search resiste a injeção SQL',
    injection.status === 200 && (injection.body?.data?.items ?? []).length === 0,
    `status ${injection.status} itens=${injection.body?.data?.items?.length}`,
  );

  // 8. Paths sensíveis negados para quem não é admin (403/401 sem token)
  const setupNoAuth = await json('/api/v1/platform/integration-setup');
  check('integration-setup exige admin', setupNoAuth.status === 401, `status ${setupNoAuth.status}`);

  // 9. Rate limit de login (e-mail inexistente; bucket por IP/e-mail)
  const rateEmail = `probe-${Date.now()}@integrai.invalid`;
  let limited = false;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const attemptResponse = await json('/api/v1/auth/login', {
      method: 'POST',
      body: { email: rateEmail, password: 'WrongPassword-2026!' },
    });
    if (attemptResponse.status === 429) {
      limited = true;
      break;
    }
  }
  check('rate limit de login responde 429', limited);

  // 10. Auditoria exige ADMIN (token de operador não-admin é coberto nos testes; aqui só o controle)
  const audit = await json('/api/v1/admin/audit-logs?perPage=1', { headers: auth });
  check('audit-logs acessível ao ADMIN', audit.status === 200);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificações passaram.`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Falha:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
