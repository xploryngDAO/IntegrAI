/**
 * Teste de isolamento multi-tenant (A ≠ B) contra a API publicada.
 *
 * Cria um segundo tenant com conta/operador/ticket próprios, verifica que a
 * sessão do tenant A não enxerga nada do B e limpa tudo no final.
 *
 * Uso: node scripts/isolation-test.mjs [apiBase] [email] [password]
 */
import { PrismaClient } from '@prisma/client';

const API = (process.argv[2] ?? 'https://growth-voters-independent-rca.trycloudflare.com').replace(/\/$/, '');
const EMAIL = process.argv[3] ?? 'admin@integr-ai.local';
const PASSWORD = process.argv[4] ?? process.env.ADMIN_PASSWORD ?? 'IntegrAI-Prod-2026!';
const prisma = new PrismaClient();

const B = {
  tenantId: '00000000-0000-4000-8000-0000000000b2',
  accountId: '00000000-0000-4000-8000-0000000000a2',
  agentId: '00000000-0000-4000-8000-0000000000c2',
  ticketId: '00000000-0000-4000-8000-0000000000d2',
  slug: 'tenant-b-isolation-test',
  email: 'isolation-b@test.local',
};

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function seedTenantB() {
  await prisma.tenant.upsert({
    where: { slug: B.slug },
    update: { name: 'Tenant B (isolamento)' },
    create: { id: B.tenantId, slug: B.slug, name: 'Tenant B (isolamento)', status: 'ACTIVE' },
  });
  await prisma.marketplaceAccount.upsert({
    where: { id: B.accountId },
    update: { tenantId: B.tenantId },
    create: {
      id: B.accountId,
      tenantId: B.tenantId,
      marketplace: 'MERCADO_LIVRE',
      displayName: 'Loja B Isolamento',
      externalSellerId: 'iso-b-1',
      marketplaceSiteId: 'MLB',
      status: 'ACTIVE',
    },
  });
  await prisma.agent.upsert({
    where: { email: B.email },
    update: { tenantId: B.tenantId },
    create: {
      id: B.agentId,
      tenantId: B.tenantId,
      email: B.email,
      name: 'Operador B',
      passwordHash: 'x',
      role: 'ADMIN',
      presence: 'OFFLINE',
      avatarColor: '#000000',
      maxConcurrent: 1,
      isActive: true,
    },
  });
  await prisma.supportTicket.upsert({
    where: { id: B.ticketId },
    update: { tenantId: B.tenantId },
    create: {
      id: B.ticketId,
      tenantId: B.tenantId,
      accountId: B.accountId,
      marketplace: 'MERCADO_LIVRE',
      ticketType: 'PRE_SALE',
      externalReferenceId: 'iso-b-1',
      status: 'UNREAD',
      priority: 'MEDIUM',
      slaDeadlineAt: new Date(Date.now() + 3_600_000),
    },
  });
}

async function cleanup() {
  await prisma.supportTicket.deleteMany({ where: { id: B.ticketId } });
  await prisma.marketplaceAccount.deleteMany({ where: { id: B.accountId } });
  await prisma.agent.deleteMany({ where: { email: B.email } });
  await prisma.tenant.deleteMany({ where: { id: B.tenantId } });
}

async function main() {
  console.log(`API: ${API}`);
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const token = login.body?.data?.token;
  record('A-login', login.status === 200 && Boolean(token), `status ${login.status}`);
  if (!token) throw new Error('sem token do tenant A');
  const headers = { authorization: `Bearer ${token}` };

  await seedTenantB();

  const accounts = await api('/api/v1/accounts', { headers });
  const accountIds = (accounts.body?.data ?? []).map((account) => account.id);
  record('A-nao-ve-conta-B', !accountIds.includes(B.accountId), `contas=${accountIds.length}`);

  const tickets = await api('/api/v1/tickets?filter=ALL&page=1&pageSize=20', { headers });
  record('A-nao-ve-ticket-B', (tickets.body?.data?.total ?? 0) === 0, `total=${tickets.body?.data?.total}`);

  const detail = await api(`/api/v1/tickets/${B.ticketId}`, { headers });
  record('A-detalhe-ticket-B-404', detail.status === 404, `status ${detail.status}`);

  const mutation = await api(`/api/v1/tickets/${B.ticketId}/assign`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agentId: B.agentId }),
  });
  record('A-mutacao-ticket-B-404', mutation.status === 404, `status ${mutation.status}`);

  await cleanup();
  const leftover = await prisma.tenant.count({ where: { id: B.tenantId } });
  record('cleanup', leftover === 0, `tenants restantes=${leftover}`);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificações passaram.`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch(async (error) => {
    console.error('Falha:', error instanceof Error ? error.message : error);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
