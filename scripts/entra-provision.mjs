/**
 * Cria o App registration do Microsoft Entra ID para o SSO do IntegrAI via
 * Microsoft Graph (device code — o usuário autentica no navegador, nenhuma
 * senha passa por este script).
 *
 * Uso:
 *   node scripts/entra-provision.mjs --redirect=<api>/api/v1/auth/sso/callback [--name="IntegrAI SSO"]
 *   node scripts/entra-provision.mjs --dry-run   # só imprime o código de dispositivo
 *
 * Requer um usuário com permissão de criar aplicações no tenant (Admin global ou
 * Cloud Application Administrator). Saída: issuer/client id/secret e um JSON
 * `.entra-app.json` (gitignored) para configurar em /settings.
 */
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.join('=')];
  }),
);

// Azure CLI public client (pré-autorizado para Application.ReadWrite.All).
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const AUTHORITY = 'https://login.microsoftonline.com/common';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'https://graph.microsoft.com/Application.ReadWrite.All offline_access openid profile';
const redirectUri = args.get('redirect') ?? '';
const appName = args.get('name') ?? 'IntegrAI SSO';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postForm(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${response.status} ${json.error ?? ''} ${json.error_description ?? ''}`.trim());
  }
  return json;
}

async function graphJson(method, path, token, body) {
  const response = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status}: ${json.error?.message ?? JSON.stringify(json)}`);
  }
  return json;
}

function decodeJwt(token) {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function main() {
  if (!args.has('dry-run') && redirectUri === '') {
    console.error('uso: node scripts/entra-provision.mjs --redirect=<api>/api/v1/auth/sso/callback [--name=...]');
    process.exit(2);
  }

  const device = await postForm(`${AUTHORITY}/oauth2/v2.0/devicecode`, {
    client_id: CLIENT_ID,
    scope: SCOPES,
  });
  console.log('\n1) Abra no navegador: ' + device.verification_uri);
  console.log('2) Informe o código: ' + device.user_code);
  console.log(`   (expira em ${Math.round(device.expires_in / 60)} min)\n`);
  if (args.has('dry-run')) {
    console.log('dry-run: encerrando antes do login. Rode sem --dry-run para criar o app.');
    return;
  }

  process.stdout.write('Aguardando a autenticação no navegador');
  let token = null;
  const deadline = Date.now() + device.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.max(2, device.interval ?? 5) * 1000);
    try {
      token = await postForm(`${AUTHORITY}/oauth2/v2.0/token`, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: CLIENT_ID,
        device_code: device.device_code,
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!message.includes('authorization_pending') && !message.includes('slow_down')) {
        throw error;
      }
      process.stdout.write('.');
    }
  }
  if (!token?.access_token) {
    throw new Error('autenticação não concluída a tempo');
  }
  console.log(' ok');

  const claims = decodeJwt(token.access_token);
  const tenantId = claims.tid;
  if (typeof tenantId !== 'string') throw new Error('tenant id ausente no token');

  const application = await graphJson('POST', '/applications', token.access_token, {
    displayName: appName,
    signInAudience: 'AzureADMyOrg',
    web: { redirectUris: [redirectUri] },
  });

  const password = await graphJson('POST', `/applications/${application.id}/addPassword`, token.access_token, {
    passwordCredential: { displayName: `IntegrAI SSO ${new Date().toISOString().slice(0, 10)}` },
  });

  try {
    await graphJson('POST', '/servicePrincipals', token.access_token, { appId: application.appId });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('already exists')) throw error;
  }

  const result = {
    tenantId,
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    clientId: application.appId,
    clientSecret: password.secretText,
    redirectUri,
    appObjectId: application.id,
    createdAt: new Date().toISOString(),
  };

  const fs = await import('node:fs');
  fs.writeFileSync('.entra-app.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log('\nApp registration criado.');
  console.log(`  issuer:      ${result.issuer}`);
  console.log(`  client id:   ${result.clientId}`);
  console.log(`  secret:      ${result.clientSecret.slice(0, 4)}…${result.clientSecret.slice(-4)} (salvo em .entra-app.json)`);
  console.log(`  redirect:    ${result.redirectUri}`);
  console.log('\nPróximos passos: configure em /settings → Autenticação corporativa e clique em “Testar conexão”.');
}

main().catch((error) => {
  console.error('\nFalha:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
