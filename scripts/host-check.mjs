/**
 * Valida um host de API candidato antes de apontar o SPA para ele
 * (issue #2 — host/domínio definitivo).
 *
 * Uso:
 *   node scripts/host-check.mjs --api=https://api.seudominio.com --web=https://integrai-dev.vercel.app
 *   node scripts/host-check.mjs --api=https://api.seudominio.com --web=https://integrai-dev.vercel.app --metrics-token=...
 */
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.join('=')];
  }),
);

const API = (args.get('api') ?? '').replace(/\/+$/, '');
const WEB = (args.get('web') ?? 'https://integrai-dev.vercel.app').replace(/\/+$/, '');
const METRICS_TOKEN = args.get('metrics-token') ?? '';
const RUNTIME_CONFIG_URL =
  args.get('runtime-config') ??
  'https://raw.githubusercontent.com/xploryngDAO/IntegrAI/main/apps/web/runtime-config.json';

if (!/^https?:\/\//.test(API)) {
  console.error('uso: node scripts/host-check.mjs --api=https://api.dominio.com [--web=https://spa] [--metrics-token=...]');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '', warning = false) => {
  results.push({ name, ok, warning });
  const label = ok ? 'PASS' : warning ? 'WARN' : 'FAIL';
  console.log(`${label}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function timedFetch(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { response, ms: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const origin = new URL(API).origin;
  check('API com https', API.startsWith('https://'), API, !API.startsWith('https://'));

  let health;
  try {
    const { response, ms } = await timedFetch(`${API}/api/v1/health`);
    health = { response, ms };
    check('GET /api/v1/health', response.ok, `HTTP ${response.status} em ${ms} ms`);
  } catch (error) {
    check('GET /api/v1/health', false, error instanceof Error ? error.message : String(error));
    summary();
    return;
  }

  const readyResponse = await fetch(`${API}/api/v1/health/ready`).catch(() => null);
  const ready = readyResponse === null ? null : await readyResponse.json().catch(() => null);
  const checks = ready?.checks ?? {};
  check(
    'GET /api/v1/health/ready',
    readyResponse?.ok === true && ready?.status === 'ready',
    `HTTP ${readyResponse?.status ?? 'n/a'} · status=${ready?.status ?? 'n/a'} · db=${checks.database} · redis=${checks.redis} · storage=${checks.storage}`,
  );

  const csp = health.response.headers.get('content-security-policy');
  check('CSP do API', typeof csp === 'string' && csp.includes("default-src 'none'"), csp?.slice(0, 80) ?? 'ausente');
  check(
    'X-Frame-Options / nosniff',
    health.response.headers.get('x-frame-options') === 'DENY' &&
      health.response.headers.get('x-content-type-options') === 'nosniff',
  );
  const hsts = health.response.headers.get('strict-transport-security');
  check(
    'HSTS no API (edge/TLS)',
    typeof hsts === 'string' && hsts.length > 0,
    hsts ?? 'ausente — adicione no proxy TLS (Caddy/nginx) antes do go-live',
    true,
  );

  // CORS exatamente para a origem do SPA publicado.
  const preflight = await fetch(`${API}/api/v1/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: WEB,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization',
    },
  }).catch(() => null);
  const allowOrigin = preflight?.headers.get('access-control-allow-origin') ?? '';
  check('CORS preflight para o SPA', preflight?.ok === true && (allowOrigin === WEB || allowOrigin === '*'), `allow-origin=${allowOrigin || 'ausente'}`);

  // request-id ecoado (correlação obrigatória em produção).
  const correlation = await fetch(`${API}/api/v1/health`, { headers: { 'x-request-id': 'host-check-request-1' } }).catch(() => null);
  check(
    'x-request-id ecoado',
    correlation?.headers.get('x-request-id') === 'host-check-request-1',
    correlation?.headers.get('x-request-id') ?? 'ausente',
  );

  // Métricas: 200 com token, 401/404 sem (comportamento esperado, não é falha).
  const metricsWith = await fetch(`${API}/api/v1/metrics`, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  }).catch(() => null);
  check(
    'GET /api/v1/metrics',
    metricsWith?.status === 200 || metricsWith?.status === 401 || metricsWith?.status === 404,
    `HTTP ${metricsWith?.status ?? 'n/a'}${METRICS_TOKEN ? '' : ' (sem token informado)'}`,
  );

  // The published SPA resolves its API at boot from runtime-config.json; a host
  // that is healthy but not wired in the SPA would still look "down" to users.
  try {
    const configResponse = await fetch(`${RUNTIME_CONFIG_URL}?ts=${Date.now()}`, {
      cache: 'no-store',
    });
    const config = await configResponse.json();
    const configuredOrigin =
      typeof config.apiBaseUrl === 'string' ? new URL(config.apiBaseUrl).origin : null;
    check(
      'runtime-config aponta para esta API',
      configuredOrigin === origin,
      configuredOrigin === origin
        ? origin
        : `runtime-config=${configuredOrigin ?? 'ausente'} · host=${origin} (rode tunnel-sync após validar)`,
      configuredOrigin !== origin,
    );
  } catch (error) {
    check(
      'runtime-config aponta para esta API',
      false,
      `não foi possível ler runtime-config: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }

  summary();
}

function summary() {
  const failures = results.filter((result) => !result.ok && !result.warning);
  const warnings = results.filter((result) => result.warning && !result.ok);
  console.log(`\n${results.length - failures.length - warnings.length}/${results.length} verificações obrigatórias passaram${warnings.length > 0 ? ` · ${warnings.length} aviso(s)` : ''}.`);
  if (failures.length > 0) {
    console.log('Corrija os itens FAIL antes de apontar o SPA (newSlug/runtime-config) para este host.');
    process.exitCode = 1;
  } else {
    console.log('Host apto. Depois de apontar o SPA: npm run validate:live e isolation-test contra ele.');
  }
}

main().catch((error) => {
  console.error('Falha:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
