/**
 * Provedor OIDC de teste (local) para validar o fluxo SSO ponta a ponta.
 * NÃO é usado em produção. Emite um ID token RS256 com JWKS real.
 *
 * Uso: node scripts/oidc-stub.mjs [port]
 */
import { createServer } from 'node:http';
import { createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';

const PORT = Number(process.argv[2] ?? 4310);
const ISSUER = `http://127.0.0.1:${PORT}`;
const CLIENT_ID = process.env.OIDC_STUB_CLIENT_ID ?? 'stub-client';
const EMAIL = process.env.OIDC_STUB_EMAIL ?? 'sso-live@integrai.test';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
Object.assign(jwk, { kid: 'stub-key-1', use: 'sig', alg: 'RS256' });

const codes = new Map();

const b64url = (input) => Buffer.from(input).toString('base64url');
function signJwt(payload) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: jwk.kid }));
  const body = b64url(JSON.stringify(payload));
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', ISSUER);

  if (url.pathname === '/.well-known/openid-configuration') {
    return json(response, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile', 'email'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    });
  }

  if (url.pathname === '/jwks') {
    return json(response, 200, { keys: [jwk] });
  }

  if (url.pathname === '/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    const nonce = url.searchParams.get('nonce');
    if (!redirectUri || !state || !nonce) return json(response, 400, { error: 'invalid_request' });
    const code = randomUUID();
    codes.set(code, { redirectUri, nonce });
    const location = new URL(redirectUri);
    location.searchParams.set('code', code);
    location.searchParams.set('state', state);
    response.writeHead(302, { location: location.toString() });
    return response.end();
  }

  if (url.pathname === '/token' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const params = new URLSearchParams(body);
    const code = params.get('code');
    const entry = code ? codes.get(code) : null;
    if (!entry) return json(response, 400, { error: 'invalid_grant' });
    codes.delete(code);
    const now = Math.floor(Date.now() / 1000);
    const idToken = signJwt({
      iss: ISSUER,
      aud: CLIENT_ID,
      azp: CLIENT_ID,
      sub: 'stub-user-1',
      email: EMAIL,
      email_verified: true,
      name: 'Usuário SSO Stub',
      nonce: entry.nonce,
      iat: now,
      exp: now + 300,
    });
    return json(response, 200, { access_token: 'stub-access-token', token_type: 'Bearer', expires_in: 300, id_token: idToken });
  }

  json(response, 404, { error: 'not_found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`OIDC stub: ${ISSUER} (client ${CLIENT_ID}, email ${EMAIL})`);
});
