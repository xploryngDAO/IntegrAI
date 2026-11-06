/**
 * Diagnóstico de configuração OIDC/Entra antes de salvar a conexão SSO.
 *
 * Uso:
 *   node scripts/sso-doctor.mjs --issuer=https://login.microsoftonline.com/<tid>/v2.0 \
 *     --client-id=<app-id> [--redirect-uri=https://api/api/v1/auth/sso/callback] \
 *     [--domains=empresa.com,empresa.com.br] [--secret=***]
 *
 * Também aceita um provedor OIDC local (`node scripts/oidc-stub.mjs` + --issuer=http://127.0.0.1:4310)
 * para validar o fluxo durante o desenvolvimento.
 */
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.join('=')];
  }),
);

const issuer = (args.get('issuer') ?? '').replace(/\/+$/, '');
const clientId = args.get('client-id') ?? '';
const secret = args.get('secret') ?? '';
const redirectUri = args.get('redirect-uri') ?? '';
const domains = (args.get('domains') ?? '')
  .split(',')
  .map((domain) => domain.trim().toLowerCase())
  .filter(Boolean);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function timeoutFetch(url, options = {}, ms = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function main() {
  if (!issuer || !clientId) {
    console.error('uso: node scripts/sso-doctor.mjs --issuer=<url> --client-id=<id> [--redirect-uri=...] [--domains=...] [--secret=...]');
    process.exit(2);
  }
  check('issuer https (ou loopback)', issuer.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(issuer), issuer);
  check('client id informado', clientId.length >= 8, `len=${clientId.length}`);
  if (domains.length > 0) check('dominios permitidos', domains.every((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)), domains.join(','));

  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  let discovery;
  try {
    const response = await timeoutFetch(discoveryUrl);
    check('discovery acessivel', response.ok, `HTTP ${response.status}`);
    if (!response.ok) throw new Error('discovery');
    discovery = await response.json();
  } catch (error) {
    check('discovery json', false, error instanceof Error ? error.message : String(error));
    summary();
    return;
  }

  check('issuer canonico', (discovery.issuer ?? '').replace(/\/+$/, '') === issuer, discovery.issuer);
  check('authorization_endpoint', typeof discovery.authorization_endpoint === 'string' && discovery.authorization_endpoint.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost)/.test(discovery.authorization_endpoint ?? ''));
  check('token_endpoint', typeof discovery.token_endpoint === 'string' && (discovery.token_endpoint.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost)/.test(discovery.token_endpoint)));
  check('jwks_uri', typeof discovery.jwks_uri === 'string');
  check(
    'authorization code + PKCE S256',
    (discovery.response_types_supported ?? []).includes('code') &&
      (discovery.code_challenge_methods_supported ?? []).includes('S256'),
    `response_types=${(discovery.response_types_supported ?? []).join('/')} pkce=${(discovery.code_challenge_methods_supported ?? []).join('/')}`,
  );
  const signingAlgs = discovery.id_token_signing_alg_values_supported ?? [];
  check('ID token RS256', signingAlgs.includes('RS256'), signingAlgs.join(','));

  if (discovery.jwks_uri) {
    try {
      const response = await timeoutFetch(discovery.jwks_uri);
      const jwks = await response.json();
      const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
      check('JWKS com chave de assinatura', keys.some((key) => key.kty === 'RSA' && (key.use ?? 'sig') === 'sig' && typeof key.kid === 'string'), `${keys.length} chave(s)`);
    } catch (error) {
      check('JWKS legivel', false, error instanceof Error ? error.message : String(error));
    }
  }

  if (/login\.microsoftonline\.com/.test(issuer)) {
    check('issuer no formato Entra v2 (<tenant>/v2.0)', /\/[0-9a-f-]{36}\/v2\.0$/.test(issuer) || /\/common\/v2\.0$/.test(issuer), issuer);
    check('redirect URI exato do app', redirectUri.length > 0 && redirectUri.endsWith('/api/v1/auth/sso/callback'), redirectUri || '(vazio)');
    check('client secret informado', secret.length >= 8, secret ? `len=${secret.length}` : '(vazio, apenas public client/PKCE)');
  }

  summary();
}

function summary() {
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificacoes passaram.`);
  if (failed.length > 0) {
    console.log('\nCorrija os itens acima no Entra ID (App registration) e no PUT /tenants/me/sso.');
    process.exitCode = 1;
  } else {
    console.log('\nConfiguracao OIDC consistente. Salve em /settings → Autenticacao corporativa e teste "Entrar com Microsoft".');
  }
}

main().catch((error) => {
  console.error('Falha:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
