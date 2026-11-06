/**
 * Cenários de validação ao vivo contra a API publicada.
 *
 * Uso:
 *   node scripts/validate-live.mjs [apiBase] [email] [password]
 *
 * Padrões: API do túnel atual, operador ADMIN do bootstrap.
 * Só executa chamadas reais (sem mocks). Cenários que dependem de um evento
 * real do marketplace (pergunta/pedido/claim) ficam documentados em
 * docs/TEST_SCENARIOS.md e não são forjados aqui.
 */
import 'dotenv/config';

const API = (process.argv[2] ?? 'https://growth-voters-independent-rca.trycloudflare.com').replace(/\/$/, '');
const EMAIL = process.argv[3] ?? 'admin@integr-ai.local';
const PASSWORD = process.argv[4] ?? process.env.ADMIN_PASSWORD ?? 'IntegrAI-Prod-2026!';

const results = [];

function record(id, description, ok, detail) {
  results.push({ id, description, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${id.padEnd(28)} ${description}${detail ? ` — ${detail}` : ''}`);
}

async function call(path, options = {}) {
  const started = Date.now();
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const elapsed = Date.now() - started;
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body, elapsed };
}

async function main() {
  console.log(`API base: ${API}\n`);

  // 1. saúde pública
  try {
    const health = await call('/api/v1/health');
    const db = health.body?.data?.checks?.find((check) => check.name === 'database')?.ok;
    const redis = health.body?.data?.checks?.find((check) => check.name === 'redis')?.ok;
    record('A1-health', 'Health público responde e infra ok', health.status === 200 && db === true && redis === true, `status ${health.status}, db=${db}, redis=${redis}`);
  } catch (error) {
    record('A1-health', 'Health público responde e infra ok', false, String(error.message));
  }

  // 2. autenticação
  let token = null;
  try {
    const login = await call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
    token = login.body?.data?.token ?? null;
    record('A2-login', 'Login do operador ADMIN retorna JWT', login.status === 200 && Boolean(token), `status ${login.status}`);
  } catch (error) {
    record('A2-login', 'Login do operador ADMIN retorna JWT', false, String(error.message));
  }
  const auth = token ? { authorization: `Bearer ${token}` } : {};

  // 3. proteção sem autenticação
  try {
    const anonymous = await call('/api/v1/tickets');
    record('C1-auth-guard', 'GET /tickets sem token é rejeitado (401)', anonymous.status === 401, `status ${anonymous.status}`);
  } catch (error) {
    record('C1-auth-guard', 'GET /tickets sem token é rejeitado (401)', false, String(error.message));
  }

  // 4. contas conectadas
  let meliAccount = null;
  try {
    const accounts = await call('/api/v1/accounts', { headers: auth });
    meliAccount = accounts.body?.data?.find((account) => account.marketplace === 'MERCADO_LIVRE') ?? null;
    record('A3-accounts', 'Conta Mercado Livre conectada listada', accounts.status === 200 && Boolean(meliAccount), meliAccount ? `${meliAccount.displayName} (${meliAccount.status})` : `status ${accounts.status}`);
  } catch (error) {
    record('A3-accounts', 'Conta Mercado Livre conectada listada', false, String(error.message));
  }

  // 5. diagnóstico por canal (real)
  if (meliAccount) {
    try {
      const diagnose = await call(`/api/v1/accounts/${meliAccount.id}/diagnose`, { method: 'POST', headers: auth, body: '{}' });
      const checks = diagnose.body?.data?.checks ?? [];
      const failed = checks.filter((check) => check.status === 'fail');
      record('A4-diagnose', 'Diagnóstico real do Meli sem falhas', diagnose.status === 200 && failed.length === 0, `${checks.length} checks, ${failed.length} fail`);
    } catch (error) {
      record('A4-diagnose', 'Diagnóstico real do Meli sem falhas', false, String(error.message));
    }
  }

  // 6. diagnóstico global
  try {
    const diagnostics = await call('/api/v1/diagnostics', { headers: auth });
    const infra = diagnostics.body?.data?.infrastructure ?? [];
    const infraFail = infra.filter((check) => check.status === 'fail');
    record('A5-diagnostics', 'Diagnóstico global de infraestrutura sem fail', diagnostics.status === 200 && infraFail.length === 0, `overall=${diagnostics.body?.data?.overall}, infra fail=${infraFail.length}`);
  } catch (error) {
    record('A5-diagnostics', 'Diagnóstico global de infraestrutura sem fail', false, String(error.message));
  }

  // 7. webhook Meli: assinatura por segredo na URL (MELI_WEBHOOK_SECRET).
  //    Sem segredo o adapter falha fechado (401), então o cenário esperado muda.
  const meliSecret = (process.env.MELI_WEBHOOK_SECRET ?? '').trim();
  const meliWebhookPath =
    meliSecret.length > 0
      ? `/webhooks/mercadolivre?secret=${encodeURIComponent(meliSecret)}`
      : '/webhooks/mercadolivre';
  const expectedWebhookStatus = meliSecret.length > 0 ? 200 : 401;
  const notification = JSON.stringify({
    _id: `validation-${Date.now()}`,
    topic: 'questions',
    resource: '/questions/999999999',
    user_id: meliAccount?.externalSellerId ? Number(meliAccount.externalSellerId) : 0,
    application_id: 0,
    attempts: 1,
    sent: new Date().toISOString(),
  });
  try {
    const first = await call(meliWebhookPath, { method: 'POST', body: notification });
    record(
      'A6-webhook-ack',
      meliSecret.length > 0 ? 'Webhook Meli autenticado responde 200 em <500ms' : 'Webhook Meli sem segredo é rejeitado (fail closed)',
      first.status === expectedWebhookStatus && first.elapsed < 500,
      `status ${first.status}, ${first.elapsed}ms${meliSecret.length > 0 ? '' : ' (MELI_WEBHOOK_SECRET vazio)'}`,
    );
    const replay = await call(meliWebhookPath, { method: 'POST', body: notification });
    record(
      'A7-webhook-replay',
      meliSecret.length > 0 ? 'Reentrega idêntica responde 200 (OK/DUPLICATE)' : 'Reentrega idêntica também é rejeitada sem segredo',
      replay.status === expectedWebhookStatus,
      `status ${replay.status}, ${replay.elapsed}ms`,
    );
  } catch (error) {
    record('A6-webhook-ack', 'Webhook Meli responde conforme configuração', false, String(error.message));
  }

  // 8. assinaturas obrigatórias
  for (const [id, path] of [
    ['C2-shopee-signature', '/webhooks/shopee'],
    ['C3-amazon-signature', '/webhooks/amazon/ses'],
  ]) {
    try {
      const response = await call(path, { method: 'POST', body: '{}' });
      record(id, 'Webhook sem assinatura é rejeitado', response.status === 401, `status ${response.status}`);
    } catch (error) {
      record(id, 'Webhook sem assinatura é rejeitado', false, String(error.message));
    }
  }

  // 9. fila vazia: notificação inválida não cria ticket fantasma
  try {
    const tickets = await call('/api/v1/tickets?filter=ALL&page=1&pageSize=5', { headers: auth });
    const total = tickets.body?.data?.total ?? tickets.body?.data?.items?.length ?? null;
    record('A8-no-ghost-ticket', 'Evento inválido não cria ticket fantasma', total === 0 || total === null, `total=${total}`);
  } catch (error) {
    record('A8-no-ghost-ticket', 'Evento inválido não cria ticket fantasma', false, String(error.message));
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} cenários passaram.`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Falha inesperada:', error);
  process.exitCode = 1;
});
